import { model, Schema } from 'mongoose';

/** Hard limit of registered devices per account, enforced by the (user, slot) unique index. */
export const MAX_E2EE_DEVICES_PER_USER = 10;

/**
 * A registered end-to-end encryption device (Phase 15, Stage B, checkpoint B): one browser
 * profile of one account. Holds PUBLIC material only: the device's signed key object exactly as
 * the crypto library produced it (verified by services/e2ee.service.js before storing), plus its
 * two public keys as separate fields for uniqueness. Private keys never reach the server.
 *
 * Keys are immutable: a device id keeps its keys for life; new keys mean a new device id.
 */
const e2eeDeviceSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deviceId: { type: String, required: true, match: /^[A-Z]{10}$/ },
    /** The signed `device_keys` object (user_id, device_id, algorithms, keys, signatures). */
    deviceKeys: { type: Schema.Types.Mixed, required: true },
    ed25519: { type: String, required: true, match: /^[A-Za-z0-9+/]{43}$/ },
    curve25519: { type: String, required: true, match: /^[A-Za-z0-9+/]{43}$/ },
    /**
     * 0 … MAX_E2EE_DEVICES_PER_USER - 1. Each device holds one slot of its account; the unique
     * (user, slot) index is what enforces the device limit, also under concurrent registrations.
     * Records registered before slots existed have none until they're assigned one (see
     * services/e2ee.service.js and scripts/e2ee-device-slots.js); they are never dropped.
     */
    slot: { type: Number, min: 0, max: MAX_E2EE_DEVICES_PER_USER - 1 },
    /** The Connect session that registered it (audit only). */
    registeredBySession: { type: Schema.Types.ObjectId, ref: 'Session', default: null },
    /**
     * The highest to-device seq this device has acknowledged. New events are numbered above it
     * even after its queue was emptied, so numbering never goes back below an acknowledgment.
     */
    toDeviceAckedSeq: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true, minimize: false },
);

// One record per device of an account.
e2eeDeviceSchema.index({ user: 1, deviceId: 1 }, { unique: true });
// A public key belongs to exactly one device: no copying another device's (or user's) identity.
e2eeDeviceSchema.index({ ed25519: 1 }, { unique: true });
e2eeDeviceSchema.index({ curve25519: 1 }, { unique: true });
// The device limit: one device per slot per account. Partial, so records that don't have a slot
// yet are neither indexed nor rejected when the index is built.
e2eeDeviceSchema.index(
  { user: 1, slot: 1 },
  { unique: true, partialFilterExpression: { slot: { $type: 'number' } } },
);

export const E2eeDevice = model('E2eeDevice', e2eeDeviceSchema);
