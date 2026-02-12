import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  DEFAULT_BASE_URL,
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_SCENARIO_CONFIG,
  DEFAULT_SCENARIO_SET,
  OUTPUTS_DIR,
  makeRunId,
  OS,
} from './lib/constants.mjs';
import { connectBrowser, closeBrowser } from './lib/driver.mjs';
import { waitForAppReady } from './lib/app-control.mjs';
import {
  runStartupReadyScenario,
  runCreateBurstScenario,
  runEditBurstScenario,
  runSwitchLoopScenario,
  runSearchLoopScenario,
} from './lib/scenarios.mjs';
import { writeJson, ensureDir } from './lib/reporters.mjs';

function parseArgs(argv) {
  const args = {
    outDir: null,
    runId: null,
    scenarioSet: DEFAULT_SCENARIO_SET,
    readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
    baseUrl: DEFAULT_BASE_URL,
    headed: false,
    quiet: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.outDir = argv[++i];
    else if (a === '--run-id') args.runId = argv[++i];
    else if (a === '--scenario-set') args.scenarioSet = argv[++i];
    else if (a === '--ready-timeout-ms') args.readyTimeoutMs = Number(argv[++i]);
    else if (a === '--base-url') args.baseUrl = argv[++i];
    else if (a === '--headed') args.headed = true;
    else if (a === '--quiet') args.quiet = true;
  }

  return args;
}

function fmtDuration(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function printUiSummary({ runId, uiMetrics, uiMetricsPath }) {
  const totalErrors = uiMetrics.summary.totalErrors;
  const status = totalErrors === 0 ? 'OK' : 'WARN';

  const lines = [];
  lines.push(`PERF UI RUN: ${runId}`);
  lines.push(`Status: ${status}`);
  lines.push(`Duration: ${fmtDuration(uiMetrics.durationMs)}`);
  lines.push('');
  lines.push('Scenarios (p95 ms):');
  for (const s of uiMetrics.scenarios) {
    lines.push(`- ${s.name}: ${s.stats.p95}`);
  }
  lines.push('');
  if (totalErrors === 0) {
    lines.push('Interpretation: No scenario errors. UI workload completed successfully.');
  } else {
    lines.push(`Interpretation: ${totalErrors} scenario errors occurred. Check metrics for details.`);
  }
  lines.push('');
  lines.push('Artifacts:');
  lines.push(`- ${uiMetricsPath}`);
  process.stdout.write(lines.join('\n') + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = args.runId || makeRunId('ui');
  const outputDir = args.outDir || path.join(OUTPUTS_DIR, runId);
  await ensureDir(outputDir);

  let session;
  const scenarios = [];
  const runStartedAt = Date.now();
  const runStartPerf = performance.now();

  try {
    session = await connectBrowser({ baseUrl: args.baseUrl, headed: args.headed });

    const readyT0 = performance.now();
    await waitForAppReady(session.page, args.readyTimeoutMs);
    const startupReady = performance.now() - readyT0;
    scenarios.push(await runStartupReadyScenario(Number(startupReady.toFixed(3))));

    if (args.scenarioSet !== 'core5') {
      throw new Error(`Unsupported scenario set: ${args.scenarioSet}`);
    }

    const config = { ...DEFAULT_SCENARIO_CONFIG };
    scenarios.push(await runCreateBurstScenario(session.page, config));
    scenarios.push(await runEditBurstScenario(session.page, config));
    scenarios.push(await runSwitchLoopScenario(session.page, config));
    scenarios.push(await runSearchLoopScenario(session.page, config));
  } finally {
    await closeBrowser(session);
  }

  const totalOps = scenarios.reduce((sum, s) => sum + s.iterations, 0);
  const totalErrors = scenarios.reduce((sum, s) => sum + s.errors.length, 0);

  const uiMetrics = {
    runId,
    startedAt: runStartedAt,
    finishedAt: Date.now(),
    durationMs: Number((performance.now() - runStartPerf).toFixed(3)),
    env: {
      os: OS,
      appMode: 'browser',
      scenarioSet: args.scenarioSet,
      baseUrl: args.baseUrl,
      headed: args.headed,
    },
    browser: {
      pid: null,
    },
    scenarios,
    summary: {
      totalOps,
      totalErrors,
    },
  };

  const outPath = path.join(outputDir, 'ui-metrics.json');
  await writeJson(outPath, uiMetrics);
  if (!args.quiet) {
    printUiSummary({ runId, uiMetrics, uiMetricsPath: outPath });
  }
}

main().catch((err) => {
  const msg = err?.stack || err?.message || String(err);
  const lower = String(msg).toLowerCase();
  if (lower.includes('executable doesn\'t exist') || lower.includes('browser has not been found')) {
    process.stderr.write('Playwright browser is missing. Run: bunx playwright install chromium\n');
  }
  process.stderr.write(`${msg}\n`);
  process.exit(1);
});
