import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit random token, URL-safe. Used for refresh tokens and email-link tokens. */
export function generateToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/**
 * SHA-256 of a high-entropy token. Only this hash is stored; a database leak does not reveal
 * usable tokens. (A slow hash is unnecessary because the tokens are not guessable.)
 */
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;

export function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest('base64url');
}
