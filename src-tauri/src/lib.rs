use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Manager, State};

struct Db(Mutex<Connection>);

#[derive(Serialize, Deserialize, Clone)]
struct Folder {
    id: String,
    name: String,
    created_at: i64,
    parent_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Note {
    id: String,
    folder_id: String,
    title: String,
    body: String,
    created_at: i64,
    updated_at: i64,
    // TEMP legacy-compat (added 12 02 2026): older localStorage imports don't include these fields.
    // Remove this defaulting path once legacy migration support is dropped.
    #[serde(default)]
    pinned: i32,
    #[serde(default)]
    sort_order: i32,
}

#[derive(Serialize, Clone)]
struct NoteMetadata {
    id: String,
    folder_id: String,
    title: String,
    preview: String,
    created_at: i64,
    updated_at: i64,
    pinned: i32,
    sort_order: i32,
}

fn init_db(conn: &Connection) {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA cache_size = -2000;
        PRAGMA foreign_keys = ON;
        ",
    )
    .unwrap();
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
    .unwrap();

    // Versioned migrations using PRAGMA user_version
    let version: i32 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap_or(0);

    if version < 1 {
        // Add pinned and sort_order columns (skip if already present from old migration path)
        let has_pinned: bool = conn.prepare("SELECT pinned FROM notes LIMIT 0").is_ok();
        if !has_pinned {
            conn.execute(
                "ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .unwrap();
        }
        let added_sort_order = if conn
            .prepare("SELECT sort_order FROM notes LIMIT 0")
            .is_err()
        {
            conn.execute(
                "ALTER TABLE notes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .unwrap();
            true
        } else {
            false
        };
        if added_sort_order {
            // Initialize sort_order from updated_at so existing notes keep their visual order
            let _ = conn.execute_batch(
                "
                WITH ranked AS (
                    SELECT id, ROW_NUMBER() OVER (PARTITION BY folder_id ORDER BY updated_at DESC) - 1 AS rn
                    FROM notes
                )
                UPDATE notes SET sort_order = (SELECT rn FROM ranked WHERE ranked.id = notes.id)
                ",
            );
        }
        conn.pragma_update(None, "user_version", 1).unwrap();
    }

    if version < 2 {
        let has_parent_id = conn
            .prepare("SELECT parent_id FROM folders LIMIT 0")
            .is_ok();
        if !has_parent_id {
            conn.execute(
                "ALTER TABLE folders ADD COLUMN parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL",
                [],
            )
            .unwrap();
        }
        conn.pragma_update(None, "user_version", 2).unwrap();
    }
    // Future migrations: if version < 3 { ... conn.pragma_update(None, "user_version", 3).unwrap(); }
}

// ===== Folder commands =====

#[tauri::command]
fn get_folders(db: State<Db>) -> Result<Vec<Folder>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, created_at, parent_id FROM folders ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let folders = stmt
        .query_map([], |row| {
            Ok(Folder {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                parent_id: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(folders)
}

#[tauri::command]
fn create_folder(
    db: State<Db>,
    id: String,
    name: String,
    created_at: i64,
    parent_id: Option<String>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO folders (id, name, created_at, parent_id) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![id, name, created_at, parent_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn rename_folder(db: State<Db>, id: String, name: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE folders SET name = ?1 WHERE id = ?2",
        rusqlite::params![name, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn update_folder(db: State<Db>, id: String, name: Option<String>, parent_id: Option<Option<String>>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // Validate that parent_id is not the folder's own id (prevent self-reference)
    if let Some(Some(ref pid)) = parent_id {
        if pid == &id {
            return Err("folder cannot be its own parent".to_string());
        }
        // Check for circular reference (parent is a descendant of this folder)
        let mut current = Some(pid.clone());
        while let Some(curr) = current {
            if curr == id {
                return Err("cannot create circular folder reference".to_string());
            }
            let mut stmt = conn
                .prepare("SELECT parent_id FROM folders WHERE id = ?1")
                .map_err(|e| e.to_string())?;
            current = stmt
                .query_row(rusqlite::params![curr], |row| row.get(0))
                .ok()
                .flatten();
        }
    }
    if let Some(n) = name {
        conn.execute(
            "UPDATE folders SET name = ?1 WHERE id = ?2",
            rusqlite::params![n, id],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(pid) = parent_id {
        conn.execute(
            "UPDATE folders SET parent_id = ?1 WHERE id = ?2",
            rusqlite::params![pid, id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn delete_folder(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    delete_folder_recursive(&conn, &id)?;
    Ok(())
}

fn delete_folder_recursive(conn: &Connection, id: &str) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT id FROM folders WHERE parent_id = ?1")
        .map_err(|e| e.to_string())?;
    let children: Vec<String> = stmt
        .query_map(rusqlite::params![id], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    for child_id in children {
        delete_folder_recursive(conn, &child_id)?;
    }

    conn.execute(
        "DELETE FROM notes WHERE folder_id = ?1",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM folders WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ===== Note commands =====

#[tauri::command]
fn get_notes_metadata(db: State<Db>) -> Result<Vec<NoteMetadata>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, folder_id, title, substr(body, 1, 200), created_at, updated_at, pinned, sort_order FROM notes")
        .map_err(|e| e.to_string())?;
    let notes = stmt
        .query_map([], |row| {
            Ok(NoteMetadata {
                id: row.get(0)?,
                folder_id: row.get(1)?,
                title: row.get(2)?,
                preview: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                pinned: row.get(6)?,
                sort_order: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(notes)
}

#[tauri::command]
fn get_note_body(db: State<Db>, id: String) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let body: String = conn
        .query_row(
            "SELECT body FROM notes WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(body)
}

#[tauri::command]
fn get_notes_all(db: State<Db>) -> Result<Vec<Note>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, folder_id, title, body, created_at, updated_at, pinned, sort_order FROM notes")
        .map_err(|e| e.to_string())?;
    let notes = stmt
        .query_map([], |row| {
            Ok(Note {
                id: row.get(0)?,
                folder_id: row.get(1)?,
                title: row.get(2)?,
                body: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                pinned: row.get(6)?,
                sort_order: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(notes)
}

#[tauri::command]
fn search_notes(db: State<Db>, query: String) -> Result<Vec<NoteMetadata>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // FTS5 MATCH query, joined back to notes for full metadata
    let mut stmt = conn
        .prepare(
            "SELECT n.id, n.folder_id, n.title, substr(n.body, 1, 200), \
             n.created_at, n.updated_at, n.pinned, n.sort_order \
             FROM notes_fts f \
             JOIN notes n ON n.rowid = f.rowid \
             WHERE notes_fts MATCH ?1 \
             ORDER BY rank \
             LIMIT 80",
        )
        .map_err(|e| e.to_string())?;
    let notes = stmt
        .query_map(rusqlite::params![query], |row| {
            Ok(NoteMetadata {
                id: row.get(0)?,
                folder_id: row.get(1)?,
                title: row.get(2)?,
                preview: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                pinned: row.get(6)?,
                sort_order: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(notes)
}

#[tauri::command]
fn create_note(
    db: State<Db>,
    id: String,
    folder_id: String,
    title: String,
    body: String,
    created_at: i64,
    updated_at: i64,
    pinned: i32,
    sort_order: i32,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO notes (id, folder_id, title, body, created_at, updated_at, pinned, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![id, folder_id, title, body, created_at, updated_at, pinned, sort_order],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn update_note(
    db: State<Db>,
    id: String,
    title: String,
    body: String,
    updated_at: i64,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE notes SET title = ?1, body = ?2, updated_at = ?3 WHERE id = ?4",
        rusqlite::params![title, body, updated_at, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_note(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM notes WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ===== Pin & reorder commands =====

#[tauri::command]
fn toggle_note_pinned(db: State<Db>, id: String, pinned: i32) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE notes SET pinned = ?1 WHERE id = ?2",
        rusqlite::params![pinned, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn reorder_notes(db: State<Db>, updates: Vec<(String, i32)>) -> Result<(), String> {
    if updates.is_empty() {
        return Ok(());
    }
    // IDs are app-generated alphanumeric (base36), validate to be safe
    for (id, _) in &updates {
        if !id.chars().all(|c| c.is_alphanumeric()) {
            return Err("invalid note id".to_string());
        }
    }
    let case_clauses: Vec<String> = updates
        .iter()
        .map(|(id, order)| format!("WHEN '{}' THEN {}", id, order))
        .collect();
    let ids: Vec<String> = updates.iter().map(|(id, _)| format!("'{}'", id)).collect();
    let sql = format!(
        "UPDATE notes SET sort_order = CASE id {} END WHERE id IN ({})",
        case_clauses.join(" "),
        ids.join(",")
    );
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(&sql, []).map_err(|e| e.to_string())?;
    Ok(())
}

// ===== Data migration command =====

#[tauri::command]
fn import_data(db: State<Db>, folders: Vec<Folder>, notes: Vec<Note>) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for folder in &folders {
        tx.execute(
            "INSERT OR IGNORE INTO folders (id, name, created_at, parent_id) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![folder.id, folder.name, folder.created_at, folder.parent_id],
        )
        .map_err(|e| e.to_string())?;
    }
    for note in &notes {
        tx.execute(
            "INSERT OR IGNORE INTO notes (id, folder_id, title, body, created_at, updated_at, pinned, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![note.id, note.folder_id, note.title, note.body, note.created_at, note.updated_at, note.pinned, note.sort_order],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// ===== Backup command =====

#[tauri::command]
fn export_backup(db: State<Db>) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    // Query all folders
    let mut folder_stmt = conn
        .prepare("SELECT id, name, created_at, parent_id FROM folders ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let folders: Vec<serde_json::Value> = folder_stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "created_at": row.get::<_, i64>(2)?,
                "parent_id": row.get::<_, Option<String>>(3)?
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    // Query all notes (full body)
    let mut note_stmt = conn
        .prepare("SELECT id, folder_id, title, body, created_at, updated_at, pinned, sort_order FROM notes")
        .map_err(|e| e.to_string())?;
    let notes: Vec<serde_json::Value> = note_stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "folder_id": row.get::<_, String>(1)?,
                "title": row.get::<_, String>(2)?,
                "body": row.get::<_, String>(3)?,
                "created_at": row.get::<_, i64>(4)?,
                "updated_at": row.get::<_, i64>(5)?,
                "pinned": row.get::<_, i32>(6)?,
                "sort_order": row.get::<_, i32>(7)?
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let now = chrono::Local::now();
    let backup = serde_json::json!({
        "version": "1.0",
        "exportedAt": now.timestamp_millis(),
        "folders": folders,
        "notes": notes
    });

    let json_str = serde_json::to_string_pretty(&backup).map_err(|e| e.to_string())?;

    // Write to ~/.anote/backups/
    let home = dirs::home_dir().ok_or("failed to get home directory")?;
    let backups_dir = home.join(".anote").join("backups");
    std::fs::create_dir_all(&backups_dir).map_err(|e| e.to_string())?;

    let filename = format!("anote-backup-{}.json", now.format("%Y%m%d-%H%M%S"));
    let file_path = backups_dir.join(&filename);
    std::fs::write(&file_path, json_str).map_err(|e| e.to_string())?;

    Ok(file_path.to_string_lossy().to_string())
}

// ===== Export commands =====

#[tauri::command]
fn export_note_markdown(db: State<Db>, id: String, path: String) -> Result<(), String> {
    // Get note from database
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let note: (String, String) = conn
        .query_row(
            "SELECT title, body FROM notes WHERE id = ?1",
            rusqlite::params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    
    let (title, body) = note;

    // Format the markdown file with title as header
    let markdown = format!("# {}\n\n{}", title, body);

    // Write to file
    std::fs::write(&path, markdown).map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Use ~/.anote/ as canonical data directory
            let home = dirs::home_dir().expect("failed to get home directory");
            let anote_dir = home.join(".anote");
            std::fs::create_dir_all(&anote_dir).expect("failed to create ~/.anote/");
            let db_path = anote_dir.join("anote.db");

            // Migrate from old Tauri app data path if needed
            if !db_path.exists() {
                if let Ok(app_data_dir) = app.path().app_data_dir() {
                    let old_db = app_data_dir.join("anote.db");
                    if old_db.exists() {
                        let _ = std::fs::copy(&old_db, &db_path);
                    }
                }
            }

            let conn = Connection::open(&db_path).expect("failed to open database");
            init_db(&conn);

            app.manage(Db(Mutex::new(conn)));

            // Add dialog plugin for file save dialogs
            app.handle().plugin(tauri_plugin_dialog::init());

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_folders,
            create_folder,
            rename_folder,
            update_folder,
            delete_folder,
            get_notes_metadata,
            get_note_body,
            get_notes_all,
            search_notes,
            create_note,
            update_note,
            delete_note,
            toggle_note_pinned,
            reorder_notes,
            import_data,
            export_backup,
            export_note_markdown,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
