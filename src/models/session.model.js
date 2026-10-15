import { AUTH_METHODS, CLIENT_TYPES, SESSION_REVOCATION_REASONS } from '#shared';
import { model, Schema } from 'mongoose';
import { TOKEN_HASH_PATTERN } from '../security/tokens.js';

const tokenHash = {
  type: String,
  match: TOKEN_HASH_PATTERN,
  select: false,
};

/**
 * A signed-in device. Only SHA-256 hashes of refresh tokens are stored; the raw token exists
 * only in the client's HttpOnly cookie. A session is valid only while it is not revoked, not
 * expired, and it is the user's `activeSessionId`.
 */
const sessionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    refreshTokenHash: { ...tokenHash, required: true },
    /** The token rotated out most recently, kept to detect refresh-token reuse. */
    previousRefreshTokenHash: { ...tokenHash, default: null },
    refreshTokenRotatedAt: { type: Date, default: null },
    authMethod: { type: String, enum: [...AUTH_METHODS], required: true },
    clientType: { type: String, enum: [...CLIENT_TYPES], required: true, default: 'web' },
    /** Last time the user proved their identity; gates sensitive account changes. */
    authenticatedAt: { type: Date, required: true },
    lastUsedAt: { type: Date, required: true },
    /** Absolute expiry. MongoDB deletes the document once it passes (TTL index). */
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, enum: [...SESSION_REVOCATION_REASONS], default: null },
    userAgent: { type: String, maxlength: 512, default: null },
    ipAddress: { type: String, maxlength: 64, default: null },
    /**
     * The end-to-end encryption device this session proved it holds (it signed a challenge with
     * the device's registered key; see e2ee.service.js). Only this device's to-device queue is
     * readable through this session, and only it may send encrypted content through it.
     */
    e2eeDeviceId: { type: String, match: /^[A-Z]{10}$/, default: null },
  },
  { timestamps: true },
);

sessionSchema.index({ refreshTokenHash: 1 }, { unique: true });
sessionSchema.index(
  { previousRefreshTokenHash: 1 },
  { partialFilterExpression: { previousRefreshTokenHash: { $type: 'string' } } },
);
sessionSchema.index({ user: 1, revokedAt: 1, _id: -1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Admin dashboard: active users (sessions used within a window).
sessionSchema.index({ lastUsedAt: -1 });

export const Session = model('Session', sessionSchema);
