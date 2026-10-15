const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function serialize(context) {
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [
      key,
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value,
    ]),
  );
}

/**
 * Minimal leveled logger: JSON lines in production (for log collectors), readable lines otherwise.
 * Never pass secrets, credentials or full request bodies as context.
 */
export function createLogger(level, options = {}) {
  const threshold = LEVELS[level];
  const write = (lvl, message, context) => {
    if (LEVELS[lvl] > threshold) return;
    const stream = lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout;
    const ctx = context ? serialize(context) : undefined;
    const time = new Date().toISOString();
    if (options.json) {
      stream.write(`${JSON.stringify({ time, level: lvl, message, ...ctx })}\n`);
    } else {
      const suffix = ctx ? ` ${JSON.stringify(ctx)}` : '';
      stream.write(`${time} ${lvl.toUpperCase().padEnd(5)} ${message}${suffix}\n`);
    }
  };
  return {
    error: (message, context) => write('error', message, context),
    warn: (message, context) => write('warn', message, context),
    info: (message, context) => write('info', message, context),
    debug: (message, context) => write('debug', message, context),
  };
}

export const silentLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
};
