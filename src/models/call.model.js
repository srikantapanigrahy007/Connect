import { CALL_END_REASONS, CALL_STATUSES, CALL_TYPES, callStatusMachine } from '#shared';
import { model, Schema } from 'mongoose';
import { stateMachinePlugin } from './plugins/state-machine.js';

/**
 * A one-to-one call. The server is the only authority on its state; clients ask for
 * transitions (services/call.service.js), each one a compare-and-set on `status`.
 *
 * Concurrency: while a call is active (ringing or ongoing) `lock` holds both participants' ids.
 * The unique multikey index on `lock` means nobody can be in two active calls, so two people
 * calling each other at the same moment (or one person from two tabs) produce exactly one call.
 * Finishing a call removes `lock` and the signaling fields.
 *
 * No media and no signaling payloads are ever stored.
 */
const callSchema = new Schema(
  {
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    caller: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    callee: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** "video" once either person turned their camera on. */
    type: { type: String, enum: [...CALL_TYPES], required: true },
    status: { type: String, enum: [...CALL_STATUSES], required: true, default: 'ringing' },
    /** Idempotency key of the start request (per caller). */
    clientCallId: { type: String, required: true, maxlength: 64 },
    /** [caller, callee] while active; absent afterwards (see above). */
    lock: { type: [{ type: Schema.Types.ObjectId }], default: undefined },
    /** Unanswered by then: missed. */
    ringsUntil: { type: Date, default: null },
    // The device (session + socket) each side uses; signaling goes only between these two.
    callerSession: { type: Schema.Types.ObjectId, default: null },
    callerSocket: { type: String, maxlength: 64, default: null },
    calleeSession: { type: Schema.Types.ObjectId, default: null },
    calleeSocket: { type: String, maxlength: 64, default: null },
    answeredAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    durationSeconds: { type: Number, min: 0, default: null },
    endReason: { type: String, enum: [...CALL_END_REASONS, null], default: null },
    endedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

callSchema.pre('validate', function () {
  if (this.caller && this.callee && this.caller.equals(this.callee)) {
    throw new Error('A call needs two different people');
  }
});

// At most one active call per person (see above).
callSchema.index(
  { lock: 1 },
  { unique: true, partialFilterExpression: { lock: { $exists: true } } },
);
// Idempotent starts.
callSchema.index({ caller: 1, clientCallId: 1 }, { unique: true });
// "My calls", newest first (either side).
callSchema.index({ caller: 1, _id: -1 });
callSchema.index({ callee: 1, _id: -1 });
// The sweep: unanswered calls past their ring time, and long-running calls.
callSchema.index({ status: 1, ringsUntil: 1 });
callSchema.index({ conversation: 1, _id: -1 });

callSchema.plugin(stateMachinePlugin, { path: 'status', machine: callStatusMachine });

export const Call = model('Call', callSchema);
