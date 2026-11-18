use std::{
    collections::{HashMap, VecDeque},
    fs::remove_file,
    path::{Path, PathBuf},
    sync::Mutex,
};

use duckdb::{params, AccessMode, Config, Connection};
use once_cell::sync::Lazy;
use serde::Serialize;
use specta::Type;

use crate::{db::Puzzle, error::Error};

fn is_legacy_database(path: &Path) -> Result<bool, std::io::Error> {
    let mut header = [0; 16];
    std::io::Read::read_exact(&mut std::fs::File::open(path)?, &mut header)?;
    Ok(&header == b"SQLite format 3\0")
}

/// A puzzle database is either the current DuckDB format or the released
/// SQLite format (same tables). Both are opened read-only; the SQLite file is
/// never modified or deleted.
enum PuzzleDb {
    Duck(Connection),
    Lite(rusqlite::Connection),
}

fn sqlite_error(error: rusqlite::Error) -> Error {
    std::io::Error::other(format!("Legacy puzzle database: {error}")).into()
}

fn open_database(path: &Path) -> Result<PuzzleDb, Error> {
    if is_legacy_database(path)? {
        return Ok(PuzzleDb::Lite(
            rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(sqlite_error)?,
        ));
    }
    Ok(PuzzleDb::Duck(Connection::open_with_flags(
        path,
        Config::default().access_mode(AccessMode::ReadOnly)?,
    )?))
}

/// Run a query returning one String column with optional params.
fn query_strings(db: &PuzzleDb, sql: &str, id: Option<i32>) -> Result<Vec<String>, Error> {
    match db {
        PuzzleDb::Duck(conn) => {
            let mut st = conn.prepare(sql)?;
            let rows = match id {
                Some(id) => st
                    .query_map([id], |row| row.get(0))?
                    .collect::<Result<_, _>>()?,
                None => st
                    .query_map([], |row| row.get(0))?
                    .collect::<Result<_, _>>()?,
            };
            Ok(rows)
        }
        PuzzleDb::Lite(conn) => {
            let mut st = conn.prepare(sql).map_err(sqlite_error)?;
            let rows = match id {
                Some(id) => st
                    .query_map([id], |row| row.get(0))
                    .map_err(sqlite_error)?
                    .collect::<Result<_, _>>(),
                None => st
                    .query_map([], |row| row.get(0))
                    .map_err(sqlite_error)?
                    .collect::<Result<_, _>>(),
            };
            rows.map_err(sqlite_error)
        }
    }
}

static PUZZLE_CACHE: Lazy<Mutex<PuzzleCache>> = Lazy::new(|| Mutex::new(PuzzleCache::default()));

type CacheKey = (String, u16, u16, Option<String>);

/// One queue of random puzzles per (file, rating range, theme). The weakspot
/// picker alternates between a few themes and rating ranges, so keeping each
/// queue avoids re-running the (slow on SQLite) random query on every switch.
#[derive(Debug, Default)]
struct PuzzleCache {
    queues: HashMap<CacheKey, VecDeque<Puzzle>>,
}

const BATCH: usize = 20;

fn fetch_puzzles(
    file: &str,
    min_rating: u16,
    max_rating: u16,
    theme: &Option<String>,
) -> Result<VecDeque<Puzzle>, Error> {
    let db = open_database(Path::new(file))?;
    const COLS: &str =
        "p.id, p.fen, p.moves, p.rating, p.rating_deviation, p.popularity, p.nb_plays";
    // With a theme, drive the query from puzzle_themes' (theme_id, puzzle_id)
    // key; on the SQLite DB this is ~5-10x faster than an EXISTS per puzzle.
    let query = if theme.is_some() {
        format!(
            "SELECT {COLS} FROM puzzle_themes pt JOIN puzzles p ON p.id = pt.puzzle_id
             WHERE pt.theme_id = (SELECT id FROM themes WHERE name = ?)
               AND p.rating BETWEEN ? AND ?
             ORDER BY random() LIMIT {BATCH}"
        )
    } else {
        format!(
            "SELECT {COLS} FROM puzzles p WHERE p.rating BETWEEN ? AND ?
             ORDER BY random() LIMIT {BATCH}"
        )
    };
    let (min, max) = (i32::from(min_rating), i32::from(max_rating));
    Ok(match &db {
        PuzzleDb::Duck(conn) => {
            let mut statement = conn.prepare(&query)?;
            let read = |row: &duckdb::Row<'_>| {
                Ok(Puzzle {
                    id: row.get(0)?,
                    fen: row.get(1)?,
                    moves: row.get(2)?,
                    rating: row.get(3)?,
                    rating_deviation: row.get(4)?,
                    popularity: row.get(5)?,
                    nb_plays: row.get(6)?,
                })
            };
            let rows = if let Some(theme_name) = theme {
                statement.query_map(params![theme_name, min, max], read)?
            } else {
                statement.query_map(params![min, max], read)?
            };
            rows.collect::<Result<_, _>>()?
        }
        PuzzleDb::Lite(conn) => {
            let mut statement = conn.prepare(&query).map_err(sqlite_error)?;
            let read = |row: &rusqlite::Row<'_>| {
                Ok(Puzzle {
                    id: row.get(0)?,
                    fen: row.get(1)?,
                    moves: row.get(2)?,
                    rating: row.get(3)?,
                    rating_deviation: row.get(4)?,
                    popularity: row.get(5)?,
                    nb_plays: row.get(6)?,
                })
            };
            let rows = if let Some(theme_name) = theme {
                statement.query_map(rusqlite::params![theme_name, min, max], read)
            } else {
                statement.query_map(rusqlite::params![min, max], read)
            }
            .map_err(sqlite_error)?;
            rows.collect::<Result<_, _>>().map_err(sqlite_error)?
        }
    })
}

impl PuzzleCache {
    fn next(
        &mut self,
        file: &str,
        min_rating: u16,
        max_rating: u16,
        theme: &Option<String>,
    ) -> Result<Option<Puzzle>, Error> {
        let key = (file.to_owned(), min_rating, max_rating, theme.clone());
        let queue = self.queues.entry(key).or_default();
        if queue.is_empty() {
            *queue = fetch_puzzles(file, min_rating, max_rating, theme)?;
        }
        Ok(queue.pop_front())
    }

    fn forget_file(&mut self, file: &str) {
        self.queues.retain(|(f, ..), _| f != file);
    }
}

#[tauri::command]
#[specta::specta]
pub fn get_puzzle(
    file: String,
    min_rating: u16,
    max_rating: u16,
    theme: Option<String>,
) -> Result<Puzzle, Error> {
    let mut cache = PUZZLE_CACHE.lock().unwrap();
    cache
        .next(&file, min_rating, max_rating, &theme)?
        .ok_or(Error::NoPuzzles)
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PuzzleDatabaseInfo {
    title: String,
    description: String,
    puzzle_count: i32,
    storage_size: u64,
    path: String,
}

#[tauri::command]
#[specta::specta]
pub async fn get_puzzle_db_info(file: PathBuf) -> Result<Option<PuzzleDatabaseInfo>, Error> {
    database_info(file)
}

fn database_info(path: PathBuf) -> Result<Option<PuzzleDatabaseInfo>, Error> {
    if !path.exists() {
        return Ok(None);
    }
    let db = open_database(&path)?;
    let puzzle_count = match &db {
        PuzzleDb::Duck(conn) => {
            conn.query_row("SELECT COUNT(*) FROM puzzles", [], |row| row.get(0))?
        }
        PuzzleDb::Lite(conn) => conn
            .query_row("SELECT COUNT(*) FROM puzzles", [], |row| row.get(0))
            .map_err(sqlite_error)?,
    };

    let storage_size = path.metadata()?.len();
    let filename = path.file_name().expect("get filename").to_string_lossy();

    Ok(Some(PuzzleDatabaseInfo {
        title: filename.to_string(),
        description: "".to_string(),
        puzzle_count,
        storage_size,
        path: path.to_string_lossy().to_string(),
    }))
}

#[tauri::command]
#[specta::specta]
pub fn delete_puzzle_database(file: String) -> Result<(), Error> {
    let mut cache = PUZZLE_CACHE.lock().unwrap();
    match remove_file(&file) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    cache.forget_file(&file);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn get_puzzle_themes(file: String) -> Result<Vec<String>, Error> {
    let db = open_database(Path::new(&file))?;
    query_strings(&db, "SELECT name FROM themes ORDER BY name", None)
}

#[tauri::command]
#[specta::specta]
pub fn get_themes_for_puzzle(file: String, puzzle_id: i32) -> Result<Vec<String>, Error> {
    let db = open_database(Path::new(&file))?;
    query_strings(
        &db,
        "SELECT t.name FROM themes t JOIN puzzle_themes pt ON t.id = pt.theme_id
         WHERE pt.puzzle_id = ? ORDER BY t.name",
        Some(puzzle_id),
    )
}

/// Sidecar file next to a puzzle database, built by
/// `scripts/build-puzzle-links.py` from the Lichess puzzle export. Kept
/// separate so the puzzle database itself is never modified.
fn links_path(file: &str) -> PathBuf {
    let path = Path::new(file);
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    path.with_file_name(format!("{stem}.links.sqlite"))
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PuzzleLink {
    lichess_id: String,
    game_url: String,
}

/// Lichess puzzle id and source game for a puzzle; None when the sidecar
/// is missing or has no row for it.
#[tauri::command]
#[specta::specta]
pub fn get_puzzle_link(file: String, puzzle_id: i32) -> Result<Option<PuzzleLink>, Error> {
    let path = links_path(&file);
    if !path.exists() {
        return Ok(None);
    }
    let conn =
        rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(sqlite_error)?;
    let result = conn.query_row(
        "SELECT lichess_id, game_url FROM links WHERE puzzle_id = ?",
        [puzzle_id],
        |row| {
            Ok(PuzzleLink {
                lichess_id: row.get(0)?,
                game_url: row.get(1)?,
            })
        },
    );
    match result {
        Ok(link) => Ok(Some(link)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(sqlite_error(e)),
    }
}

/// Number of puzzles in a rating range (and theme), for the usage gauge.
#[tauri::command]
#[specta::specta]
pub fn count_puzzles(
    file: String,
    min_rating: u16,
    max_rating: u16,
    theme: Option<String>,
) -> Result<i32, Error> {
    let db = open_database(Path::new(&file))?;
    let query = if theme.is_some() {
        "SELECT COUNT(*) FROM puzzle_themes pt JOIN puzzles p ON p.id = pt.puzzle_id
         WHERE pt.theme_id = (SELECT id FROM themes WHERE name = ?)
           AND p.rating BETWEEN ? AND ?"
    } else {
        "SELECT COUNT(*) FROM puzzles p WHERE p.rating BETWEEN ? AND ?"
    };
    let (min, max) = (i32::from(min_rating), i32::from(max_rating));
    Ok(match (&db, &theme) {
        (PuzzleDb::Duck(c), Some(t)) => {
            let n: i64 = c.query_row(query, params![t, min, max], |r| r.get(0))?;
            n as i32
        }
        (PuzzleDb::Duck(c), None) => {
            let n: i64 = c.query_row(query, params![min, max], |r| r.get(0))?;
            n as i32
        }
        (PuzzleDb::Lite(c), Some(t)) => c
            .query_row(query, rusqlite::params![t, min, max], |r| r.get(0))
            .map_err(sqlite_error)?,
        (PuzzleDb::Lite(c), None) => c
            .query_row(query, rusqlite::params![min, max], |r| r.get(0))
            .map_err(sqlite_error)?,
    })
}
