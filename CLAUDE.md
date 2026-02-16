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

Raycast extension commands:
```bash
cd raycast && bun install
bun run raycast:typecheck
cd raycast && bun run dev
cargo build --manifest-path src-tauri/Cargo.toml --bin anote_bridge
```

No unit/integration test framework or linting is configured.
A performance harness is configured under `tests/`.

## Performance Test Harness

Resource/performance automation lives under `tests/` and is intentionally isolated from app runtime code.

```bash
bun run test:perf      # Full suite (Playwright UI workload + process sampling)
bun run test:perf:ui   # UI workload only
```

Notes:
- The harness runs in browser mode (not Tauri window automation).
- It injects a test-only Tauri IPC mock so existing `invoke(...)`-based app actions can run unchanged.
- CLI output includes a concise human-readable run summary and artifact paths.

Setup once:
```bash
bun --cwd tests install
bunx playwright install chromium
```

## Dependencies

Prefer hand-written code over adding dependencies. Small utilities, UI patterns, and helpers should be implemented directly — not pulled from npm. Only use libraries for things that would be unreasonable to build in-house (e.g., the markdown editor, database driver, framework core). When tempted to `npm install`, first ask: can this be written in under ~500 lines of focused code?

## Architecture

Tauri v2 desktop app: Rust backend + Vite-bundled modular frontend with Milkdown markdown editor.

### Raycast Extension

Code lives in `raycast/` and is macOS-targeted.

- **Read path:** Raycast read/search flows may query `~/.anote/anote.db` directly.
- **Write path:** Raycast create/update flows must go through `anote_bridge` (`src-tauri/src/bin/anote_bridge.rs`), not direct extension-side SQLite writes.
- **Bridge protocol:** One JSON request on stdin and one JSON response on stdout.
- **Supported ops:** `ensure_inbox`, `create_note`, `update_note`, `search_notes`, `get_note`.
- **Bridge resolution order:** `ANOTE_BRIDGE_BIN` env var, then `src-tauri/target/debug/anote_bridge`, then `cargo run --bin anote_bridge`.
- **Permissions:** Raycast manifest must include `read-write-user-files` and `execute-api`.
- **Consistency contract:** Keep app sync-token polling and stale-write conflict guards aligned with bridge behavior; when changing these paths, add brief rationale comments.
- **Docs sync rule:** If bridge ops, error codes, resolution order, or write-path behavior changes, update both `raycast/README.md` and this Raycast section in the same commit.
- **Validation checklist:** Run `cd src-tauri && cargo check`, `cd src-tauri && cargo check --bin anote_bridge`, `bun run raycast:typecheck`, then manually verify search, copy, create, and update flows in Raycast dev mode.

### Data Flow

**In-memory state + write-through to SQLite.** The frontend keeps all data in a JS `state.data` object (with index Maps for O(1) lookups). Reads are synchronous from memory; writes update memory first, call `render()` for instant UI, then fire-and-forget `invoke()` to persist to SQLite.

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
  state.js              ← state object, index Maps, DataLayer, utilities
  render.js             ← Selective render system, all action handlers, window.* exports
  icons.js              ← SVG icon string exports
  editor.js             ← Milkdown Crepe wrapper, ProseMirror plugins (find-highlight decorations)
  styles/
    theme.css            ← CSS variable definitions (light/dark)
    base.css             ← Reset, body, scrollbar, animations
    layout.css           ← App layout, context menu, modal, responsive
    sidebar.css          ← Sidebar, folders
    notes.css            ← Notes list, note cards
    editor.css           ← Editor panel, Milkdown theme overrides
```

**Render system:** `render()` is async and uses dirty flags to skip unchanged sections. The sidebar and notes list rebuild via `innerHTML` (safe, no persistent state). The editor panel only rebuilds when `activeNoteId` changes, preserving the Milkdown instance during typing. `updateNoteCard()` does targeted DOM patches for the active note's card preview.

**Milkdown editor:** Uses `@milkdown/crepe` (batteries-included package). Supports headings, lists, checkboxes, bold/italic, code blocks, tables, blockquotes, horizontal rules. ImageBlock, Latex, and LinkTooltip features are disabled. The editor wrapper in `editor.js` includes a sequence counter to guard against race conditions during rapid note switching.

**Adding ProseMirror plugins:** Import `$prose` from `@milkdown/utils` and primitives from `@milkdown/prose/state` and `@milkdown/prose/view` (transitive deps, do not add them to `package.json`). Define plugin instances at module level in `editor.js`. Register before `crepe.create()` via `crepe.editor.use($prose(() => plugin))`. Dispatch plugin transactions through `getEditorView()`. Follow the find-highlight plugin as the reference pattern.

**Find bar DOM:** Never rebuild the find bar with `innerHTML` — it destroys the input and loses cursor position. Build once, then patch `textContent`/values on subsequent updates. Use `TextSelection.near()` + `scrollIntoView()` for navigating to ProseMirror positions, never manual `coordsAtPos`/`scrollTo`.

**Tauri IPC:** Uses `import { invoke } from '@tauri-apps/api/core'` (not the global `__TAURI__`). Action functions are exposed on `window.*` for inline `onclick` handlers in the rendered HTML.

### Backend (`src-tauri/src/lib.rs`)

SQLite database via `rusqlite` with `Mutex<Connection>` in Tauri managed state. `#[tauri::command]` functions handle CRUD for folders and notes, `search_notes` (FTS5), `import_data` for bulk migration, and `export_backup` for JSON backups to `~/.anote/backups/`.

Database schema includes an FTS5 virtual table (`notes_fts`) with triggers that keep it in sync automatically. The command palette uses `search_notes` for ranked full-text search. Schema migrations use `PRAGMA user_version` — increment the version for each new migration block in `init_db()`.

Tauri auto-converts JS camelCase params to Rust snake_case (e.g., `folderId` → `folder_id`).

### Patterns to Preserve

- **Index Maps:** Use `state.notesById`/`foldersById` for lookups, never `.find()`. Keep Maps in sync at mutation sites or call `rebuildIndexes()`.
- **Dirty flags:** Set `dirty.sidebar`/`notesHeader`/`notesList` before `render()`. Omit for full-layout changes.
- **Per-note debounce:** Call `flushPendingSaves()` before switching note, folder, or on app close.
- **Find bar cleanup:** Always call `closeFindBar()` before switching notes or folders — stale match positions will cause crashes.
- **Code comments:** Add concise comments only where logic is non-obvious; skip comments for straightforward code.
- **Cross-process consistency comments:** When adding/changing sync tokens, conflict guards, external writers, or fallback query paths, include brief rationale comments explaining why the consistency behavior exists.

### Key Config

- `tauri.conf.json`: Vite dev server at `devUrl: "http://localhost:5173"`, `frontendDist: "../dist"` for production
- `withGlobalTauri: false` — uses `@tauri-apps/api` ES module imports
- SQLite database stored at `~/.anote/anote.db` (auto-migrates from old Tauri app data dir on first run)

## Communication Style

- When describing code changes or fixes, use a single-sentence summary. Only elaborate if asked.
- At the end of each implementation, provide concise recommendations (one or more, as useful) that could improve future agent performance, including AGENTS.md rules, better commands/workflows, validation steps, or common pitfalls; present them as actionable suggestions, not questions, and skip filler when no meaningful recommendation exists.
