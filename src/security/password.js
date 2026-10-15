import argon2 from 'argon2';

/** OWASP-recommended Argon2id parameters (19 MiB memory, 2 iterations, 1 lane). */
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/** Matches an Argon2id PHC string. Used by the User model to refuse anything else. */
export const PASSWORD_HASH_PATTERN =
  /^\$argon2id\$v=\d+\$(?:[mtp]=\d+,){2}[mtp]=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

export function hashPassword(password) {
  return argon2.hash(password, HASH_OPTIONS);
}

export async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** True when the hash was created with weaker parameters and should be upgraded on next login. */
export function passwordNeedsRehash(hash) {
  return argon2.needsRehash(hash, HASH_OPTIONS);
}

let dummyHash;

/**
 * Spends the same time as a real verification when no account (or no password) exists, so
 * response timing does not reveal which email addresses are registered.
 */
export async function simulatePasswordCheck(password) {
  dummyHash ??= hashPassword('connect-timing-equaliser');
  await verifyPassword(await dummyHash, password);
  return false;
}
