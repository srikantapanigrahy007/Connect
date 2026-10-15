import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import { isValidObjectId } from 'mongoose';

import { Session } from '../models/session.model.js';
import { User } from '../models/user.model.js';
import { generateToken, hashToken } from '../security/tokens.js';
import { AppError } from '../utils/app-error.js';

const ISSUER = 'connect-api';
const AUDIENCE = 'connect';

/**
 * Who is making an authenticated request. Set as `req.auth` by the authenticate middleware.
 *
 * @typedef {object} AuthContext
 * @property {string} userId
 * @property {string} sessionId
 * @property {object} user The user document (plain object, without the password hash).
 * @property {object} session The session document (plain object, without token hashes).
 * @property {Date} accessTokenExpiresAt
 */

/**
 * Client details stored with a session.
 *
 * @typedef {object} RequestMeta
 * @property {string | null} userAgent
 * @property {string | null} ipAddress
 */

/**
 * A freshly created or refreshed session. The raw tokens only ever go into HttpOnly cookies.
 *
 * @typedef {object} IssuedSession
 * @property {string} userId
 * @property {string} sessionId
 * @property {string} accessToken
 * @property {Date} accessTokenExpiresAt
 * @property {string} refreshToken
 * @property {Date} expiresAt
 */

const unauthorized = (message = 'Please sign in to continue') =>
  new AppError(401, 'UNAUTHORIZED', message);

function revokedError(reason) {
  if (reason === 'superseded') {
    return new AppError(
      401,
      'SESSION_SUPERSEDED',
      'You were signed out because your account signed in on another device.',
    );
  }
  return new AppError(401, 'SESSION_REVOKED', 'You have been signed out. Please sign in again.');
}

/**
 * Sessions, access tokens and refresh tokens.
 *
 * @param {{ config: import('../config/app-config.js').AppConfig, events: import('./session-events.js').SessionEvents }} deps
 */
export function createSessionService({ config, events }) {
  const { auth } = config;

  async function signAccessToken(userId, sessionId) {
    const expiresAt = new Date(Date.now() + auth.accessTokenTtlSeconds * 1_000);
    const token = await new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1_000))
      .sign(auth.accessTokenKey);
    return { token, expiresAt };
  }

  /** Marks matching unrevoked sessions revoked and notifies listeners (e.g. open sockets). */
  /**
   * @param {object} filter
   * @param {string} userId
   * @param {string} reason
   * @param {{ silentSessionIds?: string[] }} [options] Sessions whose sockets are closed without
   *   a "you were signed out" notice (the device that triggered the change and keeps a new session).
   */
  async function revokeWhere(filter, userId, reason, { silentSessionIds = [] } = {}) {
    const sessions = await Session.find({ ...filter, revokedAt: null }, { _id: 1 }).lean();
    if (sessions.length === 0) return [];
    const ids = sessions.map((session) => session._id);
    await Session.updateMany(
      { _id: { $in: ids }, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: reason } },
    );
    const sessionIds = ids.map(String);
    events.emit('revoked', { userId, sessionIds, reason, silentSessionIds });
    return sessionIds;
  }

  /** Throws unless the session may authenticate; returns both records narrowed to non-null. */
  function requireUsable(session, user, now = new Date()) {
    if (!session || !user || !session.user.equals(user._id)) throw unauthorized();
    if (session.revokedAt) throw revokedError(session.revokedReason);
    if (session.expiresAt <= now) {
      throw new AppError(401, 'SESSION_INVALID', 'Your session has expired. Please sign in again.');
    }
    // Single active session: only the session the user record points to is valid.
    if (!user.activeSessionId?.equals(session._id)) throw revokedError('superseded');
    if (user.status === 'suspended') {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended.');
    }
    if (user.status === 'banned') {
      throw new AppError(403, 'ACCOUNT_BANNED', 'This account has been banned.');
    }
    if (user.status === 'deleted') throw revokedError('account_deleted');
    return { session, user };
  }

  async function loadContext(userId, sessionId, accessTokenExpiresAt) {
    const [session, user] = await Promise.all([
      Session.findById(sessionId).lean(),
      User.findById(userId).lean(),
    ]);
    const usable = requireUsable(session, user);
    return { userId, sessionId, ...usable, accessTokenExpiresAt };
  }

  return {
    /**
     * Creates a session and makes it the account's only active session. The switch is a single
     * conditional write on the user (newest session id wins), so concurrent sign-ins can never
     * leave two valid sessions, or none. Older sessions are then revoked and their sockets closed.
     */
    async start(params) {
      const now = new Date();
      const refreshToken = generateToken();
      const expiresAt = new Date(now.getTime() + auth.refreshTokenTtlMs);
      const session = await Session.create({
        user: params.userId,
        refreshTokenHash: hashToken(refreshToken),
        authMethod: params.authMethod,
        authenticatedAt: now,
        lastUsedAt: now,
        expiresAt,
        userAgent: params.meta.userAgent?.slice(0, 512) ?? null,
        ipAddress: params.meta.ipAddress?.slice(0, 64) ?? null,
      });

      const activated = await User.updateOne(
        {
          _id: params.userId,
          $or: [{ activeSessionId: null }, { activeSessionId: { $lt: session._id } }],
        },
        { $set: { activeSessionId: session._id, lastLoginAt: now } },
      );
      if (activated.modifiedCount !== 1) {
        await Session.updateOne(
          { _id: session._id },
          { $set: { revokedAt: now, revokedReason: 'superseded' } },
        );
        throw new AppError(
          409,
          'CONFLICT',
          'Another sign-in to this account happened at the same moment. Please try again.',
        );
      }

      await revokeWhere(
        { user: params.userId, _id: { $lt: session._id } },
        params.userId,
        'superseded',
      );

      const sessionId = String(session._id);
      const access = await signAccessToken(params.userId, sessionId);
      return {
        userId: params.userId,
        sessionId,
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
        refreshToken,
        expiresAt,
      };
    },

    /** Verifies an access token and that its session is still the active, unrevoked one. */
    async authenticate(accessToken) {
      let claims;
      try {
        ({ payload: claims } = await jwtVerify(accessToken, auth.accessTokenKey, {
          issuer: ISSUER,
          audience: AUDIENCE,
          algorithms: ['HS256'],
        }));
      } catch (error) {
        if (error instanceof joseErrors.JWTExpired) {
          throw new AppError(401, 'ACCESS_TOKEN_EXPIRED', 'Your session needs to be refreshed.');
        }
        throw unauthorized();
      }
      const { sub, sid, exp } = claims;
      if (!isValidObjectId(sub) || typeof sid !== 'string' || !isValidObjectId(sid) || !exp) {
        throw unauthorized();
      }
      return loadContext(String(sub), sid, new Date(exp * 1_000));
    },

    /**
     * Re-checks a session that was authenticated earlier (e.g. at a socket handshake): still
     * the account's active session, not revoked, not expired, account usable. Throws otherwise.
     */
    async verify(userId, sessionId) {
      if (!isValidObjectId(userId) || !isValidObjectId(sessionId)) throw unauthorized();
      return loadContext(String(userId), String(sessionId), null);
    },

    /**
     * Rotates the refresh token. Presenting an already-rotated token after the grace period is
     * treated as theft: the whole session is revoked.
     */
    async refresh(refreshToken) {
      const now = new Date();
      const presentedHash = hashToken(refreshToken);
      const nextToken = generateToken();
      const session = await Session.findOneAndUpdate(
        { refreshTokenHash: presentedHash, revokedAt: null, expiresAt: { $gt: now } },
        {
          $set: {
            refreshTokenHash: hashToken(nextToken),
            previousRefreshTokenHash: presentedHash,
            refreshTokenRotatedAt: now,
            lastUsedAt: now,
          },
        },
        { returnDocument: 'after' },
      ).lean();

      if (!session) {
        const reused = await Session.findOne({
          previousRefreshTokenHash: presentedHash,
        }).lean();
        if (reused && !reused.revokedAt) {
          const rotatedAgo = now.getTime() - (reused.refreshTokenRotatedAt?.getTime() ?? 0);
          if (rotatedAgo <= auth.refreshReuseGraceMs) {
            throw new AppError(
              401,
              'REFRESH_TOKEN_STALE',
              'Your session was refreshed by another tab. Retry the request.',
            );
          }
          const userId = String(reused.user);
          await User.updateOne(
            { _id: reused.user, activeSessionId: reused._id },
            { $set: { activeSessionId: null } },
          );
          await revokeWhere({ _id: reused._id }, userId, 'refresh_token_reuse');
          throw new AppError(
            401,
            'REFRESH_TOKEN_REUSED',
            'For your security you have been signed out. Please sign in again.',
          );
        }
        if (reused?.revokedAt) throw revokedError(reused.revokedReason);
        // The current token of a session that was revoked (e.g. superseded) or has expired.
        const current = await Session.findOne(
          { refreshTokenHash: presentedHash },
          { revokedAt: 1, revokedReason: 1 },
        ).lean();
        if (current?.revokedAt) throw revokedError(current.revokedReason);
        if (current) {
          throw new AppError(
            401,
            'SESSION_INVALID',
            'Your session has expired. Please sign in again.',
          );
        }
        throw unauthorized();
      }

      const user = await User.findById(session.user).lean();
      requireUsable(session, user, now);
      const userId = String(session.user);
      const sessionId = String(session._id);
      const access = await signAccessToken(userId, sessionId);
      return {
        userId,
        sessionId,
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
        refreshToken: nextToken,
        expiresAt: session.expiresAt,
      };
    },

    async findByRefreshToken(refreshToken) {
      return Session.findOne(
        { refreshTokenHash: hashToken(refreshToken) },
        { user: 1, revokedAt: 1 },
      ).lean();
    },

    async revoke(sessionId, userId, reason) {
      await User.updateOne(
        { _id: userId, activeSessionId: sessionId },
        { $set: { activeSessionId: null } },
      );
      await revokeWhere({ _id: sessionId, user: userId }, userId, reason);
    },

    /**
     * Signs the account out everywhere. The pointer is cleared first so in-flight requests fail.
     *
     * @param {string} userId
     * @param {string} reason
     * @param {{ silentSessionIds?: string[] }} [options] See revokeWhere.
     */
    async revokeAll(userId, reason, options = {}) {
      await User.updateOne({ _id: userId }, { $set: { activeSessionId: null } });
      return revokeWhere({ user: userId }, userId, reason, options);
    },

    /** Records a fresh proof of identity (password or Google re-authentication). */
    async markAuthenticated(sessionId) {
      await Session.updateOne(
        { _id: sessionId, revokedAt: null },
        { $set: { authenticatedAt: new Date() } },
      );
    },

    /** Returns the ids among `sessionIds` that may no longer authenticate. */
    async findInactive(sessionIds) {
      const inactive = new Set(sessionIds);
      if (sessionIds.length === 0) return inactive;
      const sessions = await Session.find(
        { _id: { $in: sessionIds } },
        { user: 1, revokedAt: 1, expiresAt: 1 },
      ).lean();
      const users = await User.find(
        { _id: { $in: sessions.map((session) => session.user) } },
        { activeSessionId: 1, status: 1 },
      ).lean();
      const usersById = new Map(users.map((user) => [String(user._id), user]));
      const now = new Date();
      for (const session of sessions) {
        const user = usersById.get(String(session.user)) ?? null;
        try {
          requireUsable(session, user, now);
          inactive.delete(String(session._id));
        } catch {
          // stays inactive
        }
      }
      return inactive;
    },
  };
}
