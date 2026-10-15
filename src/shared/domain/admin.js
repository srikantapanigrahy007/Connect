/*
 * Admin roles and the permission matrix (Phase 10). The API enforces it on every admin route;
 * the web app uses the same table only to hide controls an admin can't use.
 */

/** Admin roles, most powerful first. */
export const ADMIN_ROLES = ['super_admin', 'moderator', 'support'];

/** Every admin permission and who holds it. */
export const ADMIN_PERMISSION_MATRIX = {
  /** Dashboard metrics. */
  'dashboard.view': ['super_admin', 'moderator', 'support'],
  /** API, database and Socket.IO health. */
  'system.view': ['super_admin', 'moderator', 'support'],
  /** Search users and see account details (never passwords, tokens or messages). */
  'users.view': ['super_admin', 'moderator', 'support'],
  /** Force logout: revoke all of a user's sessions and close their sockets. */
  'users.sessions': ['super_admin', 'moderator', 'support'],
  /** Suspend, restore, ban and unban accounts. */
  'users.moderate': ['super_admin', 'moderator'],
  /** A user's moderation history (from the audit log). */
  'users.history': ['super_admin', 'moderator'],
  /** Search groups, see metadata, members and roles (never messages). */
  'groups.view': ['super_admin', 'moderator'],
  /** Suspend, unsuspend and remove groups. */
  'groups.moderate': ['super_admin', 'moderator'],
  /** List reports and view the evidence reporters submitted. */
  'reports.view': ['super_admin', 'moderator'],
  /** Take, resolve, dismiss and reopen reports. */
  'reports.resolve': ['super_admin', 'moderator'],
  /** Grant and revoke admin roles. */
  'roles.manage': ['super_admin'],
  /** The full audit log. */
  'audit.view': ['super_admin'],
  /** Read and change platform settings. */
  'settings.manage': ['super_admin'],
};

export const ADMIN_PERMISSIONS = Object.keys(ADMIN_PERMISSION_MATRIX);

/** The admin role of a user role ("admin" is the legacy name of super_admin), or null. */
export function adminRoleOf(role) {
  if (role === 'admin') return 'super_admin';
  return ADMIN_ROLES.includes(role) ? role : null;
}

export function isAdminRole(role) {
  return adminRoleOf(role) !== null;
}

export function hasAdminPermission(role, permission) {
  const adminRole = adminRoleOf(role);
  return Boolean(adminRole && ADMIN_PERMISSION_MATRIX[permission]?.includes(adminRole));
}

/** Hard limits that platform settings can never exceed. */
export const PLATFORM_SETTING_BOUNDS = {
  uploadMaxBytes: { min: 100 * 1024, max: 5 * 1024 * 1024 },
  groupMaxMembers: { min: 2, max: 256 },
  maintenanceMessageMaxLength: 200,
};
