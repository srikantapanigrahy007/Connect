import { API_PREFIX } from '#shared';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';

import { parseCookies } from './middleware/cookies.js';
import { csrfProtection } from './middleware/csrf.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFound } from './middleware/not-found.js';
import { requestId } from './middleware/request-id.js';
import { requestLogger } from './middleware/request-logger.js';
import { createApiRouter } from './routes/index.js';
import { createAdminService } from './services/admin.service.js';
import { createAttachmentService } from './services/attachment.service.js';
import { createAuditService } from './services/audit.service.js';
import { createAuthService } from './services/auth.service.js';
import { createGoogleOAuthService } from './services/google-oauth.service.js';
import { createGroupService } from './services/group.service.js';
import { createBlockService } from './services/block.service.js';
import { createCallService } from './services/call.service.js';
import { createE2eeService } from './services/e2ee.service.js';
import { createMessageRequestService } from './services/message-request.service.js';
import { createMessagingService } from './services/messaging.service.js';
import { createNotificationService } from './services/notification.service.js';
import { createProfileService } from './services/profile.service.js';
import { createReportService } from './services/report.service.js';
import { createSessionService } from './services/session.service.js';
import { createSettingsService } from './services/settings.service.js';

/**
 * Everything the app needs from the outside world; tests substitute parts of it.
 *
 * @typedef {object} AppContext
 * @property {import('./config/app-config.js').AppConfig} config
 * @property {import('./utils/logger.js').Logger} logger
 * @property {import('./services/mailer.js').Mailer} mailer
 * @property {import('./services/session-events.js').SessionEvents} sessionEvents
 * @property {{ getStatus: () => string, ping: (timeoutMs: number) => Promise<{ ok: boolean, latencyMs?: number }> }} database
 * @property {import('./services/storage.js').FileStorage} storage Where uploaded files are kept.
 * @property {import('./realtime/presence.js').PresenceTracker} presence Who is online right now.
 * @property {ReturnType<typeof import('./utils/metrics.js').createMetrics>} [metrics] Request and socket metrics.
 * @property {object | null} [google] Overrides the Google service built from config (tests).
 */

/**
 * The application's services, created once and shared by HTTP routes and Socket.IO.
 *
 * @typedef {object} AppServices
 * @property {ReturnType<typeof createSessionService>} sessions
 * @property {ReturnType<typeof createAuthService>} auth
 * @property {ReturnType<typeof createGoogleOAuthService> | null} google
 * @property {ReturnType<typeof createProfileService>} profiles
 * @property {ReturnType<typeof createMessageRequestService>} requests
 * @property {ReturnType<typeof createBlockService>} blocks
 * @property {ReturnType<typeof createAttachmentService>} attachments
 * @property {ReturnType<typeof createMessagingService>} messaging
 * @property {ReturnType<typeof createGroupService>} groups
 * @property {ReturnType<typeof createNotificationService>} notifications
 * @property {ReturnType<typeof createCallService>} calls
 * @property {ReturnType<typeof createE2eeService>} e2ee
 */

/**
 * @param {AppContext} ctx
 * @returns {AppServices}
 */
export function createServices(ctx) {
  const sessions = createSessionService({ config: ctx.config, events: ctx.sessionEvents });
  const settings = createSettingsService();
  const notifications = createNotificationService({ logger: ctx.logger });
  const attachments = createAttachmentService({
    storage: ctx.storage,
    config: ctx.config,
    logger: ctx.logger,
    settings,
  });
  const messaging = createMessagingService({
    presence: ctx.presence,
    attachments,
    config: ctx.config,
    notifications,
  });
  const groups = createGroupService({
    messaging,
    attachments,
    storage: ctx.storage,
    logger: ctx.logger,
    settings,
    notifications,
  });
  const audit = createAuditService();
  const e2ee = createE2eeService({ config: ctx.config, messaging });
  const calls = createCallService({
    config: ctx.config,
    messaging,
    notifications,
    logger: ctx.logger,
  });
  return {
    sessions,
    settings,
    audit,
    reports: createReportService({ audit }),
    admin: createAdminService({
      sessions,
      presence: ctx.presence,
      metrics: ctx.metrics,
      settings,
      audit,
      groups,
      config: ctx.config,
      database: ctx.database,
      storage: ctx.storage,
    }),
    auth: createAuthService({
      config: ctx.config,
      logger: ctx.logger,
      mailer: ctx.mailer,
      sessions,
      storage: ctx.storage,
      settings,
      groups,
      e2ee,
    }),
    google:
      ctx.google !== undefined
        ? ctx.google
        : ctx.config.google
          ? createGoogleOAuthService(ctx.config.google)
          : null,
    profiles: createProfileService({
      storage: ctx.storage,
      presence: ctx.presence,
      logger: ctx.logger,
    }),
    requests: createMessageRequestService({ notifications }),
    blocks: createBlockService({
      onChange: (a, b) => messaging.relationshipChanged(a, b),
      // Calls first (ending one may create a call line), then the pair's notifications.
      onBlock: async (a, b) => {
        await calls.pairBlocked(a, b).catch((error) => {
          ctx.logger.warn('Could not end calls after a block', { error });
        });
        await notifications.pairBlocked(a, b);
      },
    }),
    attachments,
    messaging,
    groups,
    notifications,
    calls,
    e2ee,
  };
}

/**
 * Builds the Express app without binding a port, so tests can exercise it directly and the
 * HTTP server can share it with Socket.IO.
 *
 * @param {AppContext} ctx
 * @param {AppServices} [services]
 */
export function createApp(ctx, services = createServices(ctx)) {
  const app = express();

  app.set('trust proxy', ctx.config.trustProxy);
  app.disable('x-powered-by');

  app.use(requestId);
  if (ctx.metrics) app.use(ctx.metrics.middleware);
  app.use(requestLogger(ctx.logger));
  // Avatars and attachments are loaded with <img>/<video>/<audio> from the web app. When it is
  // deployed on its own subdomain (app.example.com → api.example.com) the requests are
  // cross-origin but same-site, so allow same-site; other sites still cannot embed them.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cors({ origin: ctx.config.allowedOrigins, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(parseCookies);
  app.use(csrfProtection(ctx.config));

  app.use(API_PREFIX, createApiRouter(ctx, services));

  app.use(notFound);
  app.use(errorHandler(ctx.logger));

  return { app, services };
}
