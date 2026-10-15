import { API_PREFIX } from '#shared';
import { profileVisibilityOf } from './policy.js';

/**
 * Converters from user documents to the shapes other people may see. They copy an explicit
 * list of fields, so new private fields on the User model can never leak by accident.
 */

/** @param {{ avatar?: { key: string } | null }} user */
export function avatarUrlOf(user) {
  return user.avatar?.key ? `${API_PREFIX}/avatars/${user.avatar.key}` : null;
}

/** The minimal public card (see userCardSchema in #shared). */
export function toUserCard(user) {
  return {
    id: String(user._id),
    username: user.username ?? '',
    displayName: user.displayName,
    avatarUrl: avatarUrlOf(user),
    profileVisibility: profileVisibilityOf(user),
  };
}

/** Only these fields are ever read when loading another person's profile. */
export const PUBLIC_USER_FIELDS = {
  username: 1,
  displayName: 1,
  avatar: 1,
  bio: 1,
  profileVisibility: 1,
  privacy: 1,
  status: 1,
  lastSeenAt: 1,
  createdAt: 1,
};
