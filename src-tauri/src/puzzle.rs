use std::{
    collections::VecDeque,
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
            rusqlite::Connection::open_with_flags(
                path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
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
                Some(id) => st.query_map([id], |row| row.get(0))?.collect::<Result<_, _>>()?,
                None => st.query_map([], |row| row.get(0))?.collect::<Result<_, _>>()?,
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

static PUZZLE_CACHE: Lazy<Mutex<PuzzleCache>> = Lazy::new(|| Mutex::new(PuzzleCache::new()));

#[derive(Debug)]
struct PuzzleCache {
    cache: VecDeque<Puzzle>,
    file: String,
    min_rating: u16,
    max_rating: u16,
    theme: Option<String>,
}

impl PuzzleCache {
    fn new() -> Self {
        Self {
            cache: VecDeque::new(),
            file: String::new(),
            min_rating: 0,
            max_rating: 0,
            theme: None,
        }
    }

    fn get_puzzles(
        &mut self,
        file: &str,
        min_rating: u16,
        max_rating: u16,
        theme: &Option<String>,
    ) -> Result<(), Error> {
        if self.cache.is_empty()
            || self.min_rating != min_rating
            || self.max_rating != max_rating
            || self.theme != *theme
            || self.file != file
        {
            self.cache.clear();
            let db = open_database(Path::new(file))?;
            let mut query = String::from(
                "SELECT p.id, p.fen, p.moves, p.rating, p.rating_deviation, p.popularity, p.nb_plays
                 FROM puzzles p WHERE p.rating BETWEEN ? AND ?",
            );
            if theme.is_some() {
                query.push_str(
                    " AND EXISTS (SELECT 1 FROM puzzle_themes pt
                      JOIN themes t ON t.id = pt.theme_id
                      WHERE pt.puzzle_id = p.id AND t.name = ?)",
                );
            }
            query.push_str(" ORDER BY random() LIMIT 20");
            let (min, max) = (i32::from(min_rating), i32::from(max_rating));
            self.cache = match &db {
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
                        statement.query_map(params![min, max, theme_name], read)?
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
                        statement.query_map(rusqlite::params![min, max, theme_name], read)
                    } else {
                        statement.query_map(rusqlite::params![min, max], read)
                    }
                    .map_err(sqlite_error)?;
                    rows.collect::<Result<_, _>>().map_err(sqlite_error)?
                }
            };
            self.file = file.to_owned();
            self.min_rating = min_rating;
            self.max_rating = max_rating;
            self.theme = theme.clone();
        }

        Ok(())
    }

    fn get_next_puzzle(&mut self) -> Option<Puzzle> {
        self.cache.pop_front()
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
    cache.get_puzzles(&file, min_rating, max_rating, &theme)?;
    cache.get_next_puzzle().ok_or(Error::NoPuzzles)
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
        PuzzleDb::Duck(conn) => conn.query_row("SELECT COUNT(*) FROM puzzles", [], |row| row.get(0))?,
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
    if cache.file == file {
        cache.cache.clear();
    }
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
