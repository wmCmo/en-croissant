// Turn your own Chess.com games into puzzles.
//
// For every position in a new game where it was your move, Stockfish looks at
// its top two moves. It becomes a puzzle when exactly one move was good (the
// best move's winning chances beat the second best's by GAP or more), that move
// reaches at least roughly equal, and you didn't play it: a win you missed or
// a save you missed. The line then continues while each of your moves is still
// the only good one, and stops once several moves work (the advantage is
// cashed in) or the game is over.
//
// New puzzles are queued in game-puzzles.json (gitignored); make-pack.mts puts
// queued ones that aren't logged yet at the front of the next pack.
//
//   node from-games.mjs                      new games since the last run
//   node from-games.mjs --dry --archive <url of a monthly archive> --limit 1
//                                            test on old games, saving nothing

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { makeUci, parseUci } from "chessops";
import { makeFen, parseFen } from "chessops/fen";
import { parsePgn, startingPosition } from "chessops/pgn";
import { parseSan } from "chessops/san";
import { parseAttemptLog, playerRating } from "../../src/utils/weakspot.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const STATE = join(here, "game-puzzles.json");
const USER = process.env.CHESSCOM_USER ?? "wmcmo";
const LOG =
  process.env.WEAKSPOT_LOG ??
  join(process.env.APPDATA ?? "", "org.encroissant.app", "weakspot", "puzzle-attempts.jsonl");
const ENGINE =
  process.env.STOCKFISH ??
  join(process.env.APPDATA ?? "", "org.encroissant.app", "engines", "stockfish", "stockfish-windows-x86-64-avx2.exe");
const NODES = Number(process.env.PUZZLE_NODES ?? 1_000_000); // nodes, not time: same quality when the CPU is busy
const GAP = 0.4; // winning-chance gap (on a -1..1 scale) between best and second best
const MIN_BEST = -0.15; // the only move must reach at least about equal
const MAX_PLIES = 12;
const ID_BASE = 900_000_000; // far above Lichess puzzle ids

const args = parseArgs({
  options: { dry: { type: "boolean", default: false }, archive: { type: "string" }, limit: { type: "string" } },
}).values;

// ---- engine (UCI over stdin/stdout) ----
class Engine {
  constructor(path) {
    this.p = spawn(path, [], { stdio: ["pipe", "pipe", "ignore"] });
    this.buf = "";
    this.waiters = [];
    this.p.stdout.on("data", (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        for (const w of [...this.waiters]) w(line);
      }
    });
  }
  send(cmd) {
    this.p.stdin.write(`${cmd}\n`);
  }
  until(pred, onLine = () => {}) {
    return new Promise((resolve) => {
      const w = (line) => {
        onLine(line);
        if (pred(line)) {
          this.waiters = this.waiters.filter((x) => x !== w);
          resolve(line);
        }
      };
      this.waiters.push(w);
    });
  }
  async init() {
    this.send("uci");
    await this.until((l) => l === "uciok");
    this.send("setoption name Threads value 2");
    this.send("setoption name Hash value 128");
    this.send("setoption name MultiPV value 2");
    this.multipv = 2;
    this.send("isready");
    await this.until((l) => l === "readyok");
  }
  /**
   * Top `multipv` lines for a position: [{ move, pv, wc, mate }], wc = winning
   * chances for the side to move.
   */
  async analyse(fen, multipv = 2, nodes = NODES) {
    const lines = new Map();
    if (multipv !== this.multipv) {
      this.send(`setoption name MultiPV value ${multipv}`);
      this.multipv = multipv;
    }
    this.send(`position fen ${fen}`);
    this.send(`go nodes ${nodes}`);
    await this.until(
      (l) => l.startsWith("bestmove"),
      (l) => {
        const m = l.match(/ multipv (\d+) .*score (cp|mate) (-?\d+).* pv (.+)$/);
        if (m) lines.set(Number(m[1]), { kind: m[2], v: Number(m[3]), pv: m[4].trim().split(" ") });
      },
    );
    return [...lines.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, x]) => ({ move: x.pv[0], pv: x.pv, mate: x.kind === "mate" ? x.v : null, wc: winChance(x) }));
  }
  quit() {
    this.send("quit");
  }
}

function winChance({ kind, v }) {
  if (kind === "mate") return v > 0 ? 1 : -1;
  return 2 / (1 + Math.exp(-0.00368208 * v)) - 1;
}

const fenOf = (pos) => makeFen(pos.toSetup());
const play = (pos, uci) => {
  const next = pos.clone();
  next.play(parseUci(uci));
  return next;
};

// ---- Chess.com ----
async function getJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "offline-puzzles/1.0" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function newGames(sinceSecs) {
  if (args.archive) return (await getJson(args.archive)).games;
  const { archives } = await getJson(`https://api.chess.com/pub/player/${USER}/games/archives`);
  const since = new Date(sinceSecs * 1000);
  const fromMonth = since.getUTCFullYear() * 100 + since.getUTCMonth() + 1;
  const games = [];
  for (const url of archives) {
    const [, y, m] = url.match(/(\d{4})\/(\d{2})$/) ?? [];
    if (Number(y) * 100 + Number(m) < fromMonth) continue;
    games.push(...(await getJson(url)).games);
  }
  return games.filter((g) => g.end_time > sinceSecs);
}

// ---- puzzle finding ----
async function puzzlesFromGame(engine, game, rating, nextId) {
  if (game.rules !== "chess") return [];
  const pgn = parsePgn(game.pgn)[0];
  if (!pgn) return [];
  const me = game.white.username.toLowerCase() === USER.toLowerCase() ? "white" : "black";
  const start = startingPosition(pgn.headers).unwrap();
  const positions = [start];
  const moves = [];
  for (const node of pgn.moves.mainline()) {
    const pos = positions.at(-1);
    const mv = parseSan(pos, node.san);
    if (!mv) break;
    moves.push(makeUci(mv));
    positions.push(play(pos, moves.at(-1)));
  }
  const found = [];
  for (let i = 1; i < moves.length; i++) {
    const pos = positions[i];
    if (pos.turn !== me) continue;
    const lines = await engine.analyse(fenOf(pos));
    if (lines[0]?.move === moves[i]) continue;
    if (!isOnlyMove(lines)) {
      const card = await blunderCheck(engine, positions, moves, i, lines);
      if (card) found.push({ ...card, id: nextId + found.length, rating, gameUrl: game.url, gameEnded: new Date(game.end_time * 1000).toISOString() });
      continue;
    }
    const solution = await extend(engine, pos, lines[0].move);
    found.push({
      id: nextId + found.length,
      fen: fenOf(positions[i - 1]),
      moves: [moves[i - 1], ...solution],
      rating,
      themes: ["fromGame", ...(lines[0].mate != null && lines[0].mate > 0 ? ["mate"] : [])],
      block: "game",
      pickedTheme: null,
      lichessId: null,
      gameUrl: game.url,
      played: moves[i],
      gameEnded: new Date(game.end_time * 1000).toISOString(),
    });
    i += solution.length; // don't make a second puzzle out of the same idea
  }
  return found;
}

/**
 * A blunder-check card: you were at least about equal, several moves kept
 * that, and your move threw it away (winning chances down by DROP or more).
 * Every move that keeps the position (within SAFE of the best) is accepted.
 */
const DROP = 0.4;
const SAFE = 0.2;
async function blunderCheck(engine, positions, moves, i, lines) {
  const pos = positions[i];
  const best = lines[0];
  if (!best || best.wc < MIN_BEST) return null;
  const after = positions[i + 1];
  if (!after || after.isEnd()) return null;
  const [reply] = await engine.analyse(fenOf(after), 1);
  if (!reply || best.wc - -reply.wc < DROP) return null;
  // every legal move, so any safe move can be accepted
  const all = await engine.analyse(fenOf(pos), 64, NODES * 3);
  const accept = all.filter((l) => l.wc >= best.wc - SAFE).map((l) => l.move);
  if (accept.length === 0 || accept.includes(moves[i])) return null;
  return {
    fen: fenOf(positions[i - 1]),
    moves: [moves[i - 1], best.move],
    accept,
    refute: [moves[i], ...reply.pv.slice(0, 3)],
    themes: ["fromGame", "blunderCheck"],
    block: "check",
    pickedTheme: null,
    lichessId: null,
    played: moves[i],
    winBefore: Math.round((best.wc + 1) * 50),
    winAfter: Math.round((1 - reply.wc) * 50),
  };
}

function isOnlyMove(lines) {
  if (lines.length < 2) return false; // a forced move isn't a puzzle
  const [best, second] = lines;
  return best.wc >= MIN_BEST && best.wc - second.wc >= GAP;
}

/** The solution line: your only move, their best reply, and on while you still have an only move. */
async function extend(engine, pos, firstMove) {
  const line = [firstMove];
  let cur = play(pos, firstMove);
  // a repeated position means the draw (perpetual) is secured: stop there
  const key = (p) => fenOf(p).split(" ").slice(0, 4).join(" ");
  const seen = new Set([key(pos), key(cur)]);
  while (line.length + 2 <= MAX_PLIES && !cur.isEnd()) {
    const [reply] = await engine.analyse(fenOf(cur));
    if (!reply) break;
    const afterReply = play(cur, reply.move);
    if (afterReply.isEnd()) break;
    const mine = await engine.analyse(fenOf(afterReply));
    if (!isOnlyMove(mine)) break; // several moves work now: cashed in
    // a save that only holds the draw (e.g. perpetual check): two moves show the idea
    if (line.length >= 3 && mine[0].wc < 0.3) break;
    line.push(reply.move, mine[0].move);
    cur = play(afterReply, mine[0].move);
    if (seen.has(key(cur))) break;
    seen.add(key(afterReply)).add(key(cur));
  }
  return line;
}

// ---- main ----
const today = new Date();
today.setHours(0, 0, 0, 0);
const state = existsSync(STATE)
  ? JSON.parse(readFileSync(STATE, "utf8"))
  : { since: Math.floor(today.getTime() / 1000), seq: 0, puzzles: [] };

let games = await newGames(state.since);
games.sort((a, b) => a.end_time - b.end_time);
if (args.limit) games = games.slice(-Number(args.limit));
if (games.length === 0) {
  console.log(`no new games since ${new Date(state.since * 1000).toISOString()}`);
  // first run: remember today as the starting point
  if (!args.dry && !existsSync(STATE)) writeFileSync(STATE, JSON.stringify(state, null, 1));
} else {

const rating = existsSync(LOG) ? playerRating(parseAttemptLog(readFileSync(LOG, "utf8"))) : 1500;
const engine = new Engine(ENGINE);
await engine.init();
let added = 0;
for (const game of games) {
  const t0 = Date.now();
  const ps = await puzzlesFromGame(engine, game, rating, ID_BASE + state.seq + 1);
  console.log(`${game.url}: ${ps.length} puzzle(s) in ${Math.round((Date.now() - t0) / 1000)}s`);
  for (const p of ps) console.log(`  [${p.block}] ${p.fen} | ${p.moves.join(" ")} | you played ${p.played}${p.accept ? ` | ${p.accept.length} safe: ${p.accept.join(",")} | refute ${p.refute.join(" ")} | win% ${p.winBefore}->${p.winAfter}` : ""}`);
  if (!args.dry) {
    state.puzzles.push(...ps);
    state.seq += ps.length;
    state.since = Math.max(state.since, game.end_time);
    added += ps.length;
  }
}
engine.quit();
if (!args.dry) {
  writeFileSync(STATE, JSON.stringify(state, null, 1));
  console.log(`queued ${added} new puzzle(s); ${state.puzzles.length} in the queue`);
}
}
