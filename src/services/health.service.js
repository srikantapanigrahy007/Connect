const READINESS_PING_TIMEOUT_MS = 2_000;

export function createHealthService(deps) {
  return {
    getHealth() {
      const database = deps.getDatabaseStatus();
      return {
        status: database === 'connected' ? 'ok' : 'degraded',
        service: 'connect-api',
        version: deps.version,
        environment: deps.environment,
        uptimeSeconds: Math.round(process.uptime() * 100) / 100,
        timestamp: new Date().toISOString(),
        checks: { database },
      };
    },

    async checkReadiness() {
      const ping = await deps.pingDatabase(READINESS_PING_TIMEOUT_MS);
      if (!ping.ok) return null;
      return { status: 'ready', checks: { database: { status: 'up', latencyMs: ping.latencyMs } } };
    },
  };
}
