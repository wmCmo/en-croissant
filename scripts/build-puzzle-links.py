"""Build a link sidecar for an En Croissant puzzle database.

The puzzle databases renumber puzzles 1..N and drop Lichess's puzzle id and
source-game URL. This matches each puzzle to the Lichess export
(https://database.lichess.org/lichess_db_puzzle.csv.zst) by FEN + moves and
writes `<db stem>.links.sqlite` next to the database. The database itself is
opened read-only and never modified.

Usage:
    python scripts/build-puzzle-links.py <lichess_db_puzzle.csv.zst> <puzzle db (.db3 SQLite)>

Needs the `zstandard` package. Reads the whole export (~6M rows) in a few
minutes and ~1 GB of memory.
"""

import csv
import hashlib
import io
import sqlite3
import sys
import time
from pathlib import Path

import zstandard


def key(fen: str, moves: str) -> int:
    return int.from_bytes(hashlib.blake2b(f"{fen}|{moves}".encode(), digest_size=8).digest(), "little")


def main() -> None:
    csv_path, db_path = Path(sys.argv[1]), Path(sys.argv[2])
    out_path = db_path.with_name(f"{db_path.stem}.links.sqlite")
    t0 = time.time()

    src = sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True)
    ids: dict[int, int] = {}
    for pid, fen, moves in src.execute("SELECT id, fen, moves FROM puzzles"):
        ids[key(fen, moves)] = pid
    src.close()
    print(f"indexed {len(ids):,} puzzles in {time.time() - t0:.0f}s", flush=True)

    tmp = out_path.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)
    out = sqlite3.connect(tmp)
    out.execute("CREATE TABLE links (puzzle_id INTEGER PRIMARY KEY, lichess_id TEXT NOT NULL, game_url TEXT NOT NULL)")

    rows, matched, batch = 0, 0, []
    with open(csv_path, "rb") as fh:
        reader = zstandard.ZstdDecompressor().stream_reader(fh)
        for rec in csv.DictReader(io.TextIOWrapper(reader, encoding="utf-8", newline="")):
            rows += 1
            pid = ids.get(key(rec["FEN"], rec["Moves"]))
            if pid is not None:
                matched += 1
                batch.append((pid, rec["PuzzleId"], rec["GameUrl"]))
                if len(batch) >= 50_000:
                    out.executemany("INSERT OR IGNORE INTO links VALUES (?, ?, ?)", batch)
                    batch.clear()
    out.executemany("INSERT OR IGNORE INTO links VALUES (?, ?, ?)", batch)
    out.commit()
    out.close()
    tmp.replace(out_path)
    print(
        f"export rows {rows:,}, matched {matched:,} of {len(ids):,} puzzles "
        f"({matched / max(len(ids), 1):.1%}) in {time.time() - t0:.0f}s -> {out_path}",
        flush=True,
    )


if __name__ == "__main__":
    main()
