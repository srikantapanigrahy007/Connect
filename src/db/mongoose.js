import mongoose from 'mongoose';

export class DatabaseConnectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DatabaseConnectionError';
  }
}

/** "mongodb+srv://user:pass@host/db?x" -> "mongodb+srv://<credentials>@host/db". Safe to log. */
export function redactMongoUri(uri) {
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/)[^@/]*@/, '$1<credentials>@').replace(/\?.*$/, '');
}

/** Removes the URI's username and password from a driver error message. */
export function sanitizeDatabaseError(error, uri) {
  let message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const credentials = /^mongodb(?:\+srv)?:\/\/([^@/]*)@/.exec(uri)?.[1];
  if (credentials) {
    for (const part of [credentials, ...credentials.split(':')]) {
      for (const variant of [part, decodeURIComponentSafe(part)]) {
        if (variant.length > 0) message = message.split(variant).join('<redacted>');
      }
    }
  }
  return message;
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Connects at startup, retrying a few times for transient failures. Throws
 * DatabaseConnectionError with a credential-free message when every attempt fails, so the
 * caller can exit before accepting traffic.
 */
export async function connectDatabase(options, logger) {
  mongoose.set('strictQuery', true);
  const target = redactMongoUri(options.uri);

  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  mongoose.connection.on('error', (error) =>
    logger.error('MongoDB error', { error: sanitizeDatabaseError(error, options.uri) }),
  );

  let lastError = '';
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      logger.info('Connecting to MongoDB', { target, attempt, maxAttempts: options.maxAttempts });
      await mongoose.connect(options.uri, {
        serverSelectionTimeoutMS: options.serverSelectionTimeoutMS,
        autoIndex: options.autoIndex,
      });
      logger.info('MongoDB connected', { target });
      return;
    } catch (error) {
      lastError = sanitizeDatabaseError(error, options.uri);
      logger.warn('MongoDB connection attempt failed', { target, attempt, error: lastError });
      await mongoose.disconnect().catch(() => undefined);
      if (attempt < options.maxAttempts) await sleep((options.retryDelayMs ?? 2_000) * attempt);
    }
  }
  throw new DatabaseConnectionError(
    `Could not connect to MongoDB at ${target} after ${options.maxAttempts} attempt(s): ${lastError}`,
  );
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}

/** Reports the Mongoose connection state without touching the network. */
export function getDatabaseStatus() {
  switch (mongoose.connection.readyState) {
    case mongoose.ConnectionStates.connected:
      return 'connected';
    case mongoose.ConnectionStates.connecting:
      return 'connecting';
    case mongoose.ConnectionStates.disconnecting:
      return 'disconnecting';
    default:
      return 'disconnected';
  }
}

/** Round-trips a `ping` command to the server, bounded by `timeoutMs`. */
export async function pingDatabase(timeoutMs) {
  const db = mongoose.connection.db;
  if (mongoose.connection.readyState !== mongoose.ConnectionStates.connected || !db) {
    return { ok: false };
  }
  const started = performance.now();
  let timer;
  try {
    await Promise.race([
      db.command({ ping: 1 }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('ping timed out')), timeoutMs);
      }),
    ]);
    return { ok: true, latencyMs: Math.round((performance.now() - started) * 10) / 10 };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}
