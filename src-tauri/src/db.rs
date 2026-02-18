use rusqlite::Connection;
use std::path::{Path, PathBuf};

pub fn canonical_data_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("failed to get home directory")?;
    let anote_dir = home.join(".anote");
    std::fs::create_dir_all(&anote_dir).map_err(|e| e.to_string())?;
    Ok(anote_dir)
}

pub fn canonical_db_path() -> Result<PathBuf, String> {
    // Keep a single canonical DB location so app and bridge always operate on the same file.
    Ok(canonical_data_dir()?.join("anote.db"))
}

pub fn open_initialized_db(db_path: &Path) -> Result<Connection, String> {
    // Centralized open + migration entrypoint used by both Tauri runtime and bridge CLI.
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    init_db(&conn)?;
    Ok(conn)
}

pub fn init_db(conn: &Connection) -> Result<(), String> {
    // All schema and migration logic lives here to avoid drift across multiple binaries.
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA cache_size = -2000;
        PRAGMA foreign_keys = ON;
        ",
    )
    .map_err(|e| e.to_string())?;

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS folders (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
            title TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id);

        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
            title, body, content=notes, content_rowid=rowid
        );

        CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
            INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
        END;

        CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
        END;

        CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
            INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
        END;
        ",
    )
    .map_err(|e| e.to_string())?;

    let version: i32 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap_or(0);

    if version < 1 {
        let has_pinned = conn.prepare("SELECT pinned FROM notes LIMIT 0").is_ok();
        if !has_pinned {
            conn.execute(
                "ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        let added_sort_order = if conn.prepare("SELECT sort_order FROM notes LIMIT 0").is_err() {
            conn.execute(
                "ALTER TABLE notes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|e| e.to_string())?;
            true
        } else {
            false
        };
        if added_sort_order {
            conn.execute_batch(
                "
                WITH ranked AS (
                    SELECT id, ROW_NUMBER() OVER (PARTITION BY folder_id ORDER BY updated_at DESC) - 1 AS rn
                    FROM notes
                )
                UPDATE notes SET sort_order = (SELECT rn FROM ranked WHERE ranked.id = notes.id)
                ",
            )
            .map_err(|e| e.to_string())?;
        }
        conn.pragma_update(None, "user_version", 1)
            .map_err(|e| e.to_string())?;
    }

    if version < 2 {
        let has_parent_id = conn.prepare("SELECT parent_id FROM folders LIMIT 0").is_ok();
        if !has_parent_id {
            conn.execute(
                "ALTER TABLE folders ADD COLUMN parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        conn.pragma_update(None, "user_version", 2)
            .map_err(|e| e.to_string())?;
    }

    if version < 3 {
        let has_col = conn.prepare("SELECT updated_at FROM folders LIMIT 0").is_ok();
        if !has_col {
            conn.execute("ALTER TABLE folders ADD COLUMN updated_at INTEGER", [])
                .map_err(|e| e.to_string())?;
        }
        conn.execute_batch("UPDATE folders SET updated_at = created_at WHERE updated_at IS NULL")
            .map_err(|e| e.to_string())?;

        // Prevent duplicate root-level folders (safety net for ensure_inbox race)
        conn.execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_name_root ON folders(name) WHERE parent_id IS NULL",
        )
        .map_err(|e| e.to_string())?;

        conn.pragma_update(None, "user_version", 3)
            .map_err(|e| e.to_string())?;
    }

    if version < 4 {
        // Tags table
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                color TEXT DEFAULT '#888888'
            )",
        )
        .map_err(|e| e.to_string())?;

        // Note-tags relationship
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS note_tags (
                note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                PRIMARY KEY (note_id, tag_id)
            )",
        )
        .map_err(|e| e.to_string())?;

        conn.pragma_update(None, "user_version", 4)
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}
