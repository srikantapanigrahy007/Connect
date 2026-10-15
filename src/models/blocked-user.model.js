import { model, Schema } from 'mongoose';

/** `blocker` has blocked `blocked`. Blocking works both ways for requests and messages. */
const blockedUserSchema = new Schema(
  {
    blocker: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    blocked: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

blockedUserSchema.pre('validate', function () {
  if (this.blocker && this.blocked && this.blocker.equals(this.blocked)) {
    throw new Error('You cannot block yourself');
  }
});

// One record per pair and direction; also serves "is A blocked by B" lookups both ways.
blockedUserSchema.index({ blocker: 1, blocked: 1 }, { unique: true });
blockedUserSchema.index({ blocked: 1, blocker: 1 });
blockedUserSchema.index({ blocker: 1, createdAt: -1 });

export const BlockedUser = model('BlockedUser', blockedUserSchema);
