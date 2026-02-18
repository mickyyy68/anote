import './styles/theme.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/sidebar.css';
import './styles/notes.css';
import './styles/editor.css';

import { state, DataLayer, migrateLocalStorage, loadTheme, saveTheme } from './state.js';
import { render } from './render.js';

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modifier = isMac ? e.metaKey : e.ctrlKey;
    
    // Ignore if modifier not pressed or if typing in an input
    if (!modifier) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
      // Allow Cmd+F to work in find bar
      if (e.key.toLowerCase() !== 'f') return;
    }

    switch (e.key.toLowerCase()) {
      case 'n': // Cmd+N: New note
        e.preventDefault();
        if (state.activeFolderId && window.addNote) {
          window.addNote();
        }
        break;
      case 's': // Cmd+S: Save note
        e.preventDefault();
        if (window.flushPendingSaves) {
          window.flushPendingSaves();
        }
        break;
      case 'd': // Cmd+D: Delete note
        e.preventDefault();
        if (state.activeNoteId && window.deleteNote) {
          window.deleteNote(state.activeNoteId);
        }
        break;
      case 'f': // Cmd+F: Focus search
        e.preventDefault();
        if (window.openFindBar) {
          window.openFindBar();
        }
        break;
      case 'p': // Cmd+P: Toggle pin
        e.preventDefault();
        if (state.activeNoteId && window.togglePinNote) {
          window.togglePinNote(state.activeNoteId);
        }
        break;
    }
  });
}

async function init() {
  saveTheme(loadTheme());
  await migrateLocalStorage();
  await DataLayer.load();
  await render();
  setupKeyboardShortcuts();
}

init();
