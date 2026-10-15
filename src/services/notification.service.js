import { EventEmitter } from 'node:events';
import { DEFAULT_NOTIFICATION_PREFERENCES, NOTIFICATION_CATEGORY_BY_TYPE } from '#shared';
import mongoose, { isValidObjectId } from 'mongoose';
import { BlockedUser } from '../models/blocked-user.model.js';
import { Conversation } from '../models/conversation.model.js';
import { Notification } from '../models/notification.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { pairKey } from '../utils/pair-key.js';
import { VISIBLE_ACCOUNT_STATUSES } from './policy.js';
import { PUBLIC_USER_FIELDS, toUserCard } from './user-dto.js';

const asId = (id) => new mongoose.Types.ObjectId(String(id));
const unique = (values) => [...new Set(values.filter(Boolean).map(String))];
const notFound = () => new AppError(404, 'NOT_FOUND', 'Notification not found.');

/** Types removed when two people block each other (they may not reach each other any more). */
const PAIR_TYPES = Object.keys(NOTIFICATION_CATEGORY_BY_TYPE).filter(
  (type) => NOTIFICATION_CATEGORY_BY_TYPE[type] === 'requests',
);

/** Older accounts have no stored preferences: every category on, desktop alerts off. */
export function notificationPreferencesOf(user) {
  return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...(user?.notificationPreferences ?? {}) };
}

function encodeCursor(notification) {
  return Buffer.from(
    `${notification.activityAt.getTime()}:${String(notification._id)}`,
    'utf8',
  ).toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  const [time, id] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
  if (!/^\d{1,15}$/.test(time ?? '') || !isValidObjectId(id)) {
    throw AppError.badRequest('Invalid cursor');
  }
  return { activityAt: new Date(Number(time)), id: asId(id) };
}

/** MongoDB bulk errors that are only duplicate keys: a guarded upsert found nothing to change. */
function onlyDuplicateKeys(error) {
  const writeErrors = error?.writeErrors ? [].concat(error.writeErrors) : [];
  return writeErrors.length > 0 && writeErrors.every((writeError) => writeError.code === 11000);
}

/**
 * Notifications: created by other services when something happens to someone, stored first,
 * then announced. Rules:
 * - the recipient is always decided here from the event, never by a client;
 * - nobody is notified about their own actions;
 * - no notification for accounts that can't sign in (suspended, banned, deactivated, deleted),
 *   or when the recipient switched notifications or that category off;
 * - messages: not from a muted chat, and not from someone in a block with the recipient;
 * - requests: never between people in a block (blocking removes the pair's request entries);
 * - creating one never fails the action that caused it (failures are logged).
 *
 * Domain events (for the real-time layer, which sends them to the recipient's own tabs only):
 * - "upsert"      { userId, notification, unreadCount }
 * - "read"        { userId, ids: string[] | null, before?: string, unreadCount }
 * - "removed"     { userId, ids: string[], unreadCount }
 * - "preferences" { userId, preferences }
 *
 * @param {{ logger: import('../utils/logger.js').Logger }} deps
 */
export function createNotificationService({ logger }) {
  const events = new EventEmitter();

  async function unreadCounts(userIds) {
    const ids = unique(userIds);
    const rows = await Notification.aggregate([
      { $match: { recipient: { $in: ids.map(asId) }, readAt: null } },
      { $group: { _id: '$recipient', count: { $sum: 1 } } },
    ]);
    const counts = new Map(ids.map((id) => [id, 0]));
    for (const row of rows) counts.set(String(row._id), row.count);
    return counts;
  }

  /**
   * Notification DTOs (see notificationSchema in #shared) for any mix of recipients,
   * with a fixed number of queries. Access is decided now, not when the entry was created:
   * a conversation or group you're no longer in is "not available", and the actor is hidden
   * while either of you blocks the other or their account isn't visible.
   */
  async function toDtos(docs) {
    if (docs.length === 0) return [];
    const actorIds = unique(docs.map((doc) => doc.actor));
    const recipientIds = unique(docs.map((doc) => doc.recipient));
    const conversationIds = unique(docs.map((doc) => doc.conversation));
    const [actors, conversations, blocks] = await Promise.all([
      actorIds.length ? User.find({ _id: { $in: actorIds } }, PUBLIC_USER_FIELDS).lean() : [],
      conversationIds.length
        ? Conversation.find(
            { _id: { $in: conversationIds } },
            { type: 1, participants: 1, 'group.name': 1, 'group.deletedAt': 1 },
          ).lean()
        : [],
      actorIds.length
        ? BlockedUser.find(
            {
              $or: [
                { blocker: { $in: recipientIds }, blocked: { $in: actorIds } },
                { blocker: { $in: actorIds }, blocked: { $in: recipientIds } },
              ],
            },
            { blocker: 1, blocked: 1 },
          ).lean()
        : [],
    ]);
    const actorsById = new Map(actors.map((user) => [String(user._id), user]));
    const conversationsById = new Map(conversations.map((c) => [String(c._id), c]));
    const blockedPairs = new Set(
      blocks.flatMap((block) => [
        `${block.blocker}:${block.blocked}`,
        `${block.blocked}:${block.blocker}`,
      ]),
    );

    return docs.map((doc) => {
      const recipient = String(doc.recipient);
      const actor = doc.actor ? actorsById.get(String(doc.actor)) : null;
      const showActor =
        actor &&
        VISIBLE_ACCOUNT_STATUSES.includes(actor.status) &&
        !blockedPairs.has(`${recipient}:${String(doc.actor)}`);
      const conversation = doc.conversation
        ? conversationsById.get(String(doc.conversation))
        : null;
      const isMember = Boolean(
        conversation &&
        !conversation.group?.deletedAt &&
        conversation.participants.some((id) => String(id) === recipient),
      );
      const conversationId = conversation ? String(conversation._id) : null;

      let link = null;
      let available = true;
      switch (doc.type) {
        case 'message_received':
        case 'call_missed':
          available = isMember;
          link = isMember ? `/chats/${conversationId}` : null;
          break;
        case 'message_request_received':
          link = '/requests';
          break;
        case 'message_request_accepted':
          available = Boolean(showActor);
          link = showActor ? `/users/${actor.username}` : null;
          break;
        case 'group_member_added':
        case 'group_role_changed':
        case 'group_invite_used':
          available = isMember;
          link = isMember ? `/groups/${conversationId}` : null;
          break;
        default:
          // Removed from a group, group deleted: nothing left to open.
          break;
      }

      return {
        id: String(doc._id),
        type: doc.type,
        read: Boolean(doc.readAt),
        createdAt: doc.activityAt.toISOString(),
        count: doc.count ?? 1,
        actor: showActor ? toUserCard(actor) : null,
        conversationId: available ? conversationId : null,
        conversationType: conversation?.type ?? null,
        // A current member sees today's name; otherwise the name from when it happened.
        groupName:
          conversation?.type === 'group' && isMember
            ? conversation.group.name
            : (doc.groupName ?? null),
        role: doc.role ?? null,
        callType: doc.callType ?? null,
        link,
        available,
      };
    });
  }

  /**
   * Who of `recipientIds` gets a `category` notification caused by `actorId`: visible accounts
   * (not the actor) with notifications and the category on; with `respectBlocks`, nobody in a
   * block with the actor.
   */
  async function eligible(category, recipientIds, actorId, { respectBlocks = true } = {}) {
    const ids = unique(recipientIds).filter((id) => id !== String(actorId ?? ''));
    if (ids.length === 0) return [];
    const users = await User.find(
      { _id: { $in: ids }, status: { $in: VISIBLE_ACCOUNT_STATUSES } },
      { notificationPreferences: 1 },
    ).lean();
    let allowed = users
      .filter((user) => {
        const preferences = notificationPreferencesOf(user);
        return preferences.enabled && preferences[category];
      })
      .map((user) => String(user._id));
    if (respectBlocks && actorId && allowed.length > 0) {
      const blocks = await BlockedUser.find(
        {
          $or: [
            { blocker: actorId, blocked: { $in: allowed } },
            { blocker: { $in: allowed }, blocked: actorId },
          ],
        },
        { blocker: 1, blocked: 1 },
      ).lean();
      const blocked = new Set(
        blocks.map((block) =>
          String(block.blocker) === String(actorId) ? String(block.blocked) : String(block.blocker),
        ),
      );
      allowed = allowed.filter((id) => !blocked.has(id));
    }
    return allowed;
  }

  /**
   * Stores notifications (one guarded upsert each, in one unordered bulk write), then announces
   * the ones that changed. Each item:
   * { recipient, type, dedupeKey, eventId, actor?, conversation?, request?, groupName?, role?,
   *   seq? (new messages: counted once per seq) }.
   */
  async function deliver(items) {
    if (items.length === 0) return;
    const now = new Date();
    // Every value goes through $literal: a group name such as "$x" must stay text.
    const literal = (value) => ({ $literal: value });
    const operations = items.map((item) => {
      const counted = item.seq !== undefined;
      return {
        updateOne: {
          filter: {
            recipient: asId(item.recipient),
            dedupeKey: item.dedupeKey,
            // Already applied (or an older message): the filter misses, the upsert's insert
            // hits the unique index, and nothing changes.
            ...(counted
              ? { lastSeq: { $not: { $gte: item.seq } } }
              : { eventId: { $ne: item.eventId } }),
          },
          update: [
            {
              $set: {
                type: literal(item.type),
                eventId: literal(item.eventId),
                actor: literal(item.actor ? asId(item.actor) : null),
                conversation: literal(item.conversation ? asId(item.conversation) : null),
                request: literal(item.request ? asId(item.request) : null),
                groupName: literal(item.groupName ?? null),
                role: literal(item.role ?? null),
                callType: literal(item.callType ?? null),
                // Unread: one more message. Already read: a fresh count.
                count: counted
                  ? {
                      $cond: [
                        { $eq: [{ $ifNull: ['$readAt', null] }, null] },
                        { $add: [{ $ifNull: ['$count', 0] }, 1] },
                        1,
                      ],
                    }
                  : 1,
                lastSeq: counted ? literal(item.seq) : { $ifNull: ['$lastSeq', 0] },
                readAt: null,
                activityAt: literal(now),
                createdAt: { $ifNull: ['$createdAt', literal(now)] },
                updatedAt: literal(now),
              },
            },
          ],
          upsert: true,
        },
      };
    });
    try {
      await Notification.collection.bulkWrite(operations, { ordered: false });
    } catch (error) {
      if (!onlyDuplicateKeys(error)) throw error;
    }

    // Only entries this call changed (an event already applied is not announced again).
    const changed = await Notification.find({
      $or: items.map((item) => ({
        recipient: asId(item.recipient),
        dedupeKey: item.dedupeKey,
        eventId: item.eventId,
        updatedAt: now,
      })),
    }).lean();
    if (changed.length === 0) return;
    const [dtos, counts] = await Promise.all([
      toDtos(changed),
      unreadCounts(changed.map((doc) => doc.recipient)),
    ]);
    for (const notification of dtos) {
      const userId = String(changed.find((doc) => String(doc._id) === notification.id).recipient);
      events.emit('upsert', { userId, notification, unreadCount: counts.get(userId) ?? 0 });
    }
  }

  /** Runs a notification side effect; failures are logged and never reach the caller. */
  async function safely(what, run) {
    try {
      await run();
    } catch (error) {
      logger.warn(`Could not ${what}`, { error });
    }
  }

  async function markReadWhere(userId, filter) {
    const before = await Notification.find(
      { ...filter, recipient: asId(userId), readAt: null },
      { _id: 1 },
    ).lean();
    if (before.length === 0) return;
    const ids = before.map((doc) => doc._id);
    await Notification.updateMany(
      { _id: { $in: ids }, readAt: null },
      { $set: { readAt: new Date() } },
    );
    const counts = await unreadCounts([userId]);
    events.emit('read', {
      userId: String(userId),
      ids: ids.map(String),
      unreadCount: counts.get(String(userId)) ?? 0,
    });
  }

  async function removeWhere(filter) {
    const docs = await Notification.find(filter, { _id: 1, recipient: 1 }).lean();
    if (docs.length === 0) return;
    await Notification.deleteMany({ _id: { $in: docs.map((doc) => doc._id) } });
    const counts = await unreadCounts(docs.map((doc) => doc.recipient));
    for (const userId of unique(docs.map((doc) => doc.recipient))) {
      events.emit('removed', {
        userId,
        ids: docs.filter((doc) => String(doc.recipient) === userId).map((doc) => String(doc._id)),
        unreadCount: counts.get(userId) ?? 0,
      });
    }
  }

  const groupItem = (group, fields) => ({
    conversation: group._id,
    groupName: group.group?.name ?? null,
    ...fields,
  });

  return {
    events,

    // ── Producers (called by other services) ──────────────────────────────

    /**
     * A message was stored (or a retried send replayed it). `conversation` is the conversation
     * as loaded for the send. One entry per chat per person, counting new messages.
     */
    messageSent(conversation, message) {
      return safely('notify about a message', async () => {
        if ((message.type ?? 'text') === 'system') return;
        const now = new Date();
        const listening = conversation.members
          .filter((member) => String(member.user) !== String(message.sender))
          .filter((member) => !(member.mutedUntil && member.mutedUntil > now))
          .map((member) => member.user);
        const current = listening.filter((id) =>
          conversation.participants.some((participant) => String(participant) === String(id)),
        );
        const recipients = await eligible('messages', current, message.sender);
        await deliver(
          recipients.map((recipient) => ({
            recipient,
            type: 'message_received',
            dedupeKey: `conversation:${conversation._id}`,
            eventId: String(message._id),
            seq: message.seq,
            actor: message.sender,
            conversation: conversation._id,
            groupName: conversation.type === 'group' ? conversation.group?.name : null,
          })),
        );
      });
    },

    /** Your conversation is read up to `lastReadSeq`: its message entry is read too. */
    conversationRead(userId, conversationId, lastReadSeq) {
      return safely('mark a conversation notification read', () =>
        markReadWhere(userId, {
          dedupeKey: `conversation:${conversationId}`,
          lastSeq: { $lte: lastReadSeq },
        }),
      );
    },

    requestReceived(request) {
      return safely('notify about a message request', async () => {
        const [recipient] = await eligible('requests', [request.recipient], request.sender);
        if (!recipient) return;
        await deliver([
          {
            recipient,
            type: 'message_request_received',
            dedupeKey: `request:${request._id}:received`,
            eventId: String(request._id),
            actor: request.sender,
            request: request._id,
          },
        ]);
      });
    },

    /** Accepted: the sender hears about it; the recipient's own entry is done (read). */
    requestAccepted(request) {
      return safely('notify about an accepted request', async () => {
        await markReadWhere(request.recipient, { dedupeKey: `request:${request._id}:received` });
        const [recipient] = await eligible('requests', [request.sender], request.recipient);
        if (!recipient) return;
        await deliver([
          {
            recipient,
            type: 'message_request_accepted',
            dedupeKey: `request:${request._id}:accepted`,
            eventId: String(request._id),
            actor: request.recipient,
            request: request._id,
          },
        ]);
      });
    },

    /** Rejected: the sender isn't told (see Phase 5); the recipient's entry is done. */
    requestRejected(request) {
      return safely('update a rejected request notification', () =>
        markReadWhere(request.recipient, { dedupeKey: `request:${request._id}:received` }),
      );
    },

    /** Cancelled by its sender: the request no longer exists for the recipient. */
    requestCancelled(request) {
      return safely('remove a cancelled request notification', () =>
        removeWhere({
          recipient: request.recipient,
          dedupeKey: `request:${request._id}:received`,
        }),
      );
    },

    /**
     * A block: the two can't reach each other, so their request entries and their one-to-one
     * chat entries are removed for both. Group entries stay; the actor is hidden from then on.
     */
    pairBlocked(a, b) {
      return safely('remove notifications after a block', async () => {
        const direct = await Conversation.findOne({ pairKey: pairKey(a, b) }, { _id: 1 }).lean();
        const pair = [
          { recipient: asId(a), actor: asId(b) },
          { recipient: asId(b), actor: asId(a) },
        ];
        await removeWhere({
          $or: pair.flatMap((sides) => [
            { ...sides, type: { $in: PAIR_TYPES } },
            ...(direct ? [{ ...sides, conversation: direct._id }] : []),
          ]),
        });
      });
    },

    /**
     * Your membership of a group changed: added (created with you, added, eventId "created" or
     * the system message id), removed, or the group was deleted. One entry per group showing the
     * latest change. `actorId` null hides who did it (a moderator removing a group).
     */
    groupMembership(group, { type, actorId, recipientIds, eventId }) {
      return safely('notify about a group membership change', async () => {
        const recipients = await eligible('groups', recipientIds, actorId, {
          respectBlocks: false,
        });
        await deliver(
          recipients.map((recipient) =>
            groupItem(group, {
              recipient,
              type,
              dedupeKey: `group:${group._id}:membership`,
              eventId: String(eventId),
              actor: actorId,
            }),
          ),
        );
      });
    },

    /** Your role in a group changed (made admin, member again, or the new owner). */
    groupRoleChanged(group, { actorId, targetId, role }) {
      return safely('notify about a group role change', async () => {
        const [recipient] = await eligible('groups', [targetId], actorId, {
          respectBlocks: false,
        });
        if (!recipient) return;
        await deliver([
          groupItem(group, {
            recipient,
            type: 'group_role_changed',
            dedupeKey: `group:${group._id}:role`,
            eventId: `role:${role}`,
            actor: actorId,
            role,
          }),
        ]);
      });
    },

    /** Someone joined with an invitation you created (while you're still a member). */
    groupInviteUsed(group, { inviterId, joinerId, eventId }) {
      return safely('notify about a used invitation', async () => {
        const stillMember = group.participants.some((id) => String(id) === String(inviterId));
        if (!stillMember) return;
        const [recipient] = await eligible('groups', [inviterId], joinerId);
        if (!recipient) return;
        await deliver([
          groupItem(group, {
            recipient,
            type: 'group_invite_used',
            dedupeKey: `group:${group._id}:joined:${joinerId}`,
            eventId: String(eventId),
            actor: joinerId,
          }),
        ]);
      });
    },

    /**
     * A call to `call.callee` went unanswered (no answer, busy, or the caller hung up first).
     * One entry per call (dedupeKey + eventId = the call id), so repeating it changes nothing.
     */
    callMissed(call) {
      return safely('notify about a missed call', async () => {
        const [recipient] = await eligible('calls', [call.callee], call.caller);
        if (!recipient) return;
        await deliver([
          {
            recipient,
            type: 'call_missed',
            dedupeKey: `call:${call._id}`,
            eventId: String(call._id),
            actor: call.caller,
            conversation: call.conversation,
            callType: call.type,
          },
        ]);
      });
    },

    // ── The signed-in user's own notifications (HTTP) ─────────────────────

    async list(userId, { filter = 'all', cursor, limit }) {
      const after = decodeCursor(cursor);
      const rows = await Notification.find({
        recipient: asId(userId),
        ...(filter === 'unread' ? { readAt: null } : {}),
        ...(after
          ? {
              $or: [
                { activityAt: { $lt: after.activityAt } },
                { activityAt: after.activityAt, _id: { $lt: after.id } },
              ],
            }
          : {}),
      })
        .sort({ activityAt: -1, _id: -1 })
        .limit(limit + 1)
        .lean();
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return {
        data: await toDtos(page),
        meta: { limit, hasMore, nextCursor: hasMore ? encodeCursor(page.at(-1)) : null },
      };
    },

    async unreadCount(userId) {
      return { unread: (await unreadCounts([userId])).get(String(userId)) ?? 0 };
    },

    /** Marks one of your notifications read (idempotent). Other people's look like missing. */
    async markRead(userId, notificationId) {
      if (!isValidObjectId(notificationId)) throw notFound();
      const doc = await Notification.findOne({ _id: notificationId, recipient: asId(userId) });
      if (!doc) throw notFound();
      if (!doc.readAt) await markReadWhere(userId, { _id: doc._id });
      const fresh = await Notification.findById(doc._id).lean();
      const [notification] = await toDtos([fresh]);
      return { notification, ...(await this.unreadCount(userId)) };
    },

    /**
     * Marks everything up to now read. A notification arriving at the same moment keeps its
     * unread state (`before` tells other tabs exactly what was covered).
     */
    async markAllRead(userId) {
      const before = new Date();
      const result = await Notification.updateMany(
        { recipient: asId(userId), readAt: null, activityAt: { $lte: before } },
        { $set: { readAt: before } },
      );
      const { unread } = await this.unreadCount(userId);
      if (result.modifiedCount > 0) {
        events.emit('read', {
          userId: String(userId),
          ids: null,
          before: before.toISOString(),
          unreadCount: unread,
        });
      }
      return { unread, before: before.toISOString() };
    },

    /** Removes one of your notifications. */
    async dismiss(userId, notificationId) {
      if (!isValidObjectId(notificationId)) throw notFound();
      const exists = await Notification.exists({ _id: notificationId, recipient: asId(userId) });
      if (!exists) throw notFound();
      await removeWhere({ _id: asId(notificationId), recipient: asId(userId) });
    },

    async getPreferences(userId) {
      const user = await User.findById(userId, { notificationPreferences: 1 }).lean();
      return notificationPreferencesOf(user);
    },

    async updatePreferences(userId, changes) {
      const set = Object.fromEntries(
        Object.entries(changes).map(([key, value]) => [`notificationPreferences.${key}`, value]),
      );
      const user = await User.findOneAndUpdate(
        { _id: userId },
        { $set: set },
        { returnDocument: 'after', projection: { notificationPreferences: 1 } },
      ).lean();
      const preferences = notificationPreferencesOf(user);
      events.emit('preferences', { userId: String(userId), preferences });
      return preferences;
    },
  };
}
