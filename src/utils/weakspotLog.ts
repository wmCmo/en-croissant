import { appDataDir, resolve } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { parseAttemptLog, type PuzzleAttempt } from "./weakspot";

// One JSON object per line, append-only, so it can be read from outside the
// app (scripts, a notebook) without the app running.
export async function getAttemptLogPath(): Promise<string> {
    const dir = await resolve(await appDataDir(), "weakspot");
    if (!(await exists(dir))) await mkdir(dir, { recursive: true });
    return resolve(dir, "puzzle-attempts.jsonl");
}

export async function appendAttempt(attempt: PuzzleAttempt): Promise<void> {
    const path = await getAttemptLogPath();
    await writeTextFile(path, `${JSON.stringify(attempt)}\n`, { append: true });
}

export async function readAttempts(): Promise<PuzzleAttempt[]> {
    const path = await getAttemptLogPath();
    if (!(await exists(path))) return [];
    return parseAttemptLog(await readTextFile(path));
}
