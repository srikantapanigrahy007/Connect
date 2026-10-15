import { AuditLog } from '../models/audit-log.model.js';
import { User } from '../models/user.model.js';

export class BootstrapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BootstrapError';
  }
}

/**
 * Makes an existing, verified account the Super Admin. Server-side only (the CLI in
 * scripts/bootstrap-super-admin.js); there is no HTTP endpoint for this.
 *
 * - Refuses when a working Super Admin already exists, unless `force` is set (the documented
 *   recovery procedure when every Super Admin lost access).
 * - The account must already exist, be active and have a verified email; no credentials are
 *   created or printed.
 * - Recorded in the audit log as "admin.bootstrap" with actor "system".
 *
 * @param {{ email: string, force?: boolean }} input
 */
export async function bootstrapSuperAdmin({ email, force = false }) {
  const normalized = String(email ?? '')
    .trim()
    .toLowerCase();
  if (!normalized.includes('@')) throw new BootstrapError('Give the email of an existing account.');
  const existing = await User.countDocuments({
    role: { $in: ['super_admin', 'admin'] },
    status: { $in: ['active', 'pending_verification'] },
  });
  if (existing > 0 && !force) {
    throw new BootstrapError(
      'A Super Admin already exists. Use the admin panel, or --force to recover access.',
    );
  }
  const user = await User.findOne({ email: normalized }).lean();
  if (!user || user.status !== 'active' || !user.emailVerifiedAt) {
    throw new BootstrapError('No active account with a verified email has that address.');
  }
  await User.updateOne({ _id: user._id }, { $set: { role: 'super_admin' } });
  await AuditLog.create({
    actor: null,
    actorRole: 'system',
    action: 'admin.bootstrap',
    targetType: 'user',
    targetId: String(user._id),
    reason: force ? 'Recovery bootstrap (--force)' : 'Initial Super Admin bootstrap',
    outcome: 'success',
    details: { previousRole: user.role },
  });
  return { userId: String(user._id), username: user.username };
}
