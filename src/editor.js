import { Crepe } from '@milkdown/crepe';
import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import { InputRule } from '@milkdown/prose/inputrules';
import { state as pmState } from '@milkdown/prose/state';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';

let crepeInstance = null;
let sequenceId = 0;

// Wiki-link autocomplete state
let linkPicker = null;
let linkPickerCallback = null;
let wikiLinkInProgress = false;
let wikiLinkStartPos = null;

// Callback to get note titles for autocomplete
export function setLinkPickerCallback(cb) {
  linkPickerCallback = cb;
}

// Show link picker popup
export function showLinkPicker(x, y, onSelect) {
  closeLinkPicker();
  linkPicker = document.createElement('div');
  linkPicker.className = 'link-picker';
  linkPicker.style.position = 'fixed';
  linkPicker.style.left = x + 'px';
  linkPicker.style.top = y + 'px';
  linkPicker.style.zIndex = '1000';
  document.body.appendChild(linkPicker);
  
  // Store callback for when picker receives results
  linkPicker._onSelect = onSelect;
  linkPicker._query = '';
  
  // Trigger initial query with all notes
  if (linkPickerCallback) {
    linkPickerCallback('');
  }
}

// Insert a wiki link at the current cursor position
export function insertWikiLink(title) {
  const view = getEditorView();
  if (!view) return;
  
  const { state, dispatch } = view;
  let { from, to } = state.selection;
  
  // Get the text before the cursor to check for partial [[
  const textBefore = state.doc.textBetween(Math.max(0, from - 2), from);
  
  // If there's a partial [[, adjust to include it for deletion
  let deleteFrom = from;
  if (textBefore === '[[') {
    deleteFrom = from - 2;
  }
  
  const linkText = `[[${title}]]`;
  
  // Delete any partial text and insert the complete link
  dispatch(state.tr.insertText(linkText, deleteFrom, to));
  
  // Close picker
  closeLinkPicker();
}

// Update link picker with results
export function updateLinkPicker(results, query) {
  if (!linkPicker) return;
  linkPicker._query = query;
  
  if (results.length === 0) {
    linkPicker.innerHTML = '<div class="link-picker-empty">No matching notes</div>';
    return;
  }
  
  linkPicker.innerHTML = results.map((note, i) => `
    <button class="link-picker-item" data-index="${i}" data-note-id="${note.noteId}">
      <span class="link-picker-title">${note.title || 'Untitled'}</span>
      <span class="link-picker-folder">${note.folderName}</span>
    </button>
  `).join('');
  
  // Add click handlers
  linkPicker.querySelectorAll('.link-picker-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const noteId = btn.dataset.noteId;
      const title = btn.querySelector('.link-picker-title').textContent;
      if (linkPicker._onSelect) {
        linkPicker._onSelect(noteId, title);
      }
      insertWikiLink(title);
    });
  });
}

// Close link picker
export function closeLinkPicker() {
  if (linkPicker) {
    linkPicker.remove();
    linkPicker = null;
  }
}

// Get link picker state
export function isLinkPickerOpen() {
  return linkPicker !== null;
}

// ProseMirror plugin for find-in-note highlight decorations
const findHighlightPluginKey = new PluginKey('find-highlight');

// Wiki-link plugin to detect [[note-title]] and render as clickable spans
const wikiLinkPluginKey = new PluginKey('wiki-link');

// Regex to match [[note-title]] patterns
const WIKI_LINK_REGEX = /\[\[([^\]]+)\]\]/g;

const wikiLinkPlugin = new Plugin({
  key: wikiLinkPluginKey,
  props: {
    decorations(state) {
      const decorations = [];
      state.doc.descendants((node, pos) => {
        if (!node.isText || !node.text) return;
        const text = node.text;
        let match;
        // Reset regex state
        const regex = new RegExp(WIKI_LINK_REGEX.source, 'g');
        while ((match = regex.exec(text)) !== null) {
          const start = pos + match.index;
          const end = start + match[0].length;
          const linkTitle = match[1];
          decorations.push(
            Decoration.inline(start, end, {
              class: 'wiki-link',
              'data-title': linkTitle,
            })
          );
        }
      });
      return DecorationSet.create(state.doc, decorations);
    },
    handleClickOn(view, pos, node, nodePos, event, direct) {
      // Check if clicked on a wiki link
      const target = event.target;
      if (target.classList.contains('wiki-link')) {
        const title = target.dataset.title;
        if (title && window.navigateToWikiLink) {
          window.navigateToWikiLink(title);
        }
        return true;
      }
      return false;
    },
  },
});

// Input rule to auto-close [[ when typing
function wikiLinkInputRule() {
  return new InputRule(/\[\[([^\]]*)\]\]$/, (state, match, start, end) => {
    const tr = state.tr;
    // Delete the typed [[...]]
    tr.delete(start - 1, end);
    return tr;
  });
}

const findHighlightPlugin = new Plugin({
  key: findHighlightPluginKey,
  state: {
    init() { return DecorationSet.empty; },
    apply(tr, old) {
      const meta = tr.getMeta(findHighlightPluginKey);
      if (meta) {
        const { matches, currentIndex } = meta;
        if (!matches || matches.length === 0) return DecorationSet.empty;
        const decos = matches.map((m, i) =>
          Decoration.inline(m.from, m.to, {
            class: i === currentIndex ? 'find-highlight-current' : 'find-highlight',
          })
        );
        return DecorationSet.create(tr.doc, decos);
      }
      return old.map(tr.mapping, tr.doc);
    },
  },
  props: {
    decorations(state) { return findHighlightPluginKey.getState(state); },
  },
});

export async function createEditor(container, markdown, onChange) {
  const currentSeq = ++sequenceId;

  // Destroy any existing editor first
  await destroyEditor();

  // Race condition guard — if another createEditor was called while we awaited destroy
  if (currentSeq !== sequenceId) return;

  const crepe = new Crepe({
    root: container,
    defaultValue: markdown,
    features: {
      [Crepe.Feature.ImageBlock]: false,
      [Crepe.Feature.Latex]: false,
      [Crepe.Feature.LinkTooltip]: false,
    },
    featureConfigs: {
      [Crepe.Feature.Placeholder]: {
        text: 'Start writing...',
        mode: 'doc',
      },
    },
  });

  crepe.editor.use($prose(() => findHighlightPlugin));
  crepe.editor.use($prose(() => wikiLinkPlugin));

  let initialLoad = true;

  crepe.on((api) => {
    api.markdownUpdated((_ctx, md, _prevMd) => {
      if (initialLoad) return;
      onChange(md);
    });
  });

  await crepe.create();
  initialLoad = false;

  // Race condition guard after async create
  if (currentSeq !== sequenceId) {
    await crepe.destroy();
    return;
  }

  // Add keydown listener for wiki link detection
  const editorView = crepe.editor.ctx.get('editorView');
  if (editorView) {
    const dom = editorView.dom;
    dom.addEventListener('keydown', handleEditorKeydown);
  }

  crepeInstance = crepe;
}

// Track partial [[ input
let pendingBracketCount = 0;

function handleEditorKeydown(e) {
  // Handle link picker if open
  if (isLinkPickerOpen()) {
    if (e.key === 'Escape') {
      closeLinkPicker();
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const picker = document.querySelector('.link-picker');
      const firstItem = picker?.querySelector('.link-picker-item');
      if (firstItem) {
        e.preventDefault();
        firstItem.click();
        return;
      }
    }
    // Close on arrow keys
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // Let picker handle navigation
      return;
    }
    // Update query on typing
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Get current query from picker
      const picker = document.querySelector('.link-picker');
      if (picker) {
        const currentQuery = picker._query || '';
        const newQuery = currentQuery + e.key;
        if (linkPickerCallback) {
          linkPickerCallback(newQuery);
        }
      }
    }
    return;
  }
  
  // Detect [[ for wiki link autocomplete
  if (e.key === '[') {
    pendingBracketCount++;
    if (pendingBracketCount >= 2) {
      // Show link picker
      const view = getEditorView();
      if (view) {
        const coords = view.coordsAtPos(view.state.selection.from);
        showLinkPicker(coords.left, coords.bottom + 5, (noteId, title) => {
          insertWikiLink(title);
        });
      }
      pendingBracketCount = 0;
      e.preventDefault();
    }
  } else {
    pendingBracketCount = 0;
  }
}

export async function destroyEditor() {
  if (crepeInstance) {
    const instance = crepeInstance;
    crepeInstance = null;
    await instance.destroy();
  }
}

export function getMarkdown() {
  if (crepeInstance) {
    return crepeInstance.getMarkdown();
  }
  return '';
}

export function focusEditor() {
  if (crepeInstance) {
    const el = crepeInstance.editor?.ctx?.get?.('editorView')?.dom;
    if (el) {
      el.focus();
    } else {
      const pm = document.querySelector('.milkdown .ProseMirror');
      if (pm) pm.focus();
    }
  }
}

export function getEditorView() {
  return crepeInstance?.editor?.ctx?.get?.('editorView');
}

export function updateFindHighlights(matches, currentIndex) {
  const view = getEditorView();
  if (!view) return;
  const tr = view.state.tr.setMeta(findHighlightPluginKey, { matches, currentIndex });
  view.dispatch(tr);
}
