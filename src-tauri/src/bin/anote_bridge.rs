#[path = "../db.rs"]
mod db;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, Read};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

// The bridge accepts one JSON request on stdin and returns one JSON response on stdout.
#[derive(Deserialize)]
struct BridgeRequest {
    op: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Serialize)]
struct BridgeError {
    code: String,
    message: String,
}

#[derive(Serialize)]
struct BridgeResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<BridgeError>,
}

#[derive(Deserialize)]
struct CreateNotePayload {
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    folder_id: Option<String>,
}

#[derive(Deserialize)]
struct UpdateNotePayload {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    updated_at: Option<i64>,
}

#[derive(Deserialize)]
struct SearchNotesPayload {
    query: Option<String>,
    limit: Option<i64>,
}

#[derive(Deserialize)]
struct GetNotePayload {
    id: String,
}

fn ok(data: Value) -> BridgeResponse {
    BridgeResponse {
        ok: true,
        data: Some(data),
        error: None,
    }
}

fn err(code: &str, message: impl Into<String>) -> BridgeResponse {
    BridgeResponse {
        ok: false,
        data: None,
        error: Some(BridgeError {
            code: code.to_string(),
            message: message.into(),
        }),
    }
}

fn print_response(resp: &BridgeResponse) {
    let output = serde_json::to_string(resp).unwrap_or_else(|_| {
        "{\"ok\":false,\"error\":{\"code\":\"INTERNAL\",\"message\":\"failed to serialize response\"}}".to_string()
    });
    println!("{}", output);
}

fn db_connection() -> Result<Connection, String> {
    // Resolve the same canonical DB path and migrations as the desktop app.
    let db_path = db::canonical_db_path()?;
    let conn = db::open_initialized_db(&db_path)?;
    // Bridge calls are short-lived CLI invocations; a small timeout avoids failing on brief WAL contention.
    conn.busy_timeout(Duration::from_millis(2000))
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn now_ms() -> i64 {
    chrono::Local::now().timestamp_millis()
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn generate_id() -> String {
    // Include high-resolution time + pid + per-process counter to avoid collisions across short-lived bridge runs.
    let t = now_nanos();
    let pid = std::process::id() as u128;
    let c = ID_COUNTER.fetch_add(1, Ordering::Relaxed) as u128;
    format!("{:x}{:x}{:x}", t, pid, c)
}

fn ensure_inbox(conn: &mut Connection) -> Result<String, String> {
    // Use BEGIN IMMEDIATE to serialize concurrent bridge writers racing to create Inbox.
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;

    let existing: Result<String, _> = tx.query_row(
        "SELECT id FROM folders WHERE name = 'Inbox' ORDER BY created_at ASC LIMIT 1",
        [],
        |row| row.get(0),
    );
    if let Ok(id) = existing {
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(id);
    }

    // INSERT OR IGNORE backed by idx_folders_name_root partial unique index.
    let id = generate_id();
    let created_at = now_ms();
    tx.execute(
        "INSERT OR IGNORE INTO folders (id, name, created_at, parent_id, updated_at) VALUES (?1, 'Inbox', ?2, NULL, ?2)",
        params![&id, created_at],
    )
    .map_err(|e| e.to_string())?;

    // Re-query to handle the case where another writer won the race.
    let final_id: String = tx.query_row(
        "SELECT id FROM folders WHERE name = 'Inbox' ORDER BY created_at ASC LIMIT 1",
        [],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(final_id)
}

fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric())
}

fn create_note(conn: &mut Connection, payload: CreateNotePayload) -> Result<Value, BridgeResponse> {
    let folder_id = match payload.folder_id {
        Some(id) => {
            if !is_safe_id(&id) {
                return Err(err("VALIDATION", "invalid folder_id"));
            }
            id
        }
        None => ensure_inbox(&mut *conn).map_err(|e| err("INTERNAL", e))?,
    };

    let folder_exists: i64 = conn
        .query_row(
            "SELECT COUNT(1) FROM folders WHERE id = ?1",
            params![&folder_id],
            |row| row.get(0),
        )
        .map_err(|e| err("INTERNAL", e.to_string()))?;
    if folder_exists == 0 {
        return Err(err("VALIDATION", "folder not found"));
    }

    let id = generate_id();
    let created_at = now_ms();
    let updated_at = created_at;

    let tx = conn
        .transaction()
        .map_err(|e| err("INTERNAL", e.to_string()))?;

    // Keep manual ordering behavior aligned with the app by inserting new unpinned notes at sort_order = 0.
    tx.execute(
        "UPDATE notes SET sort_order = sort_order + 1 WHERE folder_id = ?1 AND pinned = 0",
        params![&folder_id],
    )
    .map_err(|e| err("INTERNAL", e.to_string()))?;

    tx.execute(
        "INSERT INTO notes (id, folder_id, title, body, created_at, updated_at, pinned, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0)",
        params![&id, &folder_id, payload.title, payload.body, created_at, updated_at],
    )
    .map_err(|e| err("INTERNAL", e.to_string()))?;

    tx.commit().map_err(|e| err("INTERNAL", e.to_string()))?;

    Ok(json!({
        "id": id,
        "folder_id": folder_id,
        "created_at": created_at,
        "updated_at": updated_at,
    }))
}

fn update_note(conn: &Connection, payload: UpdateNotePayload) -> Result<Value, BridgeResponse> {
    if !is_safe_id(&payload.id) {
        return Err(err("VALIDATION", "invalid note id"));
    }

    let updated_at = payload.updated_at.unwrap_or_else(now_ms);

    // Reject stale writes instead of silently overwriting newer edits.
    let rows = conn
        .execute(
            "UPDATE notes SET title = ?1, body = ?2, updated_at = ?3 WHERE id = ?4 AND updated_at <= ?3",
            params![payload.title, payload.body, updated_at, &payload.id],
        )
        .map_err(|e| err("INTERNAL", e.to_string()))?;

    if rows == 0 {
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(1) FROM notes WHERE id = ?1",
                params![&payload.id],
                |row| row.get(0),
            )
            .map_err(|e| err("INTERNAL", e.to_string()))?;

        if exists == 0 {
            return Err(err("VALIDATION", "note not found"));
        }
        return Err(err("CONFLICT", "stale note update rejected"));
    }

    Ok(json!({ "id": payload.id, "updated_at": updated_at }))
}

fn search_notes(conn: &Connection, payload: SearchNotesPayload) -> Result<Value, BridgeResponse> {
    let query = payload.query.unwrap_or_default().trim().to_string();
    let limit = payload.limit.unwrap_or(80).clamp(1, 200);

    if query.is_empty() {
        let mut stmt = conn
            .prepare(
                "SELECT n.id, n.folder_id, n.title, substr(n.body, 1, 200), n.updated_at, COALESCE(f.name, '')
                 FROM notes n
                 LEFT JOIN folders f ON f.id = n.folder_id
                 ORDER BY n.updated_at DESC
                 LIMIT ?1",
            )
            .map_err(|e| err("INTERNAL", e.to_string()))?;

        let rows = stmt
            .query_map(params![limit], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?,
                    "folder_id": row.get::<_, String>(1)?,
                    "title": row.get::<_, String>(2)?,
                    "preview": row.get::<_, String>(3)?,
                    "updated_at": row.get::<_, i64>(4)?,
                    "folder_name": row.get::<_, String>(5)?,
                }))
            })
            .map_err(|e| err("INTERNAL", e.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| err("INTERNAL", e.to_string()))?;

        return Ok(json!({ "notes": rows }));
    }

    let mut stmt = conn
        .prepare(
            "SELECT n.id, n.folder_id, n.title, substr(n.body, 1, 200), n.updated_at, COALESCE(f.name, '')
             FROM notes_fts nf
             JOIN notes n ON n.rowid = nf.rowid
             LEFT JOIN folders f ON f.id = n.folder_id
             WHERE notes_fts MATCH ?1
             ORDER BY rank
             LIMIT ?2",
        )
        .map_err(|e| err("INTERNAL", e.to_string()))?;

    let fts_rows = stmt
        .query_map(params![&query, limit], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "folder_id": row.get::<_, String>(1)?,
                "title": row.get::<_, String>(2)?,
                "preview": row.get::<_, String>(3)?,
                "updated_at": row.get::<_, i64>(4)?,
                "folder_name": row.get::<_, String>(5)?,
            }))
        })
        .and_then(|it| it.collect::<Result<Vec<_>, _>>());

    match fts_rows {
        Ok(rows) => Ok(json!({ "notes": rows })),
        Err(_) => {
            // FTS syntax can fail on malformed user input; degrade to LIKE search instead of hard-failing.
            let like = format!("%{}%", escape_like(&query));
            let mut fallback_stmt = conn
                .prepare(
                    "SELECT n.id, n.folder_id, n.title, substr(n.body, 1, 200), n.updated_at, COALESCE(f.name, '')
                     FROM notes n
                     LEFT JOIN folders f ON f.id = n.folder_id
                     WHERE n.title LIKE ?1 ESCAPE '\\' OR n.body LIKE ?1 ESCAPE '\\'
                     ORDER BY n.updated_at DESC
                     LIMIT ?2",
                )
                .map_err(|e| err("INTERNAL", e.to_string()))?;

            let rows = fallback_stmt
                .query_map(params![&like, limit], |row| {
                    Ok(json!({
                        "id": row.get::<_, String>(0)?,
                        "folder_id": row.get::<_, String>(1)?,
                        "title": row.get::<_, String>(2)?,
                        "preview": row.get::<_, String>(3)?,
                        "updated_at": row.get::<_, i64>(4)?,
                        "folder_name": row.get::<_, String>(5)?,
                    }))
                })
                .map_err(|e| err("INTERNAL", e.to_string()))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| err("INTERNAL", e.to_string()))?;

            Ok(json!({ "notes": rows }))
        }
    }
}

fn get_note(conn: &Connection, payload: GetNotePayload) -> Result<Value, BridgeResponse> {
    if !is_safe_id(&payload.id) {
        return Err(err("VALIDATION", "invalid note id"));
    }

    let result: Result<Value, _> = conn.query_row(
        "SELECT n.id, n.folder_id, n.title, n.body, n.created_at, n.updated_at, n.pinned, n.sort_order, COALESCE(f.name, '')
         FROM notes n
         LEFT JOIN folders f ON f.id = n.folder_id
         WHERE n.id = ?1",
        params![&payload.id],
        |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "folder_id": row.get::<_, String>(1)?,
                "title": row.get::<_, String>(2)?,
                "body": row.get::<_, String>(3)?,
                "created_at": row.get::<_, i64>(4)?,
                "updated_at": row.get::<_, i64>(5)?,
                "pinned": row.get::<_, i32>(6)?,
                "sort_order": row.get::<_, i32>(7)?,
                "folder_name": row.get::<_, String>(8)?,
            }))
        },
    );

    match result {
        Ok(note) => Ok(note),
        Err(rusqlite::Error::QueryReturnedNoRows) => Err(err("VALIDATION", "note not found")),
        Err(e) => Err(err("INTERNAL", e.to_string())),
    }
}

fn main() {
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() {
        print_response(&err("VALIDATION", "failed to read request from stdin"));
        return;
    }

    let req: BridgeRequest = match serde_json::from_str(&input) {
        Ok(v) => v,
        Err(_) => {
            print_response(&err("VALIDATION", "invalid JSON request"));
            return;
        }
    };

    let mut conn = match db_connection() {
        Ok(conn) => conn,
        Err(e) => {
            print_response(&err("INTERNAL", e));
            return;
        }
    };

    // Keep operation dispatch explicit and small; unknown ops are validation errors by contract.
    let response = match req.op.as_str() {
        "ensure_inbox" => match ensure_inbox(&mut conn) {
            Ok(folder_id) => ok(json!({ "folder_id": folder_id })),
            Err(e) => err("INTERNAL", e),
        },
        "create_note" => match serde_json::from_value::<CreateNotePayload>(req.payload) {
            Ok(payload) => match create_note(&mut conn, payload) {
                Ok(data) => ok(data),
                Err(resp) => resp,
            },
            Err(_) => err("VALIDATION", "invalid payload for create_note"),
        },
        "update_note" => match serde_json::from_value::<UpdateNotePayload>(req.payload) {
            Ok(payload) => match update_note(&conn, payload) {
                Ok(data) => ok(data),
                Err(resp) => resp,
            },
            Err(_) => err("VALIDATION", "invalid payload for update_note"),
        },
        "search_notes" => match serde_json::from_value::<SearchNotesPayload>(req.payload) {
            Ok(payload) => match search_notes(&conn, payload) {
                Ok(data) => ok(data),
                Err(resp) => resp,
            },
            Err(_) => err("VALIDATION", "invalid payload for search_notes"),
        },
        "get_note" => match serde_json::from_value::<GetNotePayload>(req.payload) {
            Ok(payload) => match get_note(&conn, payload) {
                Ok(data) => ok(data),
                Err(resp) => resp,
            },
            Err(_) => err("VALIDATION", "invalid payload for get_note"),
        },
        _ => err("VALIDATION", format!("unknown op '{}'", req.op)),
    };

    print_response(&response);
}
