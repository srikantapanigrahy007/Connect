import { model, Schema } from 'mongoose';

/**
 * A device's published one-time key or fallback key (Phase 15, Stage B, checkpoint C). PUBLIC
 * material only: the signed key object exactly as the crypto library produced it (signature
 * verified against the device's registered Ed25519 key before storing).
 *
 * One-time keys are single use. A claim is one atomic update (`claimedAt: null` → now) on one
 * document, so concurrent claims can never receive the same key. Claimed keys are KEPT (as
 * markers) rather than deleted: a retried upload after a lost response re-sends the same key ids,
 * and the unique (user, deviceId, fallback, keyId) index then makes sure an already-claimed key can never
 * be stored and handed out again. They are removed with their device or account.
 *
 * Fallback keys (`fallback: true`) are served only when a device has no unclaimed one-time key;
 * they may be served more than once (that is their purpose) and are replaced by the next fallback
 * key the device uploads.
 */
const e2eeOneTimeKeySchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deviceId: { type: String, required: true, match: /^[A-Z]{10}$/ },
    /** `signed_curve25519:<id>` */
    keyId: { type: String, required: true, maxlength: 80 },
    /** The signed key object ({ key, signatures[, fallback] }). */
    signedKey: { type: Schema.Types.Mixed, required: true },
    fallback: { type: Boolean, required: true, default: false },
    /** One-time keys: when it was handed out (null = still available). */
    claimedAt: { type: Date, default: null },
    claimedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** Fallback keys: when it was last served (set = used: tells the device to make a new one). */
    usedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);

// A key id is stored once per device and kind: duplicates and replays of claimed keys are
// impossible. The library numbers fallback keys separately from one-time keys (verified with
// 18.9.0: the first fallback id equals an early one-time key id), hence `fallback` in the key.
e2eeOneTimeKeySchema.index({ user: 1, deviceId: 1, fallback: 1, keyId: 1 }, { unique: true });
// Claiming: the oldest unclaimed key of a device; counting a device's available keys.
e2eeOneTimeKeySchema.index({ user: 1, deviceId: 1, fallback: 1, claimedAt: 1, _id: 1 });

export const E2eeOneTimeKey = model('E2eeOneTimeKey', e2eeOneTimeKeySchema);
