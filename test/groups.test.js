import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Conversation } from '../src/models/conversation.model.js';
import { GroupInvite } from '../src/models/group-invite.model.js';
import { Message } from '../src/models/message.model.js';
import { PollVote } from '../src/models/poll.model.js';
import { signedInUser, startTestServer, useTestDatabase } from './helpers.js';
import { createGroup, ownerWithFriends, roleOf, sendPoll } from './group-helpers.js';
import { httpSend } from './messaging-helpers.js';

useTestDatabase();

let server;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server.close();
});

const details = async (user, groupId) => user.client.get(`/groups/${groupId}`);

describe('group lifecycle', () => {
  it('creates a group with an owner, members and a "created" event in the history', async () => {
    const { owner, friends } = await ownerWithFriends(server.baseUrl, 2);
    const group = await createGroup(owner, friends);
    expect(group).toMatchObject({ name: 'Book club', memberCount: 3, myRole: 'owner' });
    expect(roleOf(group, friends[0])).toBe('member');
    const history = await friends[0].client.get(`/conversations/${group.id}/messages`);
    expect(history.body.data[0]).toMatchObject({
      type: 'system',
      system: { kind: 'conversation_created', name: 'Book club', actorId: owner.user.id },
    });
    const list = await friends[1].client.get('/conversations');
    expect(list.body.data[0]).toMatchObject({
      id: group.id,
      type: 'group',
      peer: null,
      group: { name: 'Book club', memberCount: 3, myRole: 'member' },
    });
  });

  it('only adds people the creator is connected with and not blocked with', async () => {
    const { owner } = await ownerWithFriends(server.baseUrl, 0);
    const stranger = await signedInUser(server.baseUrl);
    const res = await owner.client.post('/groups', { name: 'x', memberIds: [stranger.user.id] });
    expect(res.status).toBe(403);
    const { owner: o2, friends } = await ownerWithFriends(server.baseUrl, 1);
    await friends[0].client.post('/blocks', { username: o2.user.username });
    expect(
      (await o2.client.post('/groups', { name: 'x', memberIds: [friends[0].user.id] })).status,
    ).toBe(403);
    expect((await owner.client.post('/groups', { name: '', memberIds: [] })).status).toBe(400);
    expect((await owner.client.post('/groups', { name: 'x', role: 'owner' })).status).toBe(400);
  });

  it('owner and admins edit details; members and outsiders cannot', async () => {
    const { owner, friends } = await ownerWithFriends(server.baseUrl, 2);
    const group = await createGroup(owner, friends);
    const [admin, member] = friends;
    await owner.client.patch(`/groups/${group.id}/members/${admin.user.id}`, { role: 'admin' });

    expect((await member.client.patch(`/groups/${group.id}`, { name: 'Hacked' })).status).toBe(403);
    const outsider = await signedInUser(server.baseUrl);
    expect((await outsider.client.patch(`/groups/${group.id}`, { name: 'x' })).status).toBe(404);
    expect((await outsider.client.get(`/groups/${group.id}`)).status).toBe(404);

    const renamed = await admin.client.patch(`/groups/${group.id}`, {
      name: 'Readers',
      description: 'Monthly books',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data).toMatchObject({ name: 'Readers', description: 'Monthly books' });
    const history = await member.client.get(`/conversations/${group.id}/messages`);
    expect(history.body.data.at(-1).system).toMatchObject({
      kind: 'group_renamed',
      name: 'Readers',
    });
  });

  it('only the owner deletes the group, and then nobody can open it', async () => {
    const { owner, friends } = await ownerWithFriends(server.baseUrl, 2);
    const group = await createGroup(owner, friends);
    await owner.client.patch(`/groups/${group.id}/members/${friends[0].user.id}`, {
      role: 'admin',
    });
    expect((await friends[0].client.delete(`/groups/${group.id}`)).status).toBe(403);
    expect((await owner.client.delete(`/groups/${group.id}`)).status).toBe(204);
    for (const user of [owner, ...friends]) {
      expect((await details(user, group.id)).status).toBe(404);
      expect((await user.client.get(`/conversations/${group.id}/messages`)).status).toBe(404);
      expect((await httpSend(user, group.id)).status).toBe(404);
    }
    expect((await owner.client.get('/conversations')).body.data.map((c) => c.id)).not.toContain(
      group.id,
    );
  });
});

describe('members and roles', () => {
  it('admins add and remove members; only the owner removes admins', async () => {
    const { owner, friends } = await ownerWithFriends(server.baseUrl, 4);
    const [admin, member, other, later] = friends;
    const group = await createGroup(owner, [admin, member, other]);
    await owner.client.patch(`/groups/${group.id}/members/${admin.user.id}`, { role: 'admin' });

    // Admin can only add people *they* are connected with.
    expect(
      (await admin.client.post(`/groups/${group.id}/members`, { userIds: [later.user.id] })).status,
    ).toBe(403);
    const added = await owner.client.post(`/groups/${group.id}/members`, {
      userIds: [later.user.id],
    });
    expect(added.body.data.memberCount).toBe(5);
    // Adding again is a no-op, never a duplicate.
    await owner.client.post(`/groups/${group.id}/members`, { userIds: [later.user.id] });
    const stored = await Conversation.findById(group.id).lean();
    expect(stored.participants.filter((id) => String(id) === later.user.id)).toHaveLength(1);

    expect(
      (await member.client.delete(`/groups/${group.id}/members/${other.user.id}`)).status,
    ).toBe(403);
    expect((await admin.client.delete(`/groups/${group.id}/members/${other.user.id}`)).status).toBe(
      200,
    );
    const promoted = await owner.client.patch(`/groups/${group.id}/members/${member.user.id}`, {
      role: 'admin',
    });
    expect(roleOf(promoted.body.data, member)).toBe('admin');
    // An admin can't remove another admin or the owner.
    expect(
      (await admin.client.delete(`/groups/${group.id}/members/${member.user.id}`)).status,
    ).toBe(403);
    expect((await admin.client.delete(`/groups/${group.id}/members/${owner.user.id}`)).status).toBe(
      403,
    );
    expect(
      (await owner.client.delete(`/groups/${group.id}/members/${member.user.id}`)).status,
    ).toBe(200);

    expect((await other.client.get(`/groups/${group.id}`)).status).toBe(404);
    const history = await owner.client.get(`/conversations/${group.id}/messages`);
    expect(history.body.data.map((m) => m.system?.kind).filter(Boolean)).toEqual([
      'conversation_created',
      'member_added',
      'member_removed',
      'member_removed',
    ]);
  });

  it('only the owner changes roles, and roles can only be admin or member', async () => {
    const { owner, friends } = await ownerWithFriends(server.baseUrl, 2);
    const group = await createGroup(owner, friends);
    const [a, b] = friends;
    await owner.client.patch(`/groups/${group.id}/members/${a.user.id}`, { role: 'admin' });
    expect(
      (await a.client.patch(`/groups/${group.id}/members/${b.user.id}`, { role: 'admin' })).status,
    ).toBe(403);
    expect(
      (await owner.client.patch(`/groups/${group.id}/members/${b.user.id}`, { role: 'owner' }))
        .status,
    ).toBe(400);
    expect(
      (await owner.client.patch(`/groups/${group.id}/members/${owner.user.id}`, { role: 'member' }))
        .status,
    ).toBe(400);
    const demoted = await owner.client.patch(`/groups/${group.id}/members/${a.user.id}`, {
      role: 'member',
    });
    expect(roleOf(demoted.body.data, a)).toBe('member');
  });

  it('transfers ownership atomically; the owner must transfer before leaving', async () => {
    const { owner, friends } = await ownerWithFriends(server.baseUrl, 2);
    const group = await createGroup(owner, friends);
    const [a, b] = friends;
    const leave = await owner.client.delete(`/groups/${group.id}/members/${owner.user.id}`);
    expect(leave.status).toBe(409);
    expect(leave.body.error.code).toBe('OWNER_MUST_TRANSFER');
    expect(
      (await a.client.post(`/groups/${group.id}/transfer`, { userId: a.user.id })).status,
    ).toBe(403);

    // Two transfers at once: exactly one owner results.
    const results = await Promise.all([
      owner.client.post(`/groups/${group.id}/transfer`, { userId: a.user.id }),
      owner.client.post(`/groups/${group.id}/transfer`, { userId: b.user.id }),
    ]);
    expect(results.filter((res) => res.status === 200).length).toBeGreaterThanOrEqual(1);
    const stored = await Conversation.findById(group.id).lean();
    expect(stored.members.filter((m) => m.role === 'owner')).toHaveLength(1);
    expect(stored.members.find((m) => String(m.user) === owner.user.id).role).toBe('admin');

    // The former owner can leave now.
    expect((await owner.client.delete(`/groups/${group.id}/members/${owner.user.id}`)).status).toBe(
      200,
    );
    expect((await owner.client.get(`/groups/${group.id}`)).status).toBe(404);
  });

  it('the last member leaving deletes the group', async () => {
    const { owner } = await ownerWithFriends(server.baseUrl, 0);
    const group = await createGroup(owner, []);
    const res = await owner.client.delete(`/groups/${group.id}/members/${owner.user.id}`);
    expect(res.body.data).toEqual({ left: true, deleted: true });
    expect((await Conversation.findById(group.id).lean()).group.deletedAt).not.toBeNull();
  });
});

describe('invitations', () => {
  async function inviteFor(owner, friends = [], options = {}) {
    const group = await createGroup(owner, friends);
    const res = await owner.client.post(`/groups/${group.id}/invites`, options);
    expect(res.status).toBe(201);
    return { group, invite: res.body.data };
  }

  it('creates hashed, expiring invitations shown once; only admins manage them', async () => {
    const { owner, friends } = await ownerWithFriends(server.baseUrl, 1);
    const { group, invite } = await inviteFor(owner, friends, { maxUses: 3 });
    expect(invite.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(invite.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(invite).toMatchObject({ maxUses: 3, uses: 0, state: 'active' });
    const stored = await GroupInvite.findById(invite.id).select('+tokenHash +codeHash').lean();
    expect(stored.tokenHash).not.toBe(invite.token);
    expect(JSON.stringify(stored)).not.toContain(invite.token);

    const list = await owner.client.get(`/groups/${group.id}/invites`);
    expect(JSON.stringify(list.body)).not.toContain(invite.token);
    expect((await friends[0].client.post(`/groups/${group.id}/invites`, {})).status).toBe(403);
    expect((await friends[0].client.get(`/groups/${group.id}/invites`)).status).toBe(403);
  });

  it('joins by link or code; joining twice never duplicates membership or uses', async () => {
    const { owner } = await ownerWithFriends(server.baseUrl, 0);
    const { group, invite } = await inviteFor(owner);
    const joiner = await signedInUser(server.baseUrl);
    const preview = await joiner.client.post('/group-invites/preview', {
      code: invite.code.toLowerCase(),
    });
    expect(preview.body.data).toMatchObject({
      groupId: group.id,
      name: 'Book club',
      alreadyMember: false,
    });

    expect((await joiner.client.post('/group-invites/join', { token: invite.token })).status).toBe(
      201,
    );
    const again = await joiner.client.post('/group-invites/join', { code: invite.code });
    expect(again.status).toBe(200);
    expect(again.body.data.alreadyMember).toBe(true);
    const concurrent = await signedInUser(server.baseUrl);
    await Promise.all(
      Array.from({ length: 5 }, () =>
        concurrent.client.post('/group-invites/join', { token: invite.token }),
      ),
    );
    const stored = await Conversation.findById(group.id).lean();
    expect(stored.participants.filter((id) => String(id) === concurrent.user.id)).toHaveLength(1);
    expect((await GroupInvite.findById(invite.id).lean()).uses).toBe(2);
    expect((await joiner.client.get(`/groups/${group.id}`)).body.data.myRole).toBe('member');
  });

  it('enforces usage limits under concurrent joins', async () => {
    const { owner } = await ownerWithFriends(server.baseUrl, 0);
    const { group, invite } = await inviteFor(owner, [], { maxUses: 2 });
    const people = await Promise.all(Array.from({ length: 5 }, () => signedInUser(server.baseUrl)));
    const results = await Promise.all(
      people.map((person) => person.client.post('/group-invites/join', { token: invite.token })),
    );
    expect(results.filter((res) => res.status === 201)).toHaveLength(2);
    expect(results.filter((res) => res.body.error?.code === 'INVITE_EXHAUSTED')).toHaveLength(3);
    expect((await Conversation.findById(group.id).lean()).participants).toHaveLength(3);
  });

  it('rejects expired, revoked, invalid and blocked uses with clear errors', async () => {
    const { owner } = await ownerWithFriends(server.baseUrl, 0);
    const joiner = await signedInUser(server.baseUrl);
    const { group, invite } = await inviteFor(owner, [], { expiresInHours: 1 });
    await GroupInvite.updateOne(
      { _id: invite.id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const expired = await joiner.client.post('/group-invites/join', { token: invite.token });
    expect([expired.status, expired.body.error.code]).toEqual([410, 'INVITE_EXPIRED']);

    const fresh = (await owner.client.post(`/groups/${group.id}/invites`, {})).body.data;
    expect(
      (await owner.client.delete(`/groups/${group.id}/invites/${fresh.id}`)).body.data.state,
    ).toBe('revoked');
    const revoked = await joiner.client.post('/group-invites/join', { code: fresh.code });
    expect([revoked.status, revoked.body.error.code]).toEqual([410, 'INVITE_REVOKED']);

    const invalid = await joiner.client.post('/group-invites/join', { code: 'ABCD-EFGH' });
    expect([invalid.status, invalid.body.error.code]).toEqual([404, 'INVITE_INVALID']);
    expect((await joiner.client.post('/group-invites/join', { token: 'short' })).status).toBe(400);

    const third = (await owner.client.post(`/groups/${group.id}/invites`, {})).body.data;
    await owner.client.post('/blocks', { username: joiner.user.username });
    const blocked = await joiner.client.post('/group-invites/join', { token: third.token });
    expect(blocked.status).toBe(404);
    expect((await Conversation.findById(group.id).lean()).participants).toHaveLength(1);
  });

  it('deleting the group revokes its invitations', async () => {
    const { owner } = await ownerWithFriends(server.baseUrl, 0);
    const { group, invite } = await inviteFor(owner);
    await owner.client.delete(`/groups/${group.id}`);
    const joiner = await signedInUser(server.baseUrl);
    expect((await joiner.client.post('/group-invites/join', { token: invite.token })).status).toBe(
      410,
    );
  });
});

describe('polls', () => {
  it('single-choice polls take exactly one option and votes can change', async () => {
    const { owner, friends } = await ownerWithFriends(server.baseUrl, 2);
    const group = await createGroup(owner, friends);
    const sent = await sendPoll(owner, group.id, {
      question: 'Lunch?',
      options: ['Pizza', 'Sushi'],
    });
    expect(sent.status).toBe(201);
    const { poll } = sent.body.data.message;
    expect(poll).toMatchObject({
      question: 'Lunch?',
      multiple: false,
      closed: false,
      totalVoters: 0,
    });
    const vote = (user, optionIds) =>
      user.client.send('put', `/conversations/${group.id}/polls/${poll.id}/vote`, { optionIds });

    expect((await vote(friends[0], ['o1', 'o2'])).status).toBe(400);
    expect((await vote(friends[0], ['o9'])).status).toBe(400);
    expect((await vote(friends[0], ['o1'])).body.data.myVotes).toEqual(['o1']);
    const changed = await vote(friends[0], ['o2']);
    expect(changed.body.data.options.map((o) => o.votes)).toEqual([0, 1]);
    expect(changed.body.data.totalVoters).toBe(1);
    // Anonymous: no voter identities anywhere.
    expect(JSON.stringify(changed.body.data)).not.toContain(friends[0].user.id);
  });

  it('multiple-choice polls count concurrent votes exactly, once per person', async () => {
    const { owner, friends } = await ownerWithFriends(server.baseUrl, 6);
    const group = await createGroup(owner, friends);
    const { poll } = (
      await sendPoll(owner, group.id, {
        question: 'Days?',
        options: ['Mon', 'Tue', 'Wed'],
        multiple: true,
      })
    ).body.data.message;
    const vote = (user, optionIds) =>
      user.client.send('put', `/conversations/${group.id}/polls/${poll.id}/vote`, { optionIds });
    await Promise.all([
      ...friends.map((friend) => vote(friend, ['o1', 'o2'])),
      ...friends.map((friend) => vote(friend, ['o1', 'o2'])),
    ]);
    const final = await vote(owner, ['o3']);
    expect(final.body.data.options.map((o) => o.votes)).toEqual([6, 6, 1]);
    expect(final.body.data.totalVoters).toBe(7);
    expect(await PollVote.countDocuments({ poll: poll.id })).toBe(7);
    expect((await vote(owner, ['o1', 'o1'])).status).toBe(400);
  });

  it('only the creator or an admin closes a poll; closed polls take no votes', async () => {
    const { owner, friends } = await ownerWithFriends(server.baseUrl, 2);
    const group = await createGroup(owner, friends);
    const [creator, other] = friends;
    const { poll } = (await sendPoll(creator, group.id, { question: 'Q?', options: ['A', 'B'] }))
      .body.data.message;
    const path = `/conversations/${group.id}/polls/${poll.id}`;
    expect((await other.client.post(`${path}/close`)).status).toBe(403);
    expect((await creator.client.post(`${path}/close`)).body.data.closed).toBe(true);
    const late = await other.client.send('put', `${path}/vote`, { optionIds: ['o1'] });
    expect([late.status, late.body.error.code]).toEqual([409, 'POLL_CLOSED']);
    // An admin may close too (repeat is harmless).
    expect((await owner.client.post(`${path}/close`)).status).toBe(200);
  });

  it('polls are groups-only, validated, and outsiders cannot vote', async () => {
    const { owner, friends } = await ownerWithFriends(server.baseUrl, 1);
    const direct = (await owner.client.post('/conversations', { userId: friends[0].user.id })).body
      .data;
    expect((await sendPoll(owner, direct.id, { question: 'Q', options: ['A', 'B'] })).status).toBe(
      400,
    );
    const group = await createGroup(owner, friends);
    expect((await sendPoll(owner, group.id, { question: 'Q', options: ['A'] })).status).toBe(400);
    expect((await sendPoll(owner, group.id, { question: 'Q', options: ['A', 'a'] })).status).toBe(
      400,
    );
    const { poll } = (await sendPoll(owner, group.id, { question: 'Q', options: ['A', 'B'] })).body
      .data.message;
    const outsider = await signedInUser(server.baseUrl);
    const res = await outsider.client.send(
      'put',
      `/conversations/${group.id}/polls/${poll.id}/vote`,
      {
        optionIds: ['o1'],
      },
    );
    expect(res.status).toBe(404);
    expect(await Message.countDocuments({ conversation: group.id, type: 'poll' })).toBe(1);
  });
});
