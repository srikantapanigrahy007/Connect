import { MESSAGING_SOCKET_EVENTS as EVENTS } from '#shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Session } from '../src/models/session.model.js';
import { connect, signedInUser, startTestServer, useTestDatabase } from './helpers.js';
import { createGroup, ownerWithFriends, sendPoll } from './group-helpers.js';
import {
  collect,
  httpSend,
  newMessage,
  nextEvent,
  openSocket,
  pause,
  request,
  waitForDisconnect,
} from './messaging-helpers.js';

useTestDatabase();

let server;
const sockets = [];
beforeAll(async () => {
  server = await startTestServer();
});
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.disconnect();
});
afterAll(async () => {
  await server.close();
});

const socketFor = (user) => openSocket(server, user, sockets);
const send = (socket, conversationId, message = newMessage()) =>
  request(socket, EVENTS.send, { conversationId, ...message });
const summary = async (user, id) => (await user.client.get(`/conversations/${id}`)).body.data;

async function groupOf(size) {
  const { owner, friends } = await ownerWithFriends(server.baseUrl, size - 1);
  const group = await createGroup(owner, friends);
  return { owner, friends, group, all: [owner, ...friends] };
}

describe('real-time group messaging', () => {
  it('delivers to every member, counts unread per member and orders the list', async () => {
    const { owner, friends, group } = await groupOf(3);
    const [s0, s1, s2] = await Promise.all([owner, ...friends].map(socketFor));
    const got1 = nextEvent(s1, EVENTS.created, (p) => p.message.text === 'hello all');
    const got2 = nextEvent(s2, EVENTS.created, (p) => p.message.text === 'hello all');
    const ack = await send(s0, group.id, newMessage('hello all'));
    expect(ack.ok).toBe(true);
    expect(ack.data.message).toMatchObject({ type: 'text', senderId: owner.user.id });
    await Promise.all([got1, got2]);

    await send(s1, group.id, newMessage('reply'));
    expect((await summary(friends[1], group.id)).unreadCount).toBe(2);
    expect((await summary(owner, group.id)).unreadCount).toBe(1);
    expect((await summary(friends[0], group.id)).unreadCount).toBe(1);
    const list = (await friends[1].client.get('/conversations')).body.data;
    expect(list[0].id).toBe(group.id);
  });

  it('aggregates delivery and read positions across the other members', async () => {
    const { owner, friends, group } = await groupOf(3);
    const [s0, s1, s2] = await Promise.all([owner, ...friends].map(socketFor));
    const sent = await send(s0, group.id, newMessage('read me'));
    const seq = sent.data.message.seq;
    await request(s1, EVENTS.delivered, { conversationId: group.id, seq });
    await request(s1, EVENTS.read, { conversationId: group.id, seq });
    // Only one of two readers so far: not "read" for the sender yet.
    expect((await summary(owner, group.id)).peerReceipts).toEqual({
      lastDeliveredSeq: 0,
      lastReadSeq: 0,
    });

    const delivered = nextEvent(
      s0,
      EVENTS.delivered,
      (p) => p.userId === 'group' && p.lastDeliveredSeq === seq,
    );
    const read = nextEvent(s0, EVENTS.read, (p) => p.userId === 'group' && p.lastReadSeq === seq);
    await request(s2, EVENTS.delivered, { conversationId: group.id, seq });
    await request(s2, EVENTS.read, { conversationId: group.id, seq });
    await Promise.all([delivered, read]);
    expect((await summary(owner, group.id)).peerReceipts).toEqual({
      lastDeliveredSeq: seq,
      lastReadSeq: seq,
    });
  });

  it('synchronises missed group messages after reconnecting', async () => {
    const { owner, friends, group } = await groupOf(2);
    const s0 = await socketFor(owner);
    const s1 = await socketFor(friends[0]);
    s1.disconnect();
    for (let i = 0; i < 3; i++) await send(s0, group.id, newMessage(`missed ${i}`));
    const back = await socketFor(friends[0]);
    const synced = await request(back, EVENTS.sync, { conversationId: group.id, afterSeq: 1 });
    expect(synced.data.messages.map((m) => m.text)).toEqual(['missed 0', 'missed 1', 'missed 2']);
    expect(synced.data.conversation).toMatchObject({ type: 'group', unreadCount: 3 });
  });

  it('typing reaches the other members', async () => {
    const { owner, friends, group } = await groupOf(3);
    const [s0, s1, s2] = await Promise.all([owner, ...friends].map(socketFor));
    const t1 = nextEvent(s1, EVENTS.typingStart);
    const t2 = nextEvent(s2, EVENTS.typingStart);
    expect((await request(s0, EVENTS.typingStart, { conversationId: group.id })).data.visible).toBe(
      true,
    );
    expect((await t1).userId).toBe(owner.user.id);
    await t2;
  });
});

describe('membership and access', () => {
  it('removed members get nothing further and lose history, files and sync', async () => {
    const { owner, friends, group } = await groupOf(3);
    const [removed, stays] = friends;
    const uploaded = await owner.client.send(
      'post',
      `/conversations/${group.id}/attachments`,
      undefined,
      (t) => t.attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'notes.pdf' }),
    );
    await httpSend(owner, group.id, {
      clientMessageId: newMessage().clientMessageId,
      attachmentId: uploaded.body.data.id,
    });
    const fileUrl = `/attachments/${uploaded.body.data.id}/content`;
    expect((await removed.client.get(fileUrl)).status).toBe(200);

    const removedSocket = await socketFor(removed);
    const staysSocket = await socketFor(stays);
    const changed = nextEvent(removedSocket, EVENTS.changed);
    expect(
      (await owner.client.delete(`/groups/${group.id}/members/${removed.user.id}`)).status,
    ).toBe(200);
    expect(await changed).toEqual({ conversationId: group.id });

    const overheard = collect(removedSocket, EVENTS.created);
    const received = nextEvent(
      staysSocket,
      EVENTS.created,
      (p) => p.message.text === 'after removal',
    );
    await httpSend(owner, group.id, newMessage('after removal'));
    await received;
    await pause(150);
    expect(overheard).toEqual([]);

    expect((await removed.client.get(`/conversations/${group.id}/messages`)).status).toBe(404);
    expect(
      (await request(removedSocket, EVENTS.sync, { conversationId: group.id, afterSeq: 0 })).error
        .code,
    ).toBe('NOT_FOUND');
    expect((await send(removedSocket, group.id)).error.code).toBe('NOT_FOUND');
    expect((await removed.client.get(fileUrl)).status).toBe(404);
    expect((await removed.client.get('/conversations')).body.data.map((c) => c.id)).not.toContain(
      group.id,
    );
  });

  it('a non-member cannot read, sync, type, vote or listen', async () => {
    const { owner, group } = await groupOf(2);
    const { poll } = (await sendPoll(owner, group.id, { question: 'Q', options: ['A', 'B'] })).body
      .data.message;
    const outsider = await signedInUser(server.baseUrl);
    const socket = await socketFor(outsider);
    const heard = collect(socket, EVENTS.created);
    for (const [event, payload] of [
      [EVENTS.send, { conversationId: group.id, ...newMessage() }],
      [EVENTS.sync, { conversationId: group.id, afterSeq: 0 }],
      [EVENTS.typingStart, { conversationId: group.id }],
      [EVENTS.read, { conversationId: group.id, seq: 1 }],
    ]) {
      expect((await request(socket, event, payload)).error.code).toBe('NOT_FOUND');
    }
    expect((await outsider.client.get(`/conversations/${group.id}/messages`)).status).toBe(404);
    const vote = await outsider.client.send(
      'put',
      `/conversations/${group.id}/polls/${poll.id}/vote`,
      { optionIds: ['o1'] },
    );
    expect(vote.status).toBe(404);
    await httpSend(owner, group.id, newMessage('members only'));
    await pause(150);
    expect(heard).toEqual([]);
  });

  it('poll results reach members live, without personal votes', async () => {
    const { owner, friends, group } = await groupOf(2);
    const s0 = await socketFor(owner);
    const { poll } = (await sendPoll(owner, group.id, { question: 'Q', options: ['A', 'B'] })).body
      .data.message;
    const update = nextEvent(s0, EVENTS.pollUpdated);
    await friends[0].client.send('put', `/conversations/${group.id}/polls/${poll.id}/vote`, {
      optionIds: ['o2'],
    });
    const payload = await update;
    expect(payload.poll.options.map((o) => o.votes)).toEqual([0, 1]);
    expect(payload.poll.myVotes).toBeUndefined();
  });
});

describe('message actions in groups', () => {
  it('reply, edit, react, delete for everyone and admin-only pins work in groups', async () => {
    const { owner, friends, group } = await groupOf(3);
    const [member, other] = friends;
    const s2 = await socketFor(other);
    const original = (await httpSend(member, group.id, newMessage('first'))).body.data.message;
    const reply = await httpSend(owner, group.id, { ...newMessage('re'), replyToId: original.id });
    expect(reply.body.data.message.replyTo).toMatchObject({ id: original.id, preview: 'first' });

    const updated = nextEvent(s2, EVENTS.updated, (p) => p.message.text === 'first!');
    expect(
      (
        await member.client.patch(`/conversations/${group.id}/messages/${original.id}`, {
          text: 'first!',
        })
      ).status,
    ).toBe(200);
    await updated;
    expect(
      (
        await owner.client.patch(`/conversations/${group.id}/messages/${original.id}`, {
          text: 'x',
        })
      ).status,
    ).toBe(403);

    await Promise.all(
      [owner, member, other].map((u) =>
        u.client.send('put', `/conversations/${group.id}/messages/${original.id}/reaction`, {
          emoji: '👍',
        }),
      ),
    );
    const reacted = (await other.client.get(`/conversations/${group.id}/messages`)).body.data.find(
      (m) => m.id === original.id,
    );
    expect(reacted.reactions).toHaveLength(3);

    expect(
      (await member.client.send('put', `/conversations/${group.id}/messages/${original.id}/pin`))
        .status,
    ).toBe(403);
    expect(
      (await owner.client.send('put', `/conversations/${group.id}/messages/${original.id}/pin`))
        .status,
    ).toBe(200);

    // System lines can't be reacted to.
    const created = (await owner.client.get(`/conversations/${group.id}/messages`)).body.data[0];
    expect(
      (
        await owner.client.send(
          'put',
          `/conversations/${group.id}/messages/${created.id}/reaction`,
          { emoji: '👍' },
        )
      ).status,
    ).toBe(400);

    expect(
      (
        await member.client.delete(
          `/conversations/${group.id}/messages/${original.id}?scope=everyone`,
        )
      ).status,
    ).toBe(200);
    expect((await summary(owner, group.id)).pins).toEqual([]);
  });

  it('forwards from a group to a one-to-one chat, and polls cannot be forwarded', async () => {
    const { owner, friends, group } = await groupOf(2);
    const direct = (await owner.client.post('/conversations', { userId: friends[0].user.id })).body
      .data;
    const text = (await httpSend(friends[0], group.id, newMessage('share me'))).body.data.message;
    const fwd = await httpSend(owner, direct.id, {
      clientMessageId: newMessage().clientMessageId,
      forwardOfId: text.id,
    });
    expect(fwd.body.data.message).toMatchObject({ forwarded: true, text: 'share me' });
    const poll = (await sendPoll(owner, group.id, { question: 'Q', options: ['A', 'B'] })).body.data
      .message;
    expect(
      (
        await httpSend(owner, direct.id, {
          clientMessageId: newMessage().clientMessageId,
          forwardOfId: poll.id,
        })
      ).status,
    ).toBe(400);
  });
});

describe('sessions and blocking', () => {
  it('a revoked session cannot keep posting to a group', async () => {
    const { owner, group } = await groupOf(2);
    const socket = await socketFor(owner);
    const sessionId = server.io.of('/').sockets.get(socket.id).data.sessionId;
    await Session.updateOne(
      { _id: sessionId },
      { $set: { revokedAt: new Date(), revokedReason: 'logout' } },
    );
    const closed = waitForDisconnect(socket);
    expect((await send(socket, group.id)).error.code).toBe('SESSION_REVOKED');
    await closed;
  });

  it('blocks don’t silence a shared group, but stop adding, inviting and typing to each other', async () => {
    const { owner, friends, group } = await groupOf(3);
    const [a, b] = friends;
    await connect(a, b);
    await a.client.post('/blocks', { username: b.user.username });

    // Both still take part in the shared group.
    expect((await httpSend(a, group.id)).status).toBe(201);
    expect((await httpSend(b, group.id)).status).toBe(201);

    // Typing from B isn't shown to A (but is to the owner).
    const sa = await socketFor(a);
    const so = await socketFor(owner);
    const sb = await socketFor(b);
    const seenByA = collect(sa, EVENTS.typingStart);
    const seenByOwner = nextEvent(so, EVENTS.typingStart);
    await request(sb, EVENTS.typingStart, { conversationId: group.id });
    await seenByOwner;
    await pause(100);
    expect(seenByA).toEqual([]);

    // A can't add B to a new group, and B can't use A's invitation.
    expect((await a.client.post('/groups', { name: 'x', memberIds: [b.user.id] })).status).toBe(
      403,
    );
    const aGroup = await createGroup(a, []);
    const invite = (await a.client.post(`/groups/${aGroup.id}/invites`, {})).body.data;
    expect((await b.client.post('/group-invites/join', { token: invite.token })).status).toBe(404);
  });
});
