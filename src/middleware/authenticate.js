import { readCookie } from './cookies.js';

import { AppError } from '../utils/app-error.js';

function readAccessToken(req, config) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  return readCookie(req, config.cookies.names.access);
}

/**
 * Requires a valid access token whose session is the account's active session, and sets
 * `req.auth` (see AuthContext in services/session.service.js).
 */
export function authenticate(config, sessions) {
  return async (req, _res, next) => {
    const token = readAccessToken(req, config);
    if (!token) throw new AppError(401, 'UNAUTHORIZED', 'Please sign in to continue');
    req.auth = await sessions.authenticate(token);
    next();
  };
}

/** Like authenticate, but continues without `req.auth` when no valid session exists. */
export function optionalAuthenticate(config, sessions) {
  return async (req, _res, next) => {
    const token = readAccessToken(req, config);
    if (token) {
      try {
        req.auth = await sessions.authenticate(token);
      } catch {
        req.auth = undefined;
      }
    }
    next();
  };
}

export function requireAuth(req) {
  if (!req.auth) throw new AppError(401, 'UNAUTHORIZED', 'Please sign in to continue');
  return req.auth;
}

/**
 * Sensitive changes need a recent proof of identity (sign-in or re-authentication within
 * RECENT_AUTH_MAX_AGE_SECONDS), not just a long-lived session.
 */
export function requireRecentAuth(config) {
  return (req, _res, next) => {
    const auth = requireAuth(req);
    const age = Date.now() - auth.session.authenticatedAt.getTime();
    if (age > config.auth.recentAuthMaxAgeMs) {
      throw new AppError(403, 'REAUTHENTICATION_REQUIRED', 'Please confirm it’s you to continue.');
    }
    next();
  };
}
