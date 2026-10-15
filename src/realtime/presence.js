/**
 * Tracks who is online: a user is online while at least one of their sockets is connected.
 * Kept in memory, so with several API instances each one only knows its own sockets
 * (documented limitation; no Redis by design).
 *
 * @typedef {object} PresenceTracker
 * @property {(userId: string) => boolean} connected Returns true when the user came online.
 * @property {(userId: string) => boolean} disconnected Returns true when the user went offline.
 * @property {(userId: string) => boolean} isOnline
 * @property {(userId: string) => number} connections Open sockets of this user (this instance).
 * @property {() => number} count People online on this instance.
 */

/** @returns {PresenceTracker} */
export function createPresenceTracker() {
  const sockets = new Map();
  return {
    connected(userId) {
      const count = (sockets.get(userId) ?? 0) + 1;
      sockets.set(userId, count);
      return count === 1;
    },
    disconnected(userId) {
      const remaining = (sockets.get(userId) ?? 1) - 1;
      if (remaining > 0) {
        sockets.set(userId, remaining);
        return false;
      }
      sockets.delete(userId);
      return true;
    },
    count() {
      return sockets.size;
    },
    isOnline(userId) {
      return sockets.has(String(userId));
    },
    connections(userId) {
      return sockets.get(String(userId)) ?? 0;
    },
  };
}
