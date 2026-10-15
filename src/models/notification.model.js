import { CALL_TYPES, GROUP_ROLES, NOTIFICATION_TYPES } from '#shared';
import { model, Schema } from 'mongoose';

/** Notifications are kept this long after their latest activity, then removed by MongoDB. */
export const NOTIFICATION_RETENTION_SECONDS = 90 * 86_400;

/**
 * One notification for one person. Written only by services/notification.service.js, which
 * upserts on (recipient, dedupeKey) so retries, replays and races never create a second copy:
 * - `dedupeKey` names the thing the entry is about ("conversation:<id>", "request:<id>:received",
 *   "group:<id>:membership", …); a later event about the same thing refreshes the entry;
 * - `eventId` is the last event applied, so applying the same event again changes nothing;
 * - `lastSeq` (new messages) only grows, so a replayed or older message is never counted twice.
 *
 * Only references and a little display metadata are stored, never message text. Whether the
 * referenced conversation or group is still yours is checked each time the list is read.
 */
const notificationSchema = new Schema(
  {
    recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: [...NOTIFICATION_TYPES], required: true },
    dedupeKey: { type: String, required: true, maxlength: 200 },
    eventId: { type: String, required: true, maxlength: 100 },
    actor: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', default: null },
    request: { type: Schema.Types.ObjectId, ref: 'MessageRequest', default: null },
    /** Group name when the event happened (shown after you lose access to the group). */
    groupName: { type: String, maxlength: 100, default: null },
    role: { type: String, enum: [...GROUP_ROLES, null], default: null },
    callType: { type: String, enum: [...CALL_TYPES, null], default: null },
    /** message_received: new messages since you last read this entry. */
    count: { type: Number, min: 1, default: 1 },
    /** message_received: seq of the newest message counted. */
    lastSeq: { type: Number, min: 0, default: 0 },
    readAt: { type: Date, default: null },
    /** Latest activity; the list is sorted by it and retention counts from it. */
    activityAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// One entry per subject per person: the constraint behind every deduplicating upsert.
notificationSchema.index({ recipient: 1, dedupeKey: 1 }, { unique: true });
// "My notifications, newest first" (keyset pagination on activityAt, _id).
notificationSchema.index({ recipient: 1, activityAt: -1, _id: -1 });
// Unread list and unread count (readAt: null).
notificationSchema.index({ recipient: 1, readAt: 1, activityAt: -1 });
notificationSchema.index({ activityAt: 1 }, { expireAfterSeconds: NOTIFICATION_RETENTION_SECONDS });

export const Notification = model('Notification', notificationSchema);
