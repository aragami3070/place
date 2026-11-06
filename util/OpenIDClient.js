const crypto = require("crypto");

// Минимальный OpenID Connect клиент: Authorization Code Flow + PKCE (S256), без внешних зависимостей.
// Как и в референсе (Mattermost), подпись id_token не проверяется: токен приходит напрямую от token endpoint
// по TLS (OIDC Core 3.1.3.7, п.6 это разрешает). Дополнительно проверяются iss, aud, exp, nonce,
// а сами claims берутся из userinfo endpoint и их sub должен совпасть с sub из id_token.

class OpenIDError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

const discoveryCache = new Map(); // issuer -> { doc, fetchedAt }
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const b64url = (buf) => buf.toString("base64url");

function isLocalhost(url) {
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

// http разрешён только для localhost (для разработки)
function assertSecureURL(value, what) {
    let url;
    try { url = new URL(value); } catch (e) { throw new OpenIDError("config", `${what}: invalid URL`); }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost(url))) throw new OpenIDError("config", `${what} must use https`);
    return url;
}

async function requestJSON(oc, url, options = {}) {
    const res = await fetch(url, Object.assign({ signal: AbortSignal.timeout(oc.timeoutMs || 8000), redirect: "error" }, options));
    if (!res.ok) throw new OpenIDError("provider", `${new URL(url).pathname} responded with HTTP ${res.status}`);
    return res.json();
}

async function discover(oc) {
    const issuer = assertSecureURL(oc.issuer, "OPENID_ISSUER").href.replace(/\/+$/, "");
    const cached = discoveryCache.get(issuer);
    if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.doc;
    const doc = await requestJSON(oc, issuer + "/.well-known/openid-configuration");
    if (String(doc.issuer || "").replace(/\/+$/, "") !== issuer) throw new OpenIDError("provider", "Discovery issuer mismatch");
    ["authorization_endpoint", "token_endpoint", "userinfo_endpoint"].forEach((key) => {
        if (!doc[key]) throw new OpenIDError("provider", `Discovery document has no ${key}`);
        assertSecureURL(doc[key], key);
    });
    discoveryCache.set(issuer, { doc, fetchedAt: Date.now() });
    return doc;
}

function redirectURI(config) {
    if (!/^https?:\/\/[^/]+/i.test(config.host || "")) throw new OpenIDError("config", "HOST must start with http:// or https:// (for example http://127.0.0.1:3000)");
    return config.host.replace(/\/+$/, "") + "/auth/openid/callback";
}

/** Готовит редирект на провайдера. Возвращает { url, session }: session нужно сохранить до callback. */
async function createAuthRequest(config) {
    const oc = config.openid;
    const doc = await discover(oc);
    const state = b64url(crypto.randomBytes(24));
    const nonce = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(32));
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", oc.clientId);
    url.searchParams.set("redirect_uri", redirectURI(config));
    url.searchParams.set("scope", oc.scopes || "openid profile email");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", b64url(crypto.createHash("sha256").update(verifier).digest()));
    url.searchParams.set("code_challenge_method", "S256");
    return { url: url.href, session: { state, nonce, verifier, createdAt: Date.now() } };
}

function decodeJWTPayload(jwt) {
    const parts = String(jwt || "").split(".");
    if (parts.length !== 3) throw new OpenIDError("provider", "Malformed id_token");
    try {
        return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch (e) {
        throw new OpenIDError("provider", "Cannot parse id_token");
    }
}

/**
 * Завершает вход: проверяет state, меняет code на токены, проверяет id_token, запрашивает userinfo.
 * Возвращает объект claims (sub гарантированно непустой и совпадает в id_token и userinfo).
 */
async function completeLogin(config, saved, query) {
    const oc = config.openid;
    if (!saved || !saved.state || Date.now() - saved.createdAt > 10 * 60 * 1000) throw new OpenIDError("state", "Login session expired. Please try again.");
    if (query.error) throw new OpenIDError("denied", "The identity provider refused the sign in" + (query.error_description ? `: ${query.error_description}` : "."));
    const given = Buffer.from(String(query.state || ""));
    const expected = Buffer.from(saved.state);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new OpenIDError("state", "Invalid state.");
    if (!query.code) throw new OpenIDError("provider", "No authorization code received.");

    const doc = await discover(oc);
    const tokens = await requestJSON(oc, doc.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code: String(query.code),
            redirect_uri: redirectURI(config),
            client_id: oc.clientId,
            client_secret: oc.clientSecret,
            code_verifier: saved.verifier
        }).toString()
    });
    if (!tokens.access_token || !tokens.id_token) throw new OpenIDError("provider", "Token response has no access_token/id_token.");

    const idClaims = decodeJWTPayload(tokens.id_token);
    const issuer = oc.issuer.replace(/\/+$/, "");
    if (String(idClaims.iss || "").replace(/\/+$/, "") !== issuer) throw new OpenIDError("provider", "id_token issuer mismatch.");
    const aud = [].concat(idClaims.aud || []);
    if (aud.indexOf(oc.clientId) === -1) throw new OpenIDError("provider", "id_token audience mismatch.");
    if (typeof idClaims.exp !== "number" || idClaims.exp * 1000 < Date.now()) throw new OpenIDError("provider", "id_token expired.");
    if (!idClaims.nonce || idClaims.nonce !== saved.nonce) throw new OpenIDError("provider", "id_token nonce mismatch.");
    if (!idClaims.sub) throw new OpenIDError("provider", "id_token has no sub.");

    const userinfo = await requestJSON(oc, doc.userinfo_endpoint, { headers: { "Authorization": "Bearer " + tokens.access_token, "Accept": "application/json" } });
    if (userinfo.sub !== idClaims.sub) throw new OpenIDError("provider", "userinfo sub does not match id_token sub.");
    // claims из id_token как запасной вариант, userinfo приоритетнее
    return Object.assign({}, idClaims, userinfo);
}

module.exports = { createAuthRequest, completeLogin, OpenIDError, redirectURI };
