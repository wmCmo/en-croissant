// Stockfish over UCI, shared by from-games.mjs and threats.mjs.
import { spawn } from "node:child_process";
import { join } from "node:path";

export const ENGINE =
  process.env.STOCKFISH ??
  join(process.env.APPDATA ?? "", "org.encroissant.app", "engines", "stockfish", "stockfish-windows-x86-64-avx2.exe");
export const NODES = Number(process.env.PUZZLE_NODES ?? 1_000_000); // nodes, not time: same quality when the CPU is busy

export class Engine {
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

export function winChance({ kind, v }) {
  if (kind === "mate") return v > 0 ? 1 : -1;
  return 2 / (1 + Math.exp(-0.00368208 * v)) - 1;
}

