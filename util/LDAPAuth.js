const { Client, InvalidCredentialsError } = require("ldapts");

// Логин LDAP-пользователя. Ограничиваем алфавит до любых обращений к LDAP,
// чтобы в DN и в фильтр не попали управляющие символы.
const LOGIN_REGEX = /^[A-Za-z0-9._-]{1,64}$/;

class LDAPAuthError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code; // invalid_credentials | forbidden | ldap_error
    }
}

function isValidLogin(login) {
    return typeof login === "string" && LOGIN_REGEX.test(login);
}

// RFC 4515: экранирование значения в LDAP-фильтре
function escapeFilterValue(value) {
    return String(value).replace(/[\\*()\0]/g, (c) => "\\" + c.charCodeAt(0).toString(16).padStart(2, "0"));
}

/**
 * Проверяет логин/пароль в LDAP (Active Directory) биндом от имени самого пользователя,
 * затем (с его же правами) проверяет членство в группе и берёт отображаемое имя.
 *
 * ldapConfig:
 *   url               из env
 *   bindDnTemplate    шаблон DN/UPN с подстановкой {user} (значение берётся из env)
 *   searchBaseDN      из env
 *   loginAttribute    по умолчанию "sAMAccountName"
 *   requiredGroupDN   необязательно: пускать только прямых членов этой группы (memberOf)
 *   tlsRejectUnauthorized  по умолчанию true
 *   timeoutMs         по умолчанию 8000
 *   adminGroupDN / moderatorGroupDN  необязательно: роли Place по членству в группах (см. passport.js)
 */
async function authenticate(ldapConfig, login, password) {
    if (!isValidLogin(login) || typeof password !== "string" || password.length === 0) {
        // Пустой пароль нельзя пускать до bind: LDAP трактует его как анонимный bind, который "успешен".
        throw new LDAPAuthError("invalid_credentials", "Incorrect username or password provided.");
    }
    const timeout = ldapConfig.timeoutMs || 8000;
    const clientOptions = { url: ldapConfig.url, timeout: timeout, connectTimeout: timeout };
    // ldapts включает TLS, если передан tlsOptions, даже для ldap://, поэтому передаём только для ldaps://
    if (/^ldaps:/i.test(ldapConfig.url || "")) clientOptions.tlsOptions = { rejectUnauthorized: ldapConfig.tlsRejectUnauthorized !== false };
    const client = new Client(clientOptions);
    const attr = ldapConfig.loginAttribute || "sAMAccountName";
    try {
        try {
            await client.bind(ldapConfig.bindDnTemplate.replace("{user}", login), password);
        } catch (err) {
            if (err instanceof InvalidCredentialsError) throw new LDAPAuthError("invalid_credentials", "Incorrect username or password provided.");
            throw err;
        }
        let filter = `(&(objectClass=person)(${attr}=${escapeFilterValue(login)})`;
        if (ldapConfig.requiredGroupDN) filter += `(memberOf=${escapeFilterValue(ldapConfig.requiredGroupDN)})`;
        filter += ")";
        const { searchEntries } = await client.search(ldapConfig.searchBaseDN, {
            scope: "sub",
            filter: filter,
            attributes: [attr, "displayName", "memberOf"],
            sizeLimit: 2
        });
        if (searchEntries.length === 0) throw new LDAPAuthError("forbidden", "Your account is not allowed to use this service.");
        if (searchEntries.length > 1) throw new LDAPAuthError("ldap_error", "Ambiguous LDAP account.");
        const entry = searchEntries[0];
        const displayName = Array.isArray(entry.displayName) ? entry.displayName[0] : entry.displayName;
        const memberOf = [].concat(entry.memberOf || []).map((g) => String(g).toLowerCase());
        return { login: login.toLowerCase(), displayName: displayName || login, groups: memberOf };
    } catch (err) {
        if (err instanceof LDAPAuthError) throw err;
        throw new LDAPAuthError("ldap_error", "The authentication server is unavailable. Please try again later. (" + err.message + ")");
    } finally {
        client.unbind().catch(() => {});
    }
}

module.exports = { authenticate, isValidLogin, LDAPAuthError, escapeFilterValue };
