const crypto = require("crypto");
const User = require("../models/user");

// Общая логика для внешних источников входа (LDAP, OpenID): создание аккаунта при первом входе
// и выдача/отзыв ролей Place по группам.

/**
 * Роли по группам. Работает только для тех ролей, для которых группа задана в env:
 * тогда роль выдаётся и отзывается при каждом входе. Если группа не задана, роль управляется вручную.
 * roles: { adminGroup, moderatorGroup }, groups: массив строк (сравнение без учёта регистра).
 */
function syncRoles(user, groups, roles, callback) {
    const normalized = (groups || []).map((g) => String(g).toLowerCase());
    const isMember = (group) => normalized.indexOf(String(group).toLowerCase()) !== -1;
    let changed = false;
    if (roles.adminGroup) {
        const v = isMember(roles.adminGroup);
        if (user.admin !== v) { user.admin = v; changed = true; }
    }
    if (roles.moderatorGroup) {
        const v = isMember(roles.moderatorGroup);
        if (user.moderator !== v) { user.moderator = v; changed = true; }
    }
    if (!changed) return callback(null);
    user.save(callback);
}

/**
 * Находит аккаунт по oauthID или создаёт новый.
 * opts: { oauthID, username, displayName, suffixOnConflict }
 * suffixOnConflict: при занятом имени добавлять случайный суффикс (иначе - ошибка username_taken).
 * callback(err, user, error): err - ошибка БД, error - ошибка регистрации в формате User.register.
 */
function findOrCreate(app, opts, callback) {
    User.findOne({ OAuthID: opts.oauthID }, function(err, user) {
        if (err) return callback(err);
        if (user) return callback(null, user);
        let attempt = 0;
        const tryRegister = (name) => {
            User.register(name, opts.oauthID, app, function(newUser, error) {
                if (!newUser) {
                    if (error && error.code === "username_taken" && opts.suffixOnConflict && ++attempt <= 5) {
                        return tryRegister(opts.username.slice(0, 15) + "_" + crypto.randomBytes(2).toString("hex"));
                    }
                    return callback(null, null, error);
                }
                // register() считает OAuth-аккаунт без выбранного ника, а ник у нас уже есть
                newUser.usernameSet = true;
                newUser.save((err) => err ? callback(err) : callback(null, newUser));
            }, opts.oauthID, opts.displayName);
        };
        tryRegister(opts.username);
    });
}

module.exports = { syncRoles, findOrCreate };
