import { performance } from 'node:perf_hooks';
import { sleep } from './metrics.mjs';

async function callWindowFn(page, fnName, args = []) {
  return page.evaluate(
    ({ fnName, args }) => {
      const fn = window[fnName];
      if (typeof fn !== 'function') {
        throw new Error('Missing window function: ' + fnName);
      }
      return fn(...args);
    },
    { fnName, args },
  );
}

export async function waitForAppReady(page, timeoutMs) {
  const start = Date.now();
  for (;;) {
    const ready = await page.evaluate(() => {
      return (
        typeof window.addFolder === 'function' &&
        !!document.getElementById('sidebar-root')
      );
    });

    if (ready) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`READY_TIMEOUT: app not ready within ${timeoutMs}ms`);
    }
    await sleep(200);
  }
}

export async function ensureFolderExists(page) {
  const folderCount = await page.evaluate(() => {
    return document.querySelectorAll('.folder-item').length;
  });
  if (folderCount > 0) return;
  await callWindowFn(page, 'addFolder', []);
  await sleep(200);
}

export async function ensureNoteCount(page, targetCount) {
  await ensureFolderExists(page);

  for (;;) {
    const count = await page.evaluate(() => {
      return document.querySelectorAll('.note-card').length;
    });
    if (count >= targetCount) return;
    await callWindowFn(page, 'addNote', []);
  }
}

export async function getAllNoteIds(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('.note-card[data-note-id]')).map((el) => el.dataset.noteId);
  });
}

export async function getActiveNoteId(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.note-card.active[data-note-id]');
    return el ? el.dataset.noteId : null;
  });
}

export async function timedWindowCall(page, fnName, args = []) {
  const t0 = performance.now();
  await callWindowFn(page, fnName, args);
  const t1 = performance.now();
  return t1 - t0;
}

export async function openCommandPalette(page) {
  await timedWindowCall(page, 'openCommandPalette', []);
}

export async function closeCommandPalette(page) {
  await timedWindowCall(page, 'closeCommandPalette', []);
}

export async function waitForDebouncedSaves(page, settleMs) {
  const t0 = performance.now();
  await page.waitForTimeout(settleMs);
  return performance.now() - t0;
}
