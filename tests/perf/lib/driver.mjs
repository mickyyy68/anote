import { chromium } from 'playwright';

export async function connectBrowser({ baseUrl, headed = false } = {}) {
  const browser = await chromium.launch({
    headless: !headed,
  });

  const context = await browser.newContext();
  await context.addInitScript(() => {
    const state = {
      folders: [],
      notes: [],
    };

    const callbacks = new Map();
    let callbackId = 1;

    const clone = (v) => JSON.parse(JSON.stringify(v));
    const asMs = () => Date.now();

    function getArg(args, camel, snake) {
      if (camel in args) return args[camel];
      if (snake in args) return args[snake];
      return undefined;
    }

    function metadataFromNote(note) {
      return {
        id: note.id,
        folder_id: note.folder_id,
        title: note.title || '',
        preview: (note.body || '').slice(0, 200),
        created_at: note.created_at,
        updated_at: note.updated_at,
        pinned: note.pinned || 0,
        sort_order: note.sort_order || 0,
      };
    }

    async function invoke(cmd, args = {}) {
      switch (cmd) {
        case 'get_folders':
          return clone(state.folders).sort((a, b) => a.created_at - b.created_at);
        case 'create_folder': {
          const id = getArg(args, 'id', 'id');
          const name = getArg(args, 'name', 'name');
          const createdAt = getArg(args, 'createdAt', 'created_at') || asMs();
          state.folders.push({ id, name, created_at: createdAt });
          return null;
        }
        case 'rename_folder': {
          const id = getArg(args, 'id', 'id');
          const name = getArg(args, 'name', 'name');
          const folder = state.folders.find((f) => f.id === id);
          if (folder) folder.name = name;
          return null;
        }
        case 'delete_folder': {
          const id = getArg(args, 'id', 'id');
          state.folders = state.folders.filter((f) => f.id !== id);
          state.notes = state.notes.filter((n) => n.folder_id !== id);
          return null;
        }
        case 'get_notes_metadata':
          return clone(state.notes).map(metadataFromNote);
        case 'get_note_body': {
          const id = getArg(args, 'id', 'id');
          const note = state.notes.find((n) => n.id === id);
          return note ? note.body || '' : '';
        }
        case 'get_notes_all':
          return clone(state.notes);
        case 'create_note': {
          const note = {
            id: getArg(args, 'id', 'id'),
            folder_id: getArg(args, 'folderId', 'folder_id'),
            title: getArg(args, 'title', 'title') || '',
            body: getArg(args, 'body', 'body') || '',
            created_at: getArg(args, 'createdAt', 'created_at') || asMs(),
            updated_at: getArg(args, 'updatedAt', 'updated_at') || asMs(),
            pinned: getArg(args, 'pinned', 'pinned') || 0,
            sort_order: getArg(args, 'sortOrder', 'sort_order') || 0,
          };
          state.notes.push(note);
          return null;
        }
        case 'update_note': {
          const id = getArg(args, 'id', 'id');
          const note = state.notes.find((n) => n.id === id);
          if (!note) return null;
          note.title = getArg(args, 'title', 'title') || '';
          note.body = getArg(args, 'body', 'body') || '';
          note.updated_at = getArg(args, 'updatedAt', 'updated_at') || asMs();
          return null;
        }
        case 'delete_note': {
          const id = getArg(args, 'id', 'id');
          state.notes = state.notes.filter((n) => n.id !== id);
          return null;
        }
        case 'search_notes': {
          const query = String(getArg(args, 'query', 'query') || '').toLowerCase().trim();
          if (!query) return [];
          const matches = state.notes
            .filter((n) => (n.title || '').toLowerCase().includes(query) || (n.body || '').toLowerCase().includes(query))
            .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
            .slice(0, 80)
            .map(metadataFromNote);
          return clone(matches);
        }
        case 'toggle_note_pinned': {
          const id = getArg(args, 'id', 'id');
          const pinned = getArg(args, 'pinned', 'pinned') || 0;
          const note = state.notes.find((n) => n.id === id);
          if (note) note.pinned = pinned;
          return null;
        }
        case 'reorder_notes': {
          const updates = getArg(args, 'updates', 'updates') || [];
          for (const [id, sortOrder] of updates) {
            const note = state.notes.find((n) => n.id === id);
            if (note) note.sort_order = sortOrder;
          }
          return null;
        }
        case 'import_data': {
          const folders = getArg(args, 'folders', 'folders') || [];
          const notes = getArg(args, 'notes', 'notes') || [];
          state.folders = clone(folders);
          state.notes = clone(notes);
          return null;
        }
        case 'export_backup':
          return '/tmp/mock-backup.json';
        default:
          // Ignore plugin and unknown commands in browser-mode harness.
          return null;
      }
    }

    window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
    window.__TAURI_INTERNALS__.invoke = invoke;
    window.__TAURI_INTERNALS__.transformCallback = (cb) => {
      const id = callbackId++;
      callbacks.set(id, cb);
      return id;
    };
    window.__TAURI_INTERNALS__.unregisterCallback = (id) => {
      callbacks.delete(id);
    };
    window.__TAURI_INTERNALS__.convertFileSrc = (filePath) => filePath;
  });
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  return { browser, context, page };
}

export async function closeBrowser(session) {
  if (!session) return;
  try {
    await session.context?.close();
  } catch {
    // Ignore teardown failures.
  }
  try {
    await session.browser?.close();
  } catch {
    // Ignore teardown failures.
  }
}
