import { LIMITS } from '#shared';
import { model, Schema } from 'mongoose';

/**
 * A poll in a group, shown through its message (type "poll"). Closing is a compare-and-set on
 * `closedAt: null`. Votes live in PollVote (one document per person), so counts come from the
 * votes themselves and stay correct under concurrent voting.
 */
const pollSchema = new Schema(
  {
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    creator: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    question: { type: String, required: true, maxlength: LIMITS.pollQuestionMaxLength },
    options: {
      type: [
        new Schema(
          {
            id: { type: String, required: true, match: /^[a-z0-9]{1,16}$/ },
            text: { type: String, required: true, maxlength: LIMITS.pollOptionTextMaxLength },
          },
          { _id: false },
        ),
      ],
      validate: {
        validator: (options) =>
          options.length >= LIMITS.pollMinOptions && options.length <= LIMITS.pollMaxOptions,
        message: 'Invalid number of options',
      },
    },
    multiple: { type: Boolean, required: true, default: false },
    closedAt: { type: Date, default: null },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

pollSchema.index({ conversation: 1, createdAt: -1 });

export const Poll = model('Poll', pollSchema);

/**
 * One person's vote on one poll (their chosen option ids). The unique index makes a duplicate
 * vote impossible; changing a vote replaces `optionIds` in one atomic update.
 */
const pollVoteSchema = new Schema(
  {
    poll: { type: Schema.Types.ObjectId, ref: 'Poll', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    optionIds: { type: [String], required: true },
  },
  { timestamps: true },
);

pollVoteSchema.index({ poll: 1, user: 1 }, { unique: true });

export const PollVote = model('PollVote', pollVoteSchema);
