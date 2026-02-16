import { Crepe } from '@milkdown/crepe';
import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';

let crepeInstance = null;
let sequenceId = 0;

// ProseMirror plugin for find-in-note highlight decorations
const findHighlightPluginKey = new PluginKey('find-highlight');

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

  crepeInstance = crepe;
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
