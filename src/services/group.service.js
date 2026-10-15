import { randomInt } from 'node:crypto';
import { API_PREFIX, INVITE_CODE_ALPHABET, LIMITS } from '#shared';
import mongoose, { isValidObjectId } from 'mongoose';
import { Conversation } from '../models/conversation.model.js';
import { GroupInvite } from '../models/group-invite.model.js';
import { Message } from '../models/message.model.js';
import { Poll, PollVote } from '../models/poll.model.js';
import { User } from '../models/user.model.js';
import { generateToken, hashToken } from '../security/tokens.js';
import { AppError } from '../utils/app-error.js';
import { processAvatarImage } from './avatar-image.js';
import { loadPolls } from './message-dto.js';
import {
  isBlockedEitherWay,
  loadRelationships,
  messagingUnavailableReason,
  VISIBLE_ACCOUNT_STATUSES,
} from './policy.js';
import { PUBLIC_USER_FIELDS, toUserCard } from './user-dto.js';

const ADMINS = ['owner', 'admin'];

const groupNotFound = () => new AppError(404, 'NOT_FOUND', 'Group not found.');
const forbidden = (message) => new AppError(403, 'FORBIDDEN', message);
const inviteError = {
  invalid: () => new AppError(404, 'INVITE_INVALID', 'This invitation is not valid.'),
  revoked: () => new AppError(410, 'INVITE_REVOKED', 'This invitation was revoked.'),
  expired: () => new AppError(410, 'INVITE_EXPIRED', 'This invitation has expired.'),
  exhausted: () =>
    new AppError(410, 'INVITE_EXHAUSTED', 'This invitation has reached its usage limit.'),
};

const asId = (id) => new mongoose.Types.ObjectId(String(id));
const memberOf = (conversation, userId) =>
  conversation.members.find((member) => String(member.user) === String(userId));
const roleOf = (conversation, userId) => memberOf(conversation, userId)?.role ?? null;

/** "ABCDEFGH" → "ABCD-EFGH". */
const formatCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

function newInviteCode() {
  let code = '';
  for (let i = 0; i < 8; i++) code += INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)];
  return code;
}

function inviteState(invite, now = new Date()) {
  if (invite.revokedAt) return 'revoked';
  if (invite.expiresAt <= now) return 'expired';
  if (invite.maxUses !== null && invite.uses >= invite.maxUses) return 'exhausted';
  return 'active';
}

function toInviteDto(invite) {
  const state = inviteState(invite);
  return {
    id: String(invite._id),
    createdBy: String(invite.createdBy),
    createdAt: invite.createdAt.toISOString(),
    expiresAt: invite.expiresAt.toISOString(),
    maxUses: invite.maxUses ?? null,
    uses: invite.uses,
    revoked: Boolean(invite.revokedAt),
    state,
  };
}

const avatarUrlOf = (group) =>
  group.avatar?.key ? `${API_PREFIX}/avatars/${group.avatar.key}` : null;

/**
 * Groups: lifecycle, membership and roles, invitations and polls. Group messages themselves go
 * through the messaging service (a group is a conversation of type "group").
 *
 * Invariants, each kept by a single conditional update on the conversation document:
 * - exactly one owner (ownership moves only by an atomic transfer; the owner can't leave or be
 *   removed while others remain);
 * - at most LIMITS.groupMaxMembers members, never the same person twice;
 * - the actor's role is part of every role-changing update's filter, so a concurrent demotion
 *   can't be bypassed.
 *
 * History rule: access is current membership. People who leave or are removed lose access to
 * the group, its history and its files at once and receive nothing further; if they're added
 * again they see the history again.
 *
 * Notifications (when `notifications` is given) go to the person affected: added, removed, new
 * role, group deleted, and to an invitation's creator when someone joins with it.
 *
 * @param {{ messaging: ReturnType<typeof import('./messaging.service.js').createMessagingService>, attachments: ReturnType<typeof import('./attachment.service.js').createAttachmentService>, storage: import('./storage.js').FileStorage, logger: import('../utils/logger.js').Logger, notifications?: ReturnType<typeof import('./notification.service.js').createNotificationService> }} deps
 */
export function createGroupService({
  messaging,
  attachments,
  storage,
  logger,
  settings,
  notifications,
}) {
  /** The current member limit (a platform setting, never above LIMITS.groupMaxMembers). */
  async function maxMembers() {
    const value = settings ? (await settings.get()).groupMaxMembers : LIMITS.groupMaxMembers;
    return Math.min(value, LIMITS.groupMaxMembers);
  }

  /** Suspended groups are read-only for their members (a moderator's decision). */
  function requireNotSuspended(group) {
    if (group.group?.suspendedAt) {
      throw new AppError(403, 'FORBIDDEN', 'This group is suspended by a moderator.');
    }
  }

  /** The live group, if `userId` is a member (non-members get 404, like a missing group). */
  async function loadGroup(userId, groupId) {
    if (!isValidObjectId(groupId)) throw groupNotFound();
    const group = await Conversation.findOne({
      _id: groupId,
      type: 'group',
      participants: userId,
      'group.deletedAt': null,
    }).lean();
    if (!group) throw groupNotFound();
    return group;
  }

  function requireRole(group, userId, roles, message) {
    if (!roles.includes(roleOf(group, userId))) throw forbidden(message);
  }

  async function details(userId, groupId) {
    const group = await loadGroup(userId, groupId);
    const users = await User.find({ _id: { $in: group.participants } }, PUBLIC_USER_FIELDS).lean();
    const byId = new Map(users.map((user) => [String(user._id), user]));
    const order = { owner: 0, admin: 1, member: 2 };
    const members = group.members
      .filter((member) => group.participants.some((id) => id.equals(member.user)))
      .map((member) => ({
        user: toUserCard(
          byId.get(String(member.user)) ?? { _id: member.user, displayName: 'Deleted user' },
        ),
        role: member.role ?? 'member',
        joinedAt: (member.joinedAt ?? group.createdAt).toISOString(),
      }))
      .sort(
        (a, b) =>
          order[a.role] - order[b.role] || a.user.displayName.localeCompare(b.user.displayName),
      );
    return {
      id: String(group._id),
      name: group.group.name,
      description: group.group.description ?? '',
      avatarUrl: avatarUrlOf(group.group),
      memberCount: group.participants.length,
      myRole: roleOf(group, userId) ?? 'member',
      suspended: Boolean(group.group.suspendedAt),
      createdAt: group.createdAt.toISOString(),
      members,
    };
  }

  /**
   * People the actor may add: visible accounts they are connected with and not blocked with
   * (the Phase 5 messaging rules), so a group can't be used to reach someone otherwise.
   */
  async function requireAddable(actorId, userIds) {
    const ids = userIds.map(String).filter((id) => id !== String(actorId));
    if (ids.length === 0) return [];
    const [users, relationships] = await Promise.all([
      User.find({ _id: { $in: ids } }, { status: 1 }).lean(),
      loadRelationships(actorId, ids),
    ]);
    const byId = new Map(users.map((user) => [String(user._id), user]));
    for (const id of ids) {
      const reason = messagingUnavailableReason(byId.get(id) ?? null, relationships.get(id));
      if (reason) {
        throw forbidden('You can only add people you are connected with and can message.');
      }
    }
    return ids;
  }

  function newMember(userId, role, seq, now) {
    return {
      user: asId(userId),
      role,
      joinedAt: now,
      lastDeliveredSeq: seq,
      lastReadSeq: seq,
      lastReceivedSeq: seq,
    };
  }

  /** Adds one person if there's room and they aren't in yet (atomic). True when added. */
  async function addMember(groupId, userId) {
    const limit = await maxMembers();
    const seq = await messaging.latestSeq(groupId);
    const result = await Conversation.updateOne(
      {
        _id: groupId,
        type: 'group',
        'group.deletedAt': null,
        participants: { $ne: asId(userId) },
        'group.suspendedAt': null,
        [`participants.${limit - 1}`]: { $exists: false },
      },
      {
        $push: {
          participants: asId(userId),
          members: newMember(userId, 'member', seq, new Date()),
        },
      },
    );
    return result.modifiedCount === 1;
  }

  async function dropFromPinned(userId, groupId) {
    await User.updateOne({ _id: userId }, { $pull: { pinnedChats: asId(groupId) } });
  }

  /** Deletes the group for everyone: no members remain, invitations stop, files are released. */
  /** asAdmin: removal by a moderator (no owner check). */
  async function destroy(group, actorId, { asAdmin = false } = {}) {
    const former = group.participants.map(String);
    const deleted = await Conversation.updateOne(
      {
        _id: group._id,
        'group.deletedAt': null,
        ...(asAdmin ? {} : { members: { $elemMatch: { user: actorId, role: 'owner' } } }),
      },
      { $set: { 'group.deletedAt': new Date(), participants: [], members: [], pins: [] } },
    );
    if (deleted.modifiedCount === 0) throw groupNotFound();
    await GroupInvite.updateMany(
      { conversation: group._id, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedBy: actorId } },
    );
    await User.updateMany({ _id: { $in: former } }, { $pull: { pinnedChats: group._id } });
    messaging.notifyChanged(group._id, former);
    // A moderator's removal doesn't name the moderator.
    await notifications?.groupMembership(group, {
      type: 'group_deleted',
      actorId: asAdmin ? null : actorId,
      recipientIds: former,
      eventId: 'deleted',
    });
    // Files used only by this group's messages are removed (forwards elsewhere keep theirs).
    const used = await Message.distinct('attachment', {
      conversation: group._id,
      attachment: { $ne: null },
    });
    for (const attachmentId of used) await attachments.requestCleanup(attachmentId);
    await Message.updateMany(
      { conversation: group._id, attachment: { $ne: null } },
      { $set: { attachment: null } },
    );
    for (const attachmentId of used) {
      await attachments.releaseIfUnused(attachmentId).catch((error) => {
        logger.warn('Group attachment cleanup failed; the reaper will retry', { error });
      });
    }
    if (group.group.avatar?.key)
      await storage.remove(group.group.avatar.key).catch(() => undefined);
  }

  /** Finds an invitation by its secret (only hashes are stored). */
  async function findInvite({ token, code }) {
    const filter = token ? { tokenHash: hashToken(token) } : { codeHash: hashToken(code) };
    return GroupInvite.findOne(filter).lean();
  }

  function requireUsableInvite(invite) {
    if (!invite) throw inviteError.invalid();
    const state = inviteState(invite);
    if (state !== 'active') throw inviteError[state]();
  }

  async function publishPoll(group, pollId, messageId) {
    const poll = (await loadPolls([asId(pollId)])).get(String(pollId));
    messaging.events.emit('poll', {
      conversationId: String(group._id),
      messageId: String(messageId),
      poll,
      participants: group.participants.map(String),
    });
  }

  async function pollFor(userId, conversationId, pollId) {
    const group = await loadGroup(userId, conversationId);
    requireNotSuspended(group);
    if (!isValidObjectId(pollId)) throw new AppError(404, 'NOT_FOUND', 'Poll not found.');
    const [poll, message] = await Promise.all([
      Poll.findOne({ _id: pollId, conversation: group._id }).lean(),
      Message.findOne(
        { conversation: group._id, poll: pollId, deletedAt: null },
        { _id: 1 },
      ).lean(),
    ]);
    if (!poll || !message) throw new AppError(404, 'NOT_FOUND', 'Poll not found.');
    return { group, poll, message };
  }

  async function myPoll(pollId, userId) {
    return (await loadPolls([asId(pollId)], userId)).get(String(pollId));
  }

  return {
    // ── Moderation (admin routes check permissions) ──────────────────────

    /** Removes a group as a moderator, exactly like an owner deleting it. */
    async adminRemove(groupId, actorId) {
      const group = await Conversation.findOne({
        _id: groupId,
        type: 'group',
        'group.deletedAt': null,
      }).lean();
      if (!group) throw groupNotFound();
      await destroy(group, asId(actorId), { asAdmin: true });
    },

    /** Tells the members to refresh (e.g. after a suspension changed what they can do). */
    notifyMembers(group) {
      messaging.notifyChanged(group._id, group.participants);
    },

    /**
     * A deleted account leaves every group, following the leaving rules: a sole owner's group is
     * deleted; an owner with other members hands it to the longest-standing admin (or member if
     * there is no admin) in the same atomic update. Otherwise the account would stay a member
     * forever, freezing group read receipts and leaving groups without a working owner.
     */
    async removeDeletedAccount(userId) {
      const groups = await Conversation.find({
        type: 'group',
        participants: asId(userId),
        'group.deletedAt': null,
      }).lean();
      for (const group of groups) {
        try {
          if (group.participants.length === 1) {
            await destroy(group, asId(userId));
            continue;
          }
          let successor = null;
          if (roleOf(group, userId) === 'owner') {
            const byTenure = (a, b) => (a.joinedAt ?? 0) - (b.joinedAt ?? 0);
            const others = group.members.filter((member) => !member.user.equals(userId));
            successor =
              others.filter((member) => member.role === 'admin').sort(byTenure)[0] ??
              others.sort(byTenure)[0];
          }
          const result = await Conversation.updateOne(
            { _id: group._id, participants: asId(userId), 'group.deletedAt': null },
            successor
              ? [
                  {
                    $set: {
                      participants: {
                        $filter: {
                          input: '$participants',
                          cond: { $ne: ['$$this', asId(userId)] },
                        },
                      },
                      members: {
                        $map: {
                          input: {
                            $filter: {
                              input: '$members',
                              cond: { $ne: ['$$this.user', asId(userId)] },
                            },
                          },
                          in: {
                            $cond: [
                              { $eq: ['$$this.user', successor.user] },
                              { $mergeObjects: ['$$this', { role: 'owner' }] },
                              '$$this',
                            ],
                          },
                        },
                      },
                    },
                  },
                ]
              : { $pull: { participants: asId(userId), members: { user: asId(userId) } } },
            successor ? { updatePipeline: true } : {},
          );
          if (result.modifiedCount === 0) continue;
          await messaging.postSystemMessage(group._id, {
            actor: userId,
            kind: 'member_left',
            target: userId,
          });
          if (successor) {
            await messaging.postSystemMessage(group._id, {
              actor: userId,
              kind: 'owner_changed',
              target: successor.user,
            });
            await notifications?.groupRoleChanged(group, {
              actorId: null,
              targetId: successor.user,
              role: 'owner',
            });
          }
          messaging.notifyChanged(group._id, group.participants);
        } catch (error) {
          logger.warn('Could not remove a deleted account from a group', { error });
        }
      }
    },

    // ── Lifecycle ─────────────────────────────────────────────────────────

    /** Creates a group owned by the creator, with the people they may add. */
    async create(userId, { name, description = '', memberIds = [] }) {
      const ids = await requireAddable(userId, memberIds);
      const limit = await maxMembers();
      if (ids.length + 1 > limit) {
        throw new AppError(409, 'GROUP_FULL', `Groups have at most ${limit} members.`);
      }
      const _id = new mongoose.Types.ObjectId();
      const now = new Date();
      await Conversation.create({
        _id,
        type: 'group',
        pairKey: `group:${_id}`,
        participants: [asId(userId), ...ids.map(asId)],
        members: [
          newMember(userId, 'owner', 0, now),
          ...ids.map((id) => newMember(id, 'member', 0, now)),
        ],
        group: { name, description, createdBy: userId },
        lastActivityAt: now,
      });
      await messaging.postSystemMessage(_id, { actor: userId, kind: 'conversation_created', name });
      await notifications?.groupMembership(
        { _id, group: { name } },
        { type: 'group_member_added', actorId: userId, recipientIds: ids, eventId: 'created' },
      );
      return details(userId, _id);
    },

    async list(userId) {
      const groups = await Conversation.find({
        type: 'group',
        participants: userId,
        'group.deletedAt': null,
      })
        .sort({ lastActivityAt: -1 })
        .limit(200)
        .lean();
      return groups.map((group) => ({
        id: String(group._id),
        name: group.group.name,
        description: group.group.description ?? '',
        avatarUrl: avatarUrlOf(group.group),
        memberCount: group.participants.length,
        myRole: roleOf(group, userId) ?? 'member',
        suspended: Boolean(group.group.suspendedAt),
      }));
    },

    details,

    /** Owner and admins edit the name and description. */
    async update(userId, groupId, changes) {
      const group = await loadGroup(userId, groupId);
      requireNotSuspended(group);
      requireRole(group, userId, ADMINS, 'Only group admins can edit the group.');
      const set = {};
      if (changes.name !== undefined) set['group.name'] = changes.name;
      if (changes.description !== undefined) set['group.description'] = changes.description;
      const result = await Conversation.updateOne(
        { _id: group._id, members: { $elemMatch: { user: asId(userId), role: { $in: ADMINS } } } },
        { $set: set },
      );
      if (result.modifiedCount === 0) throw forbidden('Only group admins can edit the group.');
      if (changes.name !== undefined && changes.name !== group.group.name) {
        await messaging.postSystemMessage(group._id, {
          actor: userId,
          kind: 'group_renamed',
          name: changes.name,
        });
      }
      messaging.notifyChanged(group._id, group.participants);
      return details(userId, groupId);
    },

    async setAvatar(userId, groupId, file) {
      const group = await loadGroup(userId, groupId);
      requireNotSuspended(group);
      requireRole(group, userId, ADMINS, 'Only group admins can change the photo.');
      if (!file) throw AppError.badRequest('Choose an image to upload.');
      const image = await processAvatarImage(file);
      const key = `${generateToken(24)}.webp`;
      await storage.put(key, image, { contentType: 'image/webp' });
      const result = await Conversation.updateOne(
        { _id: group._id, members: { $elemMatch: { user: asId(userId), role: { $in: ADMINS } } } },
        { $set: { 'group.avatar': { key, updatedAt: new Date() } } },
      );
      if (result.modifiedCount === 0) {
        await storage.remove(key);
        throw forbidden('Only group admins can change the photo.');
      }
      if (group.group.avatar?.key)
        await storage.remove(group.group.avatar.key).catch(() => undefined);
      messaging.notifyChanged(group._id, group.participants);
      return details(userId, groupId);
    },

    async removeAvatar(userId, groupId) {
      const group = await loadGroup(userId, groupId);
      requireNotSuspended(group);
      requireRole(group, userId, ADMINS, 'Only group admins can change the photo.');
      await Conversation.updateOne({ _id: group._id }, { $set: { 'group.avatar': null } });
      if (group.group.avatar?.key)
        await storage.remove(group.group.avatar.key).catch(() => undefined);
      messaging.notifyChanged(group._id, group.participants);
      return details(userId, groupId);
    },

    /** Only the owner deletes the group; it disappears for every member. */
    async remove(userId, groupId) {
      const group = await loadGroup(userId, groupId);
      requireRole(group, userId, ['owner'], 'Only the owner can delete the group.');
      await destroy(group, asId(userId));
    },

    // ── Members and roles ─────────────────────────────────────────────────

    async addMembers(userId, groupId, userIds) {
      const group = await loadGroup(userId, groupId);
      requireNotSuspended(group);
      requireRole(group, userId, ADMINS, 'Only group admins can add members.');
      const ids = (await requireAddable(userId, userIds)).filter(
        (id) => !group.participants.some((p) => p.equals(id)),
      );
      const limit = await maxMembers();
      if (group.participants.length + ids.length > limit) {
        throw new AppError(409, 'GROUP_FULL', `Groups have at most ${limit} members.`);
      }
      for (const id of ids) {
        if (await addMember(group._id, id)) {
          const line = await messaging.postSystemMessage(group._id, {
            actor: userId,
            kind: 'member_added',
            target: id,
          });
          await notifications?.groupMembership(group, {
            type: 'group_member_added',
            actorId: userId,
            recipientIds: [id],
            eventId: line?.id ?? `added:${Date.now()}`,
          });
        }
      }
      messaging.notifyChanged(group._id, [...group.participants, ...ids]);
      return details(userId, groupId);
    },

    /**
     * Removes a member (owner: anyone but themselves; admins: plain members only), or leaves the
     * group when `targetId` is yourself. The owner must transfer ownership first, unless they
     * are the last member, in which case leaving deletes the group.
     */
    async removeMember(userId, groupId, targetId) {
      const group = await loadGroup(userId, groupId);
      const leaving = String(targetId) === String(userId);
      if (leaving) {
        if (roleOf(group, userId) === 'owner') {
          if (group.participants.length > 1) {
            throw new AppError(
              409,
              'OWNER_MUST_TRANSFER',
              'Transfer ownership to another member before leaving.',
            );
          }
          await destroy(group, asId(userId));
          return { left: true, deleted: true };
        }
      } else {
        requireNotSuspended(group);
        requireRole(group, userId, ADMINS, 'Only group admins can remove members.');
      }
      if (!isValidObjectId(targetId) || !memberOf(group, targetId)) {
        throw new AppError(404, 'NOT_FOUND', 'That person is not in this group.');
      }
      const removable = leaving
        ? ['admin', 'member']
        : roleOf(group, userId) === 'owner'
          ? ['admin', 'member']
          : ['member'];
      const actorRoles = leaving
        ? ['admin', 'member']
        : roleOf(group, userId) === 'owner'
          ? ['owner']
          : ADMINS;
      const result = await Conversation.updateOne(
        {
          _id: group._id,
          $and: [
            { members: { $elemMatch: { user: asId(userId), role: { $in: actorRoles } } } },
            { members: { $elemMatch: { user: asId(targetId), role: { $in: removable } } } },
          ],
        },
        { $pull: { participants: asId(targetId), members: { user: asId(targetId) } } },
      );
      if (result.modifiedCount === 0) {
        throw forbidden(leaving ? "You can't leave right now." : "You can't remove this member.");
      }
      await dropFromPinned(targetId, group._id);
      const line = await messaging.postSystemMessage(group._id, {
        actor: userId,
        kind: leaving ? 'member_left' : 'member_removed',
        target: targetId,
      });
      if (!leaving) {
        await notifications?.groupMembership(group, {
          type: 'group_member_removed',
          actorId: userId,
          recipientIds: [targetId],
          eventId: line?.id ?? `removed:${Date.now()}`,
        });
      }
      messaging.notifyChanged(group._id, group.participants);
      return { left: leaving, deleted: false };
    },

    /** The owner promotes a member to admin or demotes an admin. */
    async changeRole(userId, groupId, targetId, role) {
      const group = await loadGroup(userId, groupId);
      requireNotSuspended(group);
      requireRole(group, userId, ['owner'], 'Only the owner can change roles.');
      if (!isValidObjectId(targetId) || String(targetId) === String(userId)) {
        throw AppError.badRequest('Choose another member.');
      }
      const result = await Conversation.updateOne(
        {
          _id: group._id,
          $and: [
            { members: { $elemMatch: { user: asId(userId), role: 'owner' } } },
            {
              members: { $elemMatch: { user: asId(targetId), role: { $in: ['admin', 'member'] } } },
            },
          ],
        },
        { $set: { 'members.$[target].role': role } },
        { arrayFilters: [{ 'target.user': asId(targetId) }] },
      );
      if (result.matchedCount === 0) {
        throw new AppError(404, 'NOT_FOUND', 'That person is not in this group.');
      }
      if (result.modifiedCount === 1) {
        await notifications?.groupRoleChanged(group, { actorId: userId, targetId, role });
      }
      messaging.notifyChanged(group._id, group.participants);
      return details(userId, groupId);
    },

    /** Hands ownership to another member in one atomic update (the old owner becomes admin). */
    async transferOwnership(userId, groupId, targetId) {
      const group = await loadGroup(userId, groupId);
      requireNotSuspended(group);
      requireRole(group, userId, ['owner'], 'Only the owner can transfer ownership.');
      if (String(targetId) === String(userId)) throw AppError.badRequest('Choose another member.');
      const result = await Conversation.updateOne(
        {
          _id: group._id,
          $and: [
            { members: { $elemMatch: { user: asId(userId), role: 'owner' } } },
            { members: { $elemMatch: { user: asId(targetId) } } },
          ],
        },
        { $set: { 'members.$[old].role': 'admin', 'members.$[next].role': 'owner' } },
        { arrayFilters: [{ 'old.user': asId(userId) }, { 'next.user': asId(targetId) }] },
      );
      if (result.modifiedCount === 0) {
        throw new AppError(404, 'NOT_FOUND', 'That person is not in this group.');
      }
      await messaging.postSystemMessage(group._id, {
        actor: userId,
        kind: 'owner_changed',
        target: targetId,
      });
      await notifications?.groupRoleChanged(group, { actorId: userId, targetId, role: 'owner' });
      messaging.notifyChanged(group._id, group.participants);
      return details(userId, groupId);
    },

    // ── Invitations ───────────────────────────────────────────────────────

    /** Admins create an invitation; the link token and code are returned this once only. */
    async createInvite(userId, groupId, { expiresInHours, maxUses }) {
      const group = await loadGroup(userId, groupId);
      requireNotSuspended(group);
      requireRole(group, userId, ADMINS, 'Only group admins can create invitations.');
      for (let attempt = 0; attempt < 5; attempt++) {
        const token = generateToken(32);
        const code = newInviteCode();
        try {
          const invite = await GroupInvite.create({
            conversation: group._id,
            createdBy: userId,
            tokenHash: hashToken(token),
            codeHash: hashToken(code),
            expiresAt: new Date(Date.now() + expiresInHours * 3_600_000),
            maxUses,
          });
          return { ...toInviteDto(invite.toObject()), token, code: formatCode(code) };
        } catch (error) {
          if (error?.code !== 11000) throw error; // a code collision: try another
        }
      }
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Please try again.');
    },

    async listInvites(userId, groupId) {
      const group = await loadGroup(userId, groupId);
      requireRole(group, userId, ADMINS, 'Only group admins can see invitations.');
      const invites = await GroupInvite.find({ conversation: group._id })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();
      return invites.map(toInviteDto);
    },

    async revokeInvite(userId, groupId, inviteId) {
      const group = await loadGroup(userId, groupId);
      requireRole(group, userId, ADMINS, 'Only group admins can revoke invitations.');
      if (!isValidObjectId(inviteId)) throw inviteError.invalid();
      const invite = await GroupInvite.findOneAndUpdate(
        { _id: inviteId, conversation: group._id },
        [
          {
            $set: {
              revokedAt: { $ifNull: ['$revokedAt', '$$NOW'] },
              revokedBy: { $ifNull: ['$revokedBy', asId(userId)] },
            },
          },
        ],
        { returnDocument: 'after', updatePipeline: true },
      ).lean();
      if (!invite) throw inviteError.invalid();
      return toInviteDto(invite);
    },

    /** What an invitation leads to, without joining (validates it first). */
    async previewInvite(userId, secret) {
      const invite = await findInvite(secret);
      requireUsableInvite(invite);
      const group = await Conversation.findOne({
        _id: invite.conversation,
        type: 'group',
        'group.deletedAt': null,
      }).lean();
      if (!group) throw inviteError.invalid();
      requireNotSuspended(group);
      return {
        groupId: String(group._id),
        name: group.group.name,
        avatarUrl: avatarUrlOf(group.group),
        memberCount: group.participants.length,
        alreadyMember: group.participants.some((id) => id.equals(userId)),
      };
    },

    /**
     * Joins with a link token or code. A use is reserved atomically (`uses < maxUses`), then the
     * member is added atomically; if adding fails (already a member, full) the use is given
     * back. Joining twice, replaying the link or racing can't create duplicate memberships or
     * exceed the limit. Someone in a block with the invitation's creator can't use it.
     */
    async joinWithInvite(userId, secret) {
      const invite = await findInvite(secret);
      requireUsableInvite(invite);
      const group = await Conversation.findOne({
        _id: invite.conversation,
        type: 'group',
        'group.deletedAt': null,
      }).lean();
      if (!group) throw inviteError.invalid();
      requireNotSuspended(group);
      if (group.participants.some((id) => id.equals(userId))) {
        return { groupId: String(group._id), alreadyMember: true };
      }
      const joiner = await User.findById(userId, { status: 1 }).lean();
      if (!joiner || !VISIBLE_ACCOUNT_STATUSES.includes(joiner.status)) throw inviteError.invalid();
      if (await isBlockedEitherWay(userId, invite.createdBy)) throw inviteError.invalid();

      const now = new Date();
      const reserved = await GroupInvite.findOneAndUpdate(
        {
          _id: invite._id,
          revokedAt: null,
          expiresAt: { $gt: now },
          $or: [{ maxUses: null }, { $expr: { $lt: ['$uses', '$maxUses'] } }],
        },
        { $inc: { uses: 1 } },
        { returnDocument: 'after' },
      ).lean();
      if (!reserved) {
        requireUsableInvite(await GroupInvite.findById(invite._id).lean());
        throw inviteError.exhausted();
      }
      if (!(await addMember(group._id, userId))) {
        await GroupInvite.updateOne({ _id: invite._id, uses: { $gt: 0 } }, { $inc: { uses: -1 } });
        const fresh = await Conversation.findById(group._id, { participants: 1 }).lean();
        if (fresh?.participants.some((id) => id.equals(userId))) {
          return { groupId: String(group._id), alreadyMember: true };
        }
        throw new AppError(409, 'GROUP_FULL', 'This group is full.');
      }
      const line = await messaging.postSystemMessage(group._id, {
        actor: userId,
        kind: 'member_joined',
        target: userId,
      });
      await notifications?.groupInviteUsed(group, {
        inviterId: invite.createdBy,
        joinerId: userId,
        eventId: line?.id ?? `joined:${Date.now()}`,
      });
      messaging.notifyChanged(group._id, [...group.participants, userId]);
      return { groupId: String(group._id), alreadyMember: false };
    },

    // ── Polls ─────────────────────────────────────────────────────────────

    /**
     * Sets your whole vote (single choice: exactly one option). One vote document per person
     * (unique index), replaced atomically, so concurrent votes never double count. Votes on a
     * poll that closed meanwhile are undone.
     */
    async vote(userId, conversationId, pollId, optionIds) {
      const { group, poll, message } = await pollFor(userId, conversationId, pollId);
      if (poll.closedAt) throw new AppError(409, 'POLL_CLOSED', 'This poll is closed.');
      const valid = new Set(poll.options.map((option) => option.id));
      if (!optionIds.every((id) => valid.has(id))) throw AppError.badRequest('Invalid option.');
      if (!poll.multiple && optionIds.length !== 1) {
        throw AppError.badRequest('Choose exactly one option in this poll.');
      }
      const filter = { poll: poll._id, user: asId(userId) };
      let before;
      try {
        before = await PollVote.findOneAndUpdate(
          filter,
          { $set: { optionIds } },
          { upsert: true, returnDocument: 'before' },
        ).lean();
      } catch (error) {
        if (error?.code !== 11000) throw error;
        before = await PollVote.findOneAndUpdate(
          filter,
          { $set: { optionIds } },
          { returnDocument: 'before' },
        ).lean();
      }
      if (await Poll.exists({ _id: poll._id, closedAt: { $ne: null } })) {
        if (before) await PollVote.updateOne(filter, { $set: { optionIds: before.optionIds } });
        else await PollVote.deleteOne(filter);
        throw new AppError(409, 'POLL_CLOSED', 'This poll is closed.');
      }
      await publishPoll(group, poll._id, message._id);
      return myPoll(poll._id, userId);
    },

    async retractVote(userId, conversationId, pollId) {
      const { group, poll, message } = await pollFor(userId, conversationId, pollId);
      if (poll.closedAt) throw new AppError(409, 'POLL_CLOSED', 'This poll is closed.');
      const removed = await PollVote.deleteOne({ poll: poll._id, user: asId(userId) });
      if (removed.deletedCount > 0) await publishPoll(group, poll._id, message._id);
      return myPoll(poll._id, userId);
    },

    /** The poll's creator, admins and the owner close it; closing twice is harmless. */
    async closePoll(userId, conversationId, pollId) {
      const { group, poll, message } = await pollFor(userId, conversationId, pollId);
      const allowed = poll.creator.equals(userId) || ADMINS.includes(roleOf(group, userId));
      if (!allowed) throw forbidden('Only the poll creator or a group admin can close it.');
      const closed = await Poll.updateOne(
        { _id: poll._id, closedAt: null },
        { $set: { closedAt: new Date(), closedBy: userId } },
      );
      if (closed.modifiedCount > 0) await publishPoll(group, poll._id, message._id);
      return myPoll(poll._id, userId);
    },
  };
}
