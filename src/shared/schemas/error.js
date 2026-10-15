import { z } from 'zod';

export const errorCodeSchema = z.enum([
  'BAD_REQUEST',
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_STATE_TRANSITION',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'FEATURE_UNAVAILABLE',
  'INTERNAL_ERROR',
  // Authentication and sessions
  'INVALID_CREDENTIALS',
  'ACCESS_TOKEN_EXPIRED',
  'SESSION_INVALID',
  'SESSION_REVOKED',
  /** The account signed in elsewhere; only one active session is allowed. */
  'SESSION_SUPERSEDED',
  'REFRESH_TOKEN_REUSED',
  /** A concurrent refresh already rotated this token; retry the original request. */
  'REFRESH_TOKEN_STALE',
  'REAUTHENTICATION_REQUIRED',
  'ACCOUNT_SUSPENDED',
  'INVALID_TOKEN',
  // Profiles, uploads and messaging permissions
  'UNSUPPORTED_MEDIA_TYPE',
  'INVALID_FILE',
  'MESSAGING_NOT_ALLOWED',
  'ALREADY_CONNECTED',
  'REQUEST_ALREADY_PENDING',
  // Messaging
  /** The idempotency key was already used for a different message. */
  'IDEMPOTENCY_KEY_REUSED',
  /** A read receipt for messages that were not delivered yet. */
  'NOT_DELIVERED',
  /** The edit or delete-for-everyone window has passed. */
  'ACTION_WINDOW_EXPIRED',
  'PIN_LIMIT_REACHED',
  /** Your (or the service's) attachment storage is full. */
  'STORAGE_QUOTA_EXCEEDED',
  // Groups
  'INVITE_INVALID',
  'INVITE_EXPIRED',
  'INVITE_EXHAUSTED',
  'INVITE_REVOKED',
  'GROUP_FULL',
  'POLL_CLOSED',
  'OWNER_MUST_TRANSFER',
  // Admin and moderation
  'ACCOUNT_BANNED',
  'REGISTRATION_DISABLED',
  /** The last active Super Admin can't be demoted, suspended or banned. */
  'LAST_SUPER_ADMIN',
  // Request integrity
  'CSRF_TOKEN_INVALID',
  'ORIGIN_NOT_ALLOWED',
  // End-to-end encryption: devices and keys
  'INVALID_DEVICE_SIGNATURE',
  'DEVICE_LIMIT_REACHED',
  'DEVICE_KEYS_IMMUTABLE',
  'DEVICE_KEYS_IN_USE',
  'DEVICE_NOT_REGISTERED',
  'INVALID_KEY_SIGNATURE',
  'KEY_ID_REUSED',
  // End-to-end encryption: device binding and to-device delivery
  /** This sign-in hasn't proved it holds that device's key. */
  'DEVICE_NOT_BOUND',
  'INVALID_BINDING',
  'INVALID_BINDING_SIGNATURE',
  'SENDER_KEY_MISMATCH',
  'RECIPIENT_KEY_MISMATCH',
  'TRANSACTION_ID_REUSED',
  'RECIPIENT_QUEUE_FULL',
  // End-to-end encrypted conversations
  'E2EE_DISABLED',
  'E2EE_DEVICE_REQUIRED',
  'E2EE_PEER_NOT_READY',
  /** The chat is end-to-end encrypted: readable content is refused. */
  'E2EE_REQUIRED',
  'E2EE_NOT_ENABLED',
]);

export const fieldIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});

/** Envelope returned by the API for every non-2xx response. */
export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.array(fieldIssueSchema).optional(),
    requestId: z.string().optional(),
  }),
});
