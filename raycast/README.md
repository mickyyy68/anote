# anote Raycast Extension

This extension adds Raycast workflows for `anote` with a split architecture:

- Read/search/detail in Raycast from `~/.anote/anote.db`
- Copy note content/title from Raycast
- Optional `Open anote` action
- Update and delete note actions from `Search Notes`
- Write actions through a Rust bridge binary (`anote_bridge`)

## Why It Is Built This Way

- Read paths can safely query SQLite directly from Raycast.
- Write paths must go through `anote_bridge` so mutations follow app rules (Inbox defaulting, order updates, conflict checks).
- The desktop app (`src/render.js`) uses sync token polling/focus refresh to reconcile external writes.

## Repository Layout

- `raycast/src/search-notes.tsx`: main search/list/detail command, includes `Update Note` and `Delete Note` actions.
- `raycast/src/create-note.tsx`: create note form command.
- `raycast/src/lib/db.ts`: read-only SQLite access via `sqlite3` CLI.
- `raycast/src/lib/bridge.ts`: bridge invocation and typed request/response handling.
- `raycast/src/lib/anote-app.ts`: optional app-launch action.
- `src-tauri/src/bin/anote_bridge.rs`: bridge implementation.
- `src-tauri/src/db.rs`: shared DB path + schema/migration bootstrap used by app and bridge.

## Setup

1. Install extension dependencies:

```bash
cd raycast && bun install
```

2. Build the bridge binary:

```bash
cargo build --manifest-path src-tauri/Cargo.toml --bin anote_bridge
```

3. Run in Raycast development mode:

```bash
cd raycast && bun run dev
```

## Runtime Flow

### Read flow (`Search Notes`)

1. User types query.
2. `raycast/src/lib/db.ts` runs SQL via local `sqlite3`.
3. Empty query returns most-recent notes.
4. Non-empty query tries FTS (`MATCH`) and falls back to `LIKE` if needed.
5. Selecting a note loads full body for detail pane.

### Write flow (`Create Note` / `Update Note` / `Delete Note`)

1. Command calls `raycast/src/lib/bridge.ts`.
2. Bridge sends one JSON request to `anote_bridge` stdin and reads one JSON response from stdout.
3. Bridge mutates canonical DB with conflict-safe logic.
4. Desktop app picks up changes via sync token watcher and reloads in-memory state.

## Bridge Resolution

Write commands use this resolution order:

1. `ANOTE_BRIDGE_BIN` environment variable
2. Extension preference `bridgeBinaryPath` (absolute `anote_bridge` path)
3. Installed app bridge binary auto-discovery (`/Applications/anote.app/.../anote_bridge`, `~/Applications/.../anote_bridge`, `~/.anote/bin/anote_bridge`)
4. Installed app binary auto-discovery (`.../anote`) using `--bridge-cli` protocol mode
5. Auto-discovered repo root from runtime paths (`process.cwd()`, `__dirname`, `PWD`) plus optional preference `bridgeRepoRoot`, then `src-tauri/target/debug/anote_bridge`
6. Cargo fallback with discovered `src-tauri/Cargo.toml` (only when a manifest is resolvable)

## Bridge Contract (for Agents)

- Transport: single JSON request over stdin, single JSON response over stdout.
- Success shape: `{ "ok": true, "data": ... }`
- Error shape: `{ "ok": false, "error": { "code": "...", "message": "..." } }`
- Supported ops: `ensure_inbox`, `create_note`, `update_note`, `delete_note`, `search_notes`, `get_note`
- Error codes: `VALIDATION`, `CONFLICT`, `INTERNAL`

## Commands

- `Search Notes`: search/view/copy notes and open update/delete forms
- `Create Note`: create notes (defaults to `Inbox` if no folder ID is provided)
- `Quick Note`: quickly create a note with clipboard paste support

## Required Environment

- macOS + Raycast
- `sqlite3` CLI available on PATH (used by `raycast/src/lib/db.ts`)
- Bridge binary resolvable by one of the resolution paths above
- Installed users should not need manual setup when anote is installed in standard macOS app locations; preferences remain optional overrides for custom environments.

## Validation Checklist

Run these before handing off:

```bash
cd src-tauri && cargo check
cd src-tauri && cargo check --bin anote_bridge
bun run raycast:typecheck
```

Manual smoke:

1. Open `Search Notes`, verify empty query shows recent notes.
2. Search with normal text and malformed FTS input.
3. Copy content/title from an item.
4. Create note (without folder ID) and verify it lands in Inbox.
5. Update a note and verify app reflects change.
6. Delete a note and verify it is removed from search results and app state.

## Common Pitfalls

- Do not implement extension-side direct writes to SQLite.
- Keep DB bootstrap logic in `src-tauri/src/db.rs` only (avoid duplicate schema logic).
- If bridge behavior changes, update both this README and `CLAUDE.md` Raycast section.
- Bridge spawn/exit diagnostics are logged to `~/.anote/raycast-bridge.log`; check this first for `ENOENT`/startup failures.
- If app-binary fallback is used, ensure desktop app version includes `--bridge-cli` mode; older app builds will fail with an explicit “no bridge response”/“does not support bridge protocol yet” error.
