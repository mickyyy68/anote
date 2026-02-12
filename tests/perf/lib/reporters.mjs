import fs from 'node:fs/promises';
import path from 'node:path';

function parseNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

export async function readProcessCsv(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    if (lines.length <= 1) return [];
    return lines.slice(1).map((line) => {
      const [timestamp, pid, cpuPct, rssMb, threads] = line.split(',');
      return {
        timestamp,
        pid: parseNumber(pid),
        cpuPct: parseNumber(cpuPct),
        rssMb: parseNumber(rssMb),
        threads: parseNumber(threads),
      };
    });
  } catch {
    return [];
  }
}

export function summarizeProcessRows(rows) {
  if (!rows.length) {
    return {
      samples: 0,
      cpuAvg: 0,
      cpuPeak: 0,
      rssAvgMb: 0,
      rssPeakMb: 0,
      threadsPeak: 0,
    };
  }

  const cpuVals = rows.map((r) => r.cpuPct);
  const rssVals = rows.map((r) => r.rssMb);
  const threadVals = rows.map((r) => r.threads);

  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

  return {
    samples: rows.length,
    cpuAvg: Number(avg(cpuVals).toFixed(3)),
    cpuPeak: Number(Math.max(...cpuVals).toFixed(3)),
    rssAvgMb: Number(avg(rssVals).toFixed(3)),
    rssPeakMb: Number(Math.max(...rssVals).toFixed(3)),
    threadsPeak: Number(Math.max(...threadVals).toFixed(0)),
  };
}

export async function writeSummaryMarkdown({ runId, outputDir, uiMetrics, processSummary, processCsvPath }) {
  const lines = [];
  lines.push(`# Performance Summary: ${runId}`);
  lines.push('');
  lines.push('## UI Scenarios');
  lines.push('');
  lines.push('| Scenario | Iterations | p50 (ms) | p95 (ms) | p99 (ms) | avg (ms) | Errors |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');

  for (const scenario of uiMetrics.scenarios) {
    lines.push(
      `| ${scenario.name} | ${scenario.iterations} | ${scenario.stats.p50} | ${scenario.stats.p95} | ${scenario.stats.p99} | ${scenario.stats.avg} | ${scenario.errors.length} |`,
    );
  }

  lines.push('');
  lines.push('## Process Usage (macOS sampler)');
  lines.push('');
  lines.push(`- Samples: ${processSummary.samples}`);
  lines.push(`- CPU avg: ${processSummary.cpuAvg}%`);
  lines.push(`- CPU peak: ${processSummary.cpuPeak}%`);
  lines.push(`- RSS avg: ${processSummary.rssAvgMb} MB`);
  lines.push(`- RSS peak: ${processSummary.rssPeakMb} MB`);
  lines.push(`- Threads peak: ${processSummary.threadsPeak}`);
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  lines.push(`- UI metrics: \`${path.join(outputDir, 'ui-metrics.json')}\``);
  lines.push(`- Process CSV: \`${processCsvPath}\``);

  const summaryPath = path.join(outputDir, 'summary.md');
  await fs.writeFile(summaryPath, lines.join('\n') + '\n', 'utf8');
  return summaryPath;
}
