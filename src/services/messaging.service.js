import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { API_PREFIX, CONVERSATION_PIN_LIMIT, PINNED_MESSAGES_LIMIT } from '#shared';
import mongoose, { isValidObjectId } from 'mongoose';
import { Conversation } from '../models/conversation.model.js';
import { MessageFlag } from '../models/message-flag.model.js';
import { Poll } from '../models/poll.model.js';
import { Message } from '../models/message.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { pairKey } from '../utils/pair-key.js';
import { createMessageActions } from './message-actions.js';
import { loadBoundDevice } from './e2ee.service.js';
import { buildMessageDtos, previewOf, toPinDtos } from './message-dto.js';
import {
  audienceIncludes,
  loadRelationships,
  messagingUnavailableReason,
  privacyOf,
  readReceiptsAllowed,
  typingIndicatorsAllowed,
  VISIBLE_ACCOUNT_STATUSES,
} from './policy.js';
import { PUBLIC_USER_FIELDS, toUserCard } from './user-dto.js';

/** How many times a send retries when another message took the same seq at the same moment. */
const SEQ_ALLOCATION_ATTEMPTS = 25;
const SYNC_PAGE_DEFAULT = 100;

const conversationNotFound = () => new AppError(404, 'NOT_FOUND', 'Conversation not found.');
const personNotFound = () => new AppError(404, 'NOT_FOUND', "We couldn't find that person.");

function messagingNotAllowed(reason) {
  switch (reason) {
    case 'blocked_by_you':
      return new AppError(403, 'MESSAGING_NOT_ALLOWED', 'Unblock this person to message them.');
    case 'not_connected':
      return new AppError(
        403,
        'MESSAGING_NOT_ALLOWED',
        "You're not connected with this person. Send a message request first.",
      );
    default:
      return new AppError(403, 'MESSAGING_NOT_ALLOWED', "You can't message this person right now.");
  }
}

/** MongoDB E11000 on an index containing `field`. */
function isDuplicateKeyOn(error, field) {
  return error?.code === 11000 && Object.hasOwn(error.keyPattern ?? {}, field);
}

const peerOf = (conversation, userId) =>
  conversation.participants.find((id) => String(id) !== String(userId));

const memberOf = (conversation, userId) =>
  conversation.members.find((member) => String(member.user) === String(userId));

function encodeListCursor(conversation) {
  return Buffer.from(
    `${conversation.lastActivityAt.getTime()}:${String(conversation._id)}`,
    'utf8',
  ).toString('base64url');
}

function decodeListCursor(cursor) {
  if (!cursor) return null;
  const [time, id] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
  if (!/^\d{1,15}$/.test(time ?? '') || !isValidObjectId(id)) {
    throw AppError.badRequest('Invalid cursor');
  }
  return { lastActivityAt: new Date(Number(time)), id: new mongoose.Types.ObjectId(id) };
}

/** Changes newer than this before `changesSince` are returned again (clock skew between servers). */
const CHANGES_OVERLAP_MS = 30_000;
const CHANGES_LIMIT = 500;

/** "Mute until unmuted" is stored as this far-future time. */
const MUTED_FOREVER = new Date('9999-12-31T00:00:00.000Z');
const MUTE_MS = { '8h': 8 * 3_600_000, '1w': 7 * 86_400_000 };
/** Search looks through at most this many of your conversations. */
const SEARCH_SCAN_LIMIT = 2_000;
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Your own chat settings as clients see them. */
function preferencesOf(member, now = new Date()) {
  return {
    pinned: Boolean(member.pinnedAt),
    favorite: Boolean(member.favoriteAt),
    archived: Boolean(member.archivedAt),
    markedUnread: Boolean(member.markedUnread),
    mutedUntil:
      member.mutedUntil && member.mutedUntil > now ? member.mutedUntil.toISOString() : null,
  };
}

/** The content fields that make two sends "the same message" for idempotency. */
const contentKey = (message) =>
  (message.type ?? 'text') === 'poll'
    ? JSON.stringify(['poll', message.replyTo ? String(message.replyTo) : null])
    : message.forwardedFrom?.message
      ? JSON.stringify(['forward', String(message.forwardedFrom.message)])
      : JSON.stringify([
          message.type ?? 'text',
          message.text ?? '',
          message.attachment ? String(message.attachment) : null,
          message.sticker ?? null,
          message.replyTo ? String(message.replyTo) : null,
          message.encrypted?.ciphertext ?? null,
        ]);

/**
 * One-to-one conversations and messages. Every method takes the signed-in user's id (from the
 * session, never from the client) and checks conversation membership itself.
 *
 * Domain events (for the real-time layer, which fans them out to sockets):
 * - "message"   { message (DTO), participants: string[] }
 * - "delivered" { conversationId, userId, lastDeliveredSeq, peerId, notifyPeer }
 * - "read"      { conversationId, userId, lastReadSeq, peerId, notifyPeer }
 * - "updated"   { message (DTO), participants } — edited, deleted for everyone, reactions
 * - "state"     { userId, state } — a person's private star / delete-for-me flags
 * - "pins"      { conversationId, pins, participants }
 *
 * @param {{ presence: import('../realtime/presence.js').PresenceTracker, attachments: ReturnType<typeof import('./attachment.service.js').createAttachmentService>, config: import('../config/app-config.js').AppConfig, notifications?: ReturnType<typeof import('./notification.service.js').createNotificationService> }} deps
 */
export function createMessagingService({ presence, attachments, config, notifications }) {
  const events = new EventEmitter();

  /** The conversation, if `userId` is one of its two participants; otherwise 404. */
  async function loadMembership(userId, conversationId) {
    if (!isValidObjectId(conversationId)) throw conversationNotFound();
    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: userId,
    }).lean();
    if (!conversation) throw conversationNotFound();
    return conversation;
  }

  /** Re-checks Phase 5 rules (connection, blocks, account state) for one pair, right now. */
  async function messagingCheck(userId, peerId) {
    const [peer, relationships] = await Promise.all([
      User.findById(peerId, PUBLIC_USER_FIELDS).lean(),
      loadRelationships(userId, [peerId]),
    ]);
    const relationship = relationships.get(String(peerId));
    return { peer, relationship, reason: messagingUnavailableReason(peer, relationship) };
  }

  async function requireCanMessage(userId, peerId) {
    const check = await messagingCheck(userId, peerId);
    if (check.reason) throw messagingNotAllowed(check.reason);
    return check;
  }

  /**
   * Who may post in a conversation right now. One-to-one: the Phase 5 rules (connection, no
   * block). Groups: current membership (already checked by loading it) and a group that still
   * exists; blocks between two members don't silence either of them in a shared group.
   */
  async function requireCanPost(userId, conversation) {
    if (conversation.type === 'group') {
      if (conversation.group?.deletedAt || conversation.participants.length === 0) {
        throw new AppError(403, 'MESSAGING_NOT_ALLOWED', 'This group no longer exists.');
      }
      if (conversation.group?.suspendedAt) {
        throw new AppError(403, 'MESSAGING_NOT_ALLOWED', 'This group is suspended by a moderator.');
      }
      return null;
    }
    return requireCanMessage(userId, peerOf(conversation, userId));
  }

  /** Inserts a message with the next free seq (see message.model.js), retrying on collisions. */
  async function insertWithSeq(conversationId, fields) {
    for (let attempt = 1; ; attempt++) {
      const seq = (await latestSeq(conversationId)) + 1;
      try {
        return (await Message.create({ conversation: conversationId, seq, ...fields })).toObject();
      } catch (error) {
        if (!isDuplicateKeyOn(error, 'seq')) throw error;
        if (attempt >= SEQ_ALLOCATION_ATTEMPTS) {
          throw new AppError(
            503,
            'SERVICE_UNAVAILABLE',
            'This conversation is busy. Please try again.',
          );
        }
      }
    }
  }

  async function latestSeq(conversationId) {
    const latest = await Message.findOne({ conversation: conversationId }, { seq: 1 })
      .sort({ seq: -1 })
      .lean();
    return latest?.seq ?? 0;
  }

  /**
   * Group delivery/read positions as seen by `viewerId`: the lowest position among the other
   * members (a message is "read" once everyone else read it). Read is null when any of them, or
   * the viewer, has read receipts off.
   */
  function groupReceiptsFor(conversation, viewerId, privacyById, viewer) {
    const others = conversation.members.filter(
      (member) => String(member.user) !== String(viewerId),
    );
    if (others.length === 0) return { lastDeliveredSeq: 0, lastReadSeq: null };
    const readable = others.every((member) =>
      readReceiptsAllowed(privacyById.get(String(member.user)) ?? {}, viewer ?? {}),
    );
    return {
      lastDeliveredSeq: Math.min(...others.map((member) => member.lastDeliveredSeq ?? 0)),
      lastReadSeq: readable ? Math.min(...others.map((member) => member.lastReadSeq ?? 0)) : null,
    };
  }

  /** Sends every group member their own aggregated delivery/read positions (see above). */
  async function emitGroupReceipts(conversation) {
    const users = await User.find(
      { _id: { $in: conversation.participants } },
      { privacy: 1 },
    ).lean();
    const privacyById = new Map(users.map((user) => [String(user._id), user]));
    events.emit('groupReceipts', {
      conversationId: String(conversation._id),
      updates: conversation.participants.map((id) => ({
        userId: String(id),
        ...groupReceiptsFor(conversation, id, privacyById, privacyById.get(String(id))),
      })),
    });
  }

  /** Mongo filter: messages that count as unread for `userId` after their read position. */
  function unreadFilter(conversation, userId, afterSeq) {
    return conversation.type === 'group'
      ? {
          conversation: conversation._id,
          seq: { $gt: afterSeq },
          sender: { $ne: new mongoose.Types.ObjectId(String(userId)) },
          type: { $ne: 'system' },
        }
      : {
          conversation: conversation._id,
          recipient: new mongoose.Types.ObjectId(String(userId)),
          seq: { $gt: afterSeq },
        };
  }

  /** Builds conversation DTOs for `viewerId` with a fixed number of queries. */
  async function summarize(viewerId, conversations) {
    if (conversations.length === 0) return [];
    const direct = conversations.filter((conversation) => conversation.type !== 'group');
    const groups = conversations.filter((conversation) => conversation.type === 'group');
    const peerIds = direct.map((conversation) => String(peerOf(conversation, viewerId)));
    const groupMemberIds = [
      ...new Set(groups.flatMap((conversation) => conversation.participants.map(String))),
    ].filter((id) => id !== String(viewerId));
    const pinnedIds = conversations.flatMap((conversation) =>
      (conversation.pins ?? []).map((pin) => pin.message),
    );
    const [viewer, peers, relationships, unread, hiddenPins, groupUsers] = await Promise.all([
      User.findById(viewerId, { privacy: 1 }).lean(),
      peerIds.length ? User.find({ _id: { $in: peerIds } }, PUBLIC_USER_FIELDS).lean() : [],
      peerIds.length ? loadRelationships(viewerId, peerIds) : new Map(),
      Message.aggregate([
        {
          $match: {
            $or: conversations.map((conversation) =>
              unreadFilter(conversation, viewerId, memberOf(conversation, viewerId).lastReadSeq),
            ),
          },
        },
        { $group: { _id: '$conversation', count: { $sum: 1 } } },
      ]),
      pinnedIds.length
        ? MessageFlag.find(
            { user: viewerId, message: { $in: pinnedIds }, hiddenAt: { $ne: null } },
            { message: 1 },
          )
            .lean()
            .then((rows) => new Set(rows.map((row) => String(row.message))))
        : new Set(),
      groupMemberIds.length
        ? User.find({ _id: { $in: groupMemberIds } }, { privacy: 1 }).lean()
        : [],
    ]);
    const peersById = new Map(peers.map((peer) => [String(peer._id), peer]));
    const unreadById = new Map(unread.map((row) => [String(row._id), row.count]));
    const privacyById = new Map(groupUsers.map((user) => [String(user._id), user]));
    const rules = {
      editWindowSeconds: Math.floor(config.messages.editWindowMs / 1_000),
      deleteWindowSeconds: Math.floor(config.messages.deleteWindowMs / 1_000),
      pinLimit: PINNED_MESSAGES_LIMIT,
    };

    return conversations.map((conversation) => {
      const mine = memberOf(conversation, viewerId);
      const { lastMessage } = conversation;
      const common = {
        id: String(conversation._id),
        lastMessage: lastMessage
          ? {
              id: String(lastMessage.message),
              seq: lastMessage.seq,
              senderId: String(lastMessage.sender),
              preview: lastMessage.preview,
              createdAt: lastMessage.createdAt.toISOString(),
            }
          : null,
        lastActivityAt: conversation.lastActivityAt.toISOString(),
        unreadCount: unreadById.get(String(conversation._id)) ?? 0,
        receipts: { lastDeliveredSeq: mine.lastDeliveredSeq, lastReadSeq: mine.lastReadSeq },
        // Pins are shared, but a message you deleted for yourself isn't shown to you.
        pins: toPinDtos(conversation.pins).filter((pin) => !hiddenPins.has(pin.messageId)),
        rules,
        preferences: preferencesOf(mine),
        e2ee: conversation.e2ee ? { enabledAt: conversation.e2ee.enabledAt.toISOString() } : null,
        createdAt: conversation.createdAt.toISOString(),
      };

      if (conversation.type === 'group') {
        const { group } = conversation;
        return {
          ...common,
          type: 'group',
          peer: null,
          group: {
            name: group.name,
            description: group.description ?? '',
            avatarUrl: group.avatar?.key ? `${API_PREFIX}/avatars/${group.avatar.key}` : null,
            memberCount: conversation.participants.length,
            myRole: mine.role ?? 'member',
            suspended: Boolean(group.suspendedAt),
          },
          peerReceipts: groupReceiptsFor(conversation, viewerId, privacyById, viewer),
          canMessage: !group.deletedAt && !group.suspendedAt,
          messagingUnavailableReason: group.deletedAt || group.suspendedAt ? 'unavailable' : null,
        };
      }

      const peerId = String(peerOf(conversation, viewerId));
      const peer = peersById.get(peerId) ?? {
        _id: peerId,
        displayName: 'Deleted user',
        status: 'deleted',
      };
      const relationship = relationships.get(peerId);
      const privacy = privacyOf(peer);
      const reachable = VISIBLE_ACCOUNT_STATUSES.includes(peer.status);
      const showOnline =
        reachable && audienceIncludes(privacy.onlineStatusVisibility, relationship);
      const showLastSeen = reachable && audienceIncludes(privacy.lastSeenVisibility, relationship);
      const theirs = memberOf(conversation, peerId);
      const reason = messagingUnavailableReason(peer, relationship);
      return {
        ...common,
        type: 'direct',
        peer: {
          ...toUserCard(peer),
          presence: {
            online: showOnline ? presence.isOnline(peerId) : null,
            lastSeenAt: showLastSeen && peer.lastSeenAt ? peer.lastSeenAt.toISOString() : null,
          },
        },
        group: null,
        peerReceipts: {
          lastDeliveredSeq: theirs.lastDeliveredSeq,
          lastReadSeq: readReceiptsAllowed(peer, viewer ?? {}) ? theirs.lastReadSeq : null,
        },
        canMessage: reason === null,
        messagingUnavailableReason: reason,
      };
    });
  }

  /** Frees a pin place (unpin, archive, remove from list). */
  async function releasePin(userId, conversationId) {
    await User.updateOne({ _id: userId }, { $pull: { pinnedChats: conversationId } });
  }

  async function summarizeOne(viewerId, conversation) {
    const [summary] = await summarize(viewerId, [conversation]);
    return summary;
  }

  /**
   * Points the conversation summary at `message` unless a newer message is already there.
   * Idempotent, so retrying a send repairs a summary whose update failed the first time.
   */
  async function recordActivity(message) {
    const attachment = message.attachment
      ? (await attachments.findDtos([message.attachment])).get(String(message.attachment))
      : null;
    await Conversation.updateOne(
      {
        _id: message.conversation,
        $or: [{ lastMessage: null }, { 'lastMessage.seq': { $lt: message.seq } }],
      },
      {
        $set: {
          lastMessage: {
            message: message._id,
            seq: message.seq,
            sender: message.sender,
            preview: previewOf(message, attachment) || 'Message',
            createdAt: message.createdAt,
          },
        },
        $max: { lastActivityAt: message.createdAt },
      },
    );
    // Per-person effects of a new message (idempotent, so a retried send repairs them too), for
    // everyone except the sender (the other person, or the other group members):
    // - a chat removed from anyone's list comes back;
    // - their "newest received" position moves (the "unread" filter uses it);
    // - an archived chat returns to their main list, unless they muted it.
    // Group system lines (member added, …) only bring removed chats back.
    const now = new Date();
    const receiving = { 'r.user': { $ne: message.sender } };
    await Conversation.updateOne(
      { _id: message.conversation },
      message.type === 'system'
        ? { $set: { 'members.$[].hiddenAt': null } }
        : {
            $set: { 'members.$[].hiddenAt': null },
            $max: { 'members.$[r].lastReceivedSeq': message.seq },
          },
      message.type === 'system' ? {} : { arrayFilters: [receiving] },
    );
    if (message.type === 'system') return;
    await Conversation.updateOne(
      { _id: message.conversation },
      { $set: { 'members.$[r].archivedAt': null } },
      {
        arrayFilters: [
          {
            ...receiving,
            'r.archivedAt': { $ne: null },
            // Not muted: unset, null or in the past. ($or inside arrayFilters gets
            // subdocument defaults added by Mongoose's casting, which MongoDB rejects.)
            'r.mutedUntil': { $not: { $gt: now } },
          },
        ],
      },
    );
  }

  /** Emits a stored message to both participants and returns its DTO for `viewerId`. */
  async function announce(stored, conversation, viewerId) {
    // Stored before the message is announced, so a recipient reading it at once also reads it.
    await notifications?.messageSent(conversation, stored);
    const [shared] = await buildMessageDtos([stored]);
    events.emit('message', {
      message: shared,
      participants: conversation.participants.map(String),
    });
    const [own] = await buildMessageDtos([stored], viewerId);
    return own;
  }

  /** A retry with a known idempotency key: the same message again, or a conflict. */
  async function replay(existing, conversation, content, viewerId) {
    if (
      !existing.conversation.equals(conversation._id) ||
      contentKey(existing) !== contentKey(content)
    ) {
      throw new AppError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'This message id was already used for a different message.',
      );
    }
    if (existing.attachment && !existing.forwardedFrom) {
      await attachments.markAttached(existing.attachment);
    }
    await recordActivity(existing);
    return { message: await announce(existing, conversation, viewerId), duplicate: true };
  }

  /** Lists messages after `afterSeq`, oldest first (gap-free; see message.model.js). */
  async function messagesAfter(conversationId, afterSeq, limit, viewerId) {
    const rows = await Message.find({ conversation: conversationId, seq: { $gt: afterSeq } })
      .sort({ seq: 1 })
      .limit(limit + 1)
      .lean();
    const hasMore = rows.length > limit;
    return { messages: await buildMessageDtos(rows.slice(0, limit), viewerId), hasMore };
  }

  /**
   * Validates what a send asks for and returns the message content to store. Throws when the
   * attachment, sticker, reply target or forwarded message isn't allowed.
   */
  async function resolveContent(userId, conversation, input) {
    const content = {
      type: 'text',
      text: input.text ?? '',
      attachment: null,
      sticker: null,
      replyTo: null,
      forwardedFrom: null,
    };
    if (input.forwardOfId) {
      const source = await Message.findById(input.forwardOfId).lean();
      const visible =
        source &&
        !source.deletedAt &&
        (await Conversation.exists({ _id: source.conversation, participants: userId })) &&
        !(await MessageFlag.exists({ user: userId, message: source._id, hiddenAt: { $ne: null } }));
      if (!visible) {
        throw new AppError(404, 'NOT_FOUND', 'That message is not available to forward.');
      }
      if (source.encryption === 'e2ee_v1') {
        // The server can't read it; a client re-sends the content encrypted for the new chat.
        throw AppError.badRequest("End-to-end encrypted messages can't be forwarded.");
      }
      if (source.type === 'poll' || source.type === 'system') {
        throw AppError.badRequest("Polls and group events can't be forwarded.");
      }
      if (source.attachment && !(await attachments.isUsable(source.attachment))) {
        throw new AppError(410, 'NOT_FOUND', 'That attachment is no longer available.');
      }
      return {
        ...content,
        type: source.type ?? 'text',
        text: source.text ?? '',
        attachment: source.attachment ?? null,
        sticker: source.sticker ?? null,
        forwardedFrom: { message: source._id, sender: source.sender },
      };
    }
    if (input.encrypted) {
      Object.assign(content, { encryption: 'e2ee_v1', encrypted: input.encrypted });
    }
    if (input.attachmentId) {
      const attachment = await attachments.loadForSending(
        userId,
        conversation._id,
        input.attachmentId,
      );
      Object.assign(content, { type: 'attachment', attachment: attachment._id });
    } else if (input.sticker) {
      Object.assign(content, { type: 'sticker', sticker: input.sticker });
    } else if (input.poll) {
      if (conversation.type !== 'group') {
        throw AppError.badRequest('Polls are available in groups.');
      }
      // Created before its message; a poll whose message failed to store is never shown.
      const poll = await Poll.create({
        conversation: conversation._id,
        creator: userId,
        question: input.poll.question,
        options: input.poll.options.map((text, index) => ({ id: `o${index + 1}`, text })),
        multiple: input.poll.multiple,
      });
      // The question doubles as the message text (list previews); clients show the poll.
      Object.assign(content, { type: 'poll', poll: poll._id, text: input.poll.question });
    }
    if (input.replyToId) {
      const target = await Message.findOne(
        { _id: input.replyToId, conversation: conversation._id, deletedAt: null },
        { _id: 1 },
      ).lean();
      const hidden =
        target &&
        (await MessageFlag.exists({ user: userId, message: target._id, hiddenAt: { $ne: null } }));
      if (!target || hidden) {
        throw AppError.badRequest("You can't reply to that message.");
      }
      content.replyTo = target._id;
    }
    return content;
  }

  /** Normalised content of a send request, for comparing with a stored message (idempotency). */
  function requestedContent(input) {
    return {
      type: input.attachmentId
        ? 'attachment'
        : input.sticker
          ? 'sticker'
          : input.poll
            ? 'poll'
            : 'text',
      text: input.text ?? '',
      attachment: input.attachmentId ?? null,
      sticker: input.sticker ?? null,
      replyTo: input.replyToId ?? null,
      forwardedFrom: input.forwardOfId ? { message: input.forwardOfId } : null,
      encrypted: input.encrypted ?? null,
    };
  }

  /**
   * End-to-end encrypted chats accept encrypted text, from the device this sign-in is bound to
   * (its id and Curve25519 key must be the ones in the payload), and media (photos, videos,
   * audio, voice notes, files) WITHOUT any readable text: by product decision media is not end-to-
   * end encrypted (clients mark it so, and send captions as separate encrypted messages). Readable
   * text is always refused, so nobody can downgrade an encrypted chat's messages. Other chats
   * accept no encrypted content.
   *
   * @param {{ encrypted?: object, text?: string, attachmentId?: string, sticker?: string, forwardOfId?: string, poll?: object }} input
   */
  async function requireEncryptionRules(userId, sessionId, conversation, input) {
    const { encrypted } = input;
    if (!conversation.e2ee) {
      if (encrypted) {
        throw new AppError(400, 'E2EE_NOT_ENABLED', "This chat isn't end-to-end encrypted.");
      }
      return;
    }
    if (encrypted && input.attachmentId) {
      throw AppError.badRequest('Files are sent without end-to-end encryption, and without text.');
    }
    const media =
      input.attachmentId &&
      input.text === undefined &&
      !input.sticker &&
      !input.forwardOfId &&
      !input.poll;
    if (!encrypted) {
      if (media) return;
      throw new AppError(
        409,
        'E2EE_REQUIRED',
        'This chat is end-to-end encrypted. Messages must be encrypted on your device.',
      );
    }
    const device = await loadBoundDevice(userId, sessionId);
    if (
      !device ||
      device.deviceId !== encrypted.device_id ||
      device.curve25519 !== encrypted.sender_key
    ) {
      throw new AppError(
        403,
        'DEVICE_NOT_BOUND',
        "This message wasn't encrypted by this sign-in's encryption device.",
      );
    }
  }

  return {
    events,

    // Edit, delete (for me / everyone), react, pin, star, starred list (message-actions.js).
    ...createMessageActions({
      events,
      config,
      attachments,
      loadMembership,
      requireCanPost,
      requireEncryptionRules,
    }),

    /**
     * The signed-in user's conversations, most recent activity first (keyset pagination), from
     * their own settings only:
     * - "all": not archived, not removed; on the first page your pinned chats come first;
     * - "unread": with messages after your read position, or marked as unread;
     * - "favorites": your favorites; "archived": only archived chats.
     * `q` matches the other person's username (prefix) or display name (contains).
     */
    async listConversations(userId, { cursor, limit, filter = 'all', q }) {
      const after = decodeListCursor(cursor);
      const me = new mongoose.Types.ObjectId(String(userId));
      const mine = { user: me, hiddenAt: null };
      if (filter === 'archived') mine.archivedAt = { $ne: null };
      else mine.archivedAt = null;
      if (filter === 'favorites') mine.favoriteAt = { $ne: null };

      const base = { participants: me };
      if (filter === 'unread') {
        base.$expr = {
          $anyElementTrue: {
            $map: {
              input: '$members',
              as: 'm',
              in: {
                $and: [
                  { $eq: ['$$m.user', me] },
                  {
                    $or: [
                      { $gt: [{ $ifNull: ['$$m.lastReceivedSeq', 0] }, '$$m.lastReadSeq'] },
                      { $eq: ['$$m.markedUnread', true] },
                    ],
                  },
                ],
              },
            },
          },
        };
      }
      if (q) {
        // Only the people in your own conversations are searched.
        // Groups match their name; one-to-one chats match the other person.
        const own = await Conversation.find(
          { participants: me },
          { participants: 1, type: 1, 'group.name': 1 },
        )
          .sort({ lastActivityAt: -1 })
          .limit(SEARCH_SCAN_LIMIT)
          .lean();
        const pattern = escapeRegex(q);
        const nameMatch = new RegExp(pattern, 'i');
        const groupMatches = own
          .filter((c) => c.type === 'group' && nameMatch.test(c.group?.name ?? ''))
          .map((c) => c._id);
        const peerToConversation = new Map(
          own
            .filter((c) => c.type !== 'group')
            .map((conversation) => [String(peerOf(conversation, me)), conversation._id]),
        );
        const matches = await User.find(
          {
            _id: { $in: [...peerToConversation.keys()] },
            $or: [
              { username: { $regex: `^${pattern.toLowerCase()}` } },
              { displayName: { $regex: pattern, $options: 'i' } },
            ],
          },
          { _id: 1 },
        ).lean();
        base._id = {
          $in: [
            ...matches.map((user) => peerToConversation.get(String(user._id))),
            ...groupMatches,
          ],
        };
      }

      // Pinned chats lead the main list (first page only) and are excluded from the rest.
      const pinnedFirst = filter === 'all' && !q;
      let pinned = [];
      if (pinnedFirst && !after) {
        pinned = await Conversation.find({
          ...base,
          members: { $elemMatch: { ...mine, pinnedAt: { $ne: null } } },
        }).lean();
        pinned.sort((a, b) => memberOf(b, me).pinnedAt - memberOf(a, me).pinnedAt);
      }
      const rows = await Conversation.find({
        ...base,
        members: { $elemMatch: pinnedFirst ? { ...mine, pinnedAt: null } : mine },
        ...(after
          ? {
              $or: [
                { lastActivityAt: { $lt: after.lastActivityAt } },
                { lastActivityAt: after.lastActivityAt, _id: { $lt: after.id } },
              ],
            }
          : {}),
      })
        .sort({ lastActivityAt: -1, _id: -1 })
        .limit(limit + 1)
        .lean();
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return {
        data: await summarize(userId, [...pinned, ...page]),
        meta: { limit, hasMore, nextCursor: hasMore ? encodeListCursor(page.at(-1)) : null },
      };
    },

    /**
     * Changes the signed-in user's own settings for a conversation. Only their own member entry
     * is addressed (filter on the session user), so the other participant is never affected.
     * Archiving unpins; pinning unarchives. At most CONVERSATION_PIN_LIMIT pinned chats.
     */
    async updatePreferences(userId, conversationId, input) {
      const conversation = await loadMembership(userId, conversationId);
      const now = new Date();
      const set = {};
      if (input.favorite !== undefined) set['members.$.favoriteAt'] = input.favorite ? now : null;
      if (input.markedUnread !== undefined) set['members.$.markedUnread'] = input.markedUnread;
      if (input.muted !== undefined) {
        set['members.$.mutedUntil'] =
          input.muted === 'off'
            ? null
            : input.muted === 'always'
              ? MUTED_FOREVER
              : new Date(now.getTime() + MUTE_MS[input.muted]);
      }
      if (input.archived !== undefined) {
        set['members.$.archivedAt'] = input.archived ? now : null;
        if (input.archived) set['members.$.pinnedAt'] = null;
      }
      if (input.pinned !== undefined) {
        set['members.$.pinnedAt'] = input.pinned ? now : null;
        if (input.pinned) set['members.$.archivedAt'] = null;
      }
      if (input.pinned && memberOf(conversation, userId).pinnedAt) {
        delete set['members.$.pinnedAt']; // already pinned: keep its place
      }
      if (set['members.$.pinnedAt']) {
        // Reserve a pin place first (atomic: the array can't grow past the limit).
        const reserved = await User.updateOne(
          {
            _id: userId,
            pinnedChats: { $ne: conversation._id },
            [`pinnedChats.${CONVERSATION_PIN_LIMIT - 1}`]: { $exists: false },
          },
          { $push: { pinnedChats: conversation._id } },
        );
        if (reserved.modifiedCount === 0) {
          const user = await User.findById(userId, { pinnedChats: 1 }).lean();
          if (!user?.pinnedChats?.some((id) => id.equals(conversation._id))) {
            throw new AppError(
              409,
              'PIN_LIMIT_REACHED',
              `You can pin up to ${CONVERSATION_PIN_LIMIT} chats. Unpin one first.`,
            );
          }
        }
      } else if (set['members.$.pinnedAt'] === null) {
        await releasePin(userId, conversation._id);
      }
      await Conversation.updateOne(
        { _id: conversation._id, 'members.user': userId },
        { $set: set },
      );
      const summary = await summarizeOne(userId, await loadMembership(userId, conversationId));
      events.emit('preferences', {
        userId: String(userId),
        conversationId: summary.id,
        preferences: summary.preferences,
        removed: false,
      });
      return summary;
    },

    /**
     * Removes the conversation from the signed-in user's list only. Messages, attachments and
     * the other person's list are untouched; it comes back with the next message, or when this
     * user opens the conversation again.
     */
    async removeFromList(userId, conversationId) {
      const conversation = await loadMembership(userId, conversationId);
      await releasePin(userId, conversation._id);
      await Conversation.updateOne(
        { _id: conversation._id, 'members.user': userId },
        {
          $set: {
            'members.$.hiddenAt': new Date(),
            'members.$.pinnedAt': null,
            'members.$.markedUnread': false,
          },
        },
      );
      events.emit('preferences', {
        userId: String(userId),
        conversationId: String(conversation._id),
        preferences: null,
        removed: true,
      });
    },

    /**
     * Adds a group event line ("member added", "renamed", …) to the history and delivers it to
     * the current members like any message.
     */
    async postSystemMessage(conversationId, { actor, kind, target = null, name = null, call }) {
      const conversation = await Conversation.findById(conversationId).lean();
      if (!conversation || conversation.participants.length === 0) return null;
      const stored = await insertWithSeq(conversation._id, {
        sender: actor,
        recipient: null,
        clientMessageId: randomUUID(),
        type: 'system',
        system: { kind, actor, target, name, ...(call ? { call } : {}) },
      });
      await recordActivity(stored);
      const [message] = await buildMessageDtos([stored]);
      events.emit('message', { message, participants: conversation.participants.map(String) });
      return message;
    },

    /** Tells these people to fetch the conversation again (membership or details changed). */
    notifyChanged(conversationId, userIds) {
      events.emit('changed', {
        conversationId: String(conversationId),
        participants: [...new Set(userIds.map(String))],
      });
    },

    /** Current latest seq, so a joining member starts with nothing unread. */
    latestSeq,

    /**
     * After a block or unblock between two people: their conversation's permissions changed.
     * The real-time layer tells both to refresh (without saying why) and clears typing.
     */
    async relationshipChanged(a, b) {
      const conversation = await Conversation.findOne(
        { pairKey: pairKey(a, b) },
        { _id: 1, participants: 1 },
      ).lean();
      if (!conversation) return;
      events.emit('changed', {
        conversationId: String(conversation._id),
        participants: conversation.participants.map(String),
      });
    },

    /**
     * Opens the conversation with `peerId`, creating it if needed. Only allowed while the two
     * may message each other. Concurrent calls (from either person) converge on one document
     * through the unique pairKey index.
     */
    async openConversation(userId, peerId) {
      if (String(userId) === String(peerId)) {
        throw AppError.badRequest("You can't start a conversation with yourself.");
      }
      const check = await messagingCheck(userId, peerId);
      // Someone who blocked you, or a hidden account, looks exactly like a missing one.
      if (
        !check.peer ||
        !VISIBLE_ACCOUNT_STATUSES.includes(check.peer.status) ||
        check.relationship.blockedByTarget
      ) {
        throw personNotFound();
      }
      if (check.reason) throw messagingNotAllowed(check.reason);

      const key = pairKey(userId, peerId);
      let conversation = await Conversation.findOne({ pairKey: key }).lean();
      let created = false;
      if (!conversation) {
        const participants = [String(userId), String(peerId)].sort();
        try {
          conversation = (
            await Conversation.create({
              pairKey: key,
              participants,
              members: participants.map((user) => ({ user })),
              lastActivityAt: new Date(),
            })
          ).toObject();
          created = true;
        } catch (error) {
          // The other person (or another tab) created it at the same moment.
          if (!isDuplicateKeyOn(error, 'pairKey')) throw error;
          conversation = await Conversation.findOne({ pairKey: key }).lean();
          if (!conversation) throw error;
        }
      }
      if (!created && memberOf(conversation, userId).hiddenAt) {
        // Opening a chat you removed puts it back in your list.
        await Conversation.updateOne(
          { _id: conversation._id, 'members.user': userId },
          { $set: { 'members.$.hiddenAt': null } },
        );
        conversation = await Conversation.findById(conversation._id).lean();
      }
      return { conversation: await summarizeOne(userId, conversation), created };
    },

    async getConversation(userId, conversationId) {
      return summarizeOne(userId, await loadMembership(userId, conversationId));
    },

    /**
     * Message history, oldest first within the page.
     * - no cursor: the newest `limit` messages;
     * - cursor (a seq): the `limit` messages before it (meta.nextCursor continues further back);
     * - after (a seq): the `limit` messages after it (meta.nextCursor continues forward).
     */
    async listMessages(userId, conversationId, { cursor, after, limit }) {
      const conversation = await loadMembership(userId, conversationId);
      if (after !== undefined) {
        const { messages, hasMore } = await messagesAfter(conversation._id, after, limit, userId);
        return {
          data: messages,
          meta: { limit, hasMore, nextCursor: hasMore ? String(messages.at(-1).seq) : null },
        };
      }
      const rows = await Message.find({
        conversation: conversation._id,
        ...(cursor ? { seq: { $lt: Number(cursor) } } : {}),
      })
        .sort({ seq: -1 })
        .limit(limit + 1)
        .lean();
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit).reverse();
      return {
        data: await buildMessageDtos(page, userId),
        meta: { limit, hasMore, nextCursor: hasMore ? String(page[0].seq) : null },
      };
    },

    /**
     * Stores a message: text, an uploaded attachment (with optional caption), a sticker, or a
     * forward; or, in an end-to-end encrypted chat, only an encrypted payload (with an encrypted
     * file). Optionally replying to another message. Order of checks: membership → current
     * messaging permission (connection, blocks) → encryption rules → idempotency key → content (attachment
     * ownership, reply target, forward source) → insert → attachment marked as used. Only
     * returns once everything is stored; any failure is thrown and nothing claims success.
     *
     * @returns {Promise<{ message: object, duplicate: boolean }>}
     */
    async sendMessage(userId, conversationId, input, { sessionId } = {}) {
      const { clientMessageId } = input;
      const conversation = await loadMembership(userId, conversationId);
      await requireCanPost(userId, conversation);
      await requireEncryptionRules(userId, sessionId, conversation, input);

      const existing = await Message.findOne({ sender: userId, clientMessageId }).lean();
      if (existing) return replay(existing, conversation, requestedContent(input), userId);

      const content = await resolveContent(userId, conversation, input);
      let stored;
      try {
        stored = await insertWithSeq(conversation._id, {
          sender: userId,
          recipient: conversation.type === 'group' ? null : peerOf(conversation, userId),
          clientMessageId,
          ...content,
        });
      } catch (error) {
        if (!isDuplicateKeyOn(error, 'clientMessageId')) throw error;
        // The same submission arrived twice at once and the other copy won.
        const winner = await Message.findOne({ sender: userId, clientMessageId }).lean();
        if (!winner) throw error;
        return replay(winner, conversation, requestedContent(input), userId);
      }

      if (stored.attachment) {
        if (!stored.forwardedFrom) await attachments.markAttached(stored.attachment);
        // A cleanup that started before this insert may have removed the file: never deliver a
        // message pointing at a missing file. The seq stays used (a tombstone), so no gap.
        if (!(await attachments.isUsable(stored.attachment))) {
          await Message.updateOne(
            { _id: stored._id },
            { $set: { deletedAt: new Date(), text: '', attachment: null }, $inc: { rev: 1 } },
          );
          throw new AppError(410, 'NOT_FOUND', 'That attachment is no longer available.');
        }
      }

      await recordActivity(stored);
      return { message: await announce(stored, conversation, userId), duplicate: false };
    },

    /** The recipient's device has every message up to `seq`. Positions only move forward. */
    async markDelivered(userId, conversationId, seq) {
      const conversation = await loadMembership(userId, conversationId);
      if (seq > (await latestSeq(conversation._id))) {
        throw AppError.badRequest('That message does not exist.');
      }
      const before = memberOf(conversation, userId).lastDeliveredSeq;
      const updated = await Conversation.findOneAndUpdate(
        { _id: conversation._id, 'members.user': userId },
        { $max: { 'members.$.lastDeliveredSeq': seq } },
        { returnDocument: 'after' },
      ).lean();
      const lastDeliveredSeq = memberOf(updated, userId).lastDeliveredSeq;
      if (lastDeliveredSeq > before && conversation.type === 'group') {
        events.emit('delivered', {
          conversationId: String(conversation._id),
          userId: String(userId),
          lastDeliveredSeq,
          peerId: null,
          notifyPeer: false,
        });
        await emitGroupReceipts(updated);
      } else if (lastDeliveredSeq > before) {
        const peerId = String(peerOf(conversation, userId));
        const relationship = (await loadRelationships(userId, [peerId])).get(peerId);
        events.emit('delivered', {
          conversationId: String(conversation._id),
          userId: String(userId),
          lastDeliveredSeq,
          peerId,
          notifyPeer: !relationship.blockedByViewer && !relationship.blockedByTarget,
        });
      }
      return { conversationId: String(conversation._id), lastDeliveredSeq };
    },

    /**
     * The recipient has read every message up to `seq`. Rejected (NOT_DELIVERED) when `seq` is
     * past their delivery position; the check and the update are one atomic operation.
     */
    async markRead(userId, conversationId, seq) {
      const conversation = await loadMembership(userId, conversationId);
      const before = memberOf(conversation, userId).lastReadSeq;
      const updated = await Conversation.findOneAndUpdate(
        {
          _id: conversation._id,
          members: { $elemMatch: { user: userId, lastDeliveredSeq: { $gte: seq } } },
        },
        // Reading also clears your "marked as unread".
        { $max: { 'members.$.lastReadSeq': seq }, $set: { 'members.$.markedUnread': false } },
        { returnDocument: 'after' },
      ).lean();
      if (!updated) {
        throw new AppError(
          409,
          'NOT_DELIVERED',
          'Messages must be delivered before they can be marked as read.',
        );
      }
      const lastReadSeq = memberOf(updated, userId).lastReadSeq;
      const unreadCount = await Message.countDocuments(
        unreadFilter(conversation, userId, lastReadSeq),
      );
      if (lastReadSeq > before) {
        await notifications?.conversationRead(userId, conversation._id, lastReadSeq);
      }
      if (lastReadSeq > before && conversation.type === 'group') {
        events.emit('read', {
          conversationId: String(conversation._id),
          userId: String(userId),
          lastReadSeq,
          unreadCount,
          peerId: null,
          notifyPeer: false,
        });
        await emitGroupReceipts(updated);
      } else if (lastReadSeq > before) {
        const peerId = String(peerOf(conversation, userId));
        const [{ peer, relationship }, reader] = await Promise.all([
          messagingCheck(userId, peerId),
          User.findById(userId, { privacy: 1 }).lean(),
        ]);
        events.emit('read', {
          conversationId: String(conversation._id),
          userId: String(userId),
          lastReadSeq,
          unreadCount,
          peerId,
          notifyPeer:
            !relationship.blockedByViewer &&
            !relationship.blockedByTarget &&
            readReceiptsAllowed(reader ?? {}, peer ?? {}),
        });
      }
      return { conversationId: String(conversation._id), lastReadSeq, unreadCount };
    },

    /** Missed messages after `afterSeq` plus a fresh summary (unread counts, receipts). */
    async sync(userId, conversationId, { afterSeq, limit = SYNC_PAGE_DEFAULT, changesSince }) {
      const serverTime = new Date();
      const conversation = await loadMembership(userId, conversationId);
      const { messages, hasMore } = await messagesAfter(conversation._id, afterSeq, limit, userId);
      let changes = [];
      if (changesSince) {
        // Messages already known (seq <= afterSeq) that were edited, deleted, reacted to, or
        // whose private flags changed. Overlapping the window is harmless: clients keep the
        // highest `rev`.
        const since = new Date(new Date(changesSince).getTime() - CHANGES_OVERLAP_MS);
        const [changed, flags] = await Promise.all([
          Message.find({
            conversation: conversation._id,
            updatedAt: { $gte: since },
            seq: { $lte: afterSeq },
          })
            .limit(CHANGES_LIMIT)
            .lean(),
          MessageFlag.find(
            { user: userId, conversation: conversation._id, updatedAt: { $gte: since } },
            { message: 1 },
          )
            .limit(CHANGES_LIMIT)
            .lean(),
        ]);
        const known = new Set(changed.map((message) => String(message._id)));
        const flagged = flags.map((flag) => flag.message).filter((id) => !known.has(String(id)));
        const extra = flagged.length
          ? await Message.find({ _id: { $in: flagged }, seq: { $lte: afterSeq } }).lean()
          : [];
        changes = await buildMessageDtos([...changed, ...extra], userId);
      }
      return {
        messages,
        hasMore,
        conversation: await summarizeOne(userId, conversation),
        changes,
        serverTime: serverTime.toISOString(),
      };
    },

    /**
     * The conversation and peer for an upload, if `userId` may send messages there right now.
     */
    async requireSendAccess(userId, conversationId) {
      const conversation = await loadMembership(userId, conversationId);
      await requireCanPost(userId, conversation);
      return conversation;
    },

    /**
     * Who may see `userId` typing: the other participant, or the other group members, as far as
     * typing-indicator settings allow both ways (and, in groups, nobody in a block with them).
     * Throws when the user may not post at all.
     *
     * @returns {Promise<{ recipients: string[], conversationId: string, visible: boolean }>}
     */
    async authorizeTyping(userId, conversationId) {
      const conversation = await loadMembership(userId, conversationId);
      await requireCanPost(userId, conversation);
      const others = conversation.participants.map(String).filter((id) => id !== String(userId));
      const [typist, users, relationships] = await Promise.all([
        User.findById(userId, { privacy: 1 }).lean(),
        User.find({ _id: { $in: others } }, { privacy: 1 }).lean(),
        loadRelationships(userId, others),
      ]);
      const recipients = users
        .filter((user) => typingIndicatorsAllowed(typist ?? {}, user))
        .map((user) => String(user._id))
        .filter((id) => {
          const relationship = relationships.get(id);
          return !relationship?.blockedByViewer && !relationship?.blockedByTarget;
        });
      return {
        recipients,
        conversationId: String(conversation._id),
        visible: recipients.length > 0,
      };
    },

    /**
     * Who should hear that `userId` came online or went offline (their current state is read
     * from the presence tracker): the other participant of each of their conversations, as far
     * as the user's privacy settings and blocks allow.
     *
     * @returns {Promise<{ peerId: string, payload: { userId: string, online: boolean | null, lastSeenAt: string | null } }[]>}
     */
    async presenceAudience(userId) {
      const [user, conversations] = await Promise.all([
        User.findById(userId, { privacy: 1, status: 1, lastSeenAt: 1 }).lean(),
        // Presence is shared in one-to-one chats only, never with whole groups.
        Conversation.find(
          { participants: userId, type: { $ne: 'group' } },
          { participants: 1 },
        ).lean(),
      ]);
      if (!user || !VISIBLE_ACCOUNT_STATUSES.includes(user.status)) return [];
      const peerIds = conversations.map((conversation) => String(peerOf(conversation, userId)));
      const relationships = await loadRelationships(userId, peerIds);
      const privacy = privacyOf(user);
      // Read after the queries, so a quick disconnect + reconnect never publishes a stale state.
      const online = presence.isOnline(String(userId));
      const audience = [];
      for (const peerId of new Set(peerIds)) {
        const relationship = relationships.get(peerId);
        const showOnline = audienceIncludes(privacy.onlineStatusVisibility, relationship);
        const showLastSeen = audienceIncludes(privacy.lastSeenVisibility, relationship);
        if (!showOnline && !showLastSeen) continue;
        audience.push({
          peerId,
          payload: {
            userId: String(userId),
            online: showOnline ? online : null,
            lastSeenAt:
              showLastSeen && !online && user.lastSeenAt ? user.lastSeenAt.toISOString() : null,
          },
        });
      }
      return audience;
    },
  };
}
