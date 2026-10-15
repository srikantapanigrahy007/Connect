import { ENCRYPTION_SCHEMES, LIMITS, REACTION_EMOJI, STICKER_IDS } from '#shared';
import { model, Schema } from 'mongoose';

const reactionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    emoji: { type: String, enum: REACTION_EMOJI, required: true },
    reactedAt: { type: Date, required: true },
  },
  { _id: false },
);

/**
 * A message in a one-to-one conversation.
 *
 * - `seq` orders messages within a conversation. It is assigned when the message is inserted
 *   (highest stored seq + 1) and the unique { conversation, seq } index rejects a concurrent
 *   insert that picked the same number, which then retries. So seq N is only ever written after
 *   seq N - 1 is visible, and readers asking for "seq > X" never skip a message. Messages are
 *   never hard-deleted (that would leave a hole); "delete for everyone" leaves a tombstone.
 * - `clientMessageId` is the sender's idempotency key; { sender, clientMessageId } is unique, so
 *   a retried or duplicated submission can never create a second message.
 * - `sender` always comes from the authenticated session, never from the client.
 * - Shared state (text, edits, deletion, reactions) lives here and bumps `rev`. Per-person state
 *   (starred, deleted for me) lives in MessageFlag.
 */
const messageSchema = new Schema(
  {
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    seq: { type: Number, required: true, min: 1 },
    sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /**
     * One-to-one chats: the other participant, so unread counts are a single indexed count.
     * Null in groups (unread there = messages from others after your read position).
     */
    recipient: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    clientMessageId: { type: String, required: true, maxlength: 64 },
    type: {
      type: String,
      enum: ['text', 'attachment', 'sticker', 'poll', 'system'],
      required: true,
      default: 'text',
    },
    /** Message text, or an attachment caption (may be empty). Wiped when deleted for everyone. */
    text: { type: String, maxlength: LIMITS.messageTextMaxLength, default: '' },
    /**
     * "e2ee_v1": end-to-end encrypted. `encrypted` holds the Megolm payload exactly as the
     * sender's library produced it; `text` stays empty. The server can't read it.
     */
    encryption: { type: String, enum: ENCRYPTION_SCHEMES, default: 'none' },
    encrypted: {
      type: new Schema(
        {
          algorithm: { type: String, required: true },
          ciphertext: { type: String, required: true },
          device_id: { type: String, required: true },
          sender_key: { type: String, required: true },
          session_id: { type: String, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    attachment: { type: Schema.Types.ObjectId, ref: 'Attachment', default: null },
    sticker: { type: String, enum: [...STICKER_IDS, null], default: null },
    poll: { type: Schema.Types.ObjectId, ref: 'Poll', default: null },
    /** Events shown in the history: group changes (created, member added, …) and calls. */
    system: {
      type: new Schema(
        {
          kind: { type: String, required: true },
          actor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
          target: { type: Schema.Types.ObjectId, ref: 'User', default: null },
          name: { type: String, maxlength: 60, default: null },
          /** kind "call": a snapshot of the finished call (actor = caller, target = callee). */
          call: {
            type: new Schema(
              {
                id: { type: Schema.Types.ObjectId, ref: 'Call', required: true },
                type: { type: String, enum: ['audio', 'video'], required: true },
                status: { type: String, required: true },
                durationSeconds: { type: Number, min: 0, default: null },
                endReason: { type: String, default: null },
              },
              { _id: false },
            ),
            default: null,
          },
        },
        { _id: false },
      ),
      default: null,
    },
    /** The message this one answers (same conversation). */
    replyTo: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
    /**
     * Where a forwarded message was copied from. Kept for integrity only; clients just see
     * "Forwarded", so the original conversation and sender are never revealed to the recipient.
     */
    forwardedFrom: {
      type: new Schema(
        { message: Schema.Types.ObjectId, sender: Schema.Types.ObjectId },
        { _id: false },
      ),
      default: null,
    },
    editedAt: { type: Date, default: null },
    editCount: { type: Number, min: 0, default: 0 },
    deletedAt: { type: Date, default: null },
    reactions: { type: [reactionSchema], default: [] },
    /** Bumped on every shared change, so clients can keep the newest version. */
    rev: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true },
);

messageSchema.pre('validate', function () {
  if (this.sender && this.recipient && this.sender.equals(this.recipient)) {
    throw new Error('A message needs a sender and a different recipient');
  }
  if (this.deletedAt) return;
  if (this.encryption === 'e2ee_v1') {
    if (!this.encrypted || this.text)
      throw new Error('An encrypted message carries only ciphertext');
    if (this.type === 'attachment' && !this.attachment) throw new Error('Attachment missing');
    return;
  }
  if (this.type === 'text' && !this.text) throw new Error('A text message needs text');
  if (this.type === 'attachment' && !this.attachment) throw new Error('Attachment missing');
  if (this.type === 'sticker' && !this.sticker) throw new Error('Sticker missing');
  if (this.type === 'poll' && !this.poll) throw new Error('Poll missing');
  if (this.type === 'system' && !this.system) throw new Error('System event missing');
});

// Chronological history and gap-free synchronisation; also the seq allocator.
messageSchema.index({ conversation: 1, seq: 1 }, { unique: true });
// Idempotency: one message per sender and client message id.
messageSchema.index({ sender: 1, clientMessageId: 1 }, { unique: true });
// Unread counts: messages to a person after their read position.
messageSchema.index({ conversation: 1, recipient: 1, seq: 1 });
// Changes since a time (edits, deletions, reactions) for reconnection sync.
messageSchema.index({ conversation: 1, updatedAt: 1 });
// Admin dashboard: messages per period.
messageSchema.index({ createdAt: -1 });
// "Does any message still use this attachment?" before deleting the stored object.
messageSchema.index(
  { attachment: 1 },
  { partialFilterExpression: { attachment: { $type: 'objectId' } } },
);

export const Message = model('Message', messageSchema);
