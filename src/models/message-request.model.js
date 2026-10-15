import { LIMITS, MESSAGE_REQUEST_STATUSES, messageRequestStatusMachine } from '#shared';
import { model, Schema } from 'mongoose';
import { stateMachinePlugin } from './plugins/state-machine.js';

/**
 * A request to start talking. Pending → accepted (creates a Connection), rejected, or cancelled.
 * Every transition is a compare-and-set on `status` (see the state-machine plugin).
 */
const messageRequestSchema = new Schema(
  {
    sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** Same for both directions (see utils/pair-key.js). */
    pairKey: { type: String, required: true },
    status: {
      type: String,
      enum: [...MESSAGE_REQUEST_STATUSES],
      required: true,
      default: 'pending',
    },
    note: {
      type: String,
      trim: true,
      maxlength: LIMITS.messageRequestNoteMaxLength,
      default: null,
    },
    respondedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

messageRequestSchema.pre('validate', function () {
  if (this.sender && this.recipient && this.sender.equals(this.recipient)) {
    throw new Error('A message request needs two different people');
  }
});

// At most one pending request per pair of people, in either direction.
messageRequestSchema.index(
  { pairKey: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);
// Inbox ("received") and outbox ("sent"), newest first, filterable by status.
messageRequestSchema.index({ recipient: 1, status: 1, _id: -1 });
messageRequestSchema.index({ sender: 1, status: 1, _id: -1 });

messageRequestSchema.plugin(stateMachinePlugin, {
  path: 'status',
  machine: messageRequestStatusMachine,
});

export const MessageRequest = model('MessageRequest', messageRequestSchema);
