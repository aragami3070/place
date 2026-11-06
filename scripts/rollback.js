#!/usr/bin/env node
/*
 * Откат пикселей, нарисованных указанными пользователями.
 *
 * Для каждой клетки, где СЕЙЧАС стоит пиксель нарушителя, возвращается предыдущее значение:
 * последний пиксель в этой клетке от другого пользователя (по журналу действий "place"),
 * а если такого нет - клетка снова становится пустой (белой).
 * Клетки, которые после нарушителя уже перекрасил кто-то другой, не трогаются.
 *
 * Использование:
 *   node scripts/rollback.js --user ivanov [--user petrov ...]
 *        [--since 2026-11-05T10:00:00Z] [--until 2026-11-05T12:00:00Z]
 *        [--area x1,y1,x2,y2] [--out undo.json] [--apply]
 *
 * Без --apply это сухой прогон: ничего не меняется, только печатается отчёт.
 *
 * ВАЖНО:
 *   1. Останови сервер Place перед --apply (иначе он держит доску в памяти и перезапишет кеш картинки).
 *   2. Сделай бэкап MongoDB (mongodump).
 *   3. После --apply запусти сервер: кеш картинки доски удаляется, доска пересоберётся из БД.
 *   4. Бан пользователя делается отдельно, в админке (/admin).
 *   5. Файл --out (по умолчанию rollback-undo-<время>.json) хранит прежнее состояние изменённых клеток.
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
mongoose.Promise = global.Promise;

const config = require("../config/config");
const User = require("../models/user");
const Pixel = require("../models/pixel");
const Action = require("../models/action");

function parseArgs(argv) {
    const args = { users: [], apply: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) fail(`Не указано значение для ${a}`);
            return argv[++i];
        };
        if (a === "--user") args.users.push(next());
        else if (a === "--since") args.since = parseDate(next(), a);
        else if (a === "--until") args.until = parseDate(next(), a);
        else if (a === "--area") args.area = parseArea(next());
        else if (a === "--out") args.out = next();
        else if (a === "--apply") args.apply = true;
        else if (a === "--help" || a === "-h") { console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]); process.exit(0); }
        else fail(`Неизвестный аргумент: ${a}`);
    }
    if (args.users.length === 0) fail("Нужен хотя бы один --user <имя>");
    return args;
}

function parseDate(value, flag) {
    const d = new Date(value);
    if (isNaN(d.getTime())) fail(`${flag}: не могу разобрать дату "${value}" (нужен ISO, например 2026-11-05T10:00:00Z)`);
    return d;
}

function parseArea(value) {
    const parts = value.split(",").map((n) => Number.parseInt(n, 10));
    if (parts.length !== 4 || parts.some(Number.isNaN)) fail("--area: нужен формат x1,y1,x2,y2");
    return { x1: Math.min(parts[0], parts[2]), y1: Math.min(parts[1], parts[3]), x2: Math.max(parts[0], parts[2]), y2: Math.max(parts[1], parts[3]) };
}

function fail(message) {
    console.error("Ошибка: " + message);
    process.exit(1);
}

function hexToRGB(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    await mongoose.connect(process.env.DATABASE || config.database, { useMongoClient: true });

    const users = await User.find({ name: { $in: args.users } });
    const missing = args.users.filter((n) => !users.some((u) => u.name === n));
    if (missing.length) fail(`Пользователи не найдены (имя чувствительно к регистру): ${missing.join(", ")}`);
    const badIDs = users.map((u) => String(u._id));
    const names = new Map(users.map((u) => [String(u._id), u.name]));
    console.log(`Пользователи: ${users.map((u) => `${u.name} (${u.id})`).join(", ")}`);
    console.log(args.apply ? "РЕЖИМ: ПРИМЕНЕНИЕ ИЗМЕНЕНИЙ" : "РЕЖИМ: сухой прогон (ничего не меняется)");

    // 1. Все клетки, в которые писали нарушители (в заданном окне/области)
    const query = { actionID: "place", performingUserID: { $in: users.map((u) => u._id) } };
    if (args.since || args.until) {
        query.date = {};
        if (args.since) query.date.$gte = args.since;
        if (args.until) query.date.$lte = args.until;
    }
    if (args.area) {
        query["info.x"] = { $gte: args.area.x1, $lte: args.area.x2 };
        query["info.y"] = { $gte: args.area.y1, $lte: args.area.y2 };
    }
    const badActions = await Action.find(query).select("info date").lean();
    const cells = new Map();
    badActions.forEach((a) => {
        if (!a.info || !Number.isInteger(a.info.x) || !Number.isInteger(a.info.y)) return;
        cells.set(a.info.x + "," + a.info.y, { x: a.info.x, y: a.info.y });
    });
    console.log(`Найдено действий "place": ${badActions.length}, затронуто клеток: ${cells.size}`);

    if (args.apply) {
        // Ускоряет поиск предыдущего значения клетки по журналу
        await Action.collection.createIndex({ actionID: 1, "info.x": 1, "info.y": 1, date: -1 });
    }

    // 2. Для каждой клетки решаем, что с ней делать
    const plan = [];
    const stats = { restore: 0, clear: 0, alreadyOverwritten: 0 };
    for (const cell of cells.values()) {
        const pixel = await Pixel.findOne({ xPos: cell.x, yPos: cell.y });
        // Сейчас в клетке не пиксель нарушителя (перекрашен другим или не существует) - не трогаем
        if (!pixel || !pixel.editorID || badIDs.indexOf(String(pixel.editorID)) === -1) { stats.alreadyOverwritten++; continue; }
        // Пиксель нарушителя вне заданного окна времени - не трогаем
        if (args.since && pixel.lastModified < args.since) { stats.alreadyOverwritten++; continue; }
        if (args.until && pixel.lastModified > args.until) { stats.alreadyOverwritten++; continue; }

        const previous = await Action.findOne({
            actionID: "place",
            "info.x": cell.x,
            "info.y": cell.y,
            performingUserID: { $nin: users.map((u) => u._id) },
            date: { $lt: pixel.lastModified }
        }).sort({ date: -1 }).lean();
        const prevRGB = previous && previous.info ? hexToRGB(previous.info.colour) : null;

        const entry = {
            x: cell.x,
            y: cell.y,
            before: { colour: pixel.getHexColour(), editorID: String(pixel.editorID), editor: names.get(String(pixel.editorID)), lastModified: pixel.lastModified }
        };
        if (previous && prevRGB) {
            entry.after = { colour: previous.info.colour, editorID: String(previous.performingUserID), lastModified: previous.date };
            entry.prevRGB = prevRGB;
            entry.prevEditor = previous.performingUserID;
            entry.prevDate = previous.date;
            stats.restore++;
        } else {
            entry.after = null; // пустая клетка
            stats.clear++;
        }
        plan.push(entry);
    }

    console.log(`К откату: ${plan.length} (вернуть прежний цвет: ${stats.restore}, очистить: ${stats.clear}); пропущено, т.к. уже перекрашены/вне окна: ${stats.alreadyOverwritten}`);
    plan.slice(0, 20).forEach((e) => console.log(`  (${e.x}, ${e.y}) ${e.before.colour} [${e.before.editor}] -> ${e.after ? e.after.colour : "пусто"}`));
    if (plan.length > 20) console.log(`  ... и ещё ${plan.length - 20}`);

    if (!args.apply) {
        console.log("\nСухой прогон завершён. Для применения добавь --apply (сервер должен быть остановлен, нужен бэкап БД).");
        return;
    }
    if (plan.length === 0) return console.log("Откатывать нечего.");

    // 3. Применяем. Сначала сохраняем файл для возможности отмены.
    const outFile = args.out || `rollback-undo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    fs.writeFileSync(outFile, JSON.stringify({ date: new Date(), users: args.users, pixels: plan.map((e) => ({ x: e.x, y: e.y, before: e.before, after: e.after })) }, null, 2));
    console.log(`Прежнее состояние сохранено в ${outFile}`);

    for (const e of plan) {
        if (e.after) {
            await Pixel.update({ xPos: e.x, yPos: e.y }, { $set: {
                editorID: e.prevEditor,
                lastModified: e.prevDate,
                colourR: e.prevRGB.r,
                colourG: e.prevRGB.g,
                colourB: e.prevRGB.b
            } });
        } else {
            await Pixel.remove({ xPos: e.x, yPos: e.y });
        }
    }

    // Кеш картинки доски: без удаления сервер при старте возьмёт старую картинку и не сотрёт очищенные клетки
    const cache = path.resolve(__dirname, "../.place-data/cached-board-image.png");
    if (fs.existsSync(cache)) {
        fs.unlinkSync(cache);
        console.log("Удалён кеш картинки доски (.place-data/cached-board-image.png) - при старте доска пересоберётся из БД.");
    }
    console.log(`Готово. Откачено клеток: ${plan.length}. Теперь можно запускать сервер.`);
}

// process.exit обязателен: модели держат фоновые таймеры, и процесс иначе не завершится
main().then(() => mongoose.disconnect()).then(() => process.exit(0)).catch((err) => {
    console.error(err);
    mongoose.disconnect().then(() => process.exit(1), () => process.exit(1));
});
