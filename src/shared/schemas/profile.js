import { z } from 'zod';
import {
  MESSAGE_PERMISSIONS,
  MESSAGE_REQUEST_STATUSES,
  PRESENCE_AUDIENCES,
  PROFILE_VISIBILITIES,
} from '../domain/enums.js';
import { LIMITS } from '../domain/limits.js';
import { cursorPaginationQuerySchema } from './api.js';
import { displayNameSchema, USERNAME_MAX_LENGTH, usernameSchema } from './auth.js';

/** Usernames nobody can take, to avoid impersonating the service or clashing with routes. */
export const RESERVED_USERNAMES = [
  'admin',
  'administrator',
  'api',
  'connect',
  'help',
  'me',
  'moderator',
  'root',
  'security',
  'settings',
  'support',
  'system',
];

/** A username a person may choose: format rules plus not reserved. */
export const availableUsernameSchema = usernameSchema.refine(
  (username) => !RESERVED_USERNAMES.includes(username),
  'This username is reserved',
);

export const bioSchema = z
  .string()
  .trim()
  .max(LIMITS.bioMaxLength, `Bio must be at most ${LIMITS.bioMaxLength} characters`);

// ── Requests ────────────────────────────────────────────────────────────────

/** PATCH /me/profile: send only the fields that change. */
export const profileUpdateSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    username: availableUsernameSchema.optional(),
    bio: bioSchema.optional(),
    profileVisibility: z.enum(PROFILE_VISIBILITIES).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

/**
 * Privacy settings and what they do for other people:
 * - messagePermission: who may send you message requests (see MESSAGE_PERMISSIONS).
 * - onlineStatusVisibility: who sees whether you're online right now.
 * - lastSeenVisibility: who sees when you were last online.
 * - readReceipts: when off, people don't see that you read their messages, and you don't see
 *   their read receipts either (it works both ways).
 * - typingIndicators: when off, people don't see you typing, and you don't see them typing.
 */
export const privacySettingsSchema = z.object({
  messagePermission: z.enum(MESSAGE_PERMISSIONS),
  onlineStatusVisibility: z.enum(PRESENCE_AUDIENCES),
  lastSeenVisibility: z.enum(PRESENCE_AUDIENCES),
  readReceipts: z.boolean(),
  typingIndicators: z.boolean(),
});

/** PATCH /me/privacy: send only the settings that change. */
export const privacySettingsUpdateSchema = privacySettingsSchema
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

/** GET /users/search?q=: "@Ada_L" and "ada_l" both search for "ada_l". */
export const userSearchQuerySchema = cursorPaginationQuerySchema.extend({
  q: z
    .string()
    .trim()
    .transform((value) => value.replace(/^@/, '').toLowerCase())
    .pipe(
      z
        .string()
        .min(1, 'Enter a username to search for')
        .max(USERNAME_MAX_LENGTH, `Usernames are at most ${USERNAME_MAX_LENGTH} characters`)
        .regex(/^[a-z0-9_]+$/, 'Usernames only contain letters, numbers and underscores'),
    ),
});

export const createMessageRequestSchema = z.object({
  username: usernameSchema,
  note: z
    .string()
    .trim()
    .max(
      LIMITS.messageRequestNoteMaxLength,
      `Messages are at most ${LIMITS.messageRequestNoteMaxLength} characters`,
    )
    .optional(),
});

export const messageRequestListQuerySchema = cursorPaginationQuerySchema.extend({
  box: z.enum(['received', 'sent']),
  status: z.enum(MESSAGE_REQUEST_STATUSES).optional(),
});

export const blockUserSchema = z.object({ username: usernameSchema });

// ── Responses ───────────────────────────────────────────────────────────────

/** Minimal public card: safe to show anyone who may know the person exists. */
export const userCardSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  profileVisibility: z.enum(PROFILE_VISIBILITIES),
});

/**
 * Why the viewer can't send a message request right now (null when they can):
 * self, blocked_by_you, already_connected, request_pending, not_accepting.
 */
export const REQUEST_UNAVAILABLE_REASONS = [
  'self',
  'blocked_by_you',
  'already_connected',
  'request_pending',
  'not_accepting',
];

/**
 * Another person's profile as the viewer may see it. It never contains email addresses,
 * account status, roles, sessions or sign-in history. Hidden fields are null:
 * bio and joinedAt are null when `access` is "limited" (private profile, not connected);
 * presence fields are null when that person's privacy settings hide them from the viewer.
 */
export const publicProfileSchema = userCardSchema.extend({
  access: z.enum(['full', 'limited']),
  bio: z.string().nullable(),
  joinedAt: z.iso.datetime().nullable(),
  presence: z.object({
    online: z.boolean().nullable(),
    lastSeenAt: z.iso.datetime().nullable(),
  }),
  relationship: z.object({
    isSelf: z.boolean(),
    connected: z.boolean(),
    blockedByYou: z.boolean(),
    outgoingRequest: z
      .object({ id: z.string(), status: z.enum(MESSAGE_REQUEST_STATUSES) })
      .nullable(),
    incomingRequest: z.object({ id: z.string() }).nullable(),
    canSendRequest: z.boolean(),
    requestUnavailableReason: z.enum(REQUEST_UNAVAILABLE_REASONS).nullable(),
  }),
});

/** Your own profile, including your private settings. */
export const ownProfileSchema = userCardSchema.extend({
  bio: z.string(),
  joinedAt: z.iso.datetime(),
  privacy: privacySettingsSchema,
});

export const messageRequestSchema = z.object({
  id: z.string(),
  status: z.enum(MESSAGE_REQUEST_STATUSES),
  direction: z.enum(['received', 'sent']),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
  respondedAt: z.iso.datetime().nullable(),
  /** The sender for received requests, the recipient for sent ones. */
  otherUser: userCardSchema,
});

export const blockedUserSchema = z.object({
  user: userCardSchema,
  blockedAt: z.iso.datetime(),
});
