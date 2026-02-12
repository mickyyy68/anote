import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DEFAULT_BASE_URL, OUTPUTS_DIR, ROOT_DIR, makeRunId, IS_MACOS } from './lib/constants.mjs';
import {
  ensureDir,
  readProcessCsv,
  summarizeProcessRows,
  writeSummaryMarkdown,
} from './lib/reporters.mjs';

function parseArgs(argv) {
  const args = {
    outDir: null,
    runId: null,
    scenarioSet: 'core5',
    baseUrl: DEFAULT_BASE_URL,
    reuseApp: false,
    headed: false,
    failFast: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.outDir = argv[++i];
    else if (a === '--run-id') args.runId = argv[++i];
    else if (a === '--scenario-set') args.scenarioSet = argv[++i];
    else if (a === '--base-url') args.baseUrl = argv[++i];
    else if (a === '--reuse-app') args.reuseApp = true;
    else if (a === '--headed') args.headed = true;
    else if (a === '--fail-fast') args.failFast = true;
  }

  return args;
}

function spawnLogged(command, cmdArgs, options = {}) {
  const child = spawn(command, cmdArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });

  child.stdout?.on('data', (d) => process.stdout.write(d));
  child.stderr?.on('data', (d) => process.stderr.write(d));

  return child;
}

function fmtDuration(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function printSuiteSummary({ runId, uiMetrics, processSummary, summaryPath, uiMetricsPath, processCsvPath }) {
  const totalErrors = uiMetrics.summary.totalErrors;
  const status = totalErrors === 0 ? 'OK' : 'WARN';
  const lines = [];

  lines.push(`PERF RUN: ${runId}`);
  lines.push(`Status: ${status}`);
  lines.push(`Duration: ${fmtDuration(uiMetrics.durationMs)}`);
  lines.push('');
  lines.push('Scenarios (p95 ms):');
  for (const s of uiMetrics.scenarios) {
    lines.push(`- ${s.name}: ${s.stats.p95}`);
  }
  lines.push('');
  lines.push('Process:');
  lines.push(`- CPU avg/peak: ${processSummary.cpuAvg}% / ${processSummary.cpuPeak}%`);
  lines.push(`- RSS avg/peak: ${processSummary.rssAvgMb}MB / ${processSummary.rssPeakMb}MB`);
  lines.push(`- Threads peak: ${processSummary.threadsPeak}`);
  lines.push('');
  if (totalErrors > 0) {
    lines.push(`Interpretation: ${totalErrors} scenario errors occurred. Check ui-metrics.json.`);
  } else if (processSummary.samples === 0) {
    lines.push('Interpretation: UI scenarios passed, but no process samples were captured.');
  } else {
    lines.push('Interpretation: No scenario errors. Latencies and process sampling look healthy for this run.');
  }
  lines.push('');
  lines.push('Artifacts:');
  lines.push(`- ${summaryPath}`);
  lines.push(`- ${uiMetricsPath}`);
  lines.push(`- ${processCsvPath}`);

  process.stdout.write(lines.join('\n') + '\n');
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function killChild(child, signal = 'SIGTERM') {
  if (!child || child.killed) return;
  try {
    child.kill(signal);
  } catch {
    return;
  }
}

async function readJson(file) {
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw);
}

async function isUrlReachable(url) {
  try {
    const res = await fetch(url, { method: 'GET' });
    return res.ok || (res.status >= 200 && res.status < 500);
  } catch {
    return false;
  }
}

async function waitForUrl(url, timeoutMs) {
  const started = Date.now();
  for (;;) {
    if (await isUrlReachable(url)) return true;
    if (Date.now() - started > timeoutMs) return false;
    await wait(250);
  }
}

async function main() {
  if (!IS_MACOS) {
    process.stderr.write('run-suite v1 currently targets macOS process sampling.\n');
  }

  const args = parseArgs(process.argv.slice(2));
  const runId = args.runId || makeRunId('perf');
  const outputDir = args.outDir || path.join(OUTPUTS_DIR, runId);
  await ensureDir(outputDir);

  const processCsvPath = path.join(outputDir, 'process.csv');

  let appProc;
  let samplerProc;

  try {
    if (!args.reuseApp) {
      const existing = await isUrlReachable(args.baseUrl);
      if (!existing) {
        appProc = spawnLogged('bun', ['run', 'vite:dev'], { cwd: ROOT_DIR });
      } else {
        process.stdout.write(`Using existing app server at ${args.baseUrl}\n`);
      }
    }

    const appReady = await waitForUrl(args.baseUrl, 30_000);
    if (!appReady) {
      throw new Error(`App server not reachable at ${args.baseUrl} within timeout.`);
    }

    const uiArgs = [
      path.join(ROOT_DIR, 'tests/perf/run-ui-workload.mjs'),
      '--out', outputDir,
      '--run-id', runId,
      '--scenario-set', args.scenarioSet,
      '--base-url', args.baseUrl,
      '--quiet',
    ];
    if (args.headed) uiArgs.push('--headed');

    // Match Playwright Chromium process path under cache install dir.
    samplerProc = spawn('bash', [path.join(ROOT_DIR, 'tests/perf/sample-process.sh'), '--out', processCsvPath, '--match', 'ms-playwright/chromium'], {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    samplerProc.stdout?.on('data', (d) => process.stdout.write(d));
    samplerProc.stderr?.on('data', (d) => process.stderr.write(d));

    const uiRunner = spawnLogged('bun', uiArgs, {
      cwd: ROOT_DIR,
    });

    const exitCode = await new Promise((resolve) => {
      uiRunner.on('close', (code) => resolve(code ?? 1));
    });

    await killChild(samplerProc);

    if (exitCode !== 0) {
      throw new Error(`UI workload runner failed with exit code ${exitCode}`);
    }

    const uiMetricsPath = path.join(outputDir, 'ui-metrics.json');
    const uiMetrics = await readJson(uiMetricsPath);

    const rows = await readProcessCsv(processCsvPath);
    const processSummary = summarizeProcessRows(rows);

    const summaryPath = await writeSummaryMarkdown({
      runId,
      outputDir,
      uiMetrics,
      processSummary,
      processCsvPath,
    });

    printSuiteSummary({ runId, uiMetrics, processSummary, summaryPath, uiMetricsPath, processCsvPath });
  } finally {
    await killChild(samplerProc);
    await killChild(appProc);
  }
}

main().catch((err) => {
  process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
  process.exit(1);
});
