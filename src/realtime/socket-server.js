import { E2EE_SOCKET_EVENTS, MESSAGING_SOCKET_EVENTS, SESSION_SOCKET_EVENTS } from '#shared';
import { parseCookie } from 'cookie';
import { Server } from 'socket.io';

import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { forwardCallEvents, registerCallHandlers } from './call-handlers.js';
import {
  forwardMessagingEvents,
  forwardNotificationEvents,
  registerMessagingHandlers,
  userRoom,
} from './messaging-handlers.js';

const SWEEP_INTERVAL_MS = 60_000;

/**
 * A browser always sends Origin on WebSocket and polling requests, so cross-site socket
 * hijacking is blocked by requiring an allowed Origin whenever cookies are present.
 * Non-browser clients (future native apps) send no cookies and authenticate with a token.
 */
export function isHandshakeOriginAllowed(req, allowedOrigins) {
  const origin = req.headers.origin;
  if (origin) return allowedOrigins.has(origin);
  return !req.headers.cookie;
}

function socketError(error) {
  const code = error instanceof AppError ? error.code : 'UNAUTHORIZED';
  const failure = new Error(code);
  failure.data = { code };
  return failure;
}

/**
 * @param {import('node:http').Server} httpServer
 * @param {{ config: object, sessions: object, sessionEvents: import('node:events').EventEmitter, logger: object, e2ee?: ReturnType<typeof import('../services/e2ee.service.js').createE2eeService>, presence?: import('./presence.js').PresenceTracker, messaging?: ReturnType<typeof import('../services/messaging.service.js').createMessagingService>, notifications?: ReturnType<typeof import('../services/notification.service.js').createNotificationService>, calls?: ReturnType<typeof import('../services/call.service.js').createCallService> }} deps
 */
export function createRealtimeServer(httpServer, deps) {
  const {
    config,
    sessions,
    sessionEvents,
    logger,
    presence,
    messaging,
    notifications,
    calls,
    e2ee,
    metrics,
  } = deps;
  const allowedOrigins = new Set(config.allowedOrigins);

  const io = new Server(httpServer, {
    serveClient: false,
    // Text messages are at most 4,000 characters; nothing a client sends needs more.
    maxHttpBufferSize: 64 * 1024,
    cors: { origin: config.allowedOrigins, credentials: true },
    allowRequest: (req, callback) => {
      callback(null, isHandshakeOriginAllowed(req, allowedOrigins));
    },
  });

  io.use((socket, next) => {
    const cookies = parseCookie(socket.request.headers.cookie ?? '');
    const handshakeToken = socket.handshake.auth?.token;
    const token =
      cookies[config.cookies.names.access] ??
      (typeof handshakeToken === 'string' ? handshakeToken : undefined);
    if (!token) {
      next(socketError(new AppError(401, 'UNAUTHORIZED', 'Sign in required')));
      return;
    }
    sessions
      .authenticate(token)
      .then((auth) => {
        socket.data = { userId: auth.userId, sessionId: auth.sessionId };
        next();
      })
      .catch((error) => {
        next(socketError(error));
      });
  });

  /** Tells conversation peers (as the user's privacy allows) that they came online or left. */
  const publishPresence = (userId) => {
    if (!messaging || !presence) return;
    messaging
      .presenceAudience(userId)
      .then((audience) => {
        for (const { peerId, payload } of audience) {
          io.to(userRoom(peerId)).emit(MESSAGING_SOCKET_EVENTS.presence, payload);
        }
      })
      .catch((error) => {
        logger.warn('Could not publish presence', { error });
      });
  };

  io.on('connection', (socket) => {
    const { userId, sessionId } = socket.data;
    // Counted synchronously here (not in the async handshake), so concurrent handshakes can't
    // race past the limit. A refused socket is closed before it joins any room.
    if (presence && presence.connections(userId) >= config.realtime.maxSocketsPerUser) {
      logger.warn('Socket refused: too many connections for one account', { userId });
      socket.emit('connection:refused', { code: 'TOO_MANY_CONNECTIONS' });
      socket.disconnect(true);
      return;
    }
    // The only rooms a socket is ever in; there is no client-side "join".
    void socket.join([`session:${sessionId}`, userRoom(userId)]);
    if (messaging) registerMessagingHandlers(io, socket, { config, sessions, messaging, logger });
    if (calls) registerCallHandlers(io, socket, { config, sessions, calls, logger });
    if (presence?.connected(userId)) publishPresence(userId);
    socket.on('disconnect', () => {
      // When the user's last socket closes, remember when they were last seen.
      if (presence?.disconnected(userId)) {
        User.updateOne({ _id: userId }, { $set: { lastSeenAt: new Date() } })
          .catch((error) => {
            logger.warn('Could not record last seen time', { error });
          })
          .finally(() => publishPresence(userId));
      }
    });
  });

  metrics?.setSocketCounter(() => io.of('/').sockets.size);

  const stopForwarding = messaging ? forwardMessagingEvents(io, messaging) : () => undefined;
  const stopNotifications = notifications
    ? forwardNotificationEvents(io, notifications)
    : () => undefined;
  const stopCalls = calls ? forwardCallEvents(io, calls) : () => undefined;
  // E2EE hints go to the device owner's own tabs only and carry no keys or content; the tab that
  // holds that device fetches what waits for it over HTTP.
  const e2eeListeners = {
    toDevice: ({ userId, deviceId }) => {
      io.to(userRoom(userId)).emit(E2EE_SOCKET_EVENTS.toDevice, { deviceId });
    },
    keysLow: ({ userId, deviceId }) => {
      io.to(userRoom(userId)).emit(E2EE_SOCKET_EVENTS.keysLow, { deviceId });
    },
  };
  for (const [event, listener] of Object.entries(e2eeListeners)) e2ee?.events.on(event, listener);
  // Ends abandoned calls (unanswered, devices gone, too long); see call.service.js.
  const stopCallSweep = calls
    ? calls.startSweeper((socketId) => io.of('/').sockets.has(socketId))
    : () => undefined;

  const disconnectSessions = (sessionIds, reason, silentSessionIds = []) => {
    for (const sessionId of sessionIds) {
      const room = `session:${sessionId}`;
      if (!silentSessionIds.includes(sessionId)) {
        io.to(room).emit(SESSION_SOCKET_EVENTS.revoked, { reason });
      }
      // Let the notice flush before closing the connection.
      setImmediate(() => io.in(room).disconnectSockets(true));
    }
  };

  const onRevoked = ({ sessionIds, reason, silentSessionIds }) => {
    disconnectSessions(sessionIds, reason, silentSessionIds);
    // Calls on those sessions end at once (no reconnection grace for a revoked session).
    calls?.sessionsRevoked(sessionIds).catch((error) => {
      logger.warn('Could not end calls of revoked sessions', { error });
    });
  };
  sessionEvents.on('revoked', onRevoked);

  // Catches revocations made by other API instances and sessions that simply expired.
  const sweep = setInterval(() => {
    const sessionIds = [
      ...new Set([...io.of('/').sockets.values()].map((socket) => socket.data.sessionId)),
    ];
    sessions
      .findInactive(sessionIds)
      .then((inactive) => {
        if (inactive.size > 0) disconnectSessions([...inactive], 'expired');
      })
      .catch((error) => {
        logger.warn('Socket session sweep failed', { error });
      });
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  io.engine.on('close', () => undefined);
  const close = io.close.bind(io);
  io.close = (callback) => {
    clearInterval(sweep);
    sessionEvents.off('revoked', onRevoked);
    stopForwarding();
    stopNotifications();
    stopCalls();
    for (const [event, listener] of Object.entries(e2eeListeners))
      e2ee?.events.off(event, listener);
    stopCallSweep();
    return close(callback);
  };

  return io;
}
