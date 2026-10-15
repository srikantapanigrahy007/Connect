import { MESSAGING_SOCKET_EVENTS as EVENTS, SESSION_SOCKET_EVENTS } from '#shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Conversation } from '../src/models/conversation.model.js';
import { Message } from '../src/models/message.model.js';
import { Session } from '../src/models/session.model.js';
import { signedInUser, startTestServer, TestClient, useTestDatabase } from './helpers.js';
import {
  collect,
  connectedPair,
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
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.disconnect();
});
afterAll(async () => {
  await server.close();
});

const socketFor = (user) => openSocket(server, user, sockets);
const send = (socket, conversationId, message = newMessage()) =>
  request(socket, EVENTS.send, { conversationId, ...message });

/** A pair with one socket each. */
async function onlinePair() {
  const pair = await connectedPair(server.baseUrl);
  const [aSocket, bSocket] = await Promise.all([socketFor(pair.a), socketFor(pair.b)]);
  return { ...pair, aSocket, bSocket };
}

describe('real-time exchange', () => {
  it('two users exchange persisted messages in real time', async () => {
    const { a, b, conversation, aSocket, bSocket } = await onlinePair();

    const incoming = nextEvent(bSocket, EVENTS.created);
    const ack = await send(aSocket, conversation.id, newMessage('Hello Grace'));
    expect(ack.ok).toBe(true);
    expect(ack.data.duplicate).toBe(false);
    expect(ack.data.message).toMatchObject({ seq: 1, senderId: a.user.id, text: 'Hello Grace' });
    // The ack is only sent after the message is stored.
    expect(await Message.findById(ack.data.message.id).lean()).not.toBeNull();
    // Same message; the sender's ack also carries their private flags (starred/hidden).
    const { starred, hidden, ...shared } = ack.data.message;
    expect({ starred, hidden }).toEqual({ starred: false, hidden: false });
    expect((await incoming).message).toEqual(shared);

    const reply = nextEvent(
      aSocket,
      EVENTS.created,
      ({ message }) => message.senderId === b.user.id,
    );
    const replyAck = await send(bSocket, conversation.id, newMessage('Hi Ada'));
    expect(replyAck.ok).toBe(true);
    expect((await reply).message.text).toBe('Hi Ada');

    const stored = await Message.find({ conversation: conversation.id }).sort({ seq: 1 }).lean();
    expect(stored.map((message) => message.text)).toEqual(['Hello Grace', 'Hi Ada']);
  });

  it("also reaches the sender's other tabs", async () => {
    const { a, conversation, aSocket } = await onlinePair();
    const secondTab = await socketFor(a);
    const echoed = nextEvent(secondTab, EVENTS.created);
    const ack = await send(aSocket, conversation.id);
    expect((await echoed).message.id).toBe(ack.data.message.id);
  });

  it('validates payloads and ignores client-supplied identities', async () => {
    const { b, conversation, aSocket } = await onlinePair();
    const spoofed = await request(aSocket, EVENTS.send, {
      conversationId: conversation.id,
      ...newMessage(),
      senderId: b.user.id,
    });
    expect(spoofed).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } });
    const empty = await send(aSocket, conversation.id, newMessage('  '));
    expect(empty.error.code).toBe('VALIDATION_ERROR');
    const garbage = await request(aSocket, EVENTS.send, 'not an object');
    expect(garbage.error.code).toBe('VALIDATION_ERROR');
    expect(await Message.countDocuments({ conversation: conversation.id })).toBe(0);
  });
});

describe('isolation', () => {
  it('a non-member cannot use or listen to another conversation', async () => {
    const { conversation, aSocket, bSocket } = await onlinePair();
    const outsider = await signedInUser(server.baseUrl);
    const outsiderSocket = await socketFor(outsider);
    const overheard = collect(outsiderSocket, EVENTS.created);
    const overheardTyping = collect(outsiderSocket, EVENTS.typingStart);

    for (const [event, payload] of [
      [EVENTS.send, { conversationId: conversation.id, ...newMessage() }],
      [EVENTS.sync, { conversationId: conversation.id, afterSeq: 0 }],
      [EVENTS.delivered, { conversationId: conversation.id, seq: 1 }],
      [EVENTS.read, { conversationId: conversation.id, seq: 1 }],
      [EVENTS.typingStart, { conversationId: conversation.id }],
    ]) {
      const response = await request(outsiderSocket, event, payload);
      expect(response).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    }

    // There is no way to join a room: unknown events are ignored, and the socket stays in its
    // own rooms only.
    outsiderSocket.emit('join', `conversation:${conversation.id}`);
    outsiderSocket.emit('subscribe', { room: `user:${conversation.peer.id}` });
    await pause(50);
    const serverSide = server.io.of('/').sockets.get(outsiderSocket.id);
    const rooms = [...serverSide.rooms];
    expect(rooms).toHaveLength(3);
    expect(rooms).toEqual(
      expect.arrayContaining([
        outsiderSocket.id,
        `user:${outsider.user.id}`,
        expect.stringMatching(/^session:/),
      ]),
    );

    expect((await send(aSocket, conversation.id)).ok).toBe(true);
    expect(
      (await request(bSocket, EVENTS.typingStart, { conversationId: conversation.id })).ok,
    ).toBe(true);
    await pause(150);
    expect(overheard).toEqual([]);
    expect(overheardTyping).toEqual([]);
  });
});

describe('Phase 5 restrictions over Socket.IO', () => {
  it('a blocked user cannot send, type or bypass the block', async () => {
    const { a, b, conversation, aSocket, bSocket } = await onlinePair();
    expect((await a.client.post('/blocks', { username: b.user.username })).status).toBe(201);

    const received = collect(aSocket, EVENTS.created);
    const typingSeen = collect(aSocket, EVENTS.typingStart);
    const attempt = await send(bSocket, conversation.id, newMessage('sneaky'));
    expect(attempt).toMatchObject({ ok: false, error: { code: 'MESSAGING_NOT_ALLOWED' } });
    const typing = await request(bSocket, EVENTS.typingStart, { conversationId: conversation.id });
    expect(typing.error.code).toBe('MESSAGING_NOT_ALLOWED');
    const blockerAttempt = await send(aSocket, conversation.id);
    expect(blockerAttempt.error.code).toBe('MESSAGING_NOT_ALLOWED');

    await pause(100);
    expect(received).toEqual([]);
    expect(typingSeen).toEqual([]);
    expect(await Message.countDocuments({ conversation: conversation.id })).toBe(0);
  });

  it('an unaccepted request does not allow messaging, even with a known conversation id', async () => {
    const { conversation, aSocket } = await onlinePair();
    const stranger = await signedInUser(server.baseUrl);
    const strangerSocket = await socketFor(stranger);
    // A pending request to someone does not unlock messaging them.
    const pending = await stranger.client.post('/message-requests', {
      username: conversation.peer.username,
    });
    expect(pending.status).toBe(201);
    const opened = await stranger.client.post('/conversations', { userId: conversation.peer.id });
    expect(opened.status).toBe(403);
    // Guessing the pair's conversation id gets nowhere either.
    const guessed = await send(strangerSocket, conversation.id);
    expect(guessed.error.code).toBe('NOT_FOUND');
    expect((await send(aSocket, conversation.id)).ok).toBe(true);
  });

  it('losing the connection (e.g. after an account is deleted) denies sending at once', async () => {
    const { b, conversation, aSocket } = await onlinePair();
    // Simulates the other account disappearing: its connection record is gone.
    const { Connection } = await import('../src/models/connection.model.js');
    await Connection.deleteMany({ users: b.user.id });
    const response = await send(aSocket, conversation.id);
    expect(response.error.code).toBe('MESSAGING_NOT_ALLOWED');
  });
});

describe('idempotency over Socket.IO', () => {
  it('retries with the same key (socket or HTTP) do not create duplicates', async () => {
    const { a, conversation, aSocket } = await onlinePair();
    const message = newMessage('once');
    const first = await send(aSocket, conversation.id, message);
    const retry = await send(aSocket, conversation.id, message);
    const httpRetry = await httpSend(a, conversation.id, message);
    expect(retry.data).toEqual({ message: first.data.message, duplicate: true });
    expect(httpRetry.body.data.message.id).toBe(first.data.message.id);
    expect(await Message.countDocuments({ clientMessageId: message.clientMessageId })).toBe(1);
  });

  it('concurrent submissions with one key are stored once', async () => {
    const { a, conversation, aSocket } = await onlinePair();
    const otherTab = await socketFor(a);
    const message = newMessage('concurrent');
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => send(aSocket, conversation.id, message)),
      ...Array.from({ length: 5 }, () => send(otherTab, conversation.id, message)),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(new Set(results.map((result) => result.data.message.id)).size).toBe(1);
    expect(results.filter((result) => !result.data.duplicate)).toHaveLength(1);
    expect(await Message.countDocuments({ clientMessageId: message.clientMessageId })).toBe(1);
  });

  it('a database failure never produces a success acknowledgment', async () => {
    const { conversation, aSocket, bSocket } = await onlinePair();
    const received = collect(bSocket, EVENTS.created);
    vi.spyOn(Message, 'create').mockRejectedValueOnce(new Error('write concern timeout'));
    const message = newMessage('fragile');
    const ack = await send(aSocket, conversation.id, message);
    expect(ack).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
    await pause(100);
    expect(received).toEqual([]);
    expect(await Message.countDocuments({ clientMessageId: message.clientMessageId })).toBe(0);
  });
});

describe('receipts', () => {
  it('delivery receipts come only from the recipient and are stored', async () => {
    const { a, b, conversation, aSocket, bSocket } = await onlinePair();
    await send(aSocket, conversation.id);
    await send(aSocket, conversation.id);

    const outsider = await socketFor(await signedInUser(server.baseUrl));
    const forged = await request(outsider, EVENTS.delivered, {
      conversationId: conversation.id,
      seq: 2,
    });
    expect(forged.error.code).toBe('NOT_FOUND');
    const future = await request(bSocket, EVENTS.delivered, {
      conversationId: conversation.id,
      seq: 3,
    });
    expect(future.error.code).toBe('BAD_REQUEST');

    const notice = nextEvent(aSocket, EVENTS.delivered);
    const ack = await request(bSocket, EVENTS.delivered, {
      conversationId: conversation.id,
      seq: 2,
    });
    expect(ack).toEqual({
      ok: true,
      data: { conversationId: conversation.id, lastDeliveredSeq: 2 },
    });
    expect(await notice).toEqual({
      conversationId: conversation.id,
      userId: b.user.id,
      lastDeliveredSeq: 2,
    });
    // Positions never move backwards.
    const older = await request(bSocket, EVENTS.delivered, {
      conversationId: conversation.id,
      seq: 1,
    });
    expect(older.data.lastDeliveredSeq).toBe(2);

    // Durable: visible to the sender after reloading.
    const summary = await a.client.get(`/conversations/${conversation.id}`);
    expect(summary.body.data.peerReceipts.lastDeliveredSeq).toBe(2);
    // The sender acknowledging their own position does not touch the recipient's.
    await request(aSocket, EVENTS.delivered, { conversationId: conversation.id, seq: 2 });
    const stored = await Conversation.findById(conversation.id).lean();
    const position = (userId) =>
      stored.members.find((member) => String(member.user) === userId).lastDeliveredSeq;
    expect(position(b.user.id)).toBe(2);
  });

  it('read receipts for undelivered messages are rejected', async () => {
    const { a, b, conversation, aSocket, bSocket } = await onlinePair();
    await send(aSocket, conversation.id);
    await send(aSocket, conversation.id);

    const early = await request(bSocket, EVENTS.read, { conversationId: conversation.id, seq: 1 });
    expect(early).toMatchObject({ ok: false, error: { code: 'NOT_DELIVERED' } });

    await request(bSocket, EVENTS.delivered, { conversationId: conversation.id, seq: 1 });
    const beyond = await request(bSocket, EVENTS.read, { conversationId: conversation.id, seq: 2 });
    expect(beyond.error.code).toBe('NOT_DELIVERED');

    const readNotice = nextEvent(aSocket, EVENTS.read);
    const read = await request(bSocket, EVENTS.read, { conversationId: conversation.id, seq: 1 });
    expect(read.data).toEqual({ conversationId: conversation.id, lastReadSeq: 1, unreadCount: 1 });
    expect(await readNotice).toEqual({
      conversationId: conversation.id,
      userId: b.user.id,
      lastReadSeq: 1,
    });
    const summary = await a.client.get(`/conversations/${conversation.id}`);
    expect(summary.body.data.peerReceipts).toEqual({ lastDeliveredSeq: 1, lastReadSeq: 1 });
  });

  it('read receipts respect privacy settings both ways', async () => {
    const { a, b, conversation, aSocket, bSocket } = await onlinePair();
    await send(aSocket, conversation.id);
    expect((await a.client.patch('/me/privacy', { readReceipts: false })).status).toBe(200);
    const readSeen = collect(aSocket, EVENTS.read);
    const readSelf = nextEvent(bSocket, EVENTS.read);
    await request(bSocket, EVENTS.delivered, { conversationId: conversation.id, seq: 1 });
    expect(
      (await request(bSocket, EVENTS.read, { conversationId: conversation.id, seq: 1 })).ok,
    ).toBe(true);
    // B's own tabs learn about it (unread count), A does not.
    expect((await readSelf).unreadCount).toBe(0);
    await pause(100);
    expect(readSeen).toEqual([]);
    const summary = await a.client.get(`/conversations/${conversation.id}`);
    expect(summary.body.data.peerReceipts.lastReadSeq).toBeNull();
    // Delivery stays visible.
    expect(summary.body.data.peerReceipts.lastDeliveredSeq).toBe(1);
    void b;
  });

  it('unread counts stay correct under concurrent sends and reads', async () => {
    const { a, conversation, aSocket, bSocket } = await onlinePair();
    const sends = Array.from({ length: 20 }, (_, index) =>
      send(bSocket, conversation.id, newMessage(`burst ${index}`)),
    );
    // Reader acknowledges and reads whatever exists so far, repeatedly, while sends happen.
    const reads = (async () => {
      for (let round = 0; round < 8; round++) {
        const latest = await Message.findOne({ conversation: conversation.id })
          .sort({ seq: -1 })
          .lean();
        if (latest) {
          await request(aSocket, EVENTS.delivered, {
            conversationId: conversation.id,
            seq: latest.seq,
          });
          await request(aSocket, EVENTS.read, { conversationId: conversation.id, seq: latest.seq });
        }
        await pause(5);
      }
    })();
    const results = await Promise.all([...sends, reads]);
    expect(results.slice(0, 20).every((result) => result.ok)).toBe(true);

    const stored = await Conversation.findById(conversation.id).lean();
    const lastReadSeq = stored.members.find((m) => String(m.user) === a.user.id).lastReadSeq;
    const expected = await Message.countDocuments({
      conversation: conversation.id,
      recipient: a.user.id,
      seq: { $gt: lastReadSeq },
    });
    const listed = (await a.client.get('/conversations')).body.data[0];
    expect(listed.unreadCount).toBe(expected);
    expect(listed.unreadCount).toBe(20 - lastReadSeq);

    await request(aSocket, EVENTS.delivered, { conversationId: conversation.id, seq: 20 });
    const final = await request(aSocket, EVENTS.read, { conversationId: conversation.id, seq: 20 });
    expect(final.data.unreadCount).toBe(0);
    expect((await a.client.get('/conversations')).body.data[0].unreadCount).toBe(0);
  });
});

describe('reconnection and synchronisation', () => {
  it('a disconnected recipient synchronises exactly the messages it missed', async () => {
    const { b, conversation, aSocket, bSocket } = await onlinePair();
    await send(aSocket, conversation.id, newMessage('before'));
    bSocket.disconnect();

    for (let index = 1; index <= 5; index++) {
      expect((await send(aSocket, conversation.id, newMessage(`missed ${index}`))).ok).toBe(true);
    }

    const back = await socketFor(b);
    const firstPage = await request(back, EVENTS.sync, {
      conversationId: conversation.id,
      afterSeq: 1,
      limit: 3,
    });
    expect(firstPage.ok).toBe(true);
    expect(firstPage.data.messages.map((m) => m.text)).toEqual([
      'missed 1',
      'missed 2',
      'missed 3',
    ]);
    expect(firstPage.data.hasMore).toBe(true);
    expect(firstPage.data.conversation.unreadCount).toBe(6);
    const secondPage = await request(back, EVENTS.sync, {
      conversationId: conversation.id,
      afterSeq: firstPage.data.messages.at(-1).seq,
    });
    expect(secondPage.data.messages.map((m) => m.text)).toEqual(['missed 4', 'missed 5']);
    expect(secondPage.data.hasMore).toBe(false);

    // Repeating a sync is harmless and returns the same messages.
    const repeated = await request(back, EVENTS.sync, {
      conversationId: conversation.id,
      afterSeq: 1,
    });
    expect(repeated.data.messages.map((m) => m.seq)).toEqual([2, 3, 4, 5, 6]);
  });

  it('re-sending a pending message after reconnecting neither duplicates storage nor history', async () => {
    const { a, conversation, aSocket } = await onlinePair();
    const message = newMessage('was the ack lost?');
    // The message is stored, but suppose the acknowledgment never reached the client.
    expect((await send(aSocket, conversation.id, message)).ok).toBe(true);
    aSocket.disconnect();

    const back = await socketFor(a);
    const retried = await send(back, conversation.id, message);
    expect(retried.data.duplicate).toBe(true);
    const synced = await request(back, EVENTS.sync, {
      conversationId: conversation.id,
      afterSeq: 0,
    });
    expect(synced.data.messages).toHaveLength(1);
    expect(synced.data.messages[0].clientMessageId).toBe(message.clientMessageId);
    expect(await Message.countDocuments({ conversation: conversation.id })).toBe(1);
  });
});

describe('session revocation', () => {
  it('logout disconnects sockets and the old session cannot reconnect', async () => {
    const { a, aSocket } = await onlinePair();
    const staleCookie = a.client.cookieHeader(server.ctx.config.cookies.names.access);
    const disconnected = waitForDisconnect(aSocket);
    expect((await a.client.post('/auth/logout')).status).toBe(204);
    await disconnected;
    // Reconnecting with the old (still unexpired) access cookie is refused.
    const stale = { client: { cookieHeader: () => staleCookie } };
    await expect(openSocket(server, stale, sockets)).rejects.toThrow('SESSION_REVOKED');
  });

  it('a socket whose session was revoked elsewhere is refused and closed on its next event', async () => {
    const { a, conversation, aSocket } = await onlinePair();
    // Revoked by another API instance: no in-process event reaches this socket.
    const sessionId = server.io.of('/').sockets.get(aSocket.id).data.sessionId;
    await Session.updateOne(
      { _id: sessionId },
      { $set: { revokedAt: new Date(), revokedReason: 'logout' } },
    );
    const notice = nextEvent(aSocket, SESSION_SOCKET_EVENTS.revoked);
    const disconnected = waitForDisconnect(aSocket);

    const attempt = await send(aSocket, conversation.id, newMessage('stale'));
    expect(attempt).toMatchObject({ ok: false, error: { code: 'SESSION_REVOKED' } });
    expect(await notice).toEqual({ reason: 'revoked' });
    await disconnected;
    expect(await Message.countDocuments({ text: 'stale' })).toBe(0);
    void a;
  });

  it('a superseded session cannot sync or send receipts', async () => {
    const { a, conversation, aSocket } = await onlinePair();
    // Revoke "elsewhere" by moving the active-session pointer, as another instance's login would.
    const { User } = await import('../src/models/user.model.js');
    await User.updateOne({ _id: a.user.id }, { $set: { activeSessionId: null } });
    const sync = await request(aSocket, EVENTS.sync, {
      conversationId: conversation.id,
      afterSeq: 0,
    });
    expect(sync.error.code).toBe('SESSION_SUPERSEDED');
    await waitForDisconnect(aSocket);
  });

  it('logout-all disconnects every socket of the account', async () => {
    const { a } = await connectedPair(server.baseUrl);
    const first = await socketFor(a);
    const second = await socketFor(a);
    const closed = Promise.all([waitForDisconnect(first), waitForDisconnect(second)]);
    expect((await a.client.post('/auth/logout-all')).status).toBe(204);
    await closed;
  });
});

describe('typing indicators', () => {
  it('reach only the other participant and stop when the typist disconnects', async () => {
    const { a, conversation, aSocket, bSocket } = await onlinePair();
    const started = nextEvent(bSocket, EVENTS.typingStart);
    const ack = await request(aSocket, EVENTS.typingStart, { conversationId: conversation.id });
    expect(ack).toEqual({ ok: true, data: { visible: true } });
    expect(await started).toMatchObject({ conversationId: conversation.id, userId: a.user.id });

    const stopped = nextEvent(bSocket, EVENTS.typingStop);
    aSocket.disconnect();
    expect(await stopped).toEqual({ conversationId: conversation.id, userId: a.user.id });
  });

  it('stop on typing:stop and after sending, and are never stored', async () => {
    const { conversation, aSocket, bSocket } = await onlinePair();
    await request(aSocket, EVENTS.typingStart, { conversationId: conversation.id });
    const stopped = nextEvent(bSocket, EVENTS.typingStop);
    await request(aSocket, EVENTS.typingStop, { conversationId: conversation.id });
    await stopped;

    await request(aSocket, EVENTS.typingStart, { conversationId: conversation.id });
    const stoppedBySend = nextEvent(bSocket, EVENTS.typingStop);
    await send(aSocket, conversation.id);
    await stoppedBySend;
    expect(await Message.countDocuments({ conversation: conversation.id })).toBe(1);
  });

  it('respect the typing-indicator privacy setting', async () => {
    const { b, conversation, aSocket, bSocket } = await onlinePair();
    await b.client.patch('/me/privacy', { typingIndicators: false });
    const seen = collect(bSocket, EVENTS.typingStart);
    const ack = await request(aSocket, EVENTS.typingStart, { conversationId: conversation.id });
    expect(ack.data).toEqual({ visible: false });
    await pause(100);
    expect(seen).toEqual([]);
  });

  it('are rate-limited', async () => {
    const { conversation, aSocket } = await onlinePair();
    const results = [];
    for (let index = 0; index < 25; index++) {
      results.push(await request(aSocket, EVENTS.typingStart, { conversationId: conversation.id }));
    }
    expect(results.some((result) => result.error?.code === 'RATE_LIMITED')).toBe(true);
  });
});

describe('presence', () => {
  it('counts every connection and only goes offline when the last one closes', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const bSocket = await socketFor(b);
    const updates = collect(bSocket, EVENTS.presence);

    const online = nextEvent(bSocket, EVENTS.presence, (p) => p.online === true);
    const tab1 = await socketFor(a);
    await online;
    const tab2 = await socketFor(a);

    tab1.disconnect();
    await pause(200);
    expect(updates.filter((update) => update.online === false)).toEqual([]);
    const asB = await b.client.get(`/conversations/${conversation.id}`);
    expect(asB.body.data.peer.presence.online).toBe(true);

    const offline = nextEvent(bSocket, EVENTS.presence, (p) => p.online === false);
    tab2.disconnect();
    const update = await offline;
    expect(update.userId).toBe(a.user.id);
    expect(update.lastSeenAt).toEqual(expect.any(String));
    expect(updates.filter((u) => u.online === true)).toHaveLength(1);
  });

  it('is not shown to people the privacy settings exclude', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    await a.client.patch('/me/privacy', {
      onlineStatusVisibility: 'nobody',
      lastSeenVisibility: 'nobody',
    });
    const bSocket = await socketFor(b);
    const updates = collect(bSocket, EVENTS.presence);
    const aSocket = await socketFor(a);
    await pause(200);
    aSocket.disconnect();
    await pause(200);
    expect(updates).toEqual([]);
    const asB = await b.client.get(`/conversations/${conversation.id}`);
    expect(asB.body.data.peer.presence).toEqual({ online: null, lastSeenAt: null });
  });

  it('is never published across a block', async () => {
    const { a, b } = await connectedPair(server.baseUrl);
    await b.client.post('/blocks', { username: a.user.username });
    const bSocket = await socketFor(b);
    const updates = collect(bSocket, EVENTS.presence);
    const aSocket = await socketFor(a);
    await pause(200);
    aSocket.disconnect();
    await pause(200);
    expect(updates).toEqual([]);
  });
});

describe('rate limits', () => {
  let limited;
  beforeAll(async () => {
    limited = await startTestServer({
      rateLimitsEnabled: true,
      rateLimits: { messageSendPerUser: { windowMs: 60_000, limit: 3 } },
    });
  });
  afterAll(async () => {
    await limited.close();
  });

  it('limits message sends per user across Socket.IO and HTTP', async () => {
    const { a, conversation } = await connectedPair(limited.baseUrl);
    const socket = await openSocket(limited, a, sockets);
    expect((await send(socket, conversation.id)).ok).toBe(true);
    expect((await httpSend(a, conversation.id)).status).toBe(201);
    expect((await send(socket, conversation.id)).ok).toBe(true);
    const fourth = await send(socket, conversation.id);
    expect(fourth.error.code).toBe('RATE_LIMITED');
    expect((await httpSend(a, conversation.id)).status).toBe(429);
  });
});

describe('unauthenticated sockets', () => {
  it('cannot connect at all', async () => {
    const anonymous = new TestClient(server.baseUrl);
    await expect(openSocket(server, { client: anonymous }, sockets)).rejects.toThrow(
      'UNAUTHORIZED',
    );
  });
});
