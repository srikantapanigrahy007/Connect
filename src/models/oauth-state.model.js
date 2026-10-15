import { model, Schema } from 'mongoose';
import { TOKEN_HASH_PATTERN } from '../security/tokens.js';

/**
 * Pending OAuth authorization (10 minutes, single use). The `state` value and the browser
 * binding cookie are stored only as hashes; the PKCE verifier and nonce never leave the server.
 */
const oauthStateSchema = new Schema(
  {
    stateHash: { type: String, required: true, match: TOKEN_HASH_PATTERN },
    bindingHash: { type: String, required: true, match: TOKEN_HASH_PATTERN },
    codeVerifier: { type: String, required: true },
    nonce: { type: String, required: true },
    intent: { type: String, enum: ['login', 'reauth'], required: true },
    /** For re-authentication: the signed-in user who started the flow. */
    user: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    returnTo: { type: String, required: true, maxlength: 512 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

oauthStateSchema.index({ stateHash: 1 }, { unique: true });
oauthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OAuthState = model('OAuthState', oauthStateSchema);
