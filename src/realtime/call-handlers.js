import {
  CALL_SOCKET_EVENTS as EVENTS,
  SESSION_SOCKET_EVENTS,
  socketCallActiveSchema,
  socketCallEndSchema,
  socketCallMediaSchema,
  socketCallRefSchema,
  socketCallSignalSchema,
  socketCallStartSchema,
} from '#shared';
import { normalize } from '../middleware/error-handler.js';
import { consumeRateLimit } from '../middleware/rate-limit.js';
import { AppError } from '../utils/app-error.js';
import { createWindowLimiter, SESSION_ENDED_CODES, userRoom } from './messaging-handlers.js';

/** Any call event, per socket. Signaling sends bursts of ICE candidates, hence the headroom. */
const EVENT_LIMIT = { windowMs: 10_000, limit: 300 };
/** Signaling events re-check the session at most this often; every other event checks it fresh. */
const SIGNAL_SESSION_CHECK_MS = 5_000;

/**
 * Delivers the call service's events: call state to the participants' user rooms, signaling to
 * one specific socket (the other device of the call). @returns {() => void} Unsubscribes.
 */
export function forwardCallEvents(io, calls) {
  const listeners = {
    incoming: ({ userId, call }) => io.to(userRoom(userId)).emit(EVENTS.incoming, { call }),
    updated: ({ userId, call }) => io.to(userRoom(userId)).emit(EVENTS.updated, { call }),
    signal: ({ socketId, payload }) => io.to(socketId).emit(EVENTS.signal, payload),
    media: ({ socketId, payload }) => io.to(socketId).emit(EVENTS.media, payload),
    resumed: ({ socketId, payload }) => io.to(socketId).emit(EVENTS.resumed, payload),
  };
  for (const [event, listener] of Object.entries(listeners)) calls.events.on(event, listener);
  return () => {
    for (const [event, listener] of Object.entries(listeners)) calls.events.off(event, listener);
  };
}

/**
 * Call events for one authenticated socket, following the messaging handlers' rules: per-socket
 * rate limit, a session re-check (ended sessions are told and disconnected), Zod validation, the
 * user and device taken from the handshake (never the payload), and an acknowledgment.
 *
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {{ config: import('../config/app-config.js').AppConfig, sessions: ReturnType<typeof import('../services/session.service.js').createSessionService>, calls: ReturnType<typeof import('../services/call.service.js').createCallService>, logger: import('../utils/logger.js').Logger }} deps
 */
export function registerCallHandlers(io, socket, { config, sessions, calls, logger }) {
  const { userId, sessionId } = socket.data;
  const device = { sessionId, socketId: socket.id };
  const eventAllowed = createWindowLimiter(EVENT_LIMIT);
  let sessionCheckedAt = 0;

  async function verifySession(allowRecentCheck) {
    if (allowRecentCheck && Date.now() - sessionCheckedAt < SIGNAL_SESSION_CHECK_MS) return;
    await sessions.verify(userId, sessionId);
    sessionCheckedAt = Date.now();
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
          if (appError.statusCode >= 500) logger.error('Call event failed', { event, error });
          respond({
            ok: false,
            error: {
              code: appError.code,
              message: appError.message,
              ...(appError.details ? { details: appError.details } : {}),
            },
          });
          if (SESSION_ENDED_CODES.has(appError.code)) {
            socket.emit(SESSION_SOCKET_EVENTS.revoked, {
              reason: appError.code === 'SESSION_SUPERSEDED' ? 'superseded' : 'revoked',
            });
            setImmediate(() => socket.disconnect(true));
          }
        }
      })();
    });
  }

  on(EVENTS.start, socketCallStartSchema, async (input) => {
    await consumeRateLimit(config, 'callStartPerUser', `user:${userId}`);
    return calls.start(userId, device, input);
  });
  on(EVENTS.accept, socketCallRefSchema, ({ callId }) => calls.accept(userId, device, callId));
  on(EVENTS.decline, socketCallRefSchema, ({ callId }) => calls.decline(userId, callId));
  on(EVENTS.end, socketCallEndSchema, ({ callId, reason }) => calls.end(userId, callId, reason));
  on(EVENTS.active, socketCallActiveSchema, () => calls.active(userId));
  on(EVENTS.resume, socketCallRefSchema, ({ callId }) => calls.resume(userId, device, callId));
  on(
    EVENTS.signal,
    socketCallSignalSchema,
    ({ callId, signal }) => calls.signal(userId, socket.id, callId, signal),
    { recentSessionCheck: true },
  );
  on(
    EVENTS.media,
    socketCallMediaSchema,
    ({ callId, audio, video }) => calls.media(userId, socket.id, callId, { audio, video }),
    { recentSessionCheck: true },
  );

  socket.on('disconnect', () => {
    calls.socketDisconnected(socket.id).catch((error) => {
      logger.warn('Could not handle a call device disconnecting', { error });
    });
  });
}
