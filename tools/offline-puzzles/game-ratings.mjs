// Your Chess.com game ratings for the Progress screen: every game of the
// last 24 months as [endTimeSecs, yourRating, timeClass, result], cached in
// game-ratings.json (gitignored). Past months are fetched once; the current
// month is refreshed on every run. Run hourly by relay-sync.mjs.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const CACHE = join(here, "game-ratings.json");
const USER = process.env.CHESSCOM_USER ?? "wmcmo";
const MONTHS = 24;

async function getJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "offline-puzzles/1.0" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export function readGameRatings() {
  if (!existsSync(CACHE)) return [];
  const { months } = JSON.parse(readFileSync(CACHE, "utf8"));
  return Object.values(months).flat().sort((a, b) => a[0] - b[0]);
}

// run directly (not when imported for readGameRatings)
if (process.argv[1]?.endsWith("game-ratings.mjs")) {
  const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : { months: {} };
  const now = new Date();
  const current = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const oldest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - MONTHS + 1, 1));
  const { archives } = await getJson(`https://api.chess.com/pub/player/${USER}/games/archives`);
  let fetched = 0;
  for (const url of archives) {
    const month = url.match(/(\d{4}\/\d{2})$/)?.[1];
    if (!month || new Date(`${month.replace("/", "-")}-01T00:00:00Z`) < oldest) continue;
    if (cache.months[month] && month !== current) continue;
    const { games } = await getJson(url);
    cache.months[month] = games
      .filter((g) => g.rules === "chess")
      .map((g) => {
        const side = g.white.username.toLowerCase() === USER.toLowerCase() ? g.white : g.black;
        return [g.end_time, side.rating, g.time_class, side.result];
      });
    fetched++;
  }
  writeFileSync(CACHE, JSON.stringify(cache));
  console.log(`game ratings: ${readGameRatings().length} games cached (${fetched} month(s) fetched)`);
}
