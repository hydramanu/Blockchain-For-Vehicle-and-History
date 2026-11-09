import { copyFile, mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tesseractPackage = require.resolve("tesseract.js/package.json");
const tesseractDir = dirname(tesseractPackage);
const coreDir = dirname(createRequire(tesseractPackage).resolve("tesseract.js-core/package.json"));
const languageDir = dirname(require.resolve("@tesseract.js-data/eng/package.json"));
const outputDir = fileURLToPath(new URL("../frontend/public/tesseract/", import.meta.url));
const coreOutput = join(outputDir, "core");
const languageOutput = join(outputDir, "lang");

await Promise.all([
  mkdir(coreOutput, { recursive: true }),
  mkdir(languageOutput, { recursive: true }),
]);

const coreFiles = (await readdir(coreDir)).filter((name) => /\.wasm(?:\.js)?$/.test(name));

await Promise.all([
  ...coreFiles.map((name) => copyFile(join(coreDir, name), join(coreOutput, name))),
  copyFile(join(coreDir, "LICENSE"), join(coreOutput, "LICENSE")),
  copyFile(join(tesseractDir, "dist", "worker.min.js"), join(outputDir, "worker.min.js")),
  copyFile(
    join(tesseractDir, "dist", "worker.min.js.LICENSE.txt"),
    join(outputDir, "worker.min.js.LICENSE.txt"),
  ),
  copyFile(
    join(languageDir, "4.0.0_best_int", "eng.traineddata.gz"),
    join(languageOutput, "eng.traineddata.gz"),
  ),
]);
