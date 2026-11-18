// Build an offline puzzle pack for the tablet PWA, using the same weakspot
// picker as the app: Adaptive picks near your rating, then a Focus block.
//
//   node tools/offline-puzzles/make-pack.mts [--count 40] [--focus 10]
//
// Writes tools/offline-puzzles/public/pack.json. Puzzles already in the
// attempt log are skipped. The puzzle DB is opened read-only.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildModel, parseAttemptLog, pickNext } from "../../src/utils/weakspot.ts";

const here = dirname(fileURLToPath(import.meta.url));
const appData = join(process.env.APPDATA ?? "", "org.encroissant.app");
const { values: args } = parseArgs({
  options: {
    count: { type: "string", default: "40" },
    focus: { type: "string", default: "10" },
    db: { type: "string", default: join(appData, "puzzles", "Lichess Puzzles 2026.db3") },
    log: { type: "string", default: join(appData, "weakspot", "puzzle-attempts.jsonl") },
    out: { type: "string", default: join(here, "public", "pack.json") },
  },
});
const count = Number(args.count);
const focusCount = Math.min(Number(args.focus), count);

const attempts = existsSync(args.log) ? parseAttemptLog(readFileSync(args.log, "utf8")) : [];
const model = buildModel(attempts);
const seen = new Set(attempts.map((a) => a.puzzleId));

const db = new DatabaseSync(args.db, { readOnly: true });
const linksPath = args.db.replace(/\.[^.\\/]+$/, ".links.sqlite");
const links = existsSync(linksPath) ? new DatabaseSync(linksPath, { readOnly: true }) : null;
const available = new Set(
  (db.prepare("SELECT name FROM themes").all() as { name: string }[]).map((r) => r.name),
);

const byTheme = db.prepare(
  `SELECT p.id, p.fen, p.moves, p.rating FROM puzzle_themes pt JOIN puzzles p ON p.id = pt.puzzle_id
   WHERE pt.theme_id = (SELECT id FROM themes WHERE name = ?) AND p.rating BETWEEN ? AND ?
   ORDER BY random() LIMIT 30`,
);
const anyTheme = db.prepare(
  `SELECT p.id, p.fen, p.moves, p.rating FROM puzzles p WHERE p.rating BETWEEN ? AND ?
   ORDER BY random() LIMIT 30`,
);
const themesOf = db.prepare(
  `SELECT t.name FROM themes t JOIN puzzle_themes pt ON t.id = pt.theme_id
   WHERE pt.puzzle_id = ? ORDER BY t.name`,
);
const linkOf = links?.prepare("SELECT lichess_id, game_url FROM links WHERE puzzle_id = ?");

type Row = { id: number; fen: string; moves: string; rating: number };
const puzzles = [];
for (let i = 0; i < count; i++) {
  const mode = i < count - focusCount ? "adaptive" : "focus";
  const pick = pickNext(model, mode, available);
  const [lo, hi] = pick.range;
  const rows = (pick.theme ? byTheme.all(pick.theme, lo, hi) : anyTheme.all(lo, hi)) as Row[];
  const row = rows.find((r) => !seen.has(r.id));
  if (!row) {
    i--; // unlucky draw; try again
    continue;
  }
  seen.add(row.id);
  const link = linkOf?.get(row.id) as { lichess_id: string; game_url: string } | undefined;
  puzzles.push({
    id: row.id,
    fen: row.fen,
    moves: row.moves.split(" "),
    rating: row.rating,
    themes: (themesOf.all(row.id) as { name: string }[]).map((t) => t.name),
    block: mode,
    pickedTheme: pick.theme,
    lichessId: link?.lichess_id ?? null,
    gameUrl: link?.game_url ?? null,
  });
}

const pack = {
  id: new Date().toISOString(),
  db: args.db.split(/[\\/]/).pop(),
  rating: model.rating,
  attemptsSoFar: model.attempts,
  puzzles,
};
writeFileSync(args.out, JSON.stringify(pack));
const themes: Record<string, number> = {};
for (const p of puzzles) if (p.pickedTheme) themes[p.pickedTheme] = (themes[p.pickedTheme] ?? 0) + 1;
console.log(
  `pack ${pack.id}: ${puzzles.length} puzzles (${count - focusCount} adaptive, ${focusCount} focus), ` +
    `your rating ${model.rating}, ratings ${Math.min(...puzzles.map((p) => p.rating))}-${Math.max(...puzzles.map((p) => p.rating))}, ` +
    `linked ${puzzles.filter((p) => p.gameUrl).length}`,
);
console.log("drilled themes:", themes);
