const crypto = require("crypto");
const OpenIDClient = require("../util/OpenIDClient");
const ExternalAccounts = require("../util/ExternalAccounts");
const LDAPAuth = require("../util/LDAPAuth");
const ActionLogger = require("../util/ActionLogger");

// Вход через OpenID Connect. Параметры провайдера - только в env (см. config.example.js).

function fail(res, message) {
    return res.redirect("/#signin&loginerror=1&logintext=" + encodeURIComponent(message));
}

// Имя в Place из claims. Без linkToLdap приводим к [A-Za-z0-9_-]{3,20}; с linkToLdap берём логин как есть,
// чтобы аккаунт совпал с LDAP-аккаунтом того же человека (идентификатор "ldap_<логин>").
function resolveIdentity(oc, claims) {
    const raw = claims[oc.usernameClaim || "preferred_username"] || claims.nickname || (claims.email || "").split("@")[0];
    const login = String(raw || "").split("@")[0];
    if (oc.linkToLdap) {
        if (!LDAPAuth.isValidLogin(login)) return null;
        return { oauthID: "ldap_" + login.toLowerCase(), username: login.toLowerCase(), suffixOnConflict: false };
    }
    let name = login.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 20);
    if (name.length < 3) name = "user_" + crypto.createHash("sha256").update(String(claims.sub)).digest("hex").slice(0, 6);
    return { oauthID: "openid_" + claims.sub, username: name, suffixOnConflict: true };
}

exports.getLogin = async (req, res) => {
    if (req.user) return res.redirect("/");
    try {
        const { url, session } = await OpenIDClient.createAuthRequest(req.place.config);
        req.session.openid = session;
        res.redirect(url);
    } catch (err) {
        req.place.reportError("OpenID login start failed: " + err.message);
        fail(res, "The identity provider is unavailable. Please try again later.");
    }
};

exports.getCallback = async (req, res) => {
    const config = req.place.config;
    const oc = config.openid;
    const saved = req.session.openid;
    req.session.openid = null; // state одноразовый
    try {
        const claims = await OpenIDClient.completeLogin(config, saved, req.query);
        const groups = [].concat(claims[oc.groupsClaim || "groups"] || []).map(String);
        if (oc.requiredGroup && groups.map((g) => g.toLowerCase()).indexOf(oc.requiredGroup.toLowerCase()) === -1) {
            return fail(res, "Your account is not allowed to use this service.");
        }
        const identity = resolveIdentity(oc, claims);
        if (!identity) return fail(res, "The identity provider did not return a usable username.");
        ExternalAccounts.findOrCreate(req.place, Object.assign({ displayName: claims.name || identity.username }, identity), (err, user, regError) => {
            if (err) { req.place.reportError("OpenID account error: " + err); return fail(res, "An unknown error occurred."); }
            if (!user) return fail(res, (regError && regError.message) || "Could not create your account.");
            if (user.loginError()) return fail(res, user.loginError().message);
            ExternalAccounts.syncRoles(user, groups, { adminGroup: oc.adminGroup, moderatorGroup: oc.moderatorGroup }, (err) => {
                if (err) { req.place.reportError("OpenID role sync error: " + err); return fail(res, "An unknown error occurred."); }
                ActionLogger.log(req.place, "signIn", user, null, { method: "openid" });
                req.login(user, (err) => err ? fail(res, "An unknown error occurred.") : res.redirect("/?signedin=1"));
            });
        });
    } catch (err) {
        if (!(err instanceof OpenIDClient.OpenIDError) || err.code === "provider" || err.code === "config") req.place.reportError("OpenID login failed: " + err.message);
        fail(res, err instanceof OpenIDClient.OpenIDError && (err.code === "state" || err.code === "denied") ? err.message : "Sign in failed. Please try again later.");
    }
};
