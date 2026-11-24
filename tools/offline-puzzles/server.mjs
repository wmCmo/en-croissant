// Serves the offline puzzle PWA and receives results from the tablet.
//
//   node tools/offline-puzzles/server.mjs
//
// Binds 127.0.0.1 only; reach it from the tablet through Tailscale:
//   tailscale serve --bg --https=8446 http://127.0.0.1:8771
// Results are appended to the same attempt log En Croissant uses. When a
// sync leaves every puzzle of the current pack logged, a fresh pack is built
// (make-pack.mts) so the tablet picks it up next time it is online.
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { logReviews } from "./review.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(here, "public");
const PORT = Number(process.env.PORT ?? 8771);
const LOG =
  process.env.WEAKSPOT_LOG ??
  join(process.env.APPDATA ?? "", "org.encroissant.app", "weakspot", "puzzle-attempts.jsonl");
const PACK = process.env.OFFLINE_PACK ?? join(publicDir, "pack.json");
const PACK_ARGS = ["--count", process.env.PACK_COUNT ?? "40", "--focus", process.env.PACK_FOCUS ?? "20"];

function readPack() {
  try {
    return JSON.parse(readFileSync(PACK, "utf8"));
  } catch {
    return null;
  }
}

let building = null;
/** Build a new pack if every puzzle in the current one is logged. Returns the pack id in use. */
function refillIfFinished(ids) {
  const pack = readPack();
  const finished = !pack || pack.puzzles.every((p) => ids.has(p.id));
  if (!finished) return Promise.resolve(pack.id);
  building ??= new Promise((resolve) => {
    const script = join(here, "make-pack.mts");
    execFile(
      process.execPath,
      [script, ...PACK_ARGS, "--log", LOG, "--out", PACK],
      { timeout: 120_000 },
      (err, stdout, stderr) => {
        if (err) console.error("refill failed:", err.message, stderr);
        else console.log(`${new Date().toISOString()} refill: ${stdout.trim().split("\n")[0]}`);
        building = null;
        resolve(readPack()?.id ?? null);
      },
    );
  });
  return building;
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8",
};

function loggedIds() {
  if (!existsSync(LOG)) return new Set();
  const ids = new Set();
  for (const line of readFileSync(LOG, "utf8").split(/\r?\n/)) {
    try {
      ids.add(JSON.parse(line).puzzleId);
    } catch {}
  }
  return ids;
}

function valid(a) {
  return (
    a &&
    a.v === 1 &&
    a.source === "offline" &&
    Number.isInteger(a.puzzleId) &&
    Number.isInteger(a.rating) &&
    Array.isArray(a.themes) &&
    typeof a.solved === "boolean" &&
    typeof a.ts === "string" &&
    typeof a.totalMs === "number"
  );
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-cache" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "POST" && url.pathname === "/api/attempts") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      let attempts;
      try {
        attempts = JSON.parse(body).attempts;
      } catch {
        return send(res, 400, { error: "bad json" });
      }
      if (!Array.isArray(attempts)) return send(res, 400, { error: "attempts must be an array" });
      // reviews of missed puzzles go to their own log (review.mjs)
      const reviewed = logReviews(attempts.filter((a) => valid(a) && Number.isInteger(a.reviewOf)));
      attempts = attempts.filter((a) => !Number.isInteger(a?.reviewOf));
      const ids = loggedIds();
      const added = [...reviewed];
      const skipped = [];
      let lines = "";
      for (const a of attempts) {
        // already logged (an earlier sync) counts as synced, not as an error
        if (!valid(a) || ids.has(a.puzzleId)) {
          skipped.push(a?.puzzleId);
          continue;
        }
        ids.add(a.puzzleId);
        added.push(a.puzzleId);
        lines += `${JSON.stringify(a)}\n`;
      }
      if (lines) appendFileSync(LOG, lines);
      console.log(`${new Date().toISOString()} sync: +${added.length}, skipped ${skipped.length}`);
      refillIfFinished(ids).then((packId) => send(res, 200, { added, skipped, packId }));
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/done") {
    // puzzles of the current pack already logged (from any device), so another
    // device doesn't serve them again: { packId, done: { [puzzleId]: solved } }
    const pack = readPack();
    const inPack = new Set(pack?.puzzles.map((p) => p.id) ?? []);
    const done = {};
    if (existsSync(LOG)) {
      for (const line of readFileSync(LOG, "utf8").split(/\r?\n/)) {
        try {
          const a = JSON.parse(line);
          if (inPack.has(a.puzzleId) && !(a.puzzleId in done)) done[a.puzzleId] = a.solved;
        } catch {}
      }
    }
    return send(res, 200, { packId: pack?.id ?? null, done });
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, { ok: true, logged: loggedIds().size });
  }
  if (req.method !== "GET") return send(res, 405, { error: "method" });
  if (url.pathname === "/pack.json") {
    return existsSync(PACK) ? send(res, 200, readFileSync(PACK), TYPES[".json"]) : send(res, 404, { error: "no pack" });
  }
  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const file = normalize(join(publicDir, rel));
  if (!file.startsWith(publicDir) || !existsSync(file)) return send(res, 404, { error: "not found" });
  send(res, 200, readFileSync(file), TYPES[extname(file)] ?? "application/octet-stream");
}).listen(PORT, "127.0.0.1", () => {
  console.log(`offline puzzles on http://127.0.0.1:${PORT}  log: ${LOG}`);
});
