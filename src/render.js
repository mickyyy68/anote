import { invoke } from '@tauri-apps/api/core';
import { icons } from './icons.js';
import { state, loadTheme, saveTheme, generateId, formatDate, escapeHtml } from './state.js';
import { createEditor, destroyEditor, focusEditor } from './editor.js';

// Track which note the editor is currently showing
let currentEditorNoteId = null;
// Track whether we need a full rebuild (layout changed) vs partial update
let currentFolderId = null;

function stripMarkdown(md) {
  return md
    .replace(/^#{1,6}\s+/gm, '')          // headings
    .replace(/\*\*(.+?)\*\*/g, '$1')       // bold
    .replace(/__(.+?)__/g, '$1')            // bold alt
    .replace(/\*(.+?)\*/g, '$1')            // italic
    .replace(/_(.+?)_/g, '$1')              // italic alt
    .replace(/~~(.+?)~~/g, '$1')            // strikethrough
    .replace(/`(.+?)`/g, '$1')             // inline code
    .replace(/^>\s+/gm, '')                 // blockquotes
    .replace(/^[-*+]\s+/gm, '')             // unordered lists
    .replace(/^\d+\.\s+/gm, '')             // ordered lists
    .replace(/^- \[[ x]\]\s+/gm, '')        // checkboxes
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/^---+$/gm, '')                // horizontal rules
    .replace(/\|/g, ' ')                    // table pipes
    .replace(/\n{2,}/g, ' ')               // collapse newlines
    .replace(/\n/g, ' ')
    .trim();
}

// ===== RENDER HELPERS =====
function renderSidebar() {
  const root = document.getElementById('sidebar-root');
  if (!root) return;

  const theme = loadTheme();
  const { data, activeFolderId, editingFolderId } = state;

  root.innerHTML = `
    <div class="sidebar-header">
      <div class="logo">a<span>note</span></div>
      <button class="theme-toggle" onclick="toggleTheme()" title="Toggle theme">
        ${theme === 'light' ? icons.moon : icons.sun}
      </button>
    </div>

    <div class="folders-section">
      <div class="section-label">
        <span>Folders</span>
        <button class="add-folder-btn" onclick="addFolder()" title="New folder">
          ${icons.plus}
        </button>
      </div>

      ${data.folders.length === 0 ? `
        <div class="empty-folders">
          <div class="empty-folders-icon">${icons.folder}</div>
          <p>No folders yet.<br>Create one to start writing.</p>
        </div>
      ` : `
        <ul class="folder-list">
          ${data.folders.map((folder, i) => {
            const count = data.notes.filter(n => n.folderId === folder.id).length;
            const isEditing = editingFolderId === folder.id;
            return `
              <li class="folder-item ${activeFolderId === folder.id ? 'active' : ''}"
                  style="animation-delay: ${i * 30}ms"
                  onclick="selectFolder('${folder.id}')"
                  oncontextmenu="showFolderContextMenu(event, '${folder.id}')">
                <div class="folder-icon">${icons.folder}</div>
                ${isEditing ? `
                  <input class="folder-name-input"
                         type="text"
                         value="${escapeHtml(folder.name)}"
                         onclick="event.stopPropagation()"
                         onblur="finishEditingFolder('${folder.id}', this.value)"
                         onkeydown="handleFolderKeydown(event, '${folder.id}', this.value)"
                         id="folder-edit-${folder.id}" />
                ` : `
                  <span class="folder-name">${escapeHtml(folder.name)}</span>
                `}
                <span class="folder-count">${count}</span>
                <div class="folder-actions">
                  <button class="folder-action-btn" onclick="event.stopPropagation(); startEditingFolder('${folder.id}')" title="Rename">
                    ${icons.edit}
                  </button>
                  <button class="folder-action-btn delete" onclick="event.stopPropagation(); deleteFolder('${folder.id}')" title="Delete">
                    ${icons.trash}
                  </button>
                </div>
              </li>
            `;
          }).join('')}
        </ul>
      `}
    </div>

    <div class="sidebar-footer">
      <p>Write something worth keeping.</p>
    </div>
  `;

  // Auto-focus editing inputs
  if (editingFolderId) {
    const input = document.getElementById(`folder-edit-${editingFolderId}`);
    if (input) {
      input.focus();
      input.select();
    }
  }
}

function renderNotesHeader() {
  const root = document.getElementById('notes-header-root');
  if (!root) return;
  const { data, activeFolderId } = state;
  const activeFolder = data.folders.find(f => f.id === activeFolderId);
  root.innerHTML = `
    <h2 class="notes-header-title">${activeFolder ? escapeHtml(activeFolder.name) : ''}</h2>
    <button class="add-note-btn" onclick="addNote()">
      ${icons.plus}
      <span>New note</span>
    </button>
  `;
}

function renderNotesList() {
  const root = document.getElementById('notes-list-root');
  if (!root) return;
  const { data, activeFolderId, activeNoteId } = state;
  const folderNotes = activeFolderId
    ? data.notes.filter(n => n.folderId === activeFolderId).sort((a, b) => b.updatedAt - a.updatedAt)
    : [];

  if (folderNotes.length === 0) {
    root.innerHTML = `
      <div class="empty-notes">
        <div class="empty-notes-icon">${icons.file}</div>
        <h3>No notes yet</h3>
        <p>Create a new note to begin writing in this folder.</p>
      </div>
    `;
  } else {
    root.innerHTML = folderNotes.map((note, i) => `
      <div class="note-card ${activeNoteId === note.id ? 'active' : ''}"
           style="animation-delay: ${i * 30}ms"
           onclick="selectNote('${note.id}')"
           data-note-id="${note.id}">
        <div class="note-card-title">${escapeHtml(note.title || 'Untitled')}</div>
        <div class="note-card-preview">${escapeHtml(stripMarkdown(note.body).slice(0, 80) || 'Empty note')}</div>
        <div class="note-card-date">${formatDate(note.updatedAt)}</div>
        <button class="note-card-delete" onclick="event.stopPropagation(); deleteNote('${note.id}')" title="Delete note">
          ${icons.x}
        </button>
      </div>
    `).join('');
  }
}

async function renderEditorPanel(focusTitle) {
  const root = document.getElementById('editor-panel-root');
  if (!root) return;
  const { activeNoteId } = state;
  const activeNote = state.data.notes.find(n => n.id === activeNoteId);

  // Destroy old editor
  await destroyEditor();
  currentEditorNoteId = null;

  if (!activeNote) {
    root.innerHTML = `
      <div class="editor-empty">
        <div class="editor-empty-quill">${icons.quill}</div>
        <p>Select a note or create a new one</p>
      </div>
    `;
    return;
  }

  currentEditorNoteId = activeNote.id;

  root.innerHTML = `
    <input class="editor-title-input"
           type="text"
           placeholder="Untitled"
           value="${escapeHtml(activeNote.title)}"
           id="editor-title" />
    <div class="editor-date">${formatDate(activeNote.updatedAt)}</div>
    <div class="editor-body" id="editor-milkdown"></div>
  `;

  // Wire up title input with addEventListener
  const titleInput = document.getElementById('editor-title');
  if (titleInput) {
    titleInput.addEventListener('input', (e) => {
      updateNoteTitle(activeNote.id, e.target.value);
    });
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        focusEditor();
      }
    });
    if (focusTitle) {
      titleInput.focus();
    }
  }

  // Create Milkdown editor
  const editorContainer = document.getElementById('editor-milkdown');
  if (editorContainer) {
    await createEditor(editorContainer, activeNote.body, (markdown) => {
      updateNoteBody(activeNote.id, markdown);
    });
  }
}

// ===== MAIN RENDER =====
// Builds the skeleton on first call or when layout changes (folder selected/deselected).
// Subsequent calls only update the parts that changed.
export async function render(options = {}) {
  const app = document.getElementById('app');
  const { activeFolderId, activeNoteId } = state;
  const layoutChanged = !app.children.length || (currentFolderId === null) !== (activeFolderId === null) || (currentFolderId !== null && activeFolderId === null) || (currentFolderId === null && activeFolderId !== null);

  if (layoutChanged || !app.children.length) {
    // Full skeleton rebuild
    await destroyEditor();
    currentEditorNoteId = null;

    if (!activeFolderId) {
      app.innerHTML = `
        <aside class="sidebar" id="sidebar-root"></aside>
        <main class="main">
          <div class="no-folder-state">
            <div class="empty-notes-icon">${icons.quill}</div>
            <h2>Welcome to anote</h2>
            <p>Select a folder from the sidebar to view your notes, or create a new one to get started.</p>
          </div>
        </main>
      `;
    } else {
      app.innerHTML = `
        <aside class="sidebar" id="sidebar-root"></aside>
        <main class="main" id="main-root">
          <div class="notes-header" id="notes-header-root"></div>
          <div class="content-area">
            <div class="notes-list-panel" id="notes-list-root"></div>
            <div class="editor-panel" id="editor-panel-root"></div>
          </div>
        </main>
      `;
    }
    currentFolderId = activeFolderId;
  }

  // Always update sidebar and notes list (safe innerHTML rebuilds)
  renderSidebar();

  if (activeFolderId) {
    renderNotesHeader();
    renderNotesList();

    // Only rebuild editor when active note changes
    if (currentEditorNoteId !== activeNoteId) {
      await renderEditorPanel(options.focusTitle);
    }
  }
}

// ===== THEME =====
function toggleTheme() {
  const current = loadTheme();
  const next = current === 'light' ? 'dark' : 'light';
  saveTheme(next);
  render();
}

// ===== FOLDER ACTIONS =====
async function addFolder() {
  const folder = {
    id: generateId(),
    name: 'New folder',
    createdAt: Date.now(),
  };
  state.data.folders.push(folder);
  state.activeFolderId = folder.id;
  state.activeNoteId = null;
  state.editingFolderId = folder.id;
  render();
  await invoke('create_folder', {
    id: folder.id, name: folder.name, createdAt: folder.createdAt
  });
}

function selectFolder(id) {
  if (state.editingFolderId) return;
  state.activeFolderId = id;
  state.activeNoteId = null;
  // Auto-select first note
  const folderNotes = state.data.notes
    .filter(n => n.folderId === id)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (folderNotes.length > 0) {
    state.activeNoteId = folderNotes[0].id;
  }
  render();
}

function startEditingFolder(id) {
  state.editingFolderId = id;
  render();
}

async function finishEditingFolder(id, value) {
  const folder = state.data.folders.find(f => f.id === id);
  const newName = value.trim() || 'Untitled folder';
  if (folder) {
    folder.name = newName;
  }
  state.editingFolderId = null;
  render();
  await invoke('rename_folder', { id, name: newName });
}

function handleFolderKeydown(e, id, value) {
  if (e.key === 'Enter') {
    e.target.blur();
  } else if (e.key === 'Escape') {
    state.editingFolderId = null;
    render();
  }
}

async function deleteFolder(id) {
  state.data.folders = state.data.folders.filter(f => f.id !== id);
  state.data.notes = state.data.notes.filter(n => n.folderId !== id);
  if (state.activeFolderId === id) {
    state.activeFolderId = null;
    state.activeNoteId = null;
  }
  render();
  await invoke('delete_folder', { id });
}

function showFolderContextMenu(e, folderId) {
  e.preventDefault();
  e.stopPropagation();
  closeContextMenu();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.innerHTML = `
    <button class="context-menu-item" onclick="closeContextMenu(); startEditingFolder('${folderId}')">
      ${icons.edit} Rename
    </button>
    <div class="context-menu-separator"></div>
    <button class="context-menu-item danger" onclick="closeContextMenu(); deleteFolder('${folderId}')">
      ${icons.trash} Delete folder
    </button>
  `;
  document.body.appendChild(menu);

  // Adjust if off-screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

  state.contextMenu = menu;
}

function closeContextMenu() {
  if (state.contextMenu) {
    state.contextMenu.remove();
    state.contextMenu = null;
  }
}

// ===== NOTE ACTIONS =====
async function addNote() {
  if (!state.activeFolderId) return;
  const note = {
    id: generateId(),
    folderId: state.activeFolderId,
    title: '',
    body: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.data.notes.push(note);
  state.activeNoteId = note.id;
  await render({ focusTitle: true });
  await invoke('create_note', {
    id: note.id, folderId: note.folderId, title: note.title,
    body: note.body, createdAt: note.createdAt, updatedAt: note.updatedAt
  });
}

function selectNote(id) {
  state.activeNoteId = id;
  render();
}

let saveTimeout;
function updateNoteTitle(id, value) {
  const note = state.data.notes.find(n => n.id === id);
  if (note) {
    note.title = value;
    note.updatedAt = Date.now();
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      updateNoteCard(note);
      invoke('update_note', {
        id: note.id, title: note.title, body: note.body, updatedAt: note.updatedAt
      });
    }, 300);
  }
}

function updateNoteBody(id, value) {
  const note = state.data.notes.find(n => n.id === id);
  if (note) {
    note.body = value;
    note.updatedAt = Date.now();
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      updateNoteCard(note);
      invoke('update_note', {
        id: note.id, title: note.title, body: note.body, updatedAt: note.updatedAt
      });
    }, 300);
  }
}

function updateNoteCard(note) {
  const card = document.querySelector(`.note-card[data-note-id="${note.id}"]`);
  if (card) {
    const titleEl = card.querySelector('.note-card-title');
    const previewEl = card.querySelector('.note-card-preview');
    const dateEl = card.querySelector('.note-card-date');
    if (titleEl) titleEl.textContent = note.title || 'Untitled';
    if (previewEl) previewEl.textContent = stripMarkdown(note.body).slice(0, 80) || 'Empty note';
    if (dateEl) dateEl.textContent = formatDate(note.updatedAt);
  }
}

async function deleteNote(id) {
  state.data.notes = state.data.notes.filter(n => n.id !== id);
  if (state.activeNoteId === id) {
    const folderNotes = state.data.notes
      .filter(n => n.folderId === state.activeFolderId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    state.activeNoteId = folderNotes.length > 0 ? folderNotes[0].id : null;
  }
  render();
  await invoke('delete_note', { id });
}

// ===== GLOBAL EVENT LISTENERS =====
document.addEventListener('click', closeContextMenu);
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.folder-item')) closeContextMenu();
});

// ===== KEYBOARD SHORTCUTS =====
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
    e.preventDefault();
    if (state.activeFolderId) addNote();
  }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'N') {
    e.preventDefault();
    addFolder();
  }
  if (e.key === 'Escape') {
    closeContextMenu();
  }
});

// ===== EXPOSE TO WINDOW FOR INLINE HANDLERS =====
window.toggleTheme = toggleTheme;
window.addFolder = addFolder;
window.selectFolder = selectFolder;
window.startEditingFolder = startEditingFolder;
window.finishEditingFolder = finishEditingFolder;
window.handleFolderKeydown = handleFolderKeydown;
window.deleteFolder = deleteFolder;
window.showFolderContextMenu = showFolderContextMenu;
window.closeContextMenu = closeContextMenu;
window.addNote = addNote;
window.selectNote = selectNote;
window.updateNoteTitle = updateNoteTitle;
window.updateNoteBody = updateNoteBody;
window.deleteNote = deleteNote;
