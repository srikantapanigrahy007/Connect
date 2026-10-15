import { z } from 'zod';
import { ACCOUNT_STATUSES, AUTH_METHODS, USER_ROLES } from '../domain/enums.js';

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const emailSchema = z
  .string()
  .trim()
  .min(1, 'Enter your email address')
  .max(254, 'Email address is too long')
  .pipe(z.email('Enter a valid email address'))
  .transform((email) => email.toLowerCase());

/** Lowercase letters, numbers and underscores; must start with a letter. */
export const usernameSchema = z
  .string()
  .trim()
  .min(USERNAME_MIN_LENGTH, `Username must be at least ${USERNAME_MIN_LENGTH} characters`)
  .max(USERNAME_MAX_LENGTH, `Username must be at most ${USERNAME_MAX_LENGTH} characters`)
  .regex(
    /^[a-z][a-z0-9_]*$/,
    'Use lowercase letters, numbers and underscores, starting with a letter',
  );

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter your name')
  .max(50, 'Name must be at most 50 characters');

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`);

export const loginRequestSchema = z.object({
  email: emailSchema,
  // Login only checks presence; strength rules apply at registration.
  password: z.string().min(1, 'Enter your password').max(PASSWORD_MAX_LENGTH),
});

export const registerRequestSchema = z.object({
  displayName: displayNameSchema,
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
});

export const forgotPasswordRequestSchema = z.object({
  email: emailSchema,
});

/** Opaque single-use tokens from email links (base64url). */
export const emailLinkTokenSchema = z
  .string()
  .trim()
  .min(20, 'This link is invalid')
  .max(128, 'This link is invalid')
  .regex(/^[A-Za-z0-9_-]+$/, 'This link is invalid');

export const resetPasswordRequestSchema = z.object({
  token: emailLinkTokenSchema,
  password: passwordSchema,
});

export const verifyEmailRequestSchema = z.object({ token: emailLinkTokenSchema });

export const changePasswordRequestSchema = z.object({
  /** Required when the account already has a password. */
  currentPassword: z.string().max(PASSWORD_MAX_LENGTH).optional(),
  newPassword: passwordSchema,
});

export const reauthenticateRequestSchema = z.object({
  password: z.string().min(1, 'Enter your password').max(PASSWORD_MAX_LENGTH),
});

/** The signed-in user as returned by the auth endpoints. Never contains secrets. */
export const authUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  status: z.enum(ACCOUNT_STATUSES),
  role: z.enum(USER_ROLES),
  hasPassword: z.boolean(),
  googleLinked: z.boolean(),
  avatarUrl: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const sessionInfoSchema = z.object({
  id: z.string(),
  authMethod: z.enum(AUTH_METHODS),
  /** When the user last proved their identity (sign-in or re-authentication). */
  authenticatedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  accessTokenExpiresAt: z.iso.datetime(),
});

export const authSessionSchema = z.object({ user: authUserSchema, session: sessionInfoSchema });

export const authProvidersSchema = z.object({ google: z.boolean() });

export const csrfTokenSchema = z.object({ csrfToken: z.string() });

/** Real-time events the server sends about the current session. */
export const SESSION_SOCKET_EVENTS = { revoked: 'session:revoked' };
