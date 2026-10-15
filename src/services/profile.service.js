import { User } from '../models/user.model.js';
import { generateToken } from '../security/tokens.js';
import { AppError } from '../utils/app-error.js';
import { processAvatarImage } from './avatar-image.js';
import { BlockedUser } from '../models/blocked-user.model.js';
import {
  audienceIncludes,
  loadRelationship,
  privacyOf,
  profileAccess,
  requestUnavailableReason,
  VISIBLE_ACCOUNT_STATUSES,
} from './policy.js';
import { PUBLIC_USER_FIELDS, toUserCard } from './user-dto.js';

const notFound = () => new AppError(404, 'NOT_FOUND', "We couldn't find that person.");

function encodeCursor(username) {
  return Buffer.from(username, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  const value = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw AppError.badRequest('Invalid cursor');
  return value;
}

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Profiles, privacy settings, avatars and user search.
 *
 * @param {{ storage: import('./storage.js').FileStorage, presence: import('../realtime/presence.js').PresenceTracker, logger: import('../utils/logger.js').Logger }} deps
 */
export function createProfileService({ storage, presence, logger }) {
  async function loadOwn(userId) {
    const user = await User.findById(userId).lean();
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Please sign in to continue');
    return user;
  }

  function toOwnProfile(user) {
    return {
      ...toUserCard(user),
      bio: user.bio ?? '',
      joinedAt: user.createdAt.toISOString(),
      privacy: privacyOf(user),
    };
  }

  /** Ids of everyone the viewer blocked or who blocked the viewer. */
  async function blockedIds(viewerId) {
    const blocks = await BlockedUser.find(
      { $or: [{ blocker: viewerId }, { blocked: viewerId }] },
      { blocker: 1, blocked: 1 },
    ).lean();
    return blocks.map((block) =>
      String(block.blocker) === String(viewerId) ? block.blocked : block.blocker,
    );
  }

  return {
    async getOwnProfile(userId) {
      return toOwnProfile(await loadOwn(userId));
    },

    async updateProfile(userId, input) {
      if (input.username) {
        const taken = await User.exists({ username: input.username, _id: { $ne: userId } });
        if (taken) {
          throw new AppError(409, 'CONFLICT', 'That username is taken.', [
            { path: 'username', message: 'This username is taken' },
          ]);
        }
      }
      const user = await User.findOneAndUpdate(
        { _id: userId },
        { $set: input },
        { returnDocument: 'after', runValidators: true },
      ).lean();
      if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Please sign in to continue');
      return toOwnProfile(user);
    },

    async updatePrivacy(userId, input) {
      const update = Object.fromEntries(
        Object.entries(input).map(([key, value]) => [`privacy.${key}`, value]),
      );
      const user = await User.findOneAndUpdate(
        { _id: userId },
        { $set: update },
        { returnDocument: 'after', runValidators: true },
      ).lean();
      if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Please sign in to continue');
      return toOwnProfile(user);
    },

    /** Validates, re-encodes and stores a new avatar, then deletes the previous file. */
    async setAvatar(userId, file) {
      if (!file) throw AppError.badRequest('Choose an image to upload.');
      const image = await processAvatarImage(file);
      const key = `${generateToken(24)}.webp`;
      await storage.put(key, image, { contentType: 'image/webp' });
      let previous;
      try {
        previous = await User.findOneAndUpdate(
          { _id: userId },
          { $set: { avatar: { key, updatedAt: new Date() } } },
          { returnDocument: 'before', projection: { avatar: 1 } },
        ).lean();
      } catch (error) {
        await storage.remove(key);
        throw error;
      }
      if (!previous) {
        await storage.remove(key);
        throw new AppError(401, 'UNAUTHORIZED', 'Please sign in to continue');
      }
      if (previous.avatar?.key) {
        await storage.remove(previous.avatar.key).catch((error) => {
          logger.warn('Could not delete previous avatar file', { error });
        });
      }
      return toOwnProfile(await loadOwn(userId));
    },

    async removeAvatar(userId) {
      const previous = await User.findOneAndUpdate(
        { _id: userId },
        { $set: { avatar: null } },
        { returnDocument: 'before', projection: { avatar: 1 } },
      ).lean();
      if (previous?.avatar?.key) await storage.remove(previous.avatar.key);
      return toOwnProfile(await loadOwn(userId));
    },

    /**
     * Another person's profile as `viewerId` may see it. Blocked viewers and hidden accounts get
     * a 404, exactly as if the username did not exist.
     */
    async getPublicProfile(viewerId, username) {
      const target = await User.findOne(
        { username, status: { $in: VISIBLE_ACCOUNT_STATUSES } },
        PUBLIC_USER_FIELDS,
      ).lean();
      if (!target) throw notFound();
      const relationship = await loadRelationship(viewerId, target._id);
      const access = profileAccess(target, relationship);
      if (access === 'none') throw notFound();

      const privacy = privacyOf(target);
      const reason = requestUnavailableReason(target, relationship);
      return {
        ...toUserCard(target),
        access,
        bio: access === 'full' ? (target.bio ?? '') : null,
        joinedAt: access === 'full' ? target.createdAt.toISOString() : null,
        presence: {
          online: audienceIncludes(privacy.onlineStatusVisibility, relationship)
            ? presence.isOnline(String(target._id))
            : null,
          lastSeenAt:
            audienceIncludes(privacy.lastSeenVisibility, relationship) && target.lastSeenAt
              ? target.lastSeenAt.toISOString()
              : null,
        },
        relationship: {
          isSelf: relationship.isSelf,
          connected: relationship.connected,
          blockedByYou: relationship.blockedByViewer,
          outgoingRequest: relationship.outgoingRequest,
          incomingRequest: relationship.incomingRequest,
          canSendRequest: reason === null,
          requestUnavailableReason: reason,
        },
      };
    },

    /**
     * Exact username first (any visibility), then public profiles whose username starts with the
     * query. Private profiles are only found by their exact username. Blocks hide both ways.
     */
    async search(viewerId, { q, cursor, limit }) {
      const hidden = await blockedIds(viewerId);
      const after = decodeCursor(cursor);
      const visible = { status: { $in: VISIBLE_ACCOUNT_STATUSES }, _id: { $nin: hidden } };

      const exact = after
        ? null
        : await User.findOne({ ...visible, username: q }, PUBLIC_USER_FIELDS).lean();
      const prefix = await User.find(
        {
          ...visible,
          profileVisibility: { $ne: 'private' },
          username: {
            $regex: `^${escapeRegex(q)}`,
            ...(after ? { $gt: after } : {}),
            ...(exact ? { $ne: q } : {}),
          },
        },
        PUBLIC_USER_FIELDS,
      )
        .sort({ username: 1 })
        .limit(limit + 1)
        .lean();

      const hasMore = prefix.length > limit;
      const page = prefix.slice(0, limit);
      const results = [...(exact ? [exact] : []), ...page];
      const last = page.at(-1);
      return {
        data: results.map(toUserCard),
        meta: {
          limit,
          hasMore,
          nextCursor: hasMore && last?.username ? encodeCursor(last.username) : null,
        },
      };
    },
  };
}
