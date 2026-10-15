import {
  ADMIN_PERMISSIONS,
  adminGroupSearchSchema,
  adminReasonBodySchema,
  adminReportQuerySchema,
  adminRoleOf,
  adminUserSearchSchema,
  auditQuerySchema,
  createReportSchema,
  dashboardQuerySchema,
  hasAdminPermission,
  platformSettingsUpdateSchema,
  reportDecisionSchema,
  roleChangeSchema,
  userModerationActions,
} from '#shared';
import { z } from 'zod';
import { requireAuth } from '../middleware/authenticate.js';
import { validated } from '../middleware/validate.js';
import { auditContext } from '../services/audit.service.js';
import { sendData } from '../utils/http-response.js';

const idParams = z.object({ id: z.string() });
const userActionParams = z.object({ id: z.string(), action: z.enum(userModerationActions) });
const groupActionParams = z.object({
  id: z.string(),
  action: z.enum(['suspend', 'unsuspend', 'remove']),
});
const roleParams = z.object({ userId: z.string() });

/**
 * Admin HTTP handlers. Permission checks happen in the routes (requireAdminPermission); every
 * handler takes the actor from the session and records changes in the audit log.
 *
 * @param {{ admin: ReturnType<typeof import('../services/admin.service.js').createAdminService>, reports: ReturnType<typeof import('../services/report.service.js').createReportService>, audit: ReturnType<typeof import('../services/audit.service.js').createAuditService>, settings: ReturnType<typeof import('../services/settings.service.js').createSettingsService> }} deps
 */
export function createAdminController({ admin, reports, audit, settings }) {
  const noStore = (res) => res.set('Cache-Control', 'no-store');
  return {
    /** Your admin role and permissions (for showing the right UI; the API re-checks). */
    me: (req, res) => {
      const { role } = requireAuth(req).user;
      noStore(res);
      sendData(res, 200, {
        role: adminRoleOf(role),
        permissions: ADMIN_PERMISSIONS.filter((permission) => hasAdminPermission(role, permission)),
      });
    },

    dashboard: validated({ query: dashboardQuerySchema }, async (req, res, { query }) => {
      noStore(res);
      sendData(res, 200, await admin.dashboard(query));
    }),
    system: async (req, res) => {
      noStore(res);
      sendData(res, 200, await admin.system());
    },

    users: validated({ query: adminUserSearchSchema }, async (req, res, { query }) => {
      noStore(res);
      const { data, meta } = await admin.searchUsers(query);
      sendData(res, 200, data, meta);
    }),
    user: validated({ params: idParams }, async (req, res, { params }) => {
      noStore(res);
      const withHistory = hasAdminPermission(requireAuth(req).user.role, 'users.history');
      sendData(res, 200, await admin.userDetails(params.id, { withHistory }));
    }),
    moderateUser: validated(
      { params: userActionParams, body: adminReasonBodySchema },
      async (req, res, { params, body }) => {
        sendData(
          res,
          200,
          await admin.moderateUser(auditContext(req), params.id, params.action, body.reason),
        );
      },
    ),
    revokeSessions: validated(
      { params: idParams, body: adminReasonBodySchema },
      async (req, res, { params, body }) => {
        sendData(res, 200, await admin.revokeSessions(auditContext(req), params.id, body.reason));
      },
    ),

    groups: validated({ query: adminGroupSearchSchema }, async (req, res, { query }) => {
      noStore(res);
      const { data, meta } = await admin.searchGroups(query);
      sendData(res, 200, data, meta);
    }),
    group: validated({ params: idParams }, async (req, res, { params }) => {
      noStore(res);
      sendData(res, 200, await admin.groupDetails(params.id));
    }),
    moderateGroup: validated(
      { params: groupActionParams, body: adminReasonBodySchema },
      async (req, res, { params, body }) => {
        sendData(
          res,
          200,
          await admin.moderateGroup(auditContext(req), params.id, params.action, body.reason),
        );
      },
    ),

    reports: validated({ query: adminReportQuerySchema }, async (req, res, { query }) => {
      noStore(res);
      const { data, meta } = await reports.list(query);
      sendData(res, 200, data, meta);
    }),
    report: validated({ params: idParams }, async (req, res, { params }) => {
      noStore(res);
      sendData(res, 200, await reports.get(params.id));
    }),
    decideReport: validated(
      { params: idParams, body: reportDecisionSchema },
      async (req, res, { params, body }) => {
        sendData(res, 200, await reports.decide(auditContext(req), params.id, body));
      },
    ),

    admins: async (req, res) => {
      noStore(res);
      sendData(res, 200, await admin.listAdmins());
    },
    changeRole: validated(
      { params: roleParams, body: roleChangeSchema },
      async (req, res, { params, body }) => {
        sendData(
          res,
          200,
          await admin.changeRole(auditContext(req), params.userId, body.role, body.reason),
        );
      },
    ),

    audit: validated({ query: auditQuerySchema }, async (req, res, { query }) => {
      noStore(res);
      const { data, meta } = await audit.list(query);
      sendData(res, 200, data, meta);
    }),

    settings: async (req, res) => {
      noStore(res);
      sendData(res, 200, await settings.get());
    },
    updateSettings: validated(
      { body: platformSettingsUpdateSchema },
      async (req, res, { body }) => {
        const { reason, ...changes } = body;
        const { before, after } = await settings.update(requireAuth(req).userId, changes);
        await audit.record(auditContext(req), {
          action: 'settings.update',
          targetType: 'settings',
          targetId: 'platform',
          reason,
          details: { before, after },
        });
        sendData(res, 200, after);
      },
    ),

    // ── Public / user-facing ──────────────────────────────────────────────

    /** Registration availability, upload/group limits and the maintenance banner. */
    publicSettings: async (req, res) => {
      res.set('Cache-Control', 'public, max-age=30');
      sendData(res, 200, await settings.get());
    },

    /** Any signed-in user reports a user, a message or a group. */
    createReport: validated({ body: createReportSchema }, async (req, res, { body }) => {
      sendData(res, 201, await reports.create(requireAuth(req).userId, body));
    }),
  };
}
