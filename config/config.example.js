// Переключатели из env: "true"/"True"/"TRUE" и т.п. - включено; пусто или не задано - значение по умолчанию
const envBool = (name, def = false) => {
    const v = process.env[name];
    return v === undefined || String(v).trim() === "" ? def : String(v).trim().toLowerCase() === "true";
};

module.exports = {
    "secret": process.env.SECRET || "CHANGETHISDONTUSETHISITSINSECURE", // <------- ЗАДАЙ SECRET В .env, значение по умолчанию небезопасно
    "database": "mongodb://localhost/place",
    "port": 3000,
    "boardSize": 1600, 
    "onlyListenLocal": true,
    "trustProxyDepth": 1, // How many levels of proxy to trust for IP
    "debug": false,
    "googleAnalyticsTrackingID": "", // UA-XXXXXXXX-XX
    "host": process.env.HOST || "http://localhost:3000", // the publicly accessible URL of the site
    "placeTimeout": 60,
    'enableChangelogs': true,
    'siteName': 'Place',
    // "raven": "", 
    // "publicRaven": "", 
    // "bugsnag": "",
    'maintenance': {
        'allowSignups': true, 
        'allowLogins': true,
        'notice': undefined
    },
    "cachet": {
        // Setup reporting error count as a metric to Cachet
        "apiKey": "",
        "site": "",
        "metricID": 0
    },
    "recaptcha": { // Leave blank to disable
        "siteKey": "",
        "secretKey": ""
    },
    "oauth": {
        // No field here is required.
        // To use an oauth option, set enabled to true, and drop your keys in.
        "google": {
            "enabled": false,
            "clientID": "",
            "clientSecret": ""
        },
        "reddit": {
            "enabled": false,
            "clientID": "",
            "clientSecret": ""
        },
        "discord": {
            "enabled": false,
            "clientID": "",
            "clientSecret": ""
        },
        "twitter": {
            "enabled": false,
            "clientID": "",
            "clientSecret": ""
        },
        "github": {
            "enabled": false,
            "clientID": "",
            "clientSecret": ""
        },
        "facebook": {
            "enabled": false,
            "clientID": "",
            "clientSecret": ""
        },
        "microsoft": {
            "enabled": false,
            "clientID": "",
            "clientSecret": ""
        }
    },
    "ldap": {
        // Вход через LDAP. ВСЕ параметры берутся из переменных окружения (см. .env.example), в коде/конфиге их нет.
        // При enabled самостоятельная регистрация отключена, аккаунт создаётся при первом успешном входе (имя = логин LDAP).
        // Локальные аккаунты, созданные вручную (например, админ), по-прежнему входят по своему паролю.
        "enabled": envBool("LDAP_ENABLED"),
        "url": process.env.LDAP_URL,
        "bindDnTemplate": process.env.LDAP_BIND_DN_TEMPLATE, // шаблон с {user}
        "searchBaseDN": process.env.LDAP_SEARCH_BASE_DN,
        "loginAttribute": process.env.LDAP_LOGIN_ATTRIBUTE || "sAMAccountName",
        "requiredGroupDN": process.env.LDAP_REQUIRED_GROUP_DN || "", // необязательно: пускать только членов группы
        "adminGroupDN": process.env.LDAP_ADMIN_GROUP_DN || "", // необязательно: члены группы = админы Place
        "moderatorGroupDN": process.env.LDAP_MODERATOR_GROUP_DN || "", // необязательно: члены группы = модераторы
        "tlsRejectUnauthorized": envBool("LDAP_TLS_REJECT_UNAUTHORIZED", true),
        "timeoutMs": parseInt(process.env.LDAP_TIMEOUT_MS || "8000", 10)
    },
    "openid": {
        // Вход через OpenID Connect (Authorization Code + PKCE). ВСЕ параметры - из env (см. .env.example).
        // Redirect URI для регистрации клиента у провайдера: <HOST>/auth/openid/callback
        "enabled": envBool("OPENID_ENABLED"),
        "issuer": process.env.OPENID_ISSUER,
        "clientId": process.env.OPENID_CLIENT_ID,
        "clientSecret": process.env.OPENID_CLIENT_SECRET,
        "scopes": process.env.OPENID_SCOPES || "openid profile email",
        "usernameClaim": process.env.OPENID_USERNAME_CLAIM || "preferred_username",
        "groupsClaim": process.env.OPENID_GROUPS_CLAIM || "groups",
        "requiredGroup": process.env.OPENID_REQUIRED_GROUP || "", // необязательно: пускать только членов группы
        "adminGroup": process.env.OPENID_ADMIN_GROUP || "", // необязательно: члены группы = админы Place
        "moderatorGroup": process.env.OPENID_MODERATOR_GROUP || "", // необязательно: члены группы = модераторы
        // true: один человек = один аккаунт при одновременном LDAP и OpenID (аккаунт "ldap_<логин>").
        // Включать, только если провайдер OpenID выдаёт тот же логин, что и LDAP (иначе возможен захват чужого аккаунта).
        "linkToLdap": envBool("OPENID_LINK_TO_LDAP"),
        "buttonLabel": process.env.OPENID_BUTTON_LABEL || "Sign in with OpenID",
        "timeoutMs": parseInt(process.env.OPENID_TIMEOUT_MS || "8000", 10)
    },
    "pixelFlags": []
};
