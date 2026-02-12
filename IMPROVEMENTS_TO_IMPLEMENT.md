# Performance Improvements To Implement

1. Move command-palette search to SQLite FTS (Tauri command) instead of JS full-note scans per keystroke.
2. Avoid full sidebar/notes-list rerenders; use targeted DOM updates with dirty flags.
3. Add in-memory indexes (`notesById`, `notesByFolderId`, `folderNoteCount`) to remove repeated `find/filter` scans.
4. Replace global save debounce with per-note debounced writes; skip unchanged payloads and flush on blur/switch.
5. Reduce drag/drop churn by updating only previous/current hover targets (no full `.note-card` class clears).
6. Optimize DB startup migrations via `PRAGMA user_version` (stop retrying `ALTER TABLE` every launch).
7. Batch reorder persistence in one SQL statement (`CASE WHEN` / range updates) instead of per-row updates.
8. Cache stripped note previews once on update/load; stop recomputing `stripMarkdown` during list/search renders.
