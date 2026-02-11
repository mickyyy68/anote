# Performance Issues Backlog

## Critical

- [x] **All note bodies loaded into RAM at startup**
  `state.js:19` / `lib.rs:120`
  `get_notes_all()` fetches every note's full body text into JavaScript memory. For a user with 200 notes averaging 5KB each, that's ~1MB held in `state.data.notes` even though only one note is displayed at a time. Scales linearly with usage.
  **Fix:** Load only metadata (id, folder_id, title, created_at, updated_at) on startup. Load body on-demand when a note is selected. Add a `get_note_body(id)` Rust command.

- [x] **SVG feTurbulence grain overlay**
  `base.css:28-38`
  A `position: fixed` pseudo-element with an inline SVG `feTurbulence` filter covers the entire viewport at `z-index: 9999`. Forces a separate compositing layer and the fractalNoise filter is expensive. Adds GPU memory overhead and can cause frame drops during scrolling and animations.
  **Fix:** Replace with a pre-rendered static PNG noise texture (~2KB, renders in microseconds) or a simpler CSS pattern.

- [x] **Shared debounce timer — data loss bug**
  `render.js:427-456`
  `updateNoteTitle()` and `updateNoteBody()` share a single `saveTimeout`. If the user edits the title then types in the body within 300ms, the first save gets cancelled. Works by coincidence because both functions send both fields, but is fragile.
  **Fix:** Use a single unified debounce that always saves both fields, or use separate timers.

## Medium

- [x] **O(folders x notes) for folder counts**
  `render.js:69`
  Inside the sidebar `map()`, every folder iterates the entire notes array: `data.notes.filter(n => n.folderId === folder.id).length`. With 20 folders and 500 notes, that's 10,000 iterations per sidebar render.
  **Fix:** Pre-compute a count map: `const countMap = {}; data.notes.forEach(n => { countMap[n.folderId] = (countMap[n.folderId] || 0) + 1; });`

- [x] **`escapeHtml()` creates a DOM element every call**
  `state.js:74-77`
  Creates a throwaway `<div>` via `document.createElement('div')` on every invocation. Called ~70 times per render pass (every folder name, note title, note preview).
  **Fix:** Use string replacement: `str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')`

- [x] **`stripMarkdown()` — 14 regex passes per note card**
  `render.js:11-30`
  Runs 14 sequential regex replacements on every note body for every notes list render.
  **Fix:** Combine related patterns. Cache stripped preview in the note object and only recompute when body changes.

- [x] **slideIn animations replay on every render**
  `sidebar.css:127`, `notes.css:17`
  Every folder item and note card has `animation: slideIn 0.2s ease both`. Since `renderSidebar()` and `renderNotesList()` rebuild via `innerHTML`, animations replay on every `render()` call (theme toggle, folder rename, note selection). Causes visual flicker and unnecessary GPU work.
  **Fix:** Only apply animation to newly added items, or remove the animation and rely on transitions.

- [x] **Sidebar and notes list always rebuild**
  `render.js:270-275`
  `renderSidebar()` and `renderNotesList()` are called on every `render()`, even when nothing in those panels changed (e.g., selecting a note only needs the active-class to update).
  **Fix:** Add dirty flags or compare previous state to skip unnecessary rebuilds. At minimum, skip `renderSidebar()` when only the active note changed.

- [x] **No SQLite performance PRAGMAs**
  `lib.rs:26`
  Only `PRAGMA foreign_keys = ON` is set. Missing WAL mode, synchronous setting, and cache size.
  **Fix:** Add to `init_db()`: `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -2000;`

- [x] **No index on `notes.folder_id`**
  `lib.rs:35-42`
  The `notes` table has no index on `folder_id`. Cascading deletes and any future per-folder queries do full table scans.
  **Fix:** Add `CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id);`

- [x] **`import_data` doesn't use a transaction**
  `lib.rs:189-206`
  Each INSERT is auto-committed individually. Migrating 100 folders + 500 notes means 600 separate transactions with 600 fsyncs.
  **Fix:** Wrap in `BEGIN`/`COMMIT`.

## Low

- [x] **Sidebar width animation triggers layout thrashing**
  `sidebar.css:8`
  `transition: width 0.25s ease, min-width 0.25s ease` forces layout recalculation for the entire flex container on every animation frame during collapse/expand.
  **Fix:** Added `will-change: width, min-width` to hint the browser to optimize the compositing layer.

- [x] **`transition: all` used in 5+ places**
  `sidebar.css:52,97,124,158,217`, `notes.css:14,66`, `layout.css:26,68,146`
  Transitions all CSS properties on hover, including layout-triggering ones.
  **Fix:** Replace with explicit properties: `transition: background 0.15s, color 0.15s`.

- [x] **`formatDate()` re-allocates months array every call**
  `state.js:68-72`
  The `months` array is created inside the function on every invocation.
  **Fix:** Hoist the array to module scope.

- [x] **Google Fonts loaded from external CDN**
  `index.html:8-10`
  Two font families loaded from `fonts.googleapis.com`. Adds DNS lookup + connection time on startup, and the app won't render text correctly offline.
  **Fix:** Self-hosted WOFF2 files in `public/fonts/`, added `@font-face` rules in `theme.css`, removed CDN links.

- [x] **Redundant layout-change detection**
  `render.js:236`
  The condition has logically redundant clauses — the last two are subsets of the first XOR.
  **Fix:** Simplify to `(currentFolderId === null) !== (activeFolderId === null)`.

- [x] **Duplicate font-size declaration**
  `sidebar.css:277-281`
  `font-size: 11px` immediately overridden by `font-size: 13px`. A bug.
  **Fix:** Remove the duplicate `font-size: 11px` line.
