import {
  notificationListQuerySchema,
  notificationPreferencesUpdateSchema,
  objectIdSchema,
} from '#shared';
import { z } from 'zod';
import { requireAuth } from '../middleware/authenticate.js';
import { validated } from '../middleware/validate.js';
import { sendData } from '../utils/http-response.js';

const idParams = z.object({ id: objectIdSchema });

/**
 * HTTP handlers for the signed-in user's own notifications and preferences. The user is always
 * the session's; nothing here accepts a user id from the client.
 *
 * @param {{ notifications: ReturnType<typeof import('../services/notification.service.js').createNotificationService> }} deps
 */
export function createNotificationController({ notifications }) {
  return {
    list: validated({ query: notificationListQuerySchema }, async (req, res, { query }) => {
      res.set('Cache-Control', 'no-store');
      const { data, meta } = await notifications.list(requireAuth(req).userId, query);
      sendData(res, 200, data, meta);
    }),
    unreadCount: async (req, res) => {
      res.set('Cache-Control', 'no-store');
      sendData(res, 200, await notifications.unreadCount(requireAuth(req).userId));
    },
    markRead: validated({ params: idParams }, async (req, res, { params }) => {
      sendData(res, 200, await notifications.markRead(requireAuth(req).userId, params.id));
    }),
    markAllRead: async (req, res) => {
      sendData(res, 200, await notifications.markAllRead(requireAuth(req).userId));
    },
    dismiss: validated({ params: idParams }, async (req, res, { params }) => {
      await notifications.dismiss(requireAuth(req).userId, params.id);
      res.status(204).end();
    }),
    getPreferences: async (req, res) => {
      res.set('Cache-Control', 'no-store');
      sendData(res, 200, await notifications.getPreferences(requireAuth(req).userId));
    },
    updatePreferences: validated(
      { body: notificationPreferencesUpdateSchema },
      async (req, res, { body }) => {
        sendData(res, 200, await notifications.updatePreferences(requireAuth(req).userId, body));
      },
    ),
  };
}
