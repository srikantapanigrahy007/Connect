import { z } from 'zod';
import { ADMIN_ROLES, PLATFORM_SETTING_BOUNDS } from '../domain/admin.js';
import {
  ACCOUNT_STATUSES,
  ADMIN_AUDIT_ACTIONS,
  REPORT_REASONS,
  REPORT_RESOLUTION_ACTIONS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
} from '../domain/enums.js';
import { LIMITS } from '../domain/limits.js';
import { cursorPaginationQuerySchema, objectIdSchema } from './api.js';

/** Every moderation action needs a reason, kept in the audit log. */
export const moderationReasonSchema = z
  .string()
  .trim()
  .min(3, 'Give a reason (at least 3 characters)')
  .max(500, 'Reasons are at most 500 characters');

export const adminReasonBodySchema = z.object({ reason: moderationReasonSchema }).strict();

/** GET /admin/dashboard?days= */
export const dashboardQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((value) => [1, 7, 30, 90].includes(value), 'Choose 1, 7, 30 or 90 days')
    .default(7),
});

/** GET /admin/users?q=&status= — q matches username prefix or exact email. */
export const adminUserSearchSchema = cursorPaginationQuerySchema.extend({
  q: z.string().trim().max(254).optional(),
  status: z.enum(ACCOUNT_STATUSES).optional(),
});

/** POST /admin/users/:id/{suspend,restore,ban,unban} */
export const userModerationActions = ['suspend', 'restore', 'ban', 'unban'];

/** PUT /admin/roles/:userId — "user" revokes all admin rights. */
export const roleChangeSchema = z
  .object({ role: z.enum(['user', ...ADMIN_ROLES]), reason: moderationReasonSchema })
  .strict();

/** GET /admin/groups?q= */
export const adminGroupSearchSchema = cursorPaginationQuerySchema.extend({
  q: z.string().trim().max(60).optional(),
  status: z.enum(['active', 'suspended', 'deleted']).optional(),
});

// ── Reports ─────────────────────────────────────────────────────────────────

/**
 * POST /reports. For messages, the reported message is the evidence (a snapshot of what the
 * reporter could see). `evidenceMessageIds` may add up to 5 more messages from the same
 * conversation that the reporter chooses to share. Nothing else is ever collected.
 */
export const createReportSchema = z
  .object({
    targetType: z.enum(REPORT_TARGET_TYPES),
    targetId: objectIdSchema,
    reason: z.enum(REPORT_REASONS),
    details: z
      .string()
      .trim()
      .max(LIMITS.reportDetailsMaxLength, `At most ${LIMITS.reportDetailsMaxLength} characters`)
      .optional(),
    evidenceMessageIds: z
      .array(objectIdSchema)
      .max(5, 'Share at most 5 extra messages')
      .refine((ids) => new Set(ids).size === ids.length, 'Each message once')
      .optional(),
  })
  .strict();

/** GET /admin/reports */
export const adminReportQuerySchema = cursorPaginationQuerySchema.extend({
  status: z.enum(REPORT_STATUSES).optional(),
  targetType: z.enum(REPORT_TARGET_TYPES).optional(),
});

/**
 * PATCH /admin/reports/:id — "under_review" assigns it to you; resolving needs an action and a
 * note; dismissing needs a note; "open" reopens.
 */
export const reportDecisionSchema = z
  .object({
    status: z.enum(REPORT_STATUSES),
    action: z.enum(REPORT_RESOLUTION_ACTIONS).optional(),
    note: z.string().trim().max(1_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'resolved' && !value.action) {
      ctx.addIssue({ code: 'custom', path: ['action'], message: 'Choose the action taken' });
    }
    if (
      (value.status === 'resolved' || value.status === 'dismissed') &&
      (value.note ?? '').length < 3
    ) {
      ctx.addIssue({ code: 'custom', path: ['note'], message: 'Explain the decision' });
    }
  });

// ── Audit log ───────────────────────────────────────────────────────────────

export const auditQuerySchema = cursorPaginationQuerySchema.extend({
  action: z.enum(ADMIN_AUDIT_ACTIONS).optional(),
  actorId: objectIdSchema.optional(),
  targetId: objectIdSchema.optional(),
});

// ── Platform settings ───────────────────────────────────────────────────────

const { uploadMaxBytes, groupMaxMembers, maintenanceMessageMaxLength } = PLATFORM_SETTING_BOUNDS;

export const platformSettingsSchema = z.object({
  registrationEnabled: z.boolean(),
  uploadMaxBytes: z.number().int().min(uploadMaxBytes.min).max(uploadMaxBytes.max),
  groupMaxMembers: z.number().int().min(groupMaxMembers.min).max(groupMaxMembers.max),
  maintenanceBanner: z.object({
    enabled: z.boolean(),
    message: z.string().trim().max(maintenanceMessageMaxLength),
  }),
});

/** PUT /admin/settings: the changed settings plus a reason. */
export const platformSettingsUpdateSchema = platformSettingsSchema
  .partial()
  .extend({ reason: moderationReasonSchema })
  .strict()
  .refine((value) => Object.keys(value).length > 1, 'Nothing to update')
  .refine(
    (value) => !value.maintenanceBanner?.enabled || value.maintenanceBanner.message.length > 0,
    { message: 'Write the banner message', path: ['maintenanceBanner', 'message'] },
  );

/** GET /settings/public — what every visitor may know. */
export const publicSettingsSchema = platformSettingsSchema.extend({
  maintenanceBanner: z.object({ enabled: z.boolean(), message: z.string() }),
});
