// Weakspot: per-theme puzzle weakness model built from logged attempts.
// Pure functions only; storage lives in weakspotLog.ts.

export type FailReason = "wrong_move" | "hint" | "solution";

export interface PuzzleAttempt {
    v: 1;
    /** ISO timestamp when the attempt was resolved */
    ts: string;
    puzzleId: number;
    /** puzzle database file name */
    db: string;
    rating: number;
    themes: string[];
    solved: boolean;
    failReason: FailReason | null;
    /** first wrong move played (UCI), if any */
    wrongMove: string | null;
    /** the move the solution expected at that point (UCI) */
    expectedMove: string | null;
    /** index into the puzzle's move list where the attempt failed */
    failedAtPly: number | null;
    /** ms from puzzle shown to the user's first move; null if no move was made */
    firstMoveMs: number | null;
    /** ms from puzzle shown to solved / failed */
    totalMs: number;
}

/** Lichess source/length tags that describe the puzzle, not a tactic. */
export const META_THEMES = new Set([
    "short",
    "long",
    "veryLong",
    "oneMove",
    "master",
    "masterVsMaster",
    "superGM",
    "playerGames",
]);

/** Elo expected score of a player rated `player` against a puzzle rated `puzzle`. */
export function expectedScore(player: number, puzzle: number): number {
    return 1 / (1 + 10 ** ((puzzle - player) / 400));
}

/**
 * Maximum-likelihood puzzle rating from attempts (Newton's method on the
 * Elo logistic). Returns null with no attempts; clamps when every attempt
 * was solved or failed (the MLE is unbounded then).
 */
export function estimateRating(
    attempts: Pick<PuzzleAttempt, "rating" | "solved">[],
): number | null {
    if (attempts.length === 0) return null;
    const mean = attempts.reduce((a, x) => a + x.rating, 0) / attempts.length;
    const solved = attempts.filter((a) => a.solved).length;
    if (solved === 0) return Math.round(mean - 400);
    if (solved === attempts.length) return Math.round(mean + 400);
    const k = Math.LN10 / 400;
    let r = mean;
    for (let i = 0; i < 50; i++) {
        let grad = 0;
        let hess = 0;
        for (const a of attempts) {
            const e = expectedScore(r, a.rating);
            grad += (a.solved ? 1 : 0) - e;
            hess += e * (1 - e);
        }
        const step = grad / (k * hess);
        r += Math.max(-200, Math.min(200, step));
        if (Math.abs(step) < 0.1) break;
    }
    return Math.round(Math.max(mean - 800, Math.min(mean + 800, r)));
}

function median(xs: number[]): number | null {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface ThemeStat {
    theme: string;
    attempts: number;
    solved: number;
    /** raw success rate */
    rate: number;
    /** success rate shrunk toward the overall rate (Beta prior) */
    adjustedRate: number;
    /** (actual - expected) solves per attempt given the estimated rating, shrunk toward 0 */
    vsExpected: number;
    avgRating: number;
    medianSolveMs: number | null;
    /** success rate of the older half and newer half of attempts; null if < minTrend attempts */
    trend: { early: number; late: number } | null;
}

export interface ModelOptions {
    /** pseudo-attempts of prior weight; higher = more shrinkage */
    priorStrength?: number;
    /** attempts needed before a first-half/second-half trend is shown */
    minTrend?: number;
    includeMeta?: boolean;
}

export interface WeaknessModel {
    attempts: number;
    overallRate: number;
    rating: number | null;
    themes: ThemeStat[];
}

/** Build per-theme stats, weakest (lowest adjusted rate) first. */
export function buildModel(attempts: PuzzleAttempt[], opts: ModelOptions = {}): WeaknessModel {
    const k = opts.priorStrength ?? 8;
    const minTrend = opts.minTrend ?? 6;
    const sorted = [...attempts].sort((a, b) => a.ts.localeCompare(b.ts));
    const overallRate = sorted.length ? sorted.filter((a) => a.solved).length / sorted.length : 0;
    const rating = estimateRating(sorted);

    const byTheme = new Map<string, PuzzleAttempt[]>();
    for (const a of sorted) {
        for (const t of a.themes) {
            if (!opts.includeMeta && META_THEMES.has(t)) continue;
            let list = byTheme.get(t);
            if (!list) byTheme.set(t, (list = []));
            list.push(a);
        }
    }

    const themes: ThemeStat[] = [];
    for (const [theme, list] of byTheme) {
        const n = list.length;
        const s = list.filter((a) => a.solved).length;
        const residual =
            rating === null
                ? 0
                : list.reduce(
                      (acc, a) => acc + (a.solved ? 1 : 0) - expectedScore(rating, a.rating),
                      0,
                  );
        let trend: ThemeStat["trend"] = null;
        if (n >= minTrend) {
            const half = Math.floor(n / 2);
            const rateOf = (xs: PuzzleAttempt[]) => xs.filter((a) => a.solved).length / xs.length;
            trend = { early: rateOf(list.slice(0, half)), late: rateOf(list.slice(n - half)) };
        }
        themes.push({
            theme,
            attempts: n,
            solved: s,
            rate: s / n,
            adjustedRate: (s + k * overallRate) / (n + k),
            vsExpected: residual / (n + k),
            avgRating: Math.round(list.reduce((acc, a) => acc + a.rating, 0) / n),
            medianSolveMs: median(list.filter((a) => a.solved).map((a) => a.totalMs)),
            trend,
        });
    }
    themes.sort((a, b) => a.adjustedRate - b.adjustedRate || b.attempts - a.attempts);
    return { attempts: sorted.length, overallRate, rating, themes };
}

/** Parse a JSONL attempt log, skipping blank or malformed lines. */
export function parseAttemptLog(text: string): PuzzleAttempt[] {
    const out: PuzzleAttempt[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
            const a = JSON.parse(line);
            if (a && typeof a.puzzleId === "number" && Array.isArray(a.themes)) out.push(a);
        } catch {
            // ignore a torn line (e.g. crash mid-write)
        }
    }
    return out;
}
