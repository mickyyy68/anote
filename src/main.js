import './styles/theme.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/sidebar.css';
import './styles/notes.css';
import './styles/editor.css';

import { state, DataLayer, migrateLocalStorage, loadTheme, saveTheme } from './state.js';
import { render } from './render.js';

async function init() {
  saveTheme(loadTheme());
  await migrateLocalStorage();
  await DataLayer.load();
  await render();
}

init();
