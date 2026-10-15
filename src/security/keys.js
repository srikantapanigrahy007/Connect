import { hkdfSync } from 'node:crypto';

/**
 * Derives an independent key per purpose from AUTH_SECRET (HKDF-SHA256), so one configured
 * secret never signs two kinds of token and rotating it invalidates all of them together.
 */
export function deriveKey(secret, purpose, length = 32) {
  return Buffer.from(hkdfSync('sha256', secret, 'connect-auth-v1', purpose, length));
}
