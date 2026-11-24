// Bundle rules-entry.mjs (chessops) into public/rules.js for the tablet app.
// esbuild comes with Vite, so it's resolved from Vite's install.
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const require = createRequire(join(here, "../../package.json"));
const esbuild = require(require.resolve("esbuild", { paths: [join(require.resolve("vite/package.json"), "..")] }));
await esbuild.build({
  entryPoints: [join(here, "rules-entry.mjs")],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  outfile: join(here, "public", "rules.js"),
  absWorkingDir: join(here, "../.."),
});
console.log("built public/rules.js");
