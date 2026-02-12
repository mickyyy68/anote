import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const LIB_DIR = __dirname;
export const PERF_DIR = path.resolve(LIB_DIR, '..');
export const TESTS_DIR = path.resolve(PERF_DIR, '..');
export const ROOT_DIR = path.resolve(TESTS_DIR, '..');
export const OUTPUTS_DIR = path.join(PERF_DIR, 'outputs');

export const DEFAULT_BASE_URL = process.env.PERF_BASE_URL || 'http://localhost:5173';
export const DEFAULT_READY_TIMEOUT_MS = Number(process.env.PERF_READY_TIMEOUT_MS || 90_000);
export const DEFAULT_SCENARIO_SET = 'core5';

export const DEFAULT_SCENARIO_CONFIG = {
  createBurst: Number(process.env.PERF_CREATE_BURST || 40),
  editBurst: Number(process.env.PERF_EDIT_BURST || 80),
  switchLoop: Number(process.env.PERF_SWITCH_LOOP || 120),
  searchLoop: Number(process.env.PERF_SEARCH_LOOP || 36),
  settleMs: Number(process.env.PERF_SETTLE_MS || 350),
};

export const OS = os.platform();
export const IS_MACOS = OS === 'darwin';

export function makeRunId(prefix = 'perf') {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}-${ts}`;
}
