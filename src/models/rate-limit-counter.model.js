import { model, Schema } from 'mongoose';

/** Fixed-window rate-limit counter shared by every API instance (no Redis needed). */
const rateLimitCounterSchema = new Schema({
  key: { type: String, required: true },
  hits: { type: Number, required: true, min: 0 },
  resetAt: { type: Date, required: true },
});

rateLimitCounterSchema.index({ key: 1 }, { unique: true });
rateLimitCounterSchema.index({ resetAt: 1 }, { expireAfterSeconds: 0 });

export const RateLimitCounter = model('RateLimitCounter', rateLimitCounterSchema);
