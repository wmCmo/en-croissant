// Keeps the Cloudflare relay and the PC in step, every minute:
// - attempts the phone sent to the relay go through the local server's
//   /api/attempts (same dedupe, log and pack refill as a direct sync), then
//   are acknowledged so the relay forgets them;
// - the current pack and which of its puzzles are logged are pushed to the
//   relay, so a device that can't reach the PC still gets new packs and skips
//   puzzles another device did.
// Config: public/relay.json { url, token } (gitignored; the app reads it too).
// `node relay-sync.mjs approve <code>` pairs a device opened on the Worker.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAttemptLog } from "../../src/utils/weakspot.ts";
import { computeStats } from "./stats.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(here, "public");
const LOCAL = process.env.LOCAL_SERVER ?? "http://127.0.0.1:8771";
const LOG =
  process.env.WEAKSPOT_LOG ??
  join(process.env.APPDATA ?? "", "org.encroissant.app", "weakspot", "puzzle-attempts.jsonl");
const PACK = process.env.OFFLINE_PACK ?? join(publicDir, "pack.json");
const EVERY_MS = Number(process.env.RELAY_EVERY_MS ?? 60_000);

const { url, token } = JSON.parse(readFileSync(join(publicDir, "relay.json"), "utf8"));
const auth = { authorization: `Bearer ${token}` };

async function relay(method, path, body) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: body ? { ...auth, "content-type": "application/json" } : auth,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
  return res.json();
}

function currentState() {
  const pack = JSON.parse(readFileSync(PACK, "utf8"));
  const inPack = new Set(pack.puzzles.map((p) => p.id));
  const done = {};
  if (existsSync(LOG)) {
    for (const line of readFileSync(LOG, "utf8").split(/\r?\n/)) {
      try {
        const a = JSON.parse(line);
        if (inPack.has(a.puzzleId) && !(a.puzzleId in done)) done[a.puzzleId] = a.solved;
      } catch {}
    }
  }
  const stats = existsSync(LOG) ? computeStats(parseAttemptLog(readFileSync(LOG, "utf8"))) : null;
  return { packId: pack.id, done, pack, stats };
}

let lastPushed = "";
async function tick() {
  const { attempts } = await relay("GET", "/pending");
  if (attempts.length) {
    const res = await fetch(`${LOCAL}/api/attempts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attempts }),
    });
    if (!res.ok) throw new Error(`local sync: HTTP ${res.status}`);
    const { added, skipped } = await res.json();
    await relay("POST", "/ack", { ids: [...added, ...skipped].filter(Number.isInteger) });
    console.log(`${new Date().toISOString()} relay: +${added.length}, skipped ${skipped.length}`);
  }
  const state = currentState();
  const key = JSON.stringify([state.packId, state.done, state.stats?.attempts]);
  if (key !== lastPushed) {
    await relay("PUT", "/state", state);
    lastPushed = key;
    console.log(`${new Date().toISOString()} relay: state pushed (${Object.keys(state.done).length}/${state.pack.puzzles.length} done)`);
  }
}

async function loop() {
  try {
    await tick();
  } catch (err) {
    console.error(`${new Date().toISOString()} relay error: ${err.message}`);
  }
  setTimeout(loop, EVERY_MS);
}

// puzzles from your own Chess.com games, checked hourly (from-games.mjs)
const GAMES_EVERY_MS = Number(process.env.GAMES_EVERY_MS ?? 3_600_000);
function checkGames() {
  execFile(process.execPath, [join(here, "from-games.mjs")], { cwd: here, timeout: 30 * 60_000 }, (err, stdout, stderr) => {
    const out = (stdout || "").trim().split("\n").at(-1);
    if (err) console.error(`${new Date().toISOString()} games error: ${err.message} ${stderr}`);
    else console.log(`${new Date().toISOString()} games: ${out}`);
    setTimeout(checkGames, GAMES_EVERY_MS);
  });
}

if (process.argv[2] === "approve") {
  // pair a device that shows this code: node relay-sync.mjs approve 123456
  const res = await relay("POST", "/approve", { code: process.argv[3] }).catch((e) => ({ error: e.message }));
  console.log(res.ok ? "approved" : `not approved: ${res.error}`);
} else {
  console.log(`relay-sync: ${url} every ${EVERY_MS / 1000}s`);
  loop();
  checkGames();
}
