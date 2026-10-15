import { AUTH_TOKEN_PURPOSES } from '#shared';
import { model, Schema } from 'mongoose';
import { TOKEN_HASH_PATTERN } from '../security/tokens.js';

/** Single-use email-link token (verification, password reset). Only the hash is stored. */
const authTokenSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    purpose: { type: String, enum: [...AUTH_TOKEN_PURPOSES], required: true },
    tokenHash: { type: String, required: true, match: TOKEN_HASH_PATTERN },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

authTokenSchema.index({ tokenHash: 1 }, { unique: true });
authTokenSchema.index({ user: 1, purpose: 1 });
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AuthToken = model('AuthToken', authTokenSchema);
