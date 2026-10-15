import { model, Schema } from 'mongoose';

/**
 * Bytes used by attachments, per uploader (`user:<id>`) and for the whole service (`total`).
 * Space is reserved with a conditional atomic $inc before storing a file, so concurrent uploads
 * can never exceed a quota, and released when the stored object is removed.
 */
const storageUsageSchema = new Schema({
  scope: { type: String, required: true },
  bytes: { type: Number, required: true, min: 0, default: 0 },
});

storageUsageSchema.index({ scope: 1 }, { unique: true });

export const StorageUsage = model('StorageUsage', storageUsageSchema);
