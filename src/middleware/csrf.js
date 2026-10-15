import { generateToken, hmac, safeEqual } from '../security/tokens.js';
import { AppError } from '../utils/app-error.js';
import { readCookie } from './cookies.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `<random>.<HMAC(random)>`: a signed token, so a cookie injected from elsewhere is rejected. */
export function issueCsrfToken(key) {
  const random = generateToken(18);
  return `${random}.${hmac(key, random)}`;
}

export function isValidCsrfToken(key, token) {
  if (!token) return false;
  const [random, signature, extra] = token.split('.');
  if (!random || !signature || extra !== undefined) return false;
  return safeEqual(signature, hmac(key, random));
}

function requestOrigin(origin, referer) {
  if (origin) return origin;
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

/**
 * CSRF protection for cookie-authenticated, state-changing requests:
 * 1. the Origin (or Referer) must be an allowed web origin, and
 * 2. the X-CSRF-Token header must equal the signed CSRF cookie (double submit).
 * Requests authenticated with an Authorization header (future native clients) carry no ambient
 * credentials, so they are exempt.
 */
export function csrfProtection(config) {
  const allowed = new Set(config.allowedOrigins);
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method) || req.headers.authorization?.startsWith('Bearer ')) {
      next();
      return;
    }
    const origin = requestOrigin(req.get('origin'), req.get('referer'));
    if (!origin || !allowed.has(origin)) {
      throw new AppError(
        403,
        'ORIGIN_NOT_ALLOWED',
        'This request did not come from an allowed site.',
      );
    }
    const header = req.get('x-csrf-token');
    const cookie = readCookie(req, config.cookies.names.csrf);
    if (
      !header ||
      !cookie ||
      !safeEqual(header, cookie) ||
      !isValidCsrfToken(config.auth.csrfKey, cookie)
    ) {
      throw new AppError(
        403,
        'CSRF_TOKEN_INVALID',
        'Your security token is missing or out of date. Refresh and try again.',
      );
    }
    next();
  };
}
