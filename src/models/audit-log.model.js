import { ADMIN_AUDIT_ACTIONS, AUDIT_TARGET_TYPES } from '#shared';
import { model, Schema } from 'mongoose';

/**
 * Append-only record of administrative actions. The application only ever inserts: every
 * update, replace and delete query on this model throws, and there are no endpoints that edit
 * or remove entries. This is an application guarantee, not tamper-proof storage: anyone with
 * direct database access can still change the collection (use database auditing, restricted
 * credentials or an external log sink for that).
 *
 * Never stores passwords, tokens, secrets or message content: only who, what, to whom, why,
 * the outcome and minimal request metadata.
 */
const auditLogSchema = new Schema(
  {
    /** Null for the server-side bootstrap command. */
    actor: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorRole: { type: String, maxlength: 32, required: true },
    action: { type: String, enum: ADMIN_AUDIT_ACTIONS, required: true },
    targetType: { type: String, enum: [...AUDIT_TARGET_TYPES, 'settings'], required: true },
    targetId: { type: String, maxlength: 64, default: null },
    reason: { type: String, maxlength: 1_000, default: null },
    /** "success", or "denied" when a safety rule refused the action. */
    outcome: { type: String, enum: ['success', 'denied'], required: true },
    /** Small, non-sensitive details (e.g. { from: "active", to: "suspended" }). */
    details: { type: Schema.Types.Mixed, default: null },
    requestId: { type: String, maxlength: 64, default: null },
    ipAddress: { type: String, maxlength: 64, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ createdAt: -1, _id: -1 });
auditLogSchema.index({ targetId: 1, createdAt: -1 });
auditLogSchema.index({ actor: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });

function appendOnly() {
  throw new Error('Audit log entries cannot be changed or deleted');
}
auditLogSchema.pre(
  [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'replaceOne',
    'findOneAndReplace',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
  ],
  appendOnly,
);
auditLogSchema.pre('save', function () {
  if (!this.isNew) appendOnly();
});

export const AuditLog = model('AuditLog', auditLogSchema);
