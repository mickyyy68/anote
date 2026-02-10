# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
bun run dev          # Launch app in dev mode (Vite + Rust compile + opens window)
bun run build        # Production build (creates .app/.exe/.deb bundle)
bun run vite:dev     # Vite dev server only (no Tauri)
bun run vite:build   # Vite production build only
bun run tauri icon icon.png  # Regenerate all icon formats from source PNG
```

Rust-only checks (faster iteration on backend changes):
```bash
cd src-tauri && cargo check    # Type-check without building
cd src-tauri && cargo build    # Full debug build
```

No tests or linting are configured.

## Architecture

Tauri v2 desktop app: Rust backend + Vite-bundled modular frontend with Milkdown markdown editor.

### Data Flow

**In-memory state + write-through to SQLite.** The frontend keeps all data in a JS `state.data` object. Reads are synchronous from memory; writes update memory first, call `render()` for instant UI, then fire-and-forget `invoke()` to persist to SQLite. Note edits are debounced (300ms) before persisting.

```
User action → update state.data → render() → invoke('command', params)
                                   (async)        (async, fire-and-forget)
```

On startup: `init()` → migrate localStorage (one-time) → `DataLayer.load()` from SQLite → `render()`.

### Frontend (Vite + ES modules)

**File structure:**
```
index.html              ← Minimal Vite entry shell
vite.config.ts          ← Vite config (port 5173, macOS targets)
src/
  main.js               ← Bootstrap: CSS imports, init()
  state.js              ← state object, DataLayer, generateId, formatDate, theme utils
  render.js             ← Selective render system, all action handlers, window.* exports
  icons.js              ← SVG icon string exports
  editor.js             ← Milkdown Crepe wrapper (createEditor, destroyEditor, getMarkdown)
  styles/
    theme.css            ← CSS variable definitions (light/dark)
    base.css             ← Reset, body, scrollbar, animations
    layout.css           ← App layout, context menu, responsive
    sidebar.css          ← Sidebar, folders
    notes.css            ← Notes list, note cards
    editor.css           ← Editor panel, Milkdown theme overrides
```

**Render system:** `render()` is async and uses selective updates. The sidebar and notes list rebuild via `innerHTML` (safe, no persistent state). The editor panel only rebuilds when `activeNoteId` changes, preserving the Milkdown instance during typing. `updateNoteCard()` does targeted DOM patches for the active note's card preview.

**Milkdown editor:** Uses `@milkdown/crepe` (batteries-included package). Supports headings, lists, checkboxes, bold/italic, code blocks, tables, blockquotes, horizontal rules. ImageBlock, Latex, and LinkTooltip features are disabled. The editor wrapper in `editor.js` includes a sequence counter to guard against race conditions during rapid note switching.

**Tauri IPC:** Uses `import { invoke } from '@tauri-apps/api/core'` (not the global `__TAURI__`). Action functions are exposed on `window.*` for inline `onclick` handlers in the rendered HTML.

### Backend (`src-tauri/src/lib.rs`)

SQLite database via `rusqlite` with `Mutex<Connection>` in Tauri managed state. Nine `#[tauri::command]` functions handle CRUD for folders and notes, plus `import_data` for bulk migration.

Database schema includes an FTS5 virtual table (`notes_fts`) with triggers that keep it in sync automatically — ready for future search features but not yet exposed to the frontend.

Tauri auto-converts JS camelCase params to Rust snake_case (e.g., `folderId` → `folder_id`).

### Key Config

- `tauri.conf.json`: Vite dev server at `devUrl: "http://localhost:5173"`, `frontendDist: "../dist"` for production
- `withGlobalTauri: false` — uses `@tauri-apps/api` ES module imports
- SQLite database stored at Tauri app data dir as `anote.db`
