import { GROUP_ROLES, LIMITS } from '#shared';
import { model, Schema } from 'mongoose';

/** Receipt positions of one participant (see "Receipts" in the README). */
const memberSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** Groups only: owner (exactly one), admin or member. Null in one-to-one chats. */
    role: { type: String, enum: [...GROUP_ROLES, null], default: null },
    joinedAt: { type: Date, default: null },
    /** This person has received every message up to this seq. Only ever increases. */
    lastDeliveredSeq: { type: Number, min: 0, default: 0 },
    /** This person has read every message up to this seq (never above lastDeliveredSeq). */
    lastReadSeq: { type: Number, min: 0, default: 0 },
    /** Seq of the newest message this person received (for the "unread" filter). */
    lastReceivedSeq: { type: Number, min: 0, default: 0 },

    // This person's own chat settings (Phase 8). Only ever updated through their own entry.
    pinnedAt: { type: Date, default: null },
    favoriteAt: { type: Date, default: null },
    archivedAt: { type: Date, default: null },
    /** Muted until this time (far future = until unmuted). */
    mutedUntil: { type: Date, default: null },
    /** "Mark as unread": shown as unread until this person reads the chat again. */
    markedUnread: { type: Boolean, default: false },
    /** Removed from this person's list; it comes back with the next message. */
    hiddenAt: { type: Date, default: null },
  },
  { _id: false },
);

const lastMessageSchema = new Schema(
  {
    message: { type: Schema.Types.ObjectId, ref: 'Message', required: true },
    seq: { type: Number, required: true, min: 1 },
    sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    preview: { type: String, required: true, maxlength: 200 },
    createdAt: { type: Date, required: true },
  },
  { _id: false },
);

const pinSchema = new Schema(
  {
    message: { type: Schema.Types.ObjectId, ref: 'Message', required: true },
    seq: { type: Number, required: true, min: 1 },
    sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    preview: { type: String, required: true, maxlength: 200 },
    pinnedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    pinnedAt: { type: Date, required: true },
  },
  { _id: false },
);

/**
 * A one-to-one conversation. Exactly two distinct participants, at most one conversation per
 * pair (unique `pairKey`), created with an upsert so concurrent "open" requests converge on one
 * document. Messages live in their own collection (see message.model.js).
 */
const conversationSchema = new Schema(
  {
    type: { type: String, enum: ['direct', 'group'], required: true, default: 'direct' },
    /**
     * Direct: "smallerId:largerId" (utils/pair-key.js), the same whoever opens it. Groups:
     * "group:<id>", so the existing unique index needs no change.
     */
    pairKey: { type: String, required: true },
    /**
     * The current members' ids: exactly two (sorted) for direct chats; 0–256 for groups (0 once
     * a group is deleted). Every access check is "participants contains you", so people who
     * leave or are removed lose access at once.
     */
    participants: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      required: true,
      validate: {
        validator(users) {
          const distinct = new Set(users.map(String)).size === users.length;
          if (this.type === 'group') return distinct && users.length <= LIMITS.groupMaxMembers;
          return distinct && users.length === 2;
        },
        message: 'Invalid participants for this conversation type',
      },
    },
    members: { type: [memberSchema], required: true },
    /** Groups only. */
    group: {
      type: new Schema(
        {
          name: { type: String, required: true, trim: true, maxlength: LIMITS.groupNameMaxLength },
          description: {
            type: String,
            trim: true,
            maxlength: LIMITS.groupDescriptionMaxLength,
            default: '',
          },
          avatar: {
            type: new Schema({ key: String, updatedAt: Date }, { _id: false }),
            default: null,
          },
          createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
          /**
           * Suspended by a moderator: read-only for members (no posting, joining, inviting or
           * changes) until unsuspended. Membership and history are kept.
           */
          suspendedAt: { type: Date, default: null },
          suspendedReason: { type: String, maxlength: 500, default: null },
          /** Deleted by the owner: no participants remain and nobody can open it. */
          deletedAt: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
    /** Summary of the newest message, for the conversation list. Null until the first message. */
    lastMessage: { type: lastMessageSchema, default: null },
    /**
     * Pinned messages, oldest pin first. The limit (PINNED_MESSAGES_LIMIT) is enforced by the
     * update filter itself, so concurrent pins can never exceed it.
     */
    pins: { type: [pinSchema], default: [] },
    /**
     * Direct chats only: switched to end-to-end encryption by one of the two (opt-in, never
     * switched back, so nobody can silently downgrade it). From then on only encrypted messages
     * are accepted.
     */
    e2ee: {
      type: new Schema(
        {
          enabledAt: { type: Date, required: true },
          enabledBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    /** Time of the newest message (or creation). The conversation list is sorted by it. */
    lastActivityAt: { type: Date, required: true },
  },
  { timestamps: true },
);

conversationSchema.pre('validate', function () {
  if (this.type === 'group') {
    if (!this.group) throw new Error('A group needs its details');
    const owners = (this.members ?? []).filter((member) => member.role === 'owner').length;
    if ((this.participants ?? []).length > 0 && owners !== 1) {
      throw new Error('A group has exactly one owner');
    }
  }
  const participants = (this.participants ?? []).map(String);
  const members = (this.members ?? []).map((member) => String(member.user));
  if (participants.length !== members.length || !participants.every((id) => members.includes(id))) {
    throw new Error('Conversation members must match its participants');
  }
});

conversationSchema.index({ pairKey: 1 }, { unique: true });
// Admin dashboard counts and group search.
conversationSchema.index({ type: 1, createdAt: -1 });
// "My conversations, most recent activity first" (multikey on participants).
conversationSchema.index({ participants: 1, lastActivityAt: -1, _id: -1 });

export const Conversation = model('Conversation', conversationSchema);
