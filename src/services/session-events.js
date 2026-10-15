import { EventEmitter } from 'node:events';

/**
 * Payload of the "revoked" event.
 *
 * @typedef {object} SessionRevokedEvent
 * @property {string} userId
 * @property {string[]} sessionIds
 * @property {string} reason One of SESSION_REVOCATION_REASONS from #shared.
 * @property {string[]} [silentSessionIds] Sessions to disconnect without a sign-out notice.
 */

/**
 * In-process notifications about session changes (event: "revoked", payload: SessionRevokedEvent). The real-time server listens to disconnect
 * sockets immediately; other instances catch up through its periodic session sweep.
 */
export class SessionEvents extends EventEmitter {}
