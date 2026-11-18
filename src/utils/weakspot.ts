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
    /** Lichess puzzle id and source game URL (null if the link sidecar is missing) */
    lichessId?: string | null;
    gameUrl?: string | null;
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

export const START_RATING = 1400;
/** Solve times are capped here so time away from the board doesn't count. */
export const MAX_COUNTED_MS = 180_000;

/**
 * Speed factor for a solve: full credit up to 30s, sliding to half credit at
 * 120s or slower. Fails are not scaled.
 */
export function speedFactor(totalMs: number): number {
    const s = Math.min(totalMs, MAX_COUNTED_MS) / 1000;
    if (s <= 30) return 1;
    if (s >= 120) return 0.5;
    return 1 - (0.5 * (s - 30)) / 90;
}

/**
 * Your puzzle rating, replayed from the log: an Elo update per attempt
 * (K=40 for the first 30 attempts, then 20). Slow solves gain less; any fail
 * loses the full expected score, so the rating can go down.
 */
export function playerRating(
    attempts: Pick<PuzzleAttempt, "rating" | "solved" | "totalMs" | "ts">[],
    start = START_RATING,
): number {
    const sorted = [...attempts].sort((a, b) => a.ts.localeCompare(b.ts));
    let r = start;
    sorted.forEach((a, i) => {
        const k = i < 30 ? 40 : 20;
        const e = expectedScore(r, a.rating);
        r += a.solved ? k * (1 - e) * speedFactor(a.totalMs) : -k * e;
    });
    return Math.round(r);
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
    /**
     * Difficulty-adjusted trend: mean (solved - expected) of the older half and
     * the newer half of attempts, both against your current rating, so harder
     * puzzles later on don't read as getting worse. null if < minTrend attempts.
     */
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
    /** your puzzle rating (Elo replay of the log) */
    rating: number;
    themes: ThemeStat[];
}

/** Build per-theme stats, weakest (lowest adjusted rate) first. */
export function buildModel(attempts: PuzzleAttempt[], opts: ModelOptions = {}): WeaknessModel {
    const k = opts.priorStrength ?? 8;
    const minTrend = opts.minTrend ?? 6;
    const sorted = [...attempts].sort((a, b) => a.ts.localeCompare(b.ts));
    const overallRate = sorted.length ? sorted.filter((a) => a.solved).length / sorted.length : 0;
    const rating = playerRating(sorted);

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
        const residual = list.reduce(
            (acc, a) => acc + (a.solved ? 1 : 0) - expectedScore(rating, a.rating),
            0,
        );
        let trend: ThemeStat["trend"] = null;
        if (n >= minTrend) {
            const half = Math.floor(n / 2);
            const residualOf = (xs: PuzzleAttempt[]) =>
                xs.reduce(
                    (acc, a) => acc + (a.solved ? 1 : 0) - expectedScore(rating, a.rating),
                    0,
                ) / xs.length;
            trend = {
                early: residualOf(list.slice(0, half)),
                late: residualOf(list.slice(n - half)),
            };
        }
        themes.push({
            theme,
            attempts: n,
            solved: s,
            rate: s / n,
            adjustedRate: (s + k * overallRate) / (n + k),
            vsExpected: residual / (n + k),
            avgRating: Math.round(list.reduce((acc, a) => acc + a.rating, 0) / n),
            medianSolveMs: median(
                list.filter((a) => a.solved).map((a) => Math.min(a.totalMs, MAX_COUNTED_MS)),
            ),
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

// ---------------------------------------------------------------------------
// Picking the next puzzle

export type TrainerMode = "manual" | "adaptive" | "focus";

/**
 * Evaluation and phase tags: shown in stats, but too broad to drill
 * ("crushing" is not a tactic you can practise).
 */
export const BROAD_THEMES = new Set([
    "advantage",
    "crushing",
    "equality",
    "mate",
    "opening",
    "middlegame",
    "endgame",
]);

export interface NextPick {
    theme: string | null;
    range: [number, number];
}

const RATING_MIN = 600;
const RATING_MAX = 2800;
/** Ranges snap to this step so the Rust-side puzzle cache can be reused. */
const RANGE_STEP = 50;

export function ratingRange(center: number, below: number, above: number): [number, number] {
    const snap = (x: number) => Math.round(x / RANGE_STEP) * RANGE_STEP;
    const lo = Math.max(RATING_MIN, snap(center - below));
    const hi = Math.min(RATING_MAX, Math.max(lo + 100, snap(center + above)));
    return [lo, hi];
}

function drillable(t: ThemeStat, available: Set<string> | null) {
    return !BROAD_THEMES.has(t.theme) && (!available || available.has(t.theme));
}

/**
 * Themes that are weak and not getting better: at least `minAttempts`,
 * adjusted rate below your overall rate, and the newer half no better than
 * the older half (+5 points). Falls back to the weakest themes with 3+
 * attempts when nothing qualifies yet.
 */
export function stubbornThemes(
    model: WeaknessModel,
    count = 3,
    available: Set<string> | null = null,
): string[] {
    const pool = model.themes.filter((t) => drillable(t, available));
    const stubborn = pool.filter(
        (t) =>
            t.trend !== null &&
            t.adjustedRate < model.overallRate &&
            t.trend.late <= t.trend.early + 0.05,
    );
    const fallback = pool.filter((t) => t.attempts >= 3 && !stubborn.includes(t));
    // model.themes is already weakest-first
    return [...stubborn, ...fallback].slice(0, count).map((t) => t.theme);
}

/**
 * Adaptive: puzzles around your rating; with probability `weakShare` the
 * theme is one of your 5 weakest drillable themes (weighted by how weak),
 * otherwise any theme, which keeps exploring and collecting data.
 *
 * Focus: always one of the 2-3 stubborn themes, and slightly easier than
 * your rating so there is time to calculate the whole line.
 */
export function pickNext(
    model: WeaknessModel,
    mode: Exclude<TrainerMode, "manual">,
    available: Set<string> | null,
    rand: () => number = Math.random,
    weakShare = 0.6,
): NextPick {
    const r = model.rating;
    if (mode === "focus") {
        const focus = stubbornThemes(model, 3, available);
        return {
            theme: focus.length ? focus[Math.floor(rand() * focus.length)] : null,
            range: ratingRange(r, 250, 50),
        };
    }
    const range = ratingRange(r, 100, 100);
    if (rand() >= weakShare) return { theme: null, range };
    const weak = model.themes.filter((t) => drillable(t, available)).slice(0, 5);
    if (weak.length === 0) return { theme: null, range };
    const weights = weak.map((t) => 1 - t.adjustedRate + 0.05);
    let x = rand() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < weak.length; i++) {
        x -= weights[i];
        if (x <= 0) return { theme: weak[i].theme, range };
    }
    return { theme: weak[weak.length - 1].theme, range };
}
