import { BlockedUser } from '../models/blocked-user.model.js';
import { Connection } from '../models/connection.model.js';
import { MessageRequest } from '../models/message-request.model.js';
import { pairKey } from '../utils/pair-key.js';

/**
 * Permission rules for profiles, message requests and presence. Every protected action on the
 * backend asks this module; hiding a button in the web app is never the only protection.
 */

/** Account statuses whose profiles other people can find and view. */
export const VISIBLE_ACCOUNT_STATUSES = ['active', 'pending_verification'];

/** Used for users created before privacy settings existed, or with partial settings. */
export const DEFAULT_PRIVACY = Object.freeze({
  messagePermission: 'everyone',
  onlineStatusVisibility: 'connections',
  lastSeenVisibility: 'connections',
  readReceipts: true,
  typingIndicators: true,
});

/** @param {{ privacy?: object | null }} user */
export function privacyOf(user) {
  return { ...DEFAULT_PRIVACY, ...(user.privacy ?? {}) };
}

/** @param {{ profileVisibility?: string }} user */
export function profileVisibilityOf(user) {
  return user.profileVisibility ?? 'public';
}

/**
 * How the viewer relates to another user.
 *
 * @typedef {object} Relationship
 * @property {boolean} isSelf
 * @property {boolean} blockedByViewer The viewer blocked the other user.
 * @property {boolean} blockedByTarget The other user blocked the viewer.
 * @property {boolean} connected They have an accepted message request between them.
 * @property {{ id: string, status: string } | null} outgoingRequest Latest request viewer → target.
 * @property {{ id: string } | null} incomingRequest Pending request target → viewer.
 */

/**
 * @param {unknown} viewerId
 * @param {unknown} targetId
 * @returns {Promise<Relationship>}
 */
export async function loadRelationship(viewerId, targetId) {
  if (String(viewerId) === String(targetId)) {
    return {
      isSelf: true,
      blockedByViewer: false,
      blockedByTarget: false,
      connected: false,
      outgoingRequest: null,
      incomingRequest: null,
    };
  }
  const [blocks, connection, outgoing, incoming] = await Promise.all([
    BlockedUser.find(
      {
        $or: [
          { blocker: viewerId, blocked: targetId },
          { blocker: targetId, blocked: viewerId },
        ],
      },
      { blocker: 1 },
    ).lean(),
    Connection.exists({ pairKey: pairKey(viewerId, targetId) }),
    MessageRequest.findOne({ sender: viewerId, recipient: targetId }, { status: 1 })
      .sort({ _id: -1 })
      .lean(),
    MessageRequest.findOne(
      { sender: targetId, recipient: viewerId, status: 'pending' },
      { _id: 1 },
    ).lean(),
  ]);
  return {
    isSelf: false,
    blockedByViewer: blocks.some((block) => String(block.blocker) === String(viewerId)),
    blockedByTarget: blocks.some((block) => String(block.blocker) === String(targetId)),
    connected: Boolean(connection),
    outgoingRequest: outgoing ? { id: String(outgoing._id), status: outgoing.status } : null,
    incomingRequest: incoming ? { id: String(incoming._id) } : null,
  };
}

/** True if either user has blocked the other. */
export async function isBlockedEitherWay(a, b) {
  return Boolean(
    await BlockedUser.exists({
      $or: [
        { blocker: a, blocked: b },
        { blocker: b, blocked: a },
      ],
    }),
  );
}

/**
 * What the viewer may see of a profile:
 * - "none": the profile is treated as non-existent (the owner blocked the viewer, or the
 *   account is not visible);
 * - "full": everything public (yourself, connections, or a public profile);
 * - "limited": name, username and avatar only (a private profile, not connected).
 *
 * @param {{ status: string, profileVisibility?: string }} target
 * @param {Relationship} relationship
 * @returns {'none' | 'full' | 'limited'}
 */
export function profileAccess(target, relationship) {
  if (relationship.isSelf) return 'full';
  if (relationship.blockedByTarget || !VISIBLE_ACCOUNT_STATUSES.includes(target.status)) {
    return 'none';
  }
  if (relationship.connected || profileVisibilityOf(target) === 'public') return 'full';
  return 'limited';
}

/**
 * Whether an audience setting ("everyone" | "connections" | "nobody") includes the viewer.
 *
 * @param {string} audience
 * @param {Relationship} relationship
 */
export function audienceIncludes(audience, relationship) {
  if (relationship.isSelf) return true;
  if (relationship.blockedByTarget || relationship.blockedByViewer) return false;
  if (audience === 'everyone') return true;
  if (audience === 'connections') return relationship.connected;
  return false;
}

/**
 * Why the viewer cannot send a message request to `recipient` right now, or null if they can.
 * Blocks by the recipient are reported as "not_accepting" so they are never revealed.
 *
 * @param {{ status: string, privacy?: object }} recipient
 * @param {Relationship} relationship
 */
export function requestUnavailableReason(recipient, relationship) {
  if (relationship.isSelf) return 'self';
  if (relationship.blockedByViewer) return 'blocked_by_you';
  if (relationship.blockedByTarget) return 'not_accepting';
  if (relationship.connected) return 'already_connected';
  if (relationship.incomingRequest || relationship.outgoingRequest?.status === 'pending') {
    return 'request_pending';
  }
  if (!VISIBLE_ACCOUNT_STATUSES.includes(recipient.status)) return 'not_accepting';
  // Only "everyone" admits non-connections; "connections" and "nobody" both refuse new requests.
  if (privacyOf(recipient).messagePermission !== 'everyone') return 'not_accepting';
  return null;
}

/**
 * Relationships between the viewer and several other people in three queries (instead of
 * loadRelationship per person). Only the fields messaging and presence need are filled in.
 *
 * @param {unknown} viewerId
 * @param {unknown[]} otherIds
 * @returns {Promise<Map<string, Relationship>>}
 */
export async function loadRelationships(viewerId, otherIds) {
  const ids = [...new Set(otherIds.map(String))].filter((id) => id !== String(viewerId));
  const [blocks, connections] = await Promise.all([
    BlockedUser.find(
      {
        $or: [
          { blocker: viewerId, blocked: { $in: ids } },
          { blocker: { $in: ids }, blocked: viewerId },
        ],
      },
      { blocker: 1, blocked: 1 },
    ).lean(),
    Connection.find({ pairKey: { $in: ids.map((id) => pairKey(viewerId, id)) } }, { pairKey: 1 })
      .lean()
      .then((rows) => new Set(rows.map((row) => row.pairKey))),
  ]);
  const relationships = new Map();
  for (const id of ids) {
    relationships.set(id, {
      isSelf: false,
      blockedByViewer: blocks.some(
        (block) => String(block.blocker) === String(viewerId) && String(block.blocked) === id,
      ),
      blockedByTarget: blocks.some(
        (block) => String(block.blocker) === id && String(block.blocked) === String(viewerId),
      ),
      connected: connections.has(pairKey(viewerId, id)),
      outgoingRequest: null,
      incomingRequest: null,
    });
  }
  return relationships;
}

/**
 * Why the viewer cannot send messages to `other` right now, or null if they can. Messaging needs
 * a connection (an accepted message request), no block in either direction, and an account that
 * can be reached. "Who can message me?" controls new requests only, so existing connections keep
 * messaging. A block by the other person is reported as "unavailable" so it is never revealed.
 *
 * @param {{ status: string } | null} other
 * @param {Relationship} relationship
 * @returns {null | 'blocked_by_you' | 'not_connected' | 'unavailable'}
 */
export function messagingUnavailableReason(other, relationship) {
  if (relationship.isSelf) return 'unavailable';
  if (relationship.blockedByViewer) return 'blocked_by_you';
  if (relationship.blockedByTarget) return 'unavailable';
  if (!other || !VISIBLE_ACCOUNT_STATUSES.includes(other.status)) return 'unavailable';
  if (!relationship.connected) return 'not_connected';
  return null;
}

/**
 * Read receipts work both ways: a reader's receipt is shown to the sender only when both
 * have read receipts on. Used by messaging (Phase 6) before emitting "read" events.
 */
export function readReceiptsAllowed(reader, sender) {
  return privacyOf(reader).readReceipts && privacyOf(sender).readReceipts;
}

/** Typing indicators also work both ways. Used by messaging before emitting "typing" events. */
export function typingIndicatorsAllowed(typist, viewer) {
  return privacyOf(typist).typingIndicators && privacyOf(viewer).typingIndicators;
}
