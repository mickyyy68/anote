import { invoke } from '@tauri-apps/api/core';

const STORAGE_KEY = 'anote_data';
const THEME_KEY = 'anote_theme';

export const state = {
  data: { folders: [], notes: [], templates: [] },
  activeFolderId: null,
  activeNoteId: null,
  editingFolderId: null,
  contextMenu: null,
  sidebarCollapsed: false,
  settingsModalOpen: false,
  sortMode: 'manual',
  commandPaletteOpen: false,
  commandQuery: '',
  commandSelectedIndex: 0,
  findBarOpen: false,
  findQuery: '',
  findMatches: [],
  findCurrentMatch: 0,
  expandedFolders: new Set(),
  templatesModalOpen: false,
  editingTemplateId: null,
  // In-memory indexes for O(1) lookups
  notesById: new Map(),
  foldersById: new Map(),
  notesByFolderId: new Map(),
  notesCountByFolder: new Map(),
};

export function rebuildIndexes() {
  state.notesById.clear();
  state.foldersById.clear();
  state.notesByFolderId.clear();
  state.notesCountByFolder.clear();
  for (const f of state.data.folders) {
    state.foldersById.set(f.id, f);
    state.notesByFolderId.set(f.id, []);
    state.notesCountByFolder.set(f.id, 0);
  }
  for (const n of state.data.notes) {
    state.notesById.set(n.id, n);
    const list = state.notesByFolderId.get(n.folderId);
    if (list) list.push(n);
    state.notesCountByFolder.set(n.folderId, (state.notesCountByFolder.get(n.folderId) || 0) + 1);
  }
}

export const DataLayer = {
  async load() {
    try {
      const folders = await invoke('get_folders');
      const notes = await invoke('get_notes_metadata');
      const templates = await invoke('get_templates');
      state.data.folders = folders.map(f => ({
        id: f.id, name: f.name, createdAt: f.created_at, parentId: f.parent_id || null
      }));
      state.data.notes = notes.map(n => ({
        id: n.id, folderId: n.folder_id, title: n.title,
        preview: n.preview, body: null,
        createdAt: n.created_at, updatedAt: n.updated_at,
        pinned: n.pinned || 0, sortOrder: n.sort_order || 0
      }));
      state.data.templates = templates.map(t => ({
        id: t.id, name: t.name, content: t.content,
        category: t.category, createdAt: t.created_at
      }));
      rebuildIndexes();
    } catch (e) {
      console.error('Failed to load data:', e);
      state.data = { folders: [], notes: [], templates: [] };
      state.notesById.clear();
      state.foldersById.clear();
      state.notesByFolderId.clear();
      state.notesCountByFolder.clear();
    }
  },

  async exportNoteMarkdown(noteId, path) {
    try {
      await invoke('export_note_markdown', { id: noteId, path });
    } catch (e) {
      console.error('Failed to export note as Markdown:', e);
      throw e;
    }
  },

  async createTemplate(id, name, content, category, createdAt) {
    try {
      await invoke('create_template', { id, name, content, category, createdAt });
      state.data.templates.push({ id, name, content, category, createdAt });
    } catch (e) {
      console.error('Failed to create template:', e);
      throw e;
    }
  },

  async updateTemplate(id, name, content, category) {
    try {
      await invoke('update_template', { id, name, content, category });
      const idx = state.data.templates.findIndex(t => t.id === id);
      if (idx >= 0) {
        state.data.templates[idx] = { ...state.data.templates[idx], name, content, category };
      }
    } catch (e) {
      console.error('Failed to update template:', e);
      throw e;
    }
  },

  async deleteTemplate(id) {
    try {
      await invoke('delete_template', { id });
      state.data.templates = state.data.templates.filter(t => t.id !== id);
    } catch (e) {
      console.error('Failed to delete template:', e);
      throw e;
    }
  },
};

export async function migrateLocalStorage() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    if (data.folders && data.folders.length > 0) {
      const folders = data.folders.map(f => ({
        id: f.id, name: f.name, created_at: f.createdAt, parent_id: f.parentId || null
      }));
      const notes = (data.notes || []).map(n => ({
        id: n.id, folder_id: n.folderId, title: n.title || '',
        body: n.body || '', created_at: n.createdAt, updated_at: n.updatedAt
      }));
      await invoke('import_data', { folders, notes });
    }
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.error('Migration failed:', e);
  }
}

export function loadTheme() {
  return localStorage.getItem(THEME_KEY) || 'light';
}

export function saveTheme(theme) {
  localStorage.setItem(THEME_KEY, theme);
  document.documentElement.setAttribute('data-theme', theme);
}

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function formatDate(ts) {
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
