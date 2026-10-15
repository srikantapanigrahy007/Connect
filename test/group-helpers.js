import { randomUUID } from 'node:crypto';
import { connect, signedInUser } from './helpers.js';

/** An owner plus `count` people connected to them (so the owner may add them). */
export async function ownerWithFriends(target, count) {
  const owner = await signedInUser(target);
  const friends = [];
  for (let i = 0; i < count; i++) {
    const friend = await signedInUser(target, { displayName: `Friend ${i}` });
    await connect(owner, friend);
    friends.push(friend);
  }
  return { owner, friends };
}

/** Creates a group with the given members; returns the group details. */
export async function createGroup(owner, members = [], name = 'Book club') {
  const res = await owner.client.post('/groups', {
    name,
    memberIds: members.map((member) => member.user.id),
  });
  if (res.status !== 201)
    throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
}

export const roleOf = (group, user) =>
  group.members.find((member) => member.user.id === user.user.id)?.role ?? null;

export function sendPoll(user, groupId, poll) {
  return user.client.post(`/conversations/${groupId}/messages`, {
    clientMessageId: randomUUID(),
    poll,
  });
}
