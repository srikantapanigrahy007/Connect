import { model, Schema } from 'mongoose';

/**
 * One person's private state for one message: starred, and/or deleted for them ("delete for
 * me"). The other participant never sees it, and the shared message is untouched.
 */
const messageFlagSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    message: { type: Schema.Types.ObjectId, ref: 'Message', required: true },
    starredAt: { type: Date, default: null },
    hiddenAt: { type: Date, default: null },
  },
  { timestamps: true },
);

messageFlagSchema.index({ user: 1, message: 1 }, { unique: true });
// "My starred messages in this conversation", and flag changes for reconnection sync.
messageFlagSchema.index({ user: 1, conversation: 1, starredAt: -1 });
messageFlagSchema.index({ user: 1, conversation: 1, updatedAt: 1 });

export const MessageFlag = model('MessageFlag', messageFlagSchema);
