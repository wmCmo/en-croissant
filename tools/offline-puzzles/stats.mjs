// Progress numbers for the app's Progress screen, worked out on the PC from
// the whole attempt log and sent to devices with the pack (relay state).

import { readGameRatings } from "./game-ratings.mjs";
import { BROAD_THEMES, META_THEMES, START_RATING, buildModel, expectedScore, speedFactor } from "../../src/utils/weakspot.ts";

// Radar groups: Lichess themes folded into six skills.
export const GROUPS = [
  ["Pins & skewers", ["pin", "skewer", "xRayAttack"]],
  ["Forks & double attacks", ["fork", "discoveredAttack", "discoveredCheck", "doubleCheck", "hangingPiece", "trappedPiece"]],
  ["Mating attacks", ["mate", "mateIn1", "mateIn2", "mateIn3", "mateIn4", "mateIn5", "kingsideAttack", "exposedKing", "backRankMate", "smotheredMate"]],
  ["Sacrifices & deflection", ["sacrifice", "deflection", "attraction", "capturingDefender", "interference", "clearance"]],
  ["Defence & quiet moves", ["defensiveMove", "quietMove", "zugzwang", "intermezzo"]],
  ["Endgames", ["endgame", "pawnEndgame", "rookEndgame", "bishopEndgame", "knightEndgame", "queenEndgame", "queenRookEndgame", "advancedPawn", "promotion"]],
];
const groupOf = (theme) => {
  if (theme.endsWith("Mate")) return 2;
  return GROUPS.findIndex(([, ts]) => ts.includes(theme));
};

/**
 * Solves vs what your CURRENT rating predicts for those puzzles, shrunk toward
 * par (1.0) by 3 puzzles. Judging both halves against the same rating means
 * the early half isn't flattered by the low starting rating (1400).
 */
function perf(list, rating) {
  const solved = list.reduce((a, x) => a + (x.solved ? 1 : 0), 0);
  const expected = list.reduce((a, x) => a + expectedScore(rating, x.rating), 0);
  return { n: list.length, score: (solved + 3) / (expected + 3) };
}

export function computeStats(attempts) {
  const sorted = [...attempts].sort((a, b) => a.ts.localeCompare(b.ts));
  // replay the rating (same rule as playerRating) to get each attempt's
  // rating before and after
  let r = START_RATING;
  const points = sorted.map((a, i) => {
    const k = i < 30 ? 40 : 20;
    const e = expectedScore(r, a.rating);
    const speed = a.source === "offline" ? 1 : speedFactor(a.totalMs);
    const before = r;
    r += a.solved ? k * (1 - e) * speed : -k * e;
    return { ...a, before, after: r, expected: e };
  });

  const half = Math.floor(points.length / 2);
  const early = points.slice(0, half);
  const late = points.slice(half);
  const radar = GROUPS.map(([name], gi) => {
    const inGroup = (p) => p.themes.some((t) => groupOf(t) === gi);
    return { name, start: perf(early.filter(inGroup), r), now: perf(late.filter(inGroup), r) };
  });

  const model = buildModel(sorted);
  const themes = model.themes
    .filter((t) => !META_THEMES.has(t.theme) && !BROAD_THEMES.has(t.theme) && t.attempts >= 2)
    .map((t) => ({
      theme: t.theme,
      n: t.attempts,
      solved: t.solved,
      vsExpected: Math.round(t.vsExpected * 100) / 100,
      trend: t.trend ? Math.round((t.trend.late - t.trend.early) * 100) / 100 : null,
    }))
    .sort((a, b) => a.vsExpected - b.vsExpected);

  const misses = points.filter((p) => !p.solved && p.failReason === "wrong_move");
  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const thinkSecs = (list) => median(list.filter((p) => p.firstMoveMs).map((p) => Math.round(p.firstMoveMs / 1000)));

  return {
    at: new Date().toISOString(),
    attempts: points.length,
    rating: Math.round(r),
    series: points.map((p) => [p.ts, Math.round(p.after), p.rating, p.solved ? 1 : 0]),
    split: { start: early.at(-1)?.ts ?? null },
    radar,
    themes,
    // Chess.com games: [endTimeSecs, yourRating, timeClass, result]
    games: readGameRatings(),
    misses: {
      total: points.filter((p) => !p.solved).length,
      firstMove: misses.filter((p) => p.failedAtPly === 1).length,
      later: misses.filter((p) => p.failedAtPly > 1).length,
      gaveUp: points.filter((p) => !p.solved && p.failReason !== "wrong_move").length,
      thinkSolved: thinkSecs(points.filter((p) => p.solved)),
      thinkMissed: thinkSecs(misses),
    },
  };
}
