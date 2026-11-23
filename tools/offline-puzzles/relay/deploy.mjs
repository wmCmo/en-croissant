// Copy the app shell (not pack.json or relay.json) into site/ and deploy the Worker.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const site = join(here, "site");
const SHELL = ["index.html", "app.js", "sw.js", "pieces.css", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

rmSync(site, { recursive: true, force: true });
mkdirSync(site);
for (const f of SHELL) copyFileSync(join(here, "..", "public", f), join(site, f));
execSync("npx -y wrangler@4 deploy", { cwd: here, stdio: "inherit" });
