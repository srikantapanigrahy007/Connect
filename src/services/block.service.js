import { isValidObjectId } from 'mongoose';
import { BlockedUser } from '../models/blocked-user.model.js';
import { MessageRequest } from '../models/message-request.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { pairKey } from '../utils/pair-key.js';
import { VISIBLE_ACCOUNT_STATUSES } from './policy.js';
import { PUBLIC_USER_FIELDS, toUserCard } from './user-dto.js';

/**
 * Blocking. While either person has blocked the other they can't see each other's profiles,
 * find each other in search, or send requests or messages. Blocking cancels any pending
 * request between them.
 */
/**
 * @param {{ onChange?: (a: string, b: string) => Promise<void>, onBlock?: (a: string, b: string) => Promise<void> }} [deps]
 *   onChange: called after a block or unblock so open conversations refresh their permissions
 *   (messaging.relationshipChanged). onBlock: called after a block only (notifications between
 *   the two are removed).
 */
export function createBlockService({
  onChange = async () => undefined,
  onBlock = async () => undefined,
} = {}) {
  const notify = (a, b) => onChange(String(a), String(b)).catch(() => undefined);

  return {
    async list(userId) {
      const blocks = await BlockedUser.find({ blocker: userId }).sort({ createdAt: -1 }).lean();
      const users = await User.find(
        { _id: { $in: blocks.map((block) => block.blocked) } },
        PUBLIC_USER_FIELDS,
      ).lean();
      const byId = new Map(users.map((user) => [String(user._id), user]));
      return blocks
        .filter((block) => byId.has(String(block.blocked)))
        .map((block) => ({
          user: toUserCard(byId.get(String(block.blocked))),
          blockedAt: block.createdAt.toISOString(),
        }));
    },

    async block(userId, username) {
      const target = await User.findOne(
        { username, status: { $in: VISIBLE_ACCOUNT_STATUSES } },
        PUBLIC_USER_FIELDS,
      ).lean();
      if (!target) throw new AppError(404, 'NOT_FOUND', "We couldn't find that person.");
      if (target._id.equals(userId)) throw AppError.badRequest("You can't block yourself.");

      // Idempotent: blocking twice keeps the original record.
      await BlockedUser.updateOne(
        { blocker: userId, blocked: target._id },
        { $setOnInsert: { blocker: userId, blocked: target._id } },
        { upsert: true },
      );
      await MessageRequest.updateMany(
        { pairKey: pairKey(userId, target._id), status: 'pending' },
        { $set: { status: 'cancelled', respondedAt: new Date() } },
      );
      const block = await BlockedUser.findOne({ blocker: userId, blocked: target._id }).lean();
      await notify(userId, target._id);
      await onBlock(String(userId), String(target._id)).catch(() => undefined);
      return { user: toUserCard(target), blockedAt: block.createdAt.toISOString() };
    },

    async unblock(userId, blockedUserId) {
      if (!isValidObjectId(blockedUserId)) throw new AppError(404, 'NOT_FOUND', 'Not blocked.');
      const result = await BlockedUser.deleteOne({ blocker: userId, blocked: blockedUserId });
      if (result.deletedCount === 0) throw new AppError(404, 'NOT_FOUND', 'Not blocked.');
      await notify(userId, blockedUserId);
    },
  };
}
