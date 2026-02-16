import './styles/theme.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/sidebar.css';
import './styles/notes.css';
import './styles/editor.css';

import { DataLayer, migrateLocalStorage, loadTheme, saveTheme } from './state.js';
import { render, initExternalSyncWatcher } from './render.js';

async function init() {
  saveTheme(loadTheme());
  await migrateLocalStorage();
  await DataLayer.load();
  await render();
  // Start external-change watcher after first paint to keep startup path predictable.
  await initExternalSyncWatcher();
}

init();
