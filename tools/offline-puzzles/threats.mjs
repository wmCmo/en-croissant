// "What's your opponent threatening?" cards, from Lichess puzzles seen from
// the other side. A Lichess puzzle starts with a mistake (its first move)
// that the solver then punishes. Here you play the side about to make that
// mistake: find a safe move. Any move within SAFE of the engine's best counts
// (every legal move is analysed); the mistake itself never does. Afterwards
// the card shows the real mistake and how it was punished.
//
// Keeps threat-cards.json (gitignored) topped up to TARGET unplayed cards,
// drawn from your weak themes near your rating; make-pack.mts puts a few in
// each pack. Run hourly by relay-sync.mjs.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseFen } from "chessops/fen";
import { Chess } from "chessops/chess";
import { buildModel, parseAttemptLog, stubbornThemes } from "../../src/utils/weakspot.ts";
import { ENGINE, Engine, NODES } from "./engine.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const appData = join(process.env.APPDATA ?? "", "org.encroissant.app");
const QUEUE = join(here, "threat-cards.json");
const LOG = process.env.WEAKSPOT_LOG ?? join(appData, "weakspot", "puzzle-attempts.jsonl");
const DB = join(appData, "puzzles", "Lichess Puzzles 2026.db3");
const TARGET = 15;
const SAFE = 0.2;
const MIN_BEST = -0.15;
const ID_BASE = 700_000_000;
// tactics you have to see coming; your stubborn themes are tried first
const DEFENCE_THEMES = ["pin", "skewer", "fork", "discoveredAttack", "capturingDefender", "hangingPiece", "trappedPiece", "deflection", "attraction"];

const attempts = existsSync(LOG) ? parseAttemptLog(readFileSync(LOG, "utf8")) : [];
const model = buildModel(attempts);
const logged = new Set(attempts.map((a) => a.puzzleId));
const queue = existsSync(QUEUE) ? JSON.parse(readFileSync(QUEUE, "utf8")) : { cards: [] };
queue.cards = queue.cards.filter((c) => !logged.has(c.id));
const need = TARGET - queue.cards.length;
if (need <= 0) {
  console.log(`threat cards: ${queue.cards.length} ready`);
} else {
  const themes = [...new Set([...stubbornThemes(model, 3), ...DEFENCE_THEMES])].filter((t) => DEFENCE_THEMES.includes(t));
  const db = new DatabaseSync(DB, { readOnly: true });
  const pick = db.prepare(
    `SELECT p.id, p.fen, p.moves, p.rating FROM puzzle_themes pt JOIN puzzles p ON p.id = pt.puzzle_id
     WHERE pt.theme_id = (SELECT id FROM themes WHERE name = ?) AND p.rating BETWEEN ? AND ?
     ORDER BY random() LIMIT 6`,
  );
  const themesOf = db.prepare(
    "SELECT t.name FROM themes t JOIN puzzle_themes pt ON t.id = pt.theme_id WHERE pt.puzzle_id = ? ORDER BY t.name",
  );
  const engine = new Engine(ENGINE);
  await engine.init();
  const have = new Set(queue.cards.map((c) => c.id));
  let made = 0;
  for (let round = 0; made < need && round < need * 3; round++) {
    const theme = themes[round % themes.length];
    const rows = pick.all(theme, model.rating - 200, model.rating + 100);
    for (const row of rows) {
      const id = ID_BASE + row.id;
      if (have.has(id) || logged.has(id)) continue;
      const moves = row.moves.split(" ");
      const all = await engine.analyse(row.fen, 64, NODES * 3);
      const best = all[0];
      if (!best || best.wc < MIN_BEST) continue;
      const accept = all.filter((l) => l.wc >= best.wc - SAFE).map((l) => l.move);
      if (accept.includes(moves[0]) || accept.length === 0) continue;
      const legal = Chess.fromSetup(parseFen(row.fen).unwrap()).unwrap();
      queue.cards.push({
        id,
        fen: row.fen,
        moves: [null, best.move],
        noSetup: true,
        accept,
        refute: moves.slice(0, 4),
        rating: model.rating,
        sourceRating: row.rating,
        themes: ["threat", ...themesOf.all(row.id).map((t) => t.name)],
        block: "threat",
        pickedTheme: theme,
        lichessId: null,
        gameUrl: null,
        toMove: legal.turn,
      });
      have.add(id);
      made++;
      break;
    }
  }
  engine.quit();
  writeFileSync(QUEUE, JSON.stringify(queue, null, 1));
  console.log(`threat cards: made ${made}, ${queue.cards.length} ready`);
}
