import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { createRateLimiter, keyByUser } from '../middleware/rate-limit.js';

/**
 * /api/v1/notifications: your own notifications and notification preferences. Every route
 * needs a signed-in session; the service only ever touches the session user's records.
 *
 * @param {import('../config/app-config.js').AppConfig} config
 * @param {ReturnType<typeof import('../services/session.service.js').createSessionService>} sessions
 * @param {ReturnType<typeof import('../controllers/notification.controller.js').createNotificationController>} controller
 */
export function createNotificationRouter(config, sessions, controller) {
  const router = Router();
  const limit = createRateLimiter(config, 'notificationActionPerUser', keyByUser);
  const preferencesLimit = createRateLimiter(config, 'profileUpdatePerUser', keyByUser);

  router.use(authenticate(config, sessions));
  router.get('/', controller.list);
  router.get('/unread-count', controller.unreadCount);
  router.post('/read-all', limit, controller.markAllRead);
  router.get('/preferences', controller.getPreferences);
  router.patch('/preferences', preferencesLimit, controller.updatePreferences);
  router.post('/:id/read', limit, controller.markRead);
  router.delete('/:id', limit, controller.dismiss);
  return router;
}
