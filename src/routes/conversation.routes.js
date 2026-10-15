import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { createRateLimiter, keyByUser } from '../middleware/rate-limit.js';
import { singleFileUpload } from '../middleware/upload.js';

/**
 * /api/v1/conversations and /api/v1/attachments. Every route needs a signed-in session;
 * membership and messaging permissions are checked inside the services.
 *
 * @param {import('../config/app-config.js').AppConfig} config
 * @param {ReturnType<typeof import('../services/session.service.js').createSessionService>} sessions
 * @param {ReturnType<typeof import('../controllers/conversation.controller.js').createConversationController>} controller
 */
export function createConversationRouters(config, sessions, controller) {
  const requireSession = authenticate(config, sessions);
  const limit = {
    open: createRateLimiter(config, 'conversationOpenPerUser', keyByUser),
    // Shared with message:send over Socket.IO (same counter key).
    send: createRateLimiter(config, 'messageSendPerUser', keyByUser),
    action: createRateLimiter(config, 'messageActionPerUser', keyByUser),
    upload: createRateLimiter(config, 'attachmentUploadPerUser', keyByUser),
  };

  const conversations = Router();
  conversations.use(requireSession);
  conversations.get('/', controller.list);
  conversations.post('/', limit.open, controller.open);
  conversations.get('/:id', controller.get);
  // Your own chat settings, and removing a chat from your list only.
  conversations.patch('/:id/preferences', limit.action, controller.preferences);
  conversations.delete('/:id', limit.action, controller.removeFromList);
  conversations.get('/:id/messages', controller.history);
  conversations.post('/:id/messages', limit.send, controller.send);
  conversations.get('/:id/starred', controller.starred);
  // Authenticate and rate-limit before reading the upload body.
  conversations.post('/:id/attachments', limit.upload, singleFileUpload('file'), controller.upload);

  const message = '/:id/messages/:messageId';
  conversations.patch(message, limit.action, controller.edit);
  conversations.delete(message, limit.action, controller.remove);
  conversations.put(`${message}/reaction`, limit.action, controller.react);
  conversations.delete(`${message}/reaction`, limit.action, controller.unreact);
  conversations.put(`${message}/pin`, limit.action, controller.pin);
  conversations.delete(`${message}/pin`, limit.action, controller.unpin);
  conversations.put(`${message}/star`, limit.action, controller.star);
  conversations.delete(`${message}/star`, limit.action, controller.unstar);

  const attachments = Router();
  attachments.use(requireSession);
  attachments.get('/:id/content', controller.content);

  return { conversations, attachments };
}
