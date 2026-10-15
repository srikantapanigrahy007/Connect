import { Router } from 'express';

import { createAdminController } from '../controllers/admin.controller.js';
import { createAuthController } from '../controllers/auth.controller.js';
import { createCallController } from '../controllers/call.controller.js';
import { createConversationController } from '../controllers/conversation.controller.js';
import { createE2eeController } from '../controllers/e2ee.controller.js';
import { createGroupController } from '../controllers/group.controller.js';
import { createHealthController } from '../controllers/health.controller.js';
import { createNotificationController } from '../controllers/notification.controller.js';
import { createProfileController } from '../controllers/profile.controller.js';
import { createHealthService } from '../services/health.service.js';
import { createAdminRouters } from './admin.routes.js';
import { createAccountRouter, createAuthRouter } from './auth.routes.js';
import { createCallRouter } from './call.routes.js';
import { createConversationRouters } from './conversation.routes.js';
import { createE2eeRouter } from './e2ee.routes.js';
import { createGroupRouters } from './group.routes.js';
import { createHealthRouter } from './health.routes.js';
import { createNotificationRouter } from './notification.routes.js';
import { createProfileRouters } from './profile.routes.js';

/** Mounted at API_PREFIX (/api/v1). Add new resource routers here. */
export function createApiRouter(ctx, services) {
  const router = Router();
  const health = createHealthService({
    version: ctx.config.version,
    environment: ctx.config.nodeEnv,
    getDatabaseStatus: ctx.database.getStatus,
    pingDatabase: ctx.database.ping,
  });
  const authController = createAuthController({
    config: ctx.config,
    logger: ctx.logger,
    auth: services.auth,
    sessions: services.sessions,
    google: services.google,
  });

  router.use('/health', createHealthRouter(createHealthController(health)));
  router.use('/auth', createAuthRouter(ctx.config, services.sessions, authController));
  router.use('/account', createAccountRouter(ctx.config, services.sessions, authController));

  const profile = createProfileRouters(
    ctx.config,
    services.sessions,
    createProfileController({
      profiles: services.profiles,
      requests: services.requests,
      blocks: services.blocks,
      storage: ctx.storage,
    }),
  );
  router.use('/me', profile.me);
  router.use('/users', profile.users);
  router.use('/message-requests', profile.requests);
  router.use('/blocks', profile.blocks);
  router.use('/avatars', profile.avatars);

  const messaging = createConversationRouters(
    ctx.config,
    services.sessions,
    createConversationController({
      messaging: services.messaging,
      attachments: services.attachments,
    }),
  );
  const groups = createGroupRouters(
    ctx.config,
    services.sessions,
    createGroupController({ groups: services.groups }),
  );
  // Poll votes live under their group conversation.
  router.use('/conversations/:id/polls', groups.polls);
  router.use('/conversations', messaging.conversations);
  router.use('/attachments', messaging.attachments);
  router.use('/groups', groups.groups);
  router.use('/group-invites', groups.invites);

  router.use(
    '/calls',
    createCallRouter(
      ctx.config,
      services.sessions,
      createCallController({ calls: services.calls }),
    ),
  );
  router.use(
    '/e2ee',
    createE2eeRouter(ctx.config, services.sessions, createE2eeController({ e2ee: services.e2ee })),
  );
  router.use(
    '/notifications',
    createNotificationRouter(
      ctx.config,
      services.sessions,
      createNotificationController({ notifications: services.notifications }),
    ),
  );

  const admin = createAdminRouters(
    ctx.config,
    services.sessions,
    createAdminController({
      admin: services.admin,
      reports: services.reports,
      audit: services.audit,
      settings: services.settings,
    }),
  );
  router.use('/admin', admin.admin);
  router.use('/reports', admin.reports);
  router.use('/settings', admin.settings);
  return router;
}
