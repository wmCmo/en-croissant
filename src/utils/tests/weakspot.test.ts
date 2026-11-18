import { describe, expect, it } from "vitest";
import {
    buildModel,
    estimateRating,
    expectedScore,
    parseAttemptLog,
    type PuzzleAttempt,
} from "../weakspot";

let n = 0;
function attempt(themes: string[], solved: boolean, rating = 1400, totalMs = 20000): PuzzleAttempt {
    n++;
    return {
        v: 1,
        ts: new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString(),
        puzzleId: n,
        db: "test.db3",
        rating,
        themes,
        solved,
        failReason: solved ? null : "wrong_move",
        wrongMove: solved ? null : "e2e4",
        expectedMove: solved ? null : "d2d4",
        failedAtPly: solved ? null : 1,
        firstMoveMs: 5000,
        totalMs,
    };
}

describe("expectedScore", () => {
    it("is 0.5 at equal rating and ~0.76 at +200", () => {
        expect(expectedScore(1500, 1500)).toBeCloseTo(0.5);
        expect(expectedScore(1700, 1500)).toBeCloseTo(0.76, 2);
    });
});

describe("estimateRating", () => {
    it("returns null with no attempts", () => {
        expect(estimateRating([])).toBeNull();
    });
    it("lands on the puzzle rating at 50% success", () => {
        const xs = [attempt([], true, 1500), attempt([], false, 1500)];
        expect(estimateRating(xs)).toBe(1500);
    });
    it("rises with success rate and stays bounded when all solved", () => {
        const three = [true, true, true, false].map((s) => attempt([], s, 1500));
        expect(estimateRating(three)).toBeGreaterThan(1650);
        expect(estimateRating([attempt([], true, 1500)])).toBe(1900);
    });
});

describe("buildModel", () => {
    it("shrinks small samples toward the overall rate and sorts weakest first", () => {
        const xs = [
            // fork: 1 of 1 failed (small sample)
            attempt(["fork"], false),
            // pin: 2 of 10 solved (clearly weak)
            ...Array.from({ length: 10 }, (_, i) => attempt(["pin"], i < 2)),
            // mateIn2: 9 of 9 solved
            ...Array.from({ length: 9 }, () => attempt(["mateIn2"], true)),
        ];
        const m = buildModel(xs);
        const by = Object.fromEntries(m.themes.map((t) => [t.theme, t]));
        expect(by.fork.rate).toBe(0);
        // one failure barely moves fork off the overall rate (11/20 = 0.55)
        expect(by.fork.adjustedRate).toBeGreaterThan(0.45);
        expect(m.themes[0].theme).toBe("pin");
        expect(m.themes.at(-1)!.theme).toBe("mateIn2");
    });

    it("drops meta tags unless asked", () => {
        const xs = [attempt(["fork", "short", "master"], true)];
        expect(buildModel(xs).themes.map((t) => t.theme)).toEqual(["fork"]);
        expect(buildModel(xs, { includeMeta: true }).themes).toHaveLength(3);
    });

    it("reports a first-half vs second-half trend once there are enough attempts", () => {
        const xs = [false, false, false, true, true, true].map((s) => attempt(["skewer"], s));
        const t = buildModel(xs).themes[0];
        expect(t.trend).toEqual({ early: 0, late: 1 });
        expect(buildModel(xs.slice(0, 5)).themes[0].trend).toBeNull();
    });

    it("median solve time ignores failed attempts", () => {
        const xs = [
            attempt(["fork"], true, 1400, 10000),
            attempt(["fork"], true, 1400, 30000),
            attempt(["fork"], false, 1400, 1000),
        ];
        expect(buildModel(xs).themes[0].medianSolveMs).toBe(20000);
    });
});

describe("parseAttemptLog", () => {
    it("skips blank and torn lines", () => {
        const a = attempt(["fork"], true);
        const text = `${JSON.stringify(a)}\n\n{"puzzleId": 3, "the\n${JSON.stringify(a)}\r\n`;
        expect(parseAttemptLog(text)).toHaveLength(2);
    });
});
