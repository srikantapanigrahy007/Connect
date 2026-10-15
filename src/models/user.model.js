import {
  ACCOUNT_STATUSES,
  accountStatusMachine,
  LIMITS,
  MESSAGE_PERMISSIONS,
  PRESENCE_AUDIENCES,
  PROFILE_VISIBILITIES,
  USER_ROLES,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from '#shared';
import { model, Schema } from 'mongoose';
import { PASSWORD_HASH_PATTERN } from '../security/password.js';
import { stateMachinePlugin } from './plugins/state-machine.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isNotDeleted = function () {
  return this.status !== 'deleted';
};

/** Avatar files live in file storage (see services/storage.js); MongoDB keeps only the key. */
export const AVATAR_KEY_PATTERN = /^[A-Za-z0-9_-]{22,64}\.webp$/;

/**
 * Privacy settings. Older documents may lack some of these; always read them through
 * privacyOf() in services/policy.js, which fills in DEFAULT_PRIVACY.
 */
const privacySchema = new Schema(
  {
    messagePermission: { type: String, enum: [...MESSAGE_PERMISSIONS], default: 'everyone' },
    onlineStatusVisibility: {
      type: String,
      enum: [...PRESENCE_AUDIENCES],
      default: 'connections',
    },
    lastSeenVisibility: { type: String, enum: [...PRESENCE_AUDIENCES], default: 'connections' },
    readReceipts: { type: Boolean, default: true },
    typingIndicators: { type: Boolean, default: true },
  },
  { _id: false },
);

/**
 * Notification preferences (Phase 11). Older documents may lack them; read them through
 * notificationPreferencesOf() in services/notification.service.js.
 */
const notificationPreferencesSchema = new Schema(
  {
    enabled: { type: Boolean, default: true },
    messages: { type: Boolean, default: true },
    requests: { type: Boolean, default: true },
    groups: { type: Boolean, default: true },
    calls: { type: Boolean, default: true },
    desktop: { type: Boolean, default: false },
  },
  { _id: false },
);

const avatarSchema = new Schema(
  {
    key: { type: String, required: true, match: AVATAR_KEY_PATTERN },
    updatedAt: { type: Date, required: true },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    /** Lowercased. Null only for deleted accounts (personal data is scrubbed). */
    email: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 254,
      match: EMAIL_PATTERN,
      required: isNotDeleted,
      default: null,
    },
    emailVerifiedAt: { type: Date, default: null },
    username: {
      type: String,
      trim: true,
      lowercase: true,
      minlength: USERNAME_MIN_LENGTH,
      maxlength: USERNAME_MAX_LENGTH,
      match: /^[a-z][a-z0-9_]*$/,
      required: isNotDeleted,
      default: null,
    },
    displayName: { type: String, required: true, trim: true, minlength: 1, maxlength: 50 },
    /**
     * Argon2id hash, never a plaintext password; the validator rejects anything else.
     * Null for accounts that only sign in with Google. Excluded from queries by default.
     */
    passwordHash: {
      type: String,
      select: false,
      default: null,
      validate: {
        validator: (value) => value === null || PASSWORD_HASH_PATTERN.test(value),
        message: 'passwordHash must be an Argon2id hash',
      },
    },
    passwordChangedAt: { type: Date, default: null },
    /** Google account subject ("sub" claim). */
    googleId: { type: String, default: null },
    role: { type: String, enum: [...USER_ROLES], required: true, default: 'user' },
    status: {
      type: String,
      enum: [...ACCOUNT_STATUSES],
      required: true,
      default: 'pending_verification',
    },
    /**
     * The only session allowed to authenticate. Replacing it is a single atomic write, which is
     * what enforces one active session per account.
     */
    activeSessionId: { type: Schema.Types.ObjectId, ref: 'Session', default: null },
    lastLoginAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },

    // Profile
    bio: { type: String, trim: true, maxlength: LIMITS.bioMaxLength, default: '' },
    avatar: { type: avatarSchema, default: null },
    profileVisibility: {
      type: String,
      enum: [...PROFILE_VISIBILITIES],
      required: true,
      default: 'public',
    },
    privacy: { type: privacySchema, default: () => ({}) },
    notificationPreferences: { type: notificationPreferencesSchema, default: () => ({}) },
    /** When the user's last real-time connection closed (shown according to privacy settings). */
    lastSeenAt: { type: Date, default: null },
    /**
     * Conversations this person pinned (at most CONVERSATION_PIN_LIMIT). Reserving a place here
     * is one conditional update, so concurrent pins can't exceed the limit; the per-conversation
     * `members.pinnedAt` drives ordering.
     */
    pinnedChats: { type: [{ type: Schema.Types.ObjectId, ref: 'Conversation' }], default: [] },
  },
  { timestamps: true },
);

// Partial unique indexes let deleted accounts release their email and username.
userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);
userSchema.index(
  { username: 1 },
  { unique: true, partialFilterExpression: { username: { $type: 'string' } } },
);
userSchema.index(
  { googleId: 1 },
  { unique: true, partialFilterExpression: { googleId: { $type: 'string' } } },
);
userSchema.index({ status: 1, createdAt: -1 });
// Admin dashboard (new registrations) and the admin user list.
userSchema.index({ createdAt: -1 });
userSchema.index({ role: 1 });
// Partial username search ("^prefix" on the unique username index) filtered by visibility.
userSchema.index({ profileVisibility: 1, username: 1 });

userSchema.plugin(stateMachinePlugin, { path: 'status', machine: accountStatusMachine });

export const User = model('User', userSchema);
