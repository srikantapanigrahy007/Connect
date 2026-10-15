import { ATTACHMENT_KINDS, LIMITS } from '#shared';
import { model, Schema } from 'mongoose';

/** Lifecycle of a stored file. Every change is a compare-and-set on `status`. */
export const ATTACHMENT_LIFECYCLE = {
  /** Stored, not used by any message yet. Deleted by the reaper after ATTACHMENT_ORPHAN_MINUTES. */
  uploaded: 'uploaded',
  /** Used by at least one message (forwarding adds more messages using the same file). */
  attached: 'attached',
  /** No message uses it any more; the object is being removed (retried by the reaper). */
  deleting: 'deleting',
  deleted: 'deleted',
};

/**
 * Metadata of an uploaded file. The bytes live in object storage under `storageKey`, which the
 * server generates (never from the file name). Messages reference attachments; access is always
 * checked against those messages and the viewer's current membership.
 */
const attachmentSchema = new Schema(
  {
    uploader: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** The conversation it was uploaded for (it can only be attached there first). */
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    storageKey: { type: String, required: true, match: /^attachments\/[A-Za-z0-9_-]{32,64}$/ },
    kind: { type: String, enum: ATTACHMENT_KINDS, required: true },
    /** Detected from the file's content, not taken from the browser. */
    contentType: { type: String, required: true, maxlength: 128 },
    /** Sanitised display name. */
    originalName: { type: String, required: true, maxlength: LIMITS.attachmentFileNameMaxLength },
    size: { type: Number, required: true, min: 1, max: LIMITS.attachmentMaxBytes },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    status: {
      type: String,
      enum: Object.values(ATTACHMENT_LIFECYCLE),
      required: true,
      default: ATTACHMENT_LIFECYCLE.uploaded,
    },
    attachedAt: { type: Date, default: null },
    /**
     * Set just before a message stops using it (delete for everyone). Cleared once the
     * reference check ran; if the process stopped in between, the reaper finishes the job.
     */
    cleanupRequestedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

attachmentSchema.index({ storageKey: 1 }, { unique: true });
// The reaper: old unused uploads and stuck deletions.
attachmentSchema.index({ status: 1, updatedAt: 1 });
attachmentSchema.index(
  { cleanupRequestedAt: 1 },
  { partialFilterExpression: { cleanupRequestedAt: { $type: 'date' } } },
);

export const Attachment = model('Attachment', attachmentSchema);
