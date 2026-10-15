import { accountStatusMachine, adminRoleOf, isAdminRole } from '#shared';
import mongoose, { isValidObjectId } from 'mongoose';
import { Conversation } from '../models/conversation.model.js';
import { Message } from '../models/message.model.js';
import { Report } from '../models/report.model.js';
import { Session } from '../models/session.model.js';
import { StorageUsage } from '../models/storage-usage.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { avatarUrlOf, PUBLIC_USER_FIELDS, toUserCard } from './user-dto.js';

const SUPER_ADMIN_ROLES = ['super_admin', 'admin'];
/** Accounts that still count as a working Super Admin. */
const WORKING_STATUSES = ['active', 'pending_verification'];
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const userNotFound = () => new AppError(404, 'NOT_FOUND', 'User not found.');

/**
 * Account moderation transitions: the allowed source states come from accountStatusMachine and
 * every change is a compare-and-set on `status`.
 */
const MODERATION = {
  suspend: {
    from: ['active', 'pending_verification'],
    to: () => 'suspended',
    audit: 'user.suspend',
  },
  ban: {
    from: ['active', 'pending_verification', 'suspended'],
    to: () => 'banned',
    audit: 'user.ban',
  },
  restore: {
    from: ['suspended'],
    to: (user) => (user.emailVerifiedAt ? 'active' : 'pending_verification'),
    audit: 'user.restore',
  },
  unban: {
    from: ['banned'],
    to: (user) => (user.emailVerifiedAt ? 'active' : 'pending_verification'),
    audit: 'user.unban',
  },
};

/**
 * Admin operations. Permissions are checked by the route middleware (see ADMIN_PERMISSION_MATRIX);
 * the rules here protect targets: nobody moderates themselves, only Super Admins act on other
 * admins, and the last working Super Admin can't be demoted, suspended or banned.
 *
 * @param {{ sessions: object, presence: object, metrics: object, settings: object, audit: object, groups: object, config: object, database: { getStatus: () => string, ping: (ms: number) => Promise<{ ok: boolean, latencyMs?: number }> }, storage: { driver: string } }} deps
 */
export function createAdminService(deps) {
  const { sessions, presence, metrics, audit, groups, config, database, storage } = deps;

  async function workingSuperAdmins(excludeId = null) {
    return User.countDocuments({
      role: { $in: SUPER_ADMIN_ROLES },
      status: { $in: WORKING_STATUSES },
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });
  }

  async function loadTarget(context, userId) {
    if (!isValidObjectId(userId)) throw userNotFound();
    const user = await User.findById(userId).lean();
    if (!user || user.status === 'deleted') throw userNotFound();
    if (String(user._id) === String(context.actor)) {
      throw new AppError(403, 'FORBIDDEN', "You can't use admin actions on your own account.");
    }
    // Only Super Admins act on other admins.
    if (isAdminRole(user.role) && context.actorRole !== 'super_admin') {
      throw new AppError(403, 'FORBIDDEN', 'Only a Super Admin can act on another admin.');
    }
    return user;
  }

  /** Refuses (and audits the refusal) if this would leave no working Super Admin. */
  async function protectLastSuperAdmin(context, user, entry) {
    if (adminRoleOf(user.role) !== 'super_admin') return;
    if ((await workingSuperAdmins(user._id)) > 0) return;
    await audit.record(context, { ...entry, outcome: 'denied' });
    throw new AppError(409, 'LAST_SUPER_ADMIN', 'This is the last active Super Admin.');
  }

  function toAdminUser(user, extra = {}) {
    return {
      id: String(user._id),
      username: user.username ?? '',
      displayName: user.displayName,
      email: user.email ?? null,
      emailVerified: Boolean(user.emailVerifiedAt),
      avatarUrl: avatarUrlOf(user),
      status: user.status,
      role: adminRoleOf(user.role) ?? 'user',
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
      lastSeenAt: user.lastSeenAt ? user.lastSeenAt.toISOString() : null,
      ...extra,
    };
  }

  /** Only these user fields are ever read for admin screens (no hashes, tokens or googleId). */
  const ADMIN_USER_FIELDS = {
    username: 1,
    displayName: 1,
    email: 1,
    emailVerifiedAt: 1,
    avatar: 1,
    status: 1,
    role: 1,
    createdAt: 1,
    lastLoginAt: 1,
    lastSeenAt: 1,
  };

  async function groupDto(group, { withMembers = false } = {}) {
    const g = group.group;
    const [creator, openReports] = await Promise.all([
      User.findById(g.createdBy, PUBLIC_USER_FIELDS).lean(),
      Report.countDocuments({
        targetType: 'group',
        targetId: group._id,
        status: { $in: ['open', 'under_review'] },
      }),
    ]);
    const dto = {
      id: String(group._id),
      name: g.name,
      description: g.description ?? '',
      avatarUrl: g.avatar?.key ? avatarUrlOf({ avatar: g.avatar }) : null,
      memberCount: group.participants.length,
      status: g.deletedAt ? 'deleted' : g.suspendedAt ? 'suspended' : 'active',
      suspendedReason: g.suspendedReason ?? null,
      createdBy: creator ? toUserCard(creator) : null,
      openReports,
      createdAt: group.createdAt.toISOString(),
    };
    if (!withMembers) return dto;
    const users = await User.find({ _id: { $in: group.participants } }, PUBLIC_USER_FIELDS).lean();
    const byId = new Map(users.map((user) => [String(user._id), user]));
    return {
      ...dto,
      members: group.members
        .filter((member) => byId.has(String(member.user)))
        .map((member) => ({ user: toUserCard(byId.get(String(member.user))), role: member.role })),
    };
  }

  return {
    // ── Dashboard ─────────────────────────────────────────────────────────

    /**
     * Platform metrics for the last `days` days, from indexed counts and aggregations:
     * - activeUsers: distinct people whose session was used in the window (sessions refresh at
     *   least every 10 minutes while the app is open);
     * - onlineNow: people with an open socket on this API instance.
     */
    async dashboard({ days }) {
      const since = new Date(Date.now() - days * 86_400_000);
      const [
        totalUsers,
        newUsers,
        active,
        conversations,
        groupsCount,
        totalMessages,
        newMessages,
        pendingReports,
        storageTotal,
      ] = await Promise.all([
        User.countDocuments({ status: { $ne: 'deleted' } }),
        User.countDocuments({ createdAt: { $gte: since } }),
        Session.aggregate([
          { $match: { lastUsedAt: { $gte: since } } },
          { $group: { _id: '$user' } },
          { $count: 'n' },
        ]),
        Conversation.countDocuments({ type: 'direct' }),
        Conversation.countDocuments({ type: 'group', 'group.deletedAt': null }),
        Message.estimatedDocumentCount(),
        Message.countDocuments({ createdAt: { $gte: since } }),
        Report.countDocuments({ status: { $in: ['open', 'under_review'] } }),
        StorageUsage.findOne({ scope: 'total' }).lean(),
      ]);
      return {
        days,
        since: since.toISOString(),
        users: {
          total: totalUsers,
          new: newUsers,
          active: active[0]?.n ?? 0,
          onlineNow: presence.count(),
        },
        conversations: { direct: conversations, groups: groupsCount },
        messages: { total: totalMessages, inPeriod: newMessages },
        reports: { pending: pendingReports },
        storage: {
          usedBytes: storageTotal?.bytes ?? 0,
          quotaBytes: config.attachments.totalQuotaBytes,
          driver: storage.driver,
        },
      };
    },

    /** API, database and Socket.IO status. No hostnames, credentials or stack traces. */
    async system() {
      const ping = await database.ping(2_000);
      const sockets = metrics.socketCount();
      return {
        api: {
          status: 'ok',
          version: config.version,
          environment: config.nodeEnv,
          uptimeSeconds: Math.round((Date.now() - metrics.startedAt) / 1_000),
        },
        database: { status: ping.ok ? 'ok' : 'unavailable', latencyMs: ping.latencyMs ?? null },
        realtime: {
          status: sockets === null ? 'unavailable' : 'ok',
          connectedSockets: sockets,
          onlineUsers: presence.count(),
        },
        requests: metrics.snapshot(),
        storage: { driver: storage.driver },
      };
    },

    // ── Users ─────────────────────────────────────────────────────────────

    /** Username prefix, or an exact email when the query contains "@". Newest first. */
    async searchUsers({ q, status, cursor, limit }) {
      if (cursor && !isValidObjectId(cursor)) throw AppError.badRequest('Invalid cursor');
      const query = q?.toLowerCase();
      const rows = await User.find(
        {
          ...(query
            ? query.includes('@')
              ? { email: query }
              : { username: { $regex: `^${escapeRegex(query.replace(/^@/, ''))}` } }
            : {}),
          ...(status ? { status } : {}),
          ...(cursor ? { _id: { $lt: cursor } } : {}),
        },
        ADMIN_USER_FIELDS,
      )
        .sort({ _id: -1 })
        .limit(limit + 1)
        .lean();
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return {
        data: page.map((user) => toAdminUser(user)),
        meta: { limit, hasMore, nextCursor: hasMore ? String(page.at(-1)._id) : null },
      };
    },

    /** Account details, session count and (when allowed) moderation history. Never messages. */
    async userDetails(userId, { withHistory }) {
      if (!isValidObjectId(userId)) throw userNotFound();
      const user = await User.findById(userId, ADMIN_USER_FIELDS).lean();
      if (!user) throw userNotFound();
      const activeSessions = await Session.countDocuments({
        user: user._id,
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      });
      return toAdminUser(user, {
        activeSessions,
        online: presence.isOnline(String(user._id)),
        history: withHistory ? await audit.forTarget(user._id) : null,
      });
    },

    /** suspend | restore | ban | unban, with a reason; sessions end at once for suspend/ban. */
    async moderateUser(context, userId, action, reason) {
      const rule = MODERATION[action];
      const user = await loadTarget(context, userId);
      const entry = { action: rule.audit, targetType: 'user', targetId: userId, reason };
      if (action === 'suspend' || action === 'ban')
        await protectLastSuperAdmin(context, user, entry);
      if (!rule.from.includes(user.status)) {
        throw new AppError(409, 'INVALID_STATE_TRANSITION', `This account is ${user.status}.`);
      }
      const to = rule.to(user);
      const updated = await User.updateOne(
        {
          _id: user._id,
          status: { $in: rule.from.filter((s) => accountStatusMachine.canTransition(s, to)) },
        },
        { $set: { status: to } },
      );
      if (updated.modifiedCount === 0) {
        throw new AppError(
          409,
          'INVALID_STATE_TRANSITION',
          'The account changed meanwhile. Reload.',
        );
      }
      if (to === 'suspended' || to === 'banned') {
        // Revoke every session (sockets close immediately) — and re-check the last-admin rule
        // in case two Super Admins were moderated at the same moment.
        await sessions.revokeAll(String(user._id), 'admin_revoked');
        if (adminRoleOf(user.role) === 'super_admin' && (await workingSuperAdmins()) === 0) {
          await User.updateOne({ _id: user._id, status: to }, { $set: { status: user.status } });
          await audit.record(context, { ...entry, outcome: 'denied' });
          throw new AppError(409, 'LAST_SUPER_ADMIN', 'This is the last active Super Admin.');
        }
      }
      await audit.record(context, { ...entry, details: { from: user.status, to } });
      return this.userDetails(userId, { withHistory: true });
    },

    /** Force logout: revokes every session of the user and closes their sockets. */
    async revokeSessions(context, userId, reason) {
      const user = await loadTarget(context, userId);
      const revoked = await sessions.revokeAll(String(user._id), 'admin_revoked');
      await audit.record(context, {
        action: 'session.revoke',
        targetType: 'user',
        targetId: userId,
        reason,
        details: { sessions: revoked.length },
      });
      return { revoked: revoked.length };
    },

    // ── Admin roles ───────────────────────────────────────────────────────

    async listAdmins() {
      const admins = await User.find(
        {
          role: { $in: ['super_admin', 'admin', 'moderator', 'support'] },
          status: { $ne: 'deleted' },
        },
        ADMIN_USER_FIELDS,
      )
        .sort({ createdAt: 1 })
        .limit(500)
        .lean();
      return admins.map((user) => toAdminUser(user));
    },

    /**
     * Grants or revokes an admin role (Super Admins only, enforced by the route). Nobody changes
     * their own role, and the last working Super Admin can't be demoted. The new role applies
     * on the target's next request (roles are read from the database every time).
     */
    async changeRole(context, userId, role, reason) {
      if (!isValidObjectId(userId)) throw userNotFound();
      if (String(userId) === String(context.actor)) {
        throw new AppError(403, 'FORBIDDEN', "You can't change your own role.");
      }
      const user = await User.findById(userId).lean();
      if (!user || user.status === 'deleted') throw userNotFound();
      const from = adminRoleOf(user.role) ?? 'user';
      const entry = {
        action: 'user.role_change',
        targetType: 'user',
        targetId: userId,
        reason,
        details: { from, to: role },
      };
      if (from === role) return toAdminUser(user);
      if (role !== 'super_admin') await protectLastSuperAdmin(context, user, entry);
      if (role !== 'user' && !['active', 'pending_verification'].includes(user.status)) {
        throw new AppError(
          409,
          'INVALID_STATE_TRANSITION',
          'Restore the account before giving it a role.',
        );
      }
      await User.updateOne({ _id: user._id }, { $set: { role } });
      if (from === 'super_admin' && (await workingSuperAdmins()) === 0) {
        await User.updateOne({ _id: user._id }, { $set: { role: user.role } });
        await audit.record(context, { ...entry, outcome: 'denied' });
        throw new AppError(409, 'LAST_SUPER_ADMIN', 'This is the last active Super Admin.');
      }
      await audit.record(context, entry);
      return toAdminUser(await User.findById(userId, ADMIN_USER_FIELDS).lean());
    },

    // ── Groups ────────────────────────────────────────────────────────────

    async searchGroups({ q, status, cursor, limit }) {
      if (cursor && !isValidObjectId(cursor)) throw AppError.badRequest('Invalid cursor');
      const rows = await Conversation.find({
        type: 'group',
        ...(q ? { 'group.name': { $regex: escapeRegex(q), $options: 'i' } } : {}),
        ...(status === 'deleted'
          ? { 'group.deletedAt': { $ne: null } }
          : status === 'suspended'
            ? { 'group.deletedAt': null, 'group.suspendedAt': { $ne: null } }
            : status === 'active'
              ? { 'group.deletedAt': null, 'group.suspendedAt': null }
              : {}),
        ...(cursor ? { _id: { $lt: new mongoose.Types.ObjectId(cursor) } } : {}),
      })
        .sort({ _id: -1 })
        .limit(limit + 1)
        .lean();
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return {
        data: await Promise.all(page.map((group) => groupDto(group))),
        meta: { limit, hasMore, nextCursor: hasMore ? String(page.at(-1)._id) : null },
      };
    },

    /** Metadata, members and roles. Messages are never included. */
    async groupDetails(groupId) {
      if (!isValidObjectId(groupId)) throw new AppError(404, 'NOT_FOUND', 'Group not found.');
      const group = await Conversation.findOne({ _id: groupId, type: 'group' }).lean();
      if (!group) throw new AppError(404, 'NOT_FOUND', 'Group not found.');
      return groupDto(group, { withMembers: true });
    },

    /**
     * suspend: read-only for members (membership and history are kept; no posting, joining,
     * inviting or changes). unsuspend: back to normal. remove: deleted exactly like the owner
     * deleting it (Phase 9), for every member.
     */
    async moderateGroup(context, groupId, action, reason) {
      if (!isValidObjectId(groupId)) throw new AppError(404, 'NOT_FOUND', 'Group not found.');
      const live = { _id: groupId, type: 'group', 'group.deletedAt': null };
      const group = await Conversation.findOne(live).lean();
      if (!group) throw new AppError(404, 'NOT_FOUND', 'Group not found.');
      if (action === 'remove') {
        await groups.adminRemove(groupId, context.actor);
      } else {
        const suspend = action === 'suspend';
        const result = await Conversation.updateOne(
          { ...live, 'group.suspendedAt': suspend ? null : { $ne: null } },
          {
            $set: suspend
              ? { 'group.suspendedAt': new Date(), 'group.suspendedReason': reason }
              : { 'group.suspendedAt': null, 'group.suspendedReason': null },
          },
        );
        if (result.modifiedCount === 0) {
          throw new AppError(
            409,
            'INVALID_STATE_TRANSITION',
            suspend ? 'Already suspended.' : 'Not suspended.',
          );
        }
        groups.notifyMembers(group);
      }
      await audit.record(context, {
        action: `group.${action}`,
        targetType: 'group',
        targetId: groupId,
        reason,
      });
      return this.groupDetails(groupId);
    },
  };
}
