/**
 * Lightweight request metrics for the admin System page: request count, 4xx/5xx counts and
 * latency percentiles over the last 5 minutes, plus a live Socket.IO connection count. Kept in
 * memory per API instance (no external monitoring system), so numbers reset on restart and each
 * instance reports only its own traffic.
 */
const WINDOW_MS = 5 * 60_000;
const MAX_SAMPLES = 20_000;

export function createMetrics() {
  const samples = [];
  let countSockets = () => null;
  const startedAt = Date.now();

  const prune = (now) => {
    while (samples.length && (samples[0].t < now - WINDOW_MS || samples.length > MAX_SAMPLES)) {
      samples.shift();
    }
  };

  return {
    startedAt,
    /** Express middleware: records every response's status and duration. */
    middleware(req, res, next) {
      const started = performance.now();
      res.on('finish', () => {
        const now = Date.now();
        samples.push({ t: now, ms: performance.now() - started, status: res.statusCode });
        prune(now);
      });
      next();
    },
    setSocketCounter(fn) {
      countSockets = fn;
    },
    socketCount() {
      return countSockets();
    },
    snapshot() {
      prune(Date.now());
      const durations = samples.map((sample) => sample.ms).sort((a, b) => a - b);
      const percentile = (p) =>
        durations.length
          ? Math.round(
              durations[Math.min(durations.length - 1, Math.floor(p * durations.length))] * 10,
            ) / 10
          : null;
      return {
        windowSeconds: WINDOW_MS / 1_000,
        requests: samples.length,
        clientErrors: samples.filter((s) => s.status >= 400 && s.status < 500).length,
        serverErrors: samples.filter((s) => s.status >= 500).length,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
      };
    },
  };
}
