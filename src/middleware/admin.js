import { hasAdminPermission } from '#shared';
import { AppError } from '../utils/app-error.js';
import { requireAuth } from './authenticate.js';

/**
 * Allows the request only if the signed-in user's role (read from the database on every
 * request by `authenticate`) holds `permission` in ADMIN_PERMISSION_MATRIX. Ordinary users and
 * admins without that permission get 403. Never trusts anything the client sends about roles.
 *
 * @param {keyof typeof import('#shared').ADMIN_PERMISSION_MATRIX} permission
 */
export function requireAdminPermission(permission) {
  return (req, _res, next) => {
    const auth = requireAuth(req);
    if (!hasAdminPermission(auth.user.role, permission)) {
      throw new AppError(403, 'FORBIDDEN', "You don't have access to this.");
    }
    next();
  };
}
