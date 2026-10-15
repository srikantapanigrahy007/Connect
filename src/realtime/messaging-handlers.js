import {
  MESSAGING_SOCKET_EVENTS as EVENTS,
  NOTIFICATION_SOCKET_EVENTS as NOTIFICATION_EVENTS,
  SESSION_SOCKET_EVENTS,
  socketReceiptSchema,
  socketSendMessageSchema,
  socketSyncSchema,
  socketTypingSchema,
  TYPING_TIMEOUT_MS,
} from '#shared';
import { normalize } from '../middleware/error-handler.js';
import { consumeRateLimit } from '../middleware/rate-limit.js';
import { AppError } from '../utils/app-error.js';

/** Errors meaning this socket's session may no longer be used: notify, then disconnect. */
export const SESSION_ENDED_CODES = new Set([
  'UNAUTHORIZED',
  'SESSION_REVOKED',
  'SESSION_SUPERSEDED',
  'SESSION_INVALID',
  'ACCOUNT_SUSPENDED',
]);

/** Any client event, per socket (in memory: these limits protect this process). */
const EVENT_LIMIT = { windowMs: 10_000, limit: 200 };
/** typing:start / typing:stop, per socket. Typing is never stored, so no database counter. */
const TYPING_LIMIT = { windowMs: 10_000, limit: 20 };
/** Typing events re-check the session at most this often; every other event checks it fresh. */
const TYPING_SESSION_CHECK_MS = 5_000;

/** Every socket joins only its own user room (and session room); clients never pick rooms. */
export const userRoom = (userId) => `user:${userId}`;

export function createWindowLimiter({ windowMs, limit }) {
  let windowStart = 0;
  let hits = 0;
  return () => {
    const now = Date.now();
    if (now - windowStart >= windowMs) {
      windowStart = now;
      hits = 0;
    }
    hits += 1;
    return hits <= limit;
  };
}

/**
 * Fans the messaging service's domain events out to the right user rooms. Recipients are
 * decided on the server from conversation membership (and blocks/privacy for receipts).
 *
 * @returns {() => void} Unsubscribes.
 */
export function forwardMessagingEvents(io, messaging) {
  const onMessage = ({ message, participants }) => {
    io.to(participants.map(userRoom)).emit(EVENTS.created, { message });
  };
  const onDelivered = ({ conversationId, userId, lastDeliveredSeq, peerId, notifyPeer }) => {
    const rooms = notifyPeer ? [userRoom(userId), userRoom(peerId)] : [userRoom(userId)];
    io.to(rooms).emit(EVENTS.delivered, { conversationId, userId, lastDeliveredSeq });
  };
  const onRead = ({ conversationId, userId, lastReadSeq, unreadCount, peerId, notifyPeer }) => {
    // The reader's other tabs also learn the new unread count; the other person never does.
    io.to(userRoom(userId)).emit(EVENTS.read, { conversationId, userId, lastReadSeq, unreadCount });
    if (notifyPeer) {
      io.to(userRoom(peerId)).emit(EVENTS.read, { conversationId, userId, lastReadSeq });
    }
  };
  const onUpdated = ({ message, participants }) => {
    io.to(participants.map(userRoom)).emit(EVENTS.updated, { message });
  };
  // Private flags (star, delete for me) only ever go to the owner's own tabs.
  const onState = ({ userId, state }) => {
    io.to(userRoom(userId)).emit(EVENTS.state, state);
  };
  const onPins = ({ conversationId, pins, participants }) => {
    io.to(participants.map(userRoom)).emit(EVENTS.pins, { conversationId, pins });
  };
  // Your own chat settings: only your own tabs.
  const onPreferences = ({ userId, conversationId, preferences, removed }) => {
    io.to(userRoom(userId)).emit(EVENTS.preferences, { conversationId, preferences, removed });
  };
  // A block or unblock: both refresh the conversation, and any typing indicator is cleared.
  const onChanged = ({ conversationId, participants }) => {
    for (const userId of participants) {
      io.to(userRoom(userId)).emit(EVENTS.changed, { conversationId });
      const other = participants.find((id) => id !== userId);
      io.to(userRoom(userId)).emit(EVENTS.typingStop, { conversationId, userId: other });
    }
  };
  // Groups: each member gets their own aggregated positions ("group" stands for the others).
  const onGroupReceipts = ({ conversationId, updates }) => {
    for (const { userId, lastDeliveredSeq, lastReadSeq } of updates) {
      const room = io.to(userRoom(userId));
      room.emit(EVENTS.delivered, { conversationId, userId: 'group', lastDeliveredSeq });
      if (lastReadSeq !== null) {
        room.emit(EVENTS.read, { conversationId, userId: 'group', lastReadSeq });
      }
    }
  };
  // Poll results (counts only), to every current member.
  const onPoll = ({ conversationId, messageId, poll, participants }) => {
    io.to(participants.map(userRoom)).emit(EVENTS.pollUpdated, { conversationId, messageId, poll });
  };
  const listeners = {
    groupReceipts: onGroupReceipts,
    poll: onPoll,
    preferences: onPreferences,
    changed: onChanged,
    message: onMessage,
    delivered: onDelivered,
    read: onRead,
    updated: onUpdated,
    state: onState,
    pins: onPins,
  };
  for (const [event, listener] of Object.entries(listeners)) messaging.events.on(event, listener);
  return () => {
    for (const [event, listener] of Object.entries(listeners)) {
      messaging.events.off(event, listener);
    }
  };
}

/**
 * Sends the notification service's events to the recipient's own user room only. There are no
 * client → server notification events: reads and preferences go through the HTTP API.
 *
 * @returns {() => void} Unsubscribes.
 */
export function forwardNotificationEvents(io, notifications) {
  const listeners = {
    upsert: ({ userId, notification, unreadCount }) => {
      io.to(userRoom(userId)).emit(NOTIFICATION_EVENTS.upsert, { notification, unreadCount });
    },
    read: ({ userId, ids, before, unreadCount }) => {
      io.to(userRoom(userId)).emit(NOTIFICATION_EVENTS.read, {
        ids,
        ...(before ? { before } : {}),
        unreadCount,
      });
    },
    removed: ({ userId, ids, unreadCount }) => {
      io.to(userRoom(userId)).emit(NOTIFICATION_EVENTS.removed, { ids, unreadCount });
    },
    preferences: ({ userId, preferences }) => {
      io.to(userRoom(userId)).emit(NOTIFICATION_EVENTS.preferences, { preferences });
    },
  };
  for (const [event, listener] of Object.entries(listeners)) {
    notifications.events.on(event, listener);
  }
  return () => {
    for (const [event, listener] of Object.entries(listeners)) {
      notifications.events.off(event, listener);
    }
  };
}

/** Typing indicators one socket has started: each expires on its own, and all stop on disconnect. */
function createTypingTracker(io, userId) {
  const active = new Map();

  const stop = (conversationId) => {
    const entry = active.get(conversationId);
    if (!entry) return;
    clearTimeout(entry.timer);
    active.delete(conversationId);
    if (entry.recipients.length > 0) {
      io.to(entry.recipients.map(userRoom)).emit(EVENTS.typingStop, { conversationId, userId });
    }
  };

  return {
    /** recipients: the people allowed to see it (see messaging.authorizeTyping). */
    start(conversationId, recipients) {
      const entry = active.get(conversationId);
      if (entry) clearTimeout(entry.timer);
      const timer = setTimeout(() => stop(conversationId), TYPING_TIMEOUT_MS);
      timer.unref?.();
      active.set(conversationId, { recipients, timer });
      io.to(recipients.map(userRoom)).emit(EVENTS.typingStart, {
        conversationId,
        userId,
        expiresInMs: TYPING_TIMEOUT_MS,
      });
    },
    stop,
    stopAll() {
      for (const conversationId of [...active.keys()]) stop(conversationId);
    },
  };
}

/**
 * Messaging events for one authenticated socket. Every handler:
 * 1. applies a per-socket event rate limit;
 * 2. re-checks the session (revoked, superseded, expired or suspended → error + disconnect);
 * 3. validates the payload with the shared Zod schema;
 * 4. calls the messaging service with the user id from the handshake, never from the payload;
 * 5. answers through the acknowledgment callback: { ok: true, data } or { ok: false, error }.
 *
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {{ config: import('../config/app-config.js').AppConfig, sessions: ReturnType<typeof import('../services/session.service.js').createSessionService>, messaging: ReturnType<typeof import('../services/messaging.service.js').createMessagingService>, logger: import('../utils/logger.js').Logger }} deps
 */
export function registerMessagingHandlers(io, socket, { config, sessions, messaging, logger }) {
  const { userId, sessionId } = socket.data;
  const typing = createTypingTracker(io, userId);
  const eventAllowed = createWindowLimiter(EVENT_LIMIT);
  const typingAllowed = createWindowLimiter(TYPING_LIMIT);
  let sessionCheckedAt = 0;

  async function verifySession(allowRecentCheck) {
    if (allowRecentCheck && Date.now() - sessionCheckedAt < TYPING_SESSION_CHECK_MS) return;
    await sessions.verify(userId, sessionId);
    sessionCheckedAt = Date.now();
  }

  function endSession(error) {
    typing.stopAll();
    socket.emit(SESSION_SOCKET_EVENTS.revoked, {
      reason: error.code === 'SESSION_SUPERSEDED' ? 'superseded' : 'revoked',
    });
    setImmediate(() => socket.disconnect(true));
  }

  function on(event, schema, run, { recentSessionCheck = false } = {}) {
    socket.on(event, (payload, ack) => {
      const respond = typeof ack === 'function' ? ack : () => undefined;
      void (async () => {
        try {
          if (!eventAllowed()) {
            throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Please slow down.');
          }
          await verifySession(recentSessionCheck);
          const input = schema.parse(payload ?? {});
          respond({ ok: true, data: (await run(input)) ?? null });
        } catch (error) {
          const appError = normalize(error);
          if (appError.statusCode >= 500) {
            logger.error('Socket event failed', { event, error });
          }
          respond({
            ok: false,
            error: {
              code: appError.code,
              message: appError.message,
              ...(appError.details ? { details: appError.details } : {}),
            },
          });
          if (SESSION_ENDED_CODES.has(appError.code)) endSession(appError);
        }
      })();
    });
  }

  on(EVENTS.send, socketSendMessageSchema, async ({ conversationId, message }) => {
    await consumeRateLimit(config, 'messageSendPerUser', `user:${userId}`);
    const result = await messaging.sendMessage(userId, conversationId, message, { sessionId });
    typing.stop(result.message.conversationId);
    return result;
  });

  on(EVENTS.delivered, socketReceiptSchema, ({ conversationId, seq }) =>
    messaging.markDelivered(userId, conversationId, seq),
  );

  on(EVENTS.read, socketReceiptSchema, ({ conversationId, seq }) =>
    messaging.markRead(userId, conversationId, seq),
  );

  on(EVENTS.sync, socketSyncSchema, ({ conversationId, afterSeq, limit, changesSince }) =>
    messaging.sync(userId, conversationId, { afterSeq, limit, changesSince }),
  );

  on(
    EVENTS.typingStart,
    socketTypingSchema,
    async ({ conversationId }) => {
      if (!typingAllowed()) {
        throw new AppError(429, 'RATE_LIMITED', 'Too many typing updates.');
      }
      // Membership and messaging permission are checked on every start.
      const access = await messaging.authorizeTyping(userId, conversationId);
      if (access.visible) typing.start(access.conversationId, access.recipients);
      else typing.stop(access.conversationId);
      return { visible: access.visible };
    },
    { recentSessionCheck: true },
  );

  on(
    EVENTS.typingStop,
    socketTypingSchema,
    ({ conversationId }) => {
      if (!typingAllowed()) {
        throw new AppError(429, 'RATE_LIMITED', 'Too many typing updates.');
      }
      // Only indicators this socket started (and that were authorized) can be stopped.
      typing.stop(conversationId);
      return null;
    },
    { recentSessionCheck: true },
  );

  socket.on('disconnect', () => {
    typing.stopAll();
  });
}
