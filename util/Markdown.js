const marked = require("marked"),
    renderer = new marked.Renderer();

renderer.code = function(code, lang) {
    if (lang == "lead") return "<p class=\"lead\">" + code + "</p>";
    if (lang == "muted-lead") return "<p class=\"lead text-muted\">" + code + "</p>";
    if (lang == "small") return "<small>" + code + "</small>";
    if (lang == "small-muted") return "<small class=\"text-muted\">" + code + "</small>";
    if (lang == "term") return "<span class=\"term\">" + code + "</span>";
    return new marked.Renderer().code.apply(this, arguments);
};

marked.setOptions({
    renderer: renderer
});

// В marked >= 4 CommonJS-экспорт - объект, а сама функция лежит в marked.marked
module.exports = typeof marked === "function" ? marked : marked.marked;