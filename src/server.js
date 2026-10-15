import { createServer } from 'node:http';
import { API_PREFIX } from '#shared';
import { createApp } from './app.js';
import { APP_VERSION } from './config/app-info.js';
import { createAppConfig } from './config/app-config.js';
import { loadEnv } from './config/env.js';
import { findMissingIndexes } from './db/indexes.js';
import {
  connectDatabase,
  DatabaseConnectionError,
  disconnectDatabase,
  getDatabaseStatus,
  pingDatabase,
} from './db/mongoose.js';
import { allModels } from './models/index.js';
import { createPresenceTracker } from './realtime/presence.js';
import { createRealtimeServer } from './realtime/socket-server.js';
import { createLogMailer, createSmtpMailer } from './services/mailer.js';
import { SessionEvents } from './services/session-events.js';
import { createStorage } from './services/storage.js';
import { createLogger } from './utils/logger.js';
import { createMetrics } from './utils/metrics.js';

let env;
try {
  env = loadEnv();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const logger = createLogger(env.LOG_LEVEL, { json: env.NODE_ENV === 'production' });
const config = createAppConfig(env, APP_VERSION);

// Startup failure behaviour: retry a few times, then exit(1) before accepting any traffic.
try {
  await connectDatabase(
    {
      uri: env.MONGODB_URI,
      autoIndex: env.NODE_ENV !== 'production',
      serverSelectionTimeoutMS: env.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
      maxAttempts: env.MONGODB_CONNECT_ATTEMPTS,
    },
    logger,
  );
} catch (error) {
  logger.error(
    error instanceof DatabaseConnectionError ? error.message : 'Could not connect to MongoDB',
  );
  process.exit(1);
}

// Production doesn't build indexes automatically; never run without the unique ones.
if (env.NODE_ENV === 'production') {
  const missing = await findMissingIndexes(allModels);
  if (missing.length > 0) {
    logger.error(
      'Database indexes are missing. Run `npm run db:indexes` in backend/ and start again.',
      { missing: missing.map(({ collection, index }) => `${collection} ${JSON.stringify(index)}`) },
    );
    await disconnectDatabase();
    process.exit(1);
  }
}

const mailer = env.SMTP_HOST
  ? createSmtpMailer({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
      from: env.EMAIL_FROM,
    })
  : createLogMailer(logger);
if (!env.SMTP_HOST)
  logger.warn('SMTP_HOST is not set: emails are written to the log (development only)');

const sessionEvents = new SessionEvents();
const storage = createStorage(config.storage);
if (storage.driver === 'local' && env.NODE_ENV === 'production') {
  logger.warn(
    'STORAGE_DRIVER=local in production: uploads are only kept if this server has a persistent disk',
  );
}
const presence = createPresenceTracker();
const metrics = createMetrics();
const { app, services } = createApp({
  config,
  logger,
  mailer,
  sessionEvents,
  storage,
  presence,
  metrics,
  database: { getStatus: getDatabaseStatus, ping: pingDatabase },
});

const server = createServer(app);
const io = createRealtimeServer(server, {
  config,
  sessions: services.sessions,
  sessionEvents,
  logger,
  presence,
  messaging: services.messaging,
  notifications: services.notifications,
  calls: services.calls,
  e2ee: services.e2ee,
  metrics,
});

// Deletes unused uploads and finishes interrupted attachment deletions.
const reaper = setInterval(() => {
  services.attachments.reap().catch((error) => {
    logger.warn('Attachment cleanup failed', { error });
  });
}, 10 * 60_000);
reaper.unref();

server.listen(env.PORT, () => {
  logger.info(`Connect API listening on http://localhost:${env.PORT}${API_PREFIX}`, {
    environment: env.NODE_ENV,
    version: APP_VERSION,
    googleSignIn: services.google !== null,
  });
});

let shuttingDown = false;

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(reaper);
  logger.info(`Received ${signal}, shutting down`);

  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    await new Promise((resolve, reject) => {
      void io.close((error) => (error ? reject(error) : resolve()));
      server.closeIdleConnections();
    });
    await disconnectDatabase();
  } catch (error) {
    logger.error('Error during shutdown', { error });
    exitCode = 1;
  }
  process.exit(exitCode);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { error: reason });
  void shutdown('unhandledRejection', 1);
});
