import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';

let crepeInstance = null;
let sequenceId = 0;

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

  let initialLoad = true;

  crepe.on((api) => {
    api.markdownUpdated((_ctx, md, _prevMd) => {
      // Guard against firing onChange on initial content load
      if (initialLoad) {
        initialLoad = false;
        return;
      }
      onChange(md);
    });
  });

  await crepe.create();

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
      // Fallback: focus the ProseMirror contenteditable element
      const pm = document.querySelector('.milkdown .ProseMirror');
      if (pm) pm.focus();
    }
  }
}
