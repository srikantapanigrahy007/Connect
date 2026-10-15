import { z } from 'zod';
import { CALL_TYPES, GROUP_ROLES, NOTIFICATION_TYPES } from '../domain/enums.js';
import { cursorPaginationQuerySchema } from './api.js';
import { userCardSchema } from './profile.js';

/**
 * Your notification preferences (stored on your account, so they follow you to every device).
 * - enabled: when off, no new notifications are created at all;
 * - messages / requests / groups / calls: one switch per category
 *   (NOTIFICATION_CATEGORY_BY_TYPE); `calls` covers missed calls (calls themselves still ring);
 * - desktop: also show a system notification while Connect is open in a background tab
 *   (the browser's permission is asked for separately).
 */
export const notificationPreferencesSchema = z.object({
  enabled: z.boolean(),
  messages: z.boolean(),
  requests: z.boolean(),
  groups: z.boolean(),
  calls: z.boolean(),
  desktop: z.boolean(),
});

export const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({
  enabled: true,
  messages: true,
  requests: true,
  groups: true,
  calls: true,
  desktop: false,
});

/** PATCH /notifications/preferences: send only what changes. */
export const notificationPreferencesUpdateSchema = notificationPreferencesSchema
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

export const NOTIFICATION_FILTERS = ['all', 'unread'];

/** GET /notifications: newest activity first. */
export const notificationListQuerySchema = cursorPaginationQuerySchema.extend({
  filter: z.enum(NOTIFICATION_FILTERS).default('all'),
});

/**
 * One notification as its recipient sees it. Message text is never included. `available` is
 * false when what it points to is gone or no longer yours to open (then `link` is null).
 */
export const notificationSchema = z.object({
  id: z.string(),
  type: z.enum(NOTIFICATION_TYPES),
  read: z.boolean(),
  /** Time of the latest activity (a collapsed message notification moves up). */
  createdAt: z.string(),
  /** New messages collected in this entry (message_received); 1 otherwise. */
  count: z.number().int().min(1),
  /** Who did it; null when hidden (blocked, account unavailable) or for moderator actions. */
  actor: userCardSchema.nullable(),
  conversationId: z.string().nullable(),
  conversationType: z.enum(['direct', 'group']).nullable(),
  groupName: z.string().nullable(),
  /** group_role_changed: your new role. */
  role: z.enum(GROUP_ROLES).nullable(),
  /** call_missed: audio or video. */
  callType: z.enum(CALL_TYPES).nullable().optional(),
  /** App path to open, or null. */
  link: z.string().nullable(),
  available: z.boolean(),
});

export const notificationUnreadCountSchema = z.object({ unread: z.number().int().min(0) });

/**
 * Notification events (server → client only, always to your own tabs). The database is the
 * source of truth: after reconnecting, clients fetch the list and count again.
 */
export const NOTIFICATION_SOCKET_EVENTS = {
  /** A notification was created or refreshed: { notification, unreadCount }. Replace by id. */
  upsert: 'notification:upsert',
  /**
   * Notifications were marked read: { ids, unreadCount } for specific ones, or
   * { ids: null, before, unreadCount } for "everything up to `before`".
   */
  read: 'notification:read',
  /** Notifications were removed: { ids, unreadCount }. */
  removed: 'notification:removed',
  /** Your preferences changed (another tab or device): { preferences }. */
  preferences: 'notification:preferences',
};
