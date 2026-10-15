import { model, Schema } from 'mongoose';
import { TOKEN_HASH_PATTERN } from '../security/tokens.js';

/**
 * A group invitation. Only SHA-256 hashes of the link token and the short code are stored; the
 * secrets are shown once, to the admin who created it. `uses` is incremented with a conditional
 * update (`uses < maxUses`), so concurrent joins can never exceed the limit.
 */
const groupInviteSchema = new Schema(
  {
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tokenHash: { type: String, required: true, match: TOKEN_HASH_PATTERN, select: false },
    codeHash: { type: String, required: true, match: TOKEN_HASH_PATTERN, select: false },
    expiresAt: { type: Date, required: true },
    /** Null = unlimited until it expires. */
    maxUses: { type: Number, min: 1, default: null },
    uses: { type: Number, min: 0, default: 0 },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

groupInviteSchema.index({ tokenHash: 1 }, { unique: true });
groupInviteSchema.index({ codeHash: 1 }, { unique: true });
groupInviteSchema.index({ conversation: 1, createdAt: -1 });
// Expired invitations are removed a week after they expire.
groupInviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 86_400 });

export const GroupInvite = model('GroupInvite', groupInviteSchema);
