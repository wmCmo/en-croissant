// Spaced review of missed puzzles: a puzzle you missed comes back after 1
// day; solve it and it comes back after 3, then 7 days, then it's done. Miss
// a review and it starts again at 1 day.
//
// Review attempts carry `reviewOf` (the original puzzle id) and go to their
// own log, so they never count toward your rating or theme stats (you've seen
// the answer before).

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const REVIEW_LOG =
  process.env.REVIEW_LOG ??
  join(process.env.APPDATA ?? "", "org.encroissant.app", "weakspot", "review-attempts.jsonl");
const DAY = 86_400_000;
export const INTERVALS = [1, 3, 7]; // days before review stage 0, 1, 2

/** Distinct id per (puzzle, stage) so a review is its own pack entry. */
export function reviewId(orig, stage) {
  const key = orig >= 900_000_000 ? 9_000_000 + (orig - 900_000_000) : orig;
  return 800_000_000 + key * 10 + stage;
}

export function readJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    try {
      if (line.trim()) out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/** Append review attempts not already logged (same puzzleId and ts). Returns the ids taken. */
export function logReviews(attempts) {
  const have = new Set(readJsonl(REVIEW_LOG).map((a) => `${a.puzzleId}@${a.ts}`));
  let lines = "";
  const taken = [];
  for (const a of attempts) {
    taken.push(a.puzzleId);
    const key = `${a.puzzleId}@${a.ts}`;
    if (have.has(key)) continue;
    have.add(key);
    lines += `${JSON.stringify(a)}\n`;
  }
  if (lines) appendFileSync(REVIEW_LOG, lines);
  return taken;
}

/** Reviews that are due now: [{ orig, stage, due }], most overdue first. */
export function dueReviews(mainAttempts, reviewAttempts = readJsonl(REVIEW_LOG), now = Date.now()) {
  const first = new Map();
  for (const a of [...mainAttempts].sort((x, y) => x.ts.localeCompare(y.ts))) {
    if (!first.has(a.puzzleId)) first.set(a.puzzleId, a);
  }
  const byOrig = new Map();
  for (const r of reviewAttempts) {
    if (!byOrig.has(r.reviewOf)) byOrig.set(r.reviewOf, []);
    byOrig.get(r.reviewOf).push(r);
  }
  const due = [];
  for (const [orig, a] of first) {
    if (a.solved) continue;
    let stage = 0;
    let last = Date.parse(a.ts);
    for (const r of (byOrig.get(orig) ?? []).sort((x, y) => x.ts.localeCompare(y.ts))) {
      stage = r.solved ? stage + 1 : 0;
      last = Date.parse(r.ts);
    }
    if (stage >= INTERVALS.length) continue; // learned
    const at = last + INTERVALS[stage] * DAY;
    if (at <= now) due.push({ orig, stage, due: at });
  }
  return due.sort((x, y) => x.due - y.due);
}
