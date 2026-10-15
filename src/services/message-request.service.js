import { messageRequestStatusMachine } from '#shared';
import { isValidObjectId } from 'mongoose';
import { Connection } from '../models/connection.model.js';
import { MessageRequest } from '../models/message-request.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { pairKey } from '../utils/pair-key.js';
import {
  isBlockedEitherWay,
  loadRelationship,
  requestUnavailableReason,
  VISIBLE_ACCOUNT_STATUSES,
} from './policy.js';
import { PUBLIC_USER_FIELDS, toUserCard } from './user-dto.js';

const personNotFound = () => new AppError(404, 'NOT_FOUND', "We couldn't find that person.");
const requestNotFound = () => new AppError(404, 'NOT_FOUND', 'That request no longer exists.');

/** The error for each reason a request can't be sent (see requestUnavailableReason). */
function unavailableError(reason, username) {
  switch (reason) {
    case 'self':
      return AppError.badRequest("You can't send a message request to yourself.");
    case 'blocked_by_you':
      return new AppError(409, 'CONFLICT', `Unblock @${username} to send a message request.`);
    case 'already_connected':
      return new AppError(409, 'ALREADY_CONNECTED', `You're already connected with @${username}.`);
    case 'request_pending':
      return new AppError(
        409,
        'REQUEST_ALREADY_PENDING',
        `There's already a pending request between you and @${username}.`,
      );
    default:
      return new AppError(
        403,
        'MESSAGING_NOT_ALLOWED',
        `@${username} isn't accepting message requests.`,
      );
  }
}

function toRequestDto(request, viewerId, otherUser) {
  return {
    id: String(request._id),
    status: request.status,
    direction: String(request.recipient) === String(viewerId) ? 'received' : 'sent',
    note: request.note ?? null,
    createdAt: request.createdAt.toISOString(),
    respondedAt: request.respondedAt ? request.respondedAt.toISOString() : null,
    otherUser: toUserCard(otherUser),
  };
}

async function withOtherUser(request, viewerId) {
  const otherId = String(request.sender) === String(viewerId) ? request.recipient : request.sender;
  const other = await User.findById(otherId, PUBLIC_USER_FIELDS).lean();
  return toRequestDto(request, viewerId, other ?? { _id: otherId, displayName: 'Deleted user' });
}

/**
 * Moves one of `userId`'s requests to `to`. `role` says which side may do it: the recipient
 * accepts and rejects, the sender cancels. Requests belonging to other people are reported as
 * not found so their existence isn't revealed.
 */
async function transition(userId, requestId, role, to) {
  if (!isValidObjectId(requestId)) throw requestNotFound();
  const owner = role === 'recipient' ? { recipient: userId } : { sender: userId };
  const updated = await MessageRequest.findOneAndUpdate(
    { _id: requestId, ...owner, status: { $in: messageRequestStatusMachine.sourcesFor(to) } },
    { $set: { status: to, respondedAt: new Date() } },
    { returnDocument: 'after' },
  ).lean();
  if (updated) return updated;
  if (await MessageRequest.exists({ _id: requestId, ...owner })) {
    throw new AppError(409, 'INVALID_STATE_TRANSITION', 'This request has already been answered.');
  }
  throw requestNotFound();
}

/**
 * Message requests: send, list, accept, reject, cancel.
 *
 * @param {{ notifications?: ReturnType<typeof import('./notification.service.js').createNotificationService> }} [deps]
 */
export function createMessageRequestService({ notifications } = {}) {
  return {
    async create(senderId, { username, note }) {
      const recipient = await User.findOne(
        { username, status: { $in: VISIBLE_ACCOUNT_STATUSES } },
        PUBLIC_USER_FIELDS,
      ).lean();
      if (!recipient) throw personNotFound();
      const relationship = await loadRelationship(senderId, recipient._id);
      // Someone who blocked you looks exactly like someone who doesn't exist.
      if (relationship.blockedByTarget) throw personNotFound();
      const reason = requestUnavailableReason(recipient, relationship);
      if (reason) throw unavailableError(reason, recipient.username);

      try {
        const request = await MessageRequest.create({
          sender: senderId,
          recipient: recipient._id,
          pairKey: pairKey(senderId, recipient._id),
          note: note || null,
        });
        await notifications?.requestReceived(request.toObject());
        return toRequestDto(request.toObject(), senderId, recipient);
      } catch (error) {
        // Two requests raced; the unique "one pending request per pair" index kept only one.
        if (error?.code === 11000) throw unavailableError('request_pending', recipient.username);
        throw error;
      }
    },

    async list(userId, { box, status, cursor, limit }) {
      if (cursor && !isValidObjectId(cursor)) throw AppError.badRequest('Invalid cursor');
      const requests = await MessageRequest.find({
        [box === 'received' ? 'recipient' : 'sender']: userId,
        ...(status ? { status } : {}),
        ...(cursor ? { _id: { $lt: cursor } } : {}),
      })
        .sort({ _id: -1 })
        .limit(limit + 1)
        .lean();
      const hasMore = requests.length > limit;
      const page = requests.slice(0, limit);
      const otherIds = page.map((request) =>
        box === 'received' ? request.sender : request.recipient,
      );
      const users = await User.find({ _id: { $in: otherIds } }, PUBLIC_USER_FIELDS).lean();
      const byId = new Map(users.map((user) => [String(user._id), user]));
      return {
        data: page.map((request) => {
          const otherId = box === 'received' ? request.sender : request.recipient;
          return toRequestDto(
            request,
            userId,
            byId.get(String(otherId)) ?? { _id: otherId, displayName: 'Deleted user' },
          );
        }),
        meta: { limit, hasMore, nextCursor: hasMore ? String(page.at(-1)._id) : null },
      };
    },

    /** The recipient accepts: permissions are checked again, then the pair becomes connected. */
    async accept(userId, requestId) {
      if (!isValidObjectId(requestId)) throw requestNotFound();
      const pending = await MessageRequest.findOne({ _id: requestId, recipient: userId }).lean();
      if (!pending) throw requestNotFound();
      if (await isBlockedEitherWay(pending.sender, pending.recipient)) {
        throw new AppError(403, 'MESSAGING_NOT_ALLOWED', 'You can no longer accept this request.');
      }
      const accepted = await transition(userId, requestId, 'recipient', 'accepted');
      await Connection.updateOne(
        { pairKey: accepted.pairKey },
        { $setOnInsert: { users: [accepted.sender, accepted.recipient], request: accepted._id } },
        { upsert: true },
      );
      await notifications?.requestAccepted(accepted);
      return withOtherUser(accepted, userId);
    },

    async reject(userId, requestId) {
      const rejected = await transition(userId, requestId, 'recipient', 'rejected');
      await notifications?.requestRejected(rejected);
      return withOtherUser(rejected, userId);
    },

    async cancel(userId, requestId) {
      const cancelled = await transition(userId, requestId, 'sender', 'cancelled');
      await notifications?.requestCancelled(cancelled);
      return withOtherUser(cancelled, userId);
    },
  };
}
