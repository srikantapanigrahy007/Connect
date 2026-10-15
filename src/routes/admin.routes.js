import { Router } from 'express';
import { requireAdminPermission as can } from '../middleware/admin.js';
import { authenticate, requireRecentAuth } from '../middleware/authenticate.js';
import { createRateLimiter, keyByUser } from '../middleware/rate-limit.js';

/**
 * /api/v1/admin (every route: signed-in session + a permission from ADMIN_PERMISSION_MATRIX;
 * the most sensitive also need recent authentication), plus /api/v1/reports (any signed-in
 * user) and /api/v1/settings/public (anyone). There is no endpoint that creates admins from
 * scratch: the first Super Admin comes from the server-side bootstrap command.
 *
 * @param {import('../config/app-config.js').AppConfig} config
 * @param {ReturnType<typeof import('../services/session.service.js').createSessionService>} sessions
 * @param {ReturnType<typeof import('../controllers/admin.controller.js').createAdminController>} controller
 */
export function createAdminRouters(config, sessions, controller) {
  const requireSession = authenticate(config, sessions);
  const recent = requireRecentAuth(config);
  /** Recent authentication only for the requests `when` selects. */
  const recentIf = (when) => (req, res, next) => (when(req) ? recent(req, res, next) : next());
  const write = createRateLimiter(config, 'adminActionPerUser', keyByUser);
  const reportLimit = createRateLimiter(config, 'reportPerUser', keyByUser);

  const admin = Router();
  admin.use(requireSession);
  admin.get('/me', controller.me);
  admin.get('/dashboard', can('dashboard.view'), controller.dashboard);
  admin.get('/system', can('system.view'), controller.system);

  admin.get('/users', can('users.view'), controller.users);
  admin.get('/users/:id', can('users.view'), controller.user);
  admin.post('/users/:id/revoke-sessions', can('users.sessions'), write, controller.revokeSessions);
  // Bans and unbans also need a recent sign-in or re-authentication (suspend/restore don't).
  admin.post(
    '/users/:id/:action',
    can('users.moderate'),
    recentIf((req) => ['ban', 'unban'].includes(req.params.action)),
    write,
    controller.moderateUser,
  );

  admin.get('/groups', can('groups.view'), controller.groups);
  admin.get('/groups/:id', can('groups.view'), controller.group);
  // Removing a group is permanent: recent authentication too.
  admin.post(
    '/groups/:id/:action',
    can('groups.moderate'),
    recentIf((req) => req.params.action === 'remove'),
    write,
    controller.moderateGroup,
  );

  admin.get('/reports', can('reports.view'), controller.reports);
  admin.get('/reports/:id', can('reports.view'), controller.report);
  admin.patch('/reports/:id', can('reports.resolve'), write, controller.decideReport);

  admin.get('/roles', can('roles.manage'), controller.admins);
  admin.put('/roles/:userId', can('roles.manage'), recent, write, controller.changeRole);

  admin.get('/audit', can('audit.view'), controller.audit);

  admin.get('/settings', can('settings.manage'), controller.settings);
  admin.put('/settings', can('settings.manage'), recent, write, controller.updateSettings);

  const reports = Router();
  reports.use(requireSession);
  reports.post('/', reportLimit, controller.createReport);

  const settings = Router();
  settings.get('/public', controller.publicSettings);

  return { admin, reports, settings };
}
