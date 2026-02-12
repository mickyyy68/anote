import { performance } from 'node:perf_hooks';
import {
  ensureFolderExists,
  ensureNoteCount,
  getActiveNoteId,
  getAllNoteIds,
  openCommandPalette,
  closeCommandPalette,
  timedWindowCall,
  waitForDebouncedSaves,
} from './app-control.mjs';
import { makeScenarioResult } from './metrics.mjs';

export async function runStartupReadyScenario(startupLatencyMs) {
  return {
    name: 'startup_ready',
    iterations: 1,
    timingsMs: [startupLatencyMs],
    stats: {
      count: 1,
      min: startupLatencyMs,
      max: startupLatencyMs,
      avg: startupLatencyMs,
      p50: startupLatencyMs,
      p95: startupLatencyMs,
      p99: startupLatencyMs,
    },
    errors: [],
  };
}

export async function runCreateBurstScenario(page, config) {
  const timings = [];
  const errors = [];
  await ensureFolderExists(page);

  for (let i = 0; i < config.createBurst; i++) {
    try {
      const dt = await timedWindowCall(page, 'addNote', []);
      timings.push(dt);
    } catch (err) {
      errors.push(String(err?.message || err));
    }
  }

  return makeScenarioResult('create_burst', timings, errors);
}

export async function runEditBurstScenario(page, config) {
  const timings = [];
  const errors = [];

  await ensureNoteCount(page, 1);
  let noteId = await getActiveNoteId(page);
  if (!noteId) {
    const ids = await getAllNoteIds(page);
    noteId = ids[0];
    if (noteId) await timedWindowCall(page, 'selectNote', [noteId]);
  }

  for (let i = 0; i < config.editBurst; i++) {
    try {
      const dt = await timedWindowCall(page, 'updateNoteBody', [noteId, `Perf payload line ${i} :: ${'x'.repeat(120)}`]);
      timings.push(dt);
      if (i % 10 === 0) {
        await timedWindowCall(page, 'updateNoteTitle', [noteId, `Perf title ${i}`]);
      }
    } catch (err) {
      errors.push(String(err?.message || err));
    }
  }

  await waitForDebouncedSaves(page, config.settleMs);
  return makeScenarioResult('edit_burst', timings, errors);
}

export async function runSwitchLoopScenario(page, config) {
  const timings = [];
  const errors = [];

  await ensureNoteCount(page, 12);
  const ids = await getAllNoteIds(page);
  if (!ids.length) {
    errors.push('No notes available for switch loop.');
    return makeScenarioResult('switch_loop', timings, errors);
  }

  for (let i = 0; i < config.switchLoop; i++) {
    const id = ids[i % ids.length];
    try {
      const dt = await timedWindowCall(page, 'selectNote', [id]);
      timings.push(dt);
    } catch (err) {
      errors.push(String(err?.message || err));
    }
  }

  return makeScenarioResult('switch_loop', timings, errors);
}

export async function runSearchLoopScenario(page, config) {
  const timings = [];
  const errors = [];

  await ensureNoteCount(page, 20);
  await openCommandPalette(page);

  const queries = [
    'perf',
    'title',
    'payload',
    'new',
    'folder',
    'x',
    'untitled',
    'line',
    '0',
    'note',
  ];

  for (let i = 0; i < config.searchLoop; i++) {
    const q = queries[i % queries.length] + String(i % 7);
    const t0 = performance.now();
    try {
      await timedWindowCall(page, 'setCommandQuery', [q]);
      await page.waitForTimeout(220);
      timings.push(performance.now() - t0);
    } catch (err) {
      errors.push(String(err?.message || err));
    }
  }

  await closeCommandPalette(page);
  return makeScenarioResult('search_loop', timings, errors);
}
