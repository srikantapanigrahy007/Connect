import { adminRoleOf } from '#shared';
import { isValidObjectId } from 'mongoose';
import { AuditLog } from '../models/audit-log.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { PUBLIC_USER_FIELDS, toUserCard } from './user-dto.js';

/** Request metadata kept with an entry (no headers, bodies, cookies or tokens). */
export function auditContext(req) {
  return {
    actor: req.auth.userId,
    actorRole: adminRoleOf(req.auth.user.role) ?? req.auth.user.role,
    requestId: req.id ?? null,
    ipAddress: req.ip?.slice(0, 64) ?? null,
  };
}

function toDto(entry, actors) {
  const actor = entry.actor ? actors.get(String(entry.actor)) : null;
  return {
    id: String(entry._id),
    actor: actor ? toUserCard(actor) : null,
    actorRole: entry.actorRole,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    reason: entry.reason,
    outcome: entry.outcome,
    details: entry.details ?? null,
    requestId: entry.requestId,
    createdAt: entry.createdAt.toISOString(),
  };
}

/** Writes and reads the append-only audit log. */
export function createAuditService() {
  async function withActors(entries) {
    const ids = [
      ...new Set(
        entries
          .map((e) => e.actor)
          .filter(Boolean)
          .map(String),
      ),
    ];
    const users = ids.length
      ? await User.find({ _id: { $in: ids } }, PUBLIC_USER_FIELDS).lean()
      : [];
    const actors = new Map(users.map((user) => [String(user._id), user]));
    return entries.map((entry) => toDto(entry, actors));
  }

  return {
    /**
     * @param {ReturnType<typeof auditContext>} context
     * @param {{ action: string, targetType: string, targetId?: string | null, reason?: string | null, outcome?: 'success' | 'denied', details?: object | null }} entry
     */
    async record(context, entry) {
      await AuditLog.create({
        ...context,
        targetId: entry.targetId ? String(entry.targetId) : null,
        action: entry.action,
        targetType: entry.targetType,
        reason: entry.reason ?? null,
        outcome: entry.outcome ?? 'success',
        details: entry.details ?? null,
      });
    },

    /** Newest first; filter by action, actor or target. */
    async list({ cursor, limit, action, actorId, targetId }) {
      if (cursor && !isValidObjectId(cursor)) throw AppError.badRequest('Invalid cursor');
      const entries = await AuditLog.find({
        ...(action ? { action } : {}),
        ...(actorId ? { actor: actorId } : {}),
        ...(targetId ? { targetId } : {}),
        ...(cursor ? { _id: { $lt: cursor } } : {}),
      })
        .sort({ _id: -1 })
        .limit(limit + 1)
        .lean();
      const hasMore = entries.length > limit;
      const page = entries.slice(0, limit);
      return {
        data: await withActors(page),
        meta: { limit, hasMore, nextCursor: hasMore ? String(page.at(-1)._id) : null },
      };
    },

    /** Moderation history of one target (newest first, at most 50). */
    async forTarget(targetId) {
      const entries = await AuditLog.find({ targetId: String(targetId) })
        .sort({ _id: -1 })
        .limit(50)
        .lean();
      return withActors(entries);
    },
  };
}
