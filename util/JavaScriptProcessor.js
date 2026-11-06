const fs = require("fs");
const path = require("path");
const babel = require("babel-core");
const UglifyJS = require("uglify-js");

// Собирает client/js/*.js в public/js/build (babel es2015-2017, в продакшене ещё и минификация).
// Раньше это делал gulp 3, который не работает на современной Node.
class JavaScriptProcessor {
    constructor(app) {
        this.app = app;
        this.srcDir = path.resolve(__dirname, "../client/js");
        this.builtDir = path.resolve(__dirname, "../public/js/build");
    }

    processJavaScript() {
        this.app.logger.info('Babel', "Processing JavaScript…");
        try {
            fs.mkdirSync(this.builtDir, { recursive: true });
            fs.readdirSync(this.srcDir).filter((f) => f.endsWith(".js")).forEach((file) => {
                try {
                    const src = fs.readFileSync(path.join(this.srcDir, file), "utf8");
                    const debug = !!this.app.config.debug;
                    const result = babel.transform(src, { presets: ["es2015", "es2016", "es2017"], filename: file, sourceMaps: debug });
                    let code = result.code;
                    if (debug) {
                        code += "\n//# sourceMappingURL=" + file + ".map";
                        fs.writeFileSync(path.join(this.builtDir, file + ".map"), JSON.stringify(result.map));
                    } else {
                        code = UglifyJS.minify(code, { fromString: true }).code;
                    }
                    fs.writeFileSync(path.join(this.builtDir, file), code);
                } catch (err) {
                    this.app.reportError("Error while processing JavaScript (" + file + "): " + err);
                }
            });
            this.app.logger.info('Babel', "Finished processing JavaScript.");
        } catch (err) {
            this.app.reportError("Error while processing JavaScript: " + err);
        }
    }

    cleanJavaScript() {
        fs.rmSync(this.builtDir, { recursive: true, force: true });
    }

    watchJavaScript() {}
}

JavaScriptProcessor.prototype = Object.create(JavaScriptProcessor.prototype);

module.exports = JavaScriptProcessor;
