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
    .replace(/^#{1,6}\s+/gm, '')                    // headings
    .replace(/(\*{1,2}|_{1,2}|~~)(.+?)\1/g, '$2')   // bold, italic, strikethrough
    .replace(/`(.+?)`/g, '$1')                       // inline code
    .replace(/^>\s+/gm, '')                           // blockquotes
    .replace(/^(?:[-*+]|\d+\.|- \[[ x]\])\s+/gm, '') // all list types
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')          // links
    .replace(/^---+$/gm, '')                          // horizontal rules
    .replace(/\|/g, ' ')                              // table pipes
    .replace(/\n+/g, ' ')                             // collapse newlines
    .trim();
}

// ===== SORT HELPER =====
function getSortedFolderNotes(folderId) {
  const notes = state.data.notes.filter(n => n.folderId === folderId);
  if (state.sortMode === 'recent') {
    return notes.sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
  }
  // manual mode
  return notes.sort((a, b) => (b.pinned - a.pinned) || (a.sortOrder - b.sortOrder));
}

// ===== DRAG STATE =====
let draggedNoteId = null;

// ===== RENDER HELPERS =====
function renderSidebar() {
  const root = document.getElementById('sidebar-root');
  if (!root) return;

  const theme = loadTheme();
  const { data, activeFolderId, editingFolderId } = state;

  root.innerHTML = `
    <div class="sidebar-header">
      <div class="logo">a<span>note</span></div>
      <div class="sidebar-header-actions">
        <button class="theme-toggle" onclick="toggleTheme()" title="Toggle theme">
          ${theme === 'light' ? icons.moon : icons.sun}
        </button>
        <button class="theme-toggle" onclick="toggleSidebar()" title="Toggle sidebar">
          ${icons.panelLeft}
        </button>
      </div>
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
          ${(() => {
            const countMap = {};
            data.notes.forEach(n => { countMap[n.folderId] = (countMap[n.folderId] || 0) + 1; });
            return data.folders.map((folder, i) => {
            const count = countMap[folder.id] || 0;
            const isEditing = editingFolderId === folder.id;
            return `
              <li class="folder-item ${activeFolderId === folder.id ? 'active' : ''}"
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
          }).join('');
          })()}
        </ul>
      `}
    </div>

    <div class="sidebar-footer">
      <p>Write something worth keeping.</p>
      <button class="settings-btn" onclick="openSettingsModal()" title="Settings">
        ${icons.gear}
      </button>
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
  const expandBtn = state.sidebarCollapsed ? `
    <button class="sidebar-expand-btn" onclick="toggleSidebar()" title="Show sidebar">
      ${icons.panelLeft}
    </button>
  ` : '';
  const sortIcon = state.sortMode === 'manual' ? icons.gripLines : icons.clock;
  const sortTooltip = state.sortMode === 'manual'
    ? 'Manual order - click to sort by date'
    : 'Date order - click to sort manually';
  const escapedSortTooltip = escapeHtml(sortTooltip);
  root.innerHTML = `
    ${expandBtn}
    <h2 class="notes-header-title">${activeFolder ? escapeHtml(activeFolder.name) : ''}</h2>
    <div class="sort-tooltip-wrap">
      <button class="sort-toggle-btn"
              onclick="toggleSortMode()"
              aria-label="${escapedSortTooltip}"
              aria-describedby="sort-tooltip">
        ${sortIcon}
      </button>
      <div class="sort-tooltip" id="sort-tooltip" role="tooltip">${escapedSortTooltip}</div>
    </div>
    <button class="add-note-btn" onclick="addNote()">
      ${icons.plus}
      <span>New note</span>
    </button>
  `;
}

function renderNotesList() {
  const root = document.getElementById('notes-list-root');
  if (!root) return;
  const { activeFolderId, activeNoteId } = state;
  const folderNotes = activeFolderId
    ? getSortedFolderNotes(activeFolderId)
    : [];
  const isManual = state.sortMode === 'manual';

  if (isManual) {
    root.setAttribute('ondragover', 'onNotesListDragOver(event)');
    root.setAttribute('ondrop', 'onNotesListDrop(event)');
  } else {
    root.removeAttribute('ondragover');
    root.removeAttribute('ondrop');
  }

  if (folderNotes.length === 0) {
    root.innerHTML = `
      <div class="empty-notes">
        <div class="empty-notes-icon">${icons.file}</div>
        <h3>No notes yet</h3>
        <p>Create a new note to begin writing in this folder.</p>
      </div>
    `;
  } else {
    let html = '';
    let addedSeparator = false;
    for (let i = 0; i < folderNotes.length; i++) {
      const note = folderNotes[i];
      // Add separator between pinned and unpinned groups
      if (!addedSeparator && !note.pinned && i > 0 && folderNotes[i - 1].pinned) {
        html += `<div class="notes-pin-separator"></div>`;
        addedSeparator = true;
      }
      const dragAttrs = isManual ? `draggable="true" ondragstart="onNoteDragStart(event, '${note.id}')" ondragover="onNoteDragOver(event, '${note.id}')" ondragleave="onNoteDragLeave(event)" ondrop="onNoteDrop(event, '${note.id}')" ondragend="onNoteDragEnd(event)"` : '';
      html += `
      <div class="note-card ${activeNoteId === note.id ? 'active' : ''} ${note.pinned ? 'pinned' : ''}"
           onclick="selectNote('${note.id}')"
           oncontextmenu="showNoteContextMenu(event, '${note.id}')"
           data-note-id="${note.id}"
           data-pinned="${note.pinned ? '1' : '0'}"
           ${dragAttrs}>
        ${note.pinned ? `<div class="note-card-pin-indicator">${icons.pin}</div>` : ''}
        <div class="note-card-title">${escapeHtml(note.title || 'Untitled')}</div>
        <div class="note-card-preview">${escapeHtml(stripMarkdown(note.preview || '').slice(0, 80) || 'Empty note')}</div>
        <div class="note-card-date">${formatDate(note.updatedAt)}</div>
        <button class="note-card-pin" onclick="event.stopPropagation(); togglePinNote('${note.id}')" title="${note.pinned ? 'Unpin' : 'Pin to top'}">
          ${icons.pin}
        </button>
        <button class="note-card-delete" onclick="event.stopPropagation(); deleteNote('${note.id}')" title="Delete note">
          ${icons.x}
        </button>
      </div>`;
    }
    root.innerHTML = html;
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

  // Load body on demand if not yet loaded
  if (activeNote.body === null) {
    activeNote.body = await invoke('get_note_body', { id: activeNote.id });
    // Guard: user may have switched notes during the await
    if (state.activeNoteId !== activeNote.id) return;
  }

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
  const layoutChanged = !app.children.length || (currentFolderId === null) !== (activeFolderId === null);

  if (layoutChanged || !app.children.length) {
    // Full skeleton rebuild
    await destroyEditor();
    currentEditorNoteId = null;

    const collapsedClass = state.sidebarCollapsed ? ' collapsed' : '';
    if (!activeFolderId) {
      app.innerHTML = `
        <aside class="sidebar${collapsedClass}" id="sidebar-root"></aside>
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
        <aside class="sidebar${collapsedClass}" id="sidebar-root"></aside>
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

function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  const sidebar = document.getElementById('sidebar-root');
  if (sidebar) sidebar.classList.toggle('collapsed', state.sidebarCollapsed);
  // Re-render header to show/hide expand button inline
  renderNotesHeader();
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
  const folderNotes = getSortedFolderNotes(id);
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
  // Shift existing unpinned notes' sortOrder by +1
  const unpinnedNotes = state.data.notes.filter(n => n.folderId === state.activeFolderId && !n.pinned);
  unpinnedNotes.forEach(n => { n.sortOrder += 1; });
  const note = {
    id: generateId(),
    folderId: state.activeFolderId,
    title: '',
    preview: '',
    body: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pinned: 0,
    sortOrder: 0,
  };
  state.data.notes.push(note);
  state.activeNoteId = note.id;
  await render({ focusTitle: true });
  invoke('create_note', {
    id: note.id, folderId: note.folderId, title: note.title,
    body: note.body, createdAt: note.createdAt, updatedAt: note.updatedAt,
    pinned: note.pinned, sortOrder: note.sortOrder
  });
  invoke('reorder_notes', { updates: unpinnedNotes.map(n => [n.id, n.sortOrder]) });
}

function selectNote(id) {
  const prevId = state.activeNoteId;
  state.activeNoteId = id;

  // Toggle active class directly instead of full rebuild
  if (prevId) {
    const prevCard = document.querySelector(`.note-card[data-note-id="${prevId}"]`);
    if (prevCard) prevCard.classList.remove('active');
  }
  const newCard = document.querySelector(`.note-card[data-note-id="${id}"]`);
  if (newCard) newCard.classList.add('active');

  // Only rebuild the editor
  renderEditorPanel();
}

let saveTimeout;
function scheduleSave(note) {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    updateNoteCard(note);
    invoke('update_note', {
      id: note.id, title: note.title, body: note.body, updatedAt: note.updatedAt
    });
  }, 300);
}

function updateNoteTitle(id, value) {
  const note = state.data.notes.find(n => n.id === id);
  if (note) {
    note.title = value;
    note.updatedAt = Date.now();
    scheduleSave(note);
  }
}

function updateNoteBody(id, value) {
  const note = state.data.notes.find(n => n.id === id);
  if (note) {
    note.body = value;
    note.preview = value.slice(0, 200);
    note.updatedAt = Date.now();
    scheduleSave(note);
  }
}

function updateNoteCard(note) {
  const card = document.querySelector(`.note-card[data-note-id="${note.id}"]`);
  if (card) {
    const titleEl = card.querySelector('.note-card-title');
    const previewEl = card.querySelector('.note-card-preview');
    const dateEl = card.querySelector('.note-card-date');
    if (titleEl) titleEl.textContent = note.title || 'Untitled';
    if (previewEl) previewEl.textContent = stripMarkdown(note.preview || '').slice(0, 80) || 'Empty note';
    if (dateEl) dateEl.textContent = formatDate(note.updatedAt);
  }
}

async function deleteNote(id) {
  state.data.notes = state.data.notes.filter(n => n.id !== id);
  if (state.activeNoteId === id) {
    const folderNotes = getSortedFolderNotes(state.activeFolderId);
    state.activeNoteId = folderNotes.length > 0 ? folderNotes[0].id : null;
  }
  render();
  await invoke('delete_note', { id });
}

// ===== DRAG-AND-DROP =====
function onNoteDragStart(e, id) {
  draggedNoteId = id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', id);
  const card = e.currentTarget;
  if (card) requestAnimationFrame(() => card.classList.add('dragging'));
}

function onNoteDragOver(e, targetId) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (!draggedNoteId || draggedNoteId === targetId) return;
  const draggedNote = state.data.notes.find(n => n.id === draggedNoteId);
  const targetNote = state.data.notes.find(n => n.id === targetId);
  if (!draggedNote || !targetNote) return;
  // Reject cross-group drops
  if (!!draggedNote.pinned !== !!targetNote.pinned) return;

  const card = e.currentTarget;
  if (!card) return;
  // Clear existing indicators on all cards
  document.querySelectorAll('.note-card').forEach(c => c.classList.remove('drop-above', 'drop-below'));
  const rect = card.getBoundingClientRect();
  const midY = rect.top + rect.height / 2;
  if (e.clientY < midY) {
    card.classList.add('drop-above');
  } else {
    card.classList.add('drop-below');
  }
}

function onNoteDragLeave(e) {
  const card = e.currentTarget;
  if (card && !card.contains(e.relatedTarget)) {
    card.classList.remove('drop-above', 'drop-below');
  }
}

function applyManualReorder(orderedNotes) {
  orderedNotes.forEach((n, i) => { n.sortOrder = i; });
  draggedNoteId = null;
  document.querySelectorAll('.note-card').forEach(c => c.classList.remove('dragging', 'drop-above', 'drop-below'));
  renderNotesList();
  invoke('reorder_notes', { updates: orderedNotes.map(n => [n.id, n.sortOrder]) });
}

function reorderByTarget(dragId, targetId, placement = 'above') {
  if (!dragId || dragId === targetId) return;
  const draggedNote = state.data.notes.find(n => n.id === dragId);
  const targetNote = state.data.notes.find(n => n.id === targetId);
  if (!draggedNote || !targetNote) return;
  if (!!draggedNote.pinned !== !!targetNote.pinned) return;

  const isPinned = !!draggedNote.pinned;
  const group = getSortedFolderNotes(draggedNote.folderId).filter(n => !!n.pinned === isPinned);
  const filtered = group.filter(n => n.id !== dragId);
  let targetIdx = filtered.findIndex(n => n.id === targetId);
  if (targetIdx === -1) return;
  if (placement === 'below') targetIdx += 1;

  filtered.splice(targetIdx, 0, draggedNote);
  applyManualReorder(filtered);
}

function onNoteDrop(e, targetId) {
  e.preventDefault();
  e.stopPropagation();
  if (!draggedNoteId || draggedNoteId === targetId) return;

  const targetCard = e.currentTarget;
  if (!targetCard) return;
  const rect = targetCard.getBoundingClientRect();
  const midY = rect.top + rect.height / 2;
  const placement = e.clientY >= midY ? 'below' : 'above';
  reorderByTarget(draggedNoteId, targetId, placement);
}

function onNotesListDragOver(e) {
  if (!draggedNoteId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

function onNotesListDrop(e) {
  e.preventDefault();
  if (!draggedNoteId) return;
  if (e.target.closest('.note-card')) return;

  const draggedNote = state.data.notes.find(n => n.id === draggedNoteId);
  if (!draggedNote) return;

  const isPinned = !!draggedNote.pinned;
  const reordered = getSortedFolderNotes(draggedNote.folderId)
    .filter(n => !!n.pinned === isPinned && n.id !== draggedNoteId);
  reordered.push(draggedNote);
  applyManualReorder(reordered);
}

function onNoteDragEnd() {
  draggedNoteId = null;
  document.querySelectorAll('.note-card').forEach(c => c.classList.remove('dragging', 'drop-above', 'drop-below'));
}

// ===== SORT & PIN =====
function toggleSortMode() {
  state.sortMode = state.sortMode === 'manual' ? 'recent' : 'manual';
  renderNotesHeader();
  renderNotesList();
}

async function togglePinNote(id) {
  const note = state.data.notes.find(n => n.id === id);
  if (!note) return;
  note.pinned = note.pinned ? 0 : 1;
  // Move to top of its new group
  const folderNotes = state.data.notes.filter(n => n.folderId === note.folderId && n.id !== id);
  if (note.pinned) {
    // Newly pinned: give sortOrder 0, shift other pinned notes
    const pinnedNotes = folderNotes.filter(n => n.pinned).sort((a, b) => a.sortOrder - b.sortOrder);
    pinnedNotes.forEach((n, i) => { n.sortOrder = i + 1; });
    note.sortOrder = 0;
  } else {
    // Newly unpinned: give sortOrder 0, shift other unpinned notes
    const unpinnedNotes = folderNotes.filter(n => !n.pinned).sort((a, b) => a.sortOrder - b.sortOrder);
    unpinnedNotes.forEach((n, i) => { n.sortOrder = i + 1; });
    note.sortOrder = 0;
  }
  renderNotesList();
  invoke('toggle_note_pinned', { id, pinned: note.pinned });
  // Persist reorder for all notes in the folder
  const allFolderNotes = state.data.notes.filter(n => n.folderId === note.folderId);
  invoke('reorder_notes', { updates: allFolderNotes.map(n => [n.id, n.sortOrder]) });
}

function showNoteContextMenu(e, noteId) {
  e.preventDefault();
  e.stopPropagation();
  closeContextMenu();

  const note = state.data.notes.find(n => n.id === noteId);
  if (!note) return;

  const pinLabel = note.pinned ? 'Unpin' : 'Pin to top';
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.innerHTML = `
    <button class="context-menu-item" onclick="closeContextMenu(); togglePinNote('${noteId}')">
      ${icons.pin} ${pinLabel}
    </button>
    <div class="context-menu-separator"></div>
    <button class="context-menu-item danger" onclick="closeContextMenu(); deleteNote('${noteId}')">
      ${icons.trash} Delete note
    </button>
  `;
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

  state.contextMenu = menu;
}

// ===== SETTINGS MODAL =====
function renderSettingsModal() {
  const existing = document.getElementById('settings-modal-overlay');
  if (existing) existing.remove();

  if (!state.settingsModalOpen) return;

  const overlay = document.createElement('div');
  overlay.id = 'settings-modal-overlay';
  overlay.className = 'modal-overlay';
  overlay.onclick = () => closeSettingsModal();
  overlay.innerHTML = `
    <div class="modal-content" onclick="event.stopPropagation()">
      <div class="modal-header">
        <h2>Settings</h2>
        <button class="modal-close-btn" onclick="closeSettingsModal()">${icons.x}</button>
      </div>
      <div class="modal-body">
        <div class="settings-section">
          <div class="settings-section-header">
            <h3>Backup</h3>
            <p>Export all your folders and notes as a JSON file to <code>~/.anote/backups/</code></p>
          </div>
          <button class="settings-action-btn" onclick="exportBackup()">
            ${icons.download}
            <span>Export Backup</span>
          </button>
          <div class="backup-status" id="backup-status"></div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function openSettingsModal() {
  state.settingsModalOpen = true;
  renderSettingsModal();
}

function closeSettingsModal() {
  state.settingsModalOpen = false;
  renderSettingsModal();
}

async function exportBackup() {
  const statusEl = document.getElementById('backup-status');
  if (!statusEl) return;

  statusEl.className = 'backup-status loading';
  statusEl.textContent = 'Exporting...';

  try {
    const filePath = await invoke('export_backup');
    statusEl.className = 'backup-status success';
    statusEl.textContent = `Saved to ${filePath}`;
  } catch (e) {
    statusEl.className = 'backup-status error';
    statusEl.textContent = `Export failed: ${e}`;
  }
}

// ===== GLOBAL EVENT LISTENERS =====
document.addEventListener('click', closeContextMenu);
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.folder-item') && !e.target.closest('.note-card')) closeContextMenu();
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
  if ((e.metaKey || e.ctrlKey) && e.key === ',') {
    e.preventDefault();
    openSettingsModal();
  }
  if (e.key === 'Escape') {
    if (state.settingsModalOpen) { closeSettingsModal(); return; }
    closeContextMenu();
  }
});

// ===== EXPOSE TO WINDOW FOR INLINE HANDLERS =====
window.toggleTheme = toggleTheme;
window.toggleSidebar = toggleSidebar;
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
window.openSettingsModal = openSettingsModal;
window.closeSettingsModal = closeSettingsModal;
window.exportBackup = exportBackup;
window.toggleSortMode = toggleSortMode;
window.togglePinNote = togglePinNote;
window.showNoteContextMenu = showNoteContextMenu;
window.onNoteDragStart = onNoteDragStart;
window.onNoteDragOver = onNoteDragOver;
window.onNoteDragLeave = onNoteDragLeave;
window.onNoteDrop = onNoteDrop;
window.onNoteDragEnd = onNoteDragEnd;
window.onNotesListDragOver = onNotesListDragOver;
window.onNotesListDrop = onNotesListDrop;
