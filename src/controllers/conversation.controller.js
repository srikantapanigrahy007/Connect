import {
  attachmentUploadFieldsSchema,
  conversationListQuerySchema,
  conversationPreferencesSchema,
  deleteMessageQuerySchema,
  editMessageSchema,
  messageHistoryQuerySchema,
  openConversationSchema,
  reactionSchema,
  sendMessageSchema,
} from '#shared';
import { z } from 'zod';
import { requireAuth } from '../middleware/authenticate.js';
import { validated } from '../middleware/validate.js';
import { sendData } from '../utils/http-response.js';

// Malformed ids are treated like ids of conversations you don't belong to (404 in the service).
const idParams = z.object({ id: z.string() });
const messageParams = z.object({ id: z.string(), messageId: z.string() });

/**
 * HTTP handlers for conversations, messages, message actions and attachments. The services
 * check membership and messaging permissions on every call; the actor is always the signed-in
 * user.
 *
 * @param {{ messaging: ReturnType<typeof import('../services/messaging.service.js').createMessagingService>, attachments: ReturnType<typeof import('../services/attachment.service.js').createAttachmentService> }} deps
 */
export function createConversationController({ messaging, attachments }) {
  return {
    list: validated({ query: conversationListQuerySchema }, async (req, res, { query }) => {
      res.set('Cache-Control', 'no-store');
      const { data, meta } = await messaging.listConversations(requireAuth(req).userId, query);
      sendData(res, 200, data, meta);
    }),

    open: validated({ body: openConversationSchema }, async (req, res, { body }) => {
      const { conversation, created } = await messaging.openConversation(
        requireAuth(req).userId,
        body.userId,
      );
      sendData(res, created ? 201 : 200, conversation);
    }),

    /** Your own chat settings (pin, favorite, archive, mute, mark unread). */
    preferences: validated(
      { params: idParams, body: conversationPreferencesSchema },
      async (req, res, { params, body }) => {
        sendData(
          res,
          200,
          await messaging.updatePreferences(requireAuth(req).userId, params.id, body),
        );
      },
    ),

    /** Removes the conversation from your list only (nothing is deleted). */
    removeFromList: validated({ params: idParams }, async (req, res, { params }) => {
      await messaging.removeFromList(requireAuth(req).userId, params.id);
      res.status(204).end();
    }),

    get: validated({ params: idParams }, async (req, res, { params }) => {
      res.set('Cache-Control', 'no-store');
      sendData(res, 200, await messaging.getConversation(requireAuth(req).userId, params.id));
    }),

    history: validated(
      { params: idParams, query: messageHistoryQuerySchema },
      async (req, res, { params, query }) => {
        res.set('Cache-Control', 'no-store');
        const { data, meta } = await messaging.listMessages(
          requireAuth(req).userId,
          params.id,
          query,
        );
        sendData(res, 200, data, meta);
      },
    ),

    /** HTTP fallback for message:send (same service, same idempotency rules). */
    send: validated(
      { params: idParams, body: sendMessageSchema },
      async (req, res, { params, body }) => {
        const auth = requireAuth(req);
        const result = await messaging.sendMessage(auth.userId, params.id, body, {
          sessionId: auth.sessionId,
        });
        sendData(res, result.duplicate ? 200 : 201, result);
      },
    ),

    edit: validated(
      { params: messageParams, body: editMessageSchema },
      async (req, res, { params, body }) => {
        const auth = requireAuth(req);
        sendData(
          res,
          200,
          await messaging.editMessage(auth.userId, params.id, params.messageId, body, {
            sessionId: auth.sessionId,
          }),
        );
      },
    ),

    remove: validated(
      { params: messageParams, query: deleteMessageQuerySchema },
      async (req, res, { params, query }) => {
        const userId = requireAuth(req).userId;
        sendData(
          res,
          200,
          await messaging.deleteMessage(userId, params.id, params.messageId, query.scope),
        );
      },
    ),

    react: validated(
      { params: messageParams, body: reactionSchema },
      async (req, res, { params, body }) => {
        const userId = requireAuth(req).userId;
        sendData(res, 200, await messaging.react(userId, params.id, params.messageId, body.emoji));
      },
    ),

    unreact: validated({ params: messageParams }, async (req, res, { params }) => {
      sendData(
        res,
        200,
        await messaging.unreact(requireAuth(req).userId, params.id, params.messageId),
      );
    }),

    pin: validated({ params: messageParams }, async (req, res, { params }) => {
      sendData(res, 200, await messaging.pin(requireAuth(req).userId, params.id, params.messageId));
    }),

    unpin: validated({ params: messageParams }, async (req, res, { params }) => {
      sendData(
        res,
        200,
        await messaging.unpin(requireAuth(req).userId, params.id, params.messageId),
      );
    }),

    star: validated({ params: messageParams }, async (req, res, { params }) => {
      const userId = requireAuth(req).userId;
      sendData(res, 200, await messaging.star(userId, params.id, params.messageId, true));
    }),

    unstar: validated({ params: messageParams }, async (req, res, { params }) => {
      const userId = requireAuth(req).userId;
      sendData(res, 200, await messaging.star(userId, params.id, params.messageId, false));
    }),

    starred: validated({ params: idParams }, async (req, res, { params }) => {
      res.set('Cache-Control', 'no-store');
      sendData(res, 200, await messaging.listStarred(requireAuth(req).userId, params.id));
    }),

    /** Stores a file for a later message:send with `attachmentId`. */
    upload: validated({ params: idParams }, async (req, res, { params }) => {
      const userId = requireAuth(req).userId;
      const fields = attachmentUploadFieldsSchema.parse(req.body ?? {});
      const conversation = await messaging.requireSendAccess(userId, params.id);
      sendData(res, 201, await attachments.upload(userId, conversation._id, req.file, fields));
    }),

    /** Streams an attachment after checking the viewer's current access. */
    content: validated({ params: idParams }, async (req, res, { params }) => {
      const attachment = await attachments.authorize(requireAuth(req).userId, params.id);
      await attachments.stream(attachment, req, res);
    }),
  };
}
