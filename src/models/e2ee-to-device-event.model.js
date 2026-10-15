import { model, Schema } from 'mongoose';

/** Undelivered events are kept this long, then MongoDB deletes them (TTL index). */
export const E2EE_TO_DEVICE_RETENTION_SECONDS = 30 * 86_400;

/**
 * One Olm-encrypted to-device event waiting for one device (Phase 15, Stage B, checkpoint D):
 * typically a Megolm room key, encrypted for that device only. The server can't read it.
 *
 * - `seq` orders a device's queue. It is assigned like message seqs (highest stored + 1, the
 *   unique { user, deviceId, seq } index rejects a concurrent insert that picked the same number,
 *   which then retries), so a device that has processed everything up to N never misses N + 1.
 * - `txnId` is the sending library's transaction id: a retried send stores nothing twice
 *   (unique per sender, sender device, txnId and recipient device).
 * - Events are deleted when the recipient device acknowledges them (after processing), when the
 *   device or account is removed, or after 30 days.
 */
const e2eeToDeviceEventSchema = new Schema(
  {
    /** Recipient. */
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deviceId: { type: String, required: true, match: /^[A-Z]{10}$/ },
    seq: { type: Number, required: true, min: 1 },
    /** Sender: always from the authenticated session and its bound device, never the client. */
    sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    senderDevice: { type: String, required: true, match: /^[A-Z]{10}$/ },
    txnId: { type: String, required: true, maxlength: 64 },
    type: { type: String, required: true },
    /** The Olm payload exactly as the sender's library produced it (validated, opaque). */
    content: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false },
);

// A device's queue in order; also the seq allocator.
e2eeToDeviceEventSchema.index({ user: 1, deviceId: 1, seq: 1 }, { unique: true });
// Idempotent sends: a retried transaction is stored once per recipient device.
e2eeToDeviceEventSchema.index(
  { sender: 1, senderDevice: 1, txnId: 1, user: 1, deviceId: 1 },
  { unique: true },
);
// 30-day retention for events nobody fetched.
e2eeToDeviceEventSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: E2EE_TO_DEVICE_RETENTION_SECONDS },
);

export const E2eeToDeviceEvent = model('E2eeToDeviceEvent', e2eeToDeviceEventSchema);
