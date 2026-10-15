import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { createRateLimiter, keyByUser } from '../middleware/rate-limit.js';

/**
 * /api/v1/calls: your call history and ICE servers. Every route needs a signed-in session and
 * only ever returns calls you took part in.
 *
 * @param {import('../config/app-config.js').AppConfig} config
 * @param {ReturnType<typeof import('../services/session.service.js').createSessionService>} sessions
 * @param {ReturnType<typeof import('../controllers/call.controller.js').createCallController>} controller
 */
export function createCallRouter(config, sessions, controller) {
  const router = Router();
  router.use(authenticate(config, sessions));
  router.get('/', controller.list);
  router.get(
    '/ice-servers',
    createRateLimiter(config, 'iceServersPerUser', keyByUser),
    controller.iceServers,
  );
  router.get('/:id', controller.get);
  return router;
}
