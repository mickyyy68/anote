export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(v, digits = 3) {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

export function summarizeTimings(timingsMs) {
  if (!timingsMs.length) {
    return {
      count: 0,
      min: 0,
      max: 0,
      avg: 0,
      p50: 0,
      p95: 0,
      p99: 0,
    };
  }

  const sum = timingsMs.reduce((a, b) => a + b, 0);
  return {
    count: timingsMs.length,
    min: round(Math.min(...timingsMs)),
    max: round(Math.max(...timingsMs)),
    avg: round(sum / timingsMs.length),
    p50: round(percentile(timingsMs, 0.5)),
    p95: round(percentile(timingsMs, 0.95)),
    p99: round(percentile(timingsMs, 0.99)),
  };
}

export function makeScenarioResult(name, timingsMs, errors = []) {
  return {
    name,
    iterations: timingsMs.length,
    timingsMs,
    stats: summarizeTimings(timingsMs),
    errors,
  };
}
