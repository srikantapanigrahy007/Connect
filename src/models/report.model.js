import {
  LIMITS,
  REPORT_REASONS,
  REPORT_RESOLUTION_ACTIONS,
  REPORT_STATUSES,
  REPORT_TARGET_TYPES,
  reportStatusMachine,
} from '#shared';
import { model, Schema } from 'mongoose';
import { stateMachinePlugin } from './plugins/state-machine.js';

/**
 * Evidence the reporter explicitly submitted: snapshots of messages they could see at the time.
 * Moderators see only this, never the rest of anyone's conversations.
 */
const evidenceSchema = new Schema(
  {
    message: { type: Schema.Types.ObjectId, ref: 'Message', required: true },
    sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sentAt: { type: Date, required: true },
    type: { type: String, required: true },
    text: { type: String, maxlength: LIMITS.messageTextMaxLength, default: '' },
    /** Attachment name and type only; the file itself isn't copied. */
    attachment: {
      type: new Schema({ name: String, kind: String, contentType: String }, { _id: false }),
      default: null,
    },
  },
  { _id: false },
);

/**
 * A report about a user, a message or a group. Status changes follow reportStatusMachine
 * (open → under_review → resolved | dismissed; closed reports can be reopened), each a
 * compare-and-set. One open report per reporter and target (partial unique index).
 */
const reportSchema = new Schema(
  {
    reporter: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    targetType: { type: String, enum: REPORT_TARGET_TYPES, required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    /** The person reported (the user, or the sender of the message); null for groups. */
    targetUser: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** Message reports: the conversation it was in. Group reports: the group. */
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', default: null },
    reason: { type: String, enum: REPORT_REASONS, required: true },
    details: { type: String, maxlength: LIMITS.reportDetailsMaxLength, default: '' },
    evidence: { type: [evidenceSchema], default: [] },
    status: { type: String, enum: REPORT_STATUSES, required: true, default: 'open' },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    resolution: {
      type: new Schema(
        {
          action: { type: String, enum: REPORT_RESOLUTION_ACTIONS, default: null },
          note: { type: String, maxlength: 1_000, default: '' },
          decidedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
          decidedAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true },
);

reportSchema.index(
  { reporter: 1, targetType: 1, targetId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['open', 'under_review'] } } },
);
reportSchema.index({ status: 1, createdAt: -1, _id: -1 });
reportSchema.index({ targetType: 1, targetId: 1 });
reportSchema.index({ reporter: 1, createdAt: -1 });

reportSchema.plugin(stateMachinePlugin, { path: 'status', machine: reportStatusMachine });

export const Report = model('Report', reportSchema);
