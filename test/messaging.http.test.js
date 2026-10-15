import { randomUUID } from 'node:crypto';
import { LIMITS } from '#shared';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Conversation } from '../src/models/conversation.model.js';
import { Message } from '../src/models/message.model.js';
import { buildTestApp, connect, sendRequest, signedInUser, useTestDatabase } from './helpers.js';
import { connectedPair, httpSend, newMessage } from './messaging-helpers.js';

useTestDatabase();

let app;
beforeAll(() => {
  ({ app } = buildTestApp());
});
afterEach(() => {
  vi.restoreAllMocks();
});

const history = (user, conversationId, query = '') =>
  user.client.get(`/conversations/${conversationId}/messages${query}`);

describe('opening conversations', () => {
  it('creates one conversation per pair, whoever opens it, with exactly two participants', async () => {
    const { a, b, conversation } = await connectedPair(app);
    expect(conversation.peer.id).toBe(b.user.id);
    expect(conversation.canMessage).toBe(true);
    expect(conversation.lastMessage).toBeNull();

    const again = await a.client.post('/conversations', { userId: b.user.id });
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(conversation.id);
    const fromB = await b.client.post('/conversations', { userId: a.user.id });
    expect(fromB.status).toBe(200);
    expect(fromB.body.data.id).toBe(conversation.id);
    expect(fromB.body.data.peer.id).toBe(a.user.id);

    const stored = await Conversation.findById(conversation.id).lean();
    expect(stored.participants.map(String).sort()).toEqual([a.user.id, b.user.id].sort());
    expect(stored.members).toHaveLength(2);
  });

  it('handles both people opening the conversation at the same moment', async () => {
    const a = await signedInUser(app);
    const b = await signedInUser(app);
    await connect(a, b);
    const responses = await Promise.all([
      a.client.post('/conversations', { userId: b.user.id }),
      b.client.post('/conversations', { userId: a.user.id }),
      a.client.post('/conversations', { userId: b.user.id }),
      b.client.post('/conversations', { userId: a.user.id }),
    ]);
    expect(responses.map((response) => response.status).every((s) => s === 200 || s === 201)).toBe(
      true,
    );
    expect(new Set(responses.map((response) => response.body.data.id)).size).toBe(1);
    expect(
      await Conversation.countDocuments({ participants: { $all: [a.user.id, b.user.id] } }),
    ).toBe(1);
  });

  it('refuses people who are not connected (pending, rejected or no request)', async () => {
    const a = await signedInUser(app);
    const b = await signedInUser(app);
    const c = await signedInUser(app);

    const none = await a.client.post('/conversations', { userId: b.user.id });
    expect(none.status).toBe(403);
    expect(none.body.error.code).toBe('MESSAGING_NOT_ALLOWED');

    const pending = await sendRequest(a, b);
    expect(pending.status).toBe(201);
    expect((await a.client.post('/conversations', { userId: b.user.id })).status).toBe(403);
    expect((await b.client.post('/conversations', { userId: a.user.id })).status).toBe(403);

    const toReject = await sendRequest(a, c);
    await c.client.post(`/message-requests/${toReject.body.data.id}/reject`);
    expect((await a.client.post('/conversations', { userId: c.user.id })).status).toBe(403);

    expect(await Conversation.countDocuments({ participants: a.user.id })).toBe(0);
  });

  it('rejects yourself, unknown people and malformed input', async () => {
    const a = await signedInUser(app);
    expect((await a.client.post('/conversations', { userId: a.user.id })).status).toBe(400);
    expect((await a.client.post('/conversations', { userId: '0'.repeat(24) })).status).toBe(404);
    expect((await a.client.post('/conversations', { userId: 'nope' })).status).toBe(400);
    expect((await a.client.post('/conversations', {})).status).toBe(400);
  });

  it('requires a session', async () => {
    const { TestClient } = await import('./helpers.js');
    const anonymous = new TestClient(app);
    expect((await anonymous.get('/conversations')).status).toBe(401);
  });
});

describe('sending and reading history', () => {
  it('stores messages and returns them after reopening the conversation', async () => {
    const { a, b, conversation } = await connectedPair(app);
    const first = await httpSend(a, conversation.id, newMessage('Hi Grace'));
    expect(first.status).toBe(201);
    expect(first.body.data.duplicate).toBe(false);
    expect(first.body.data.message).toMatchObject({
      seq: 1,
      senderId: a.user.id,
      text: 'Hi Grace',
      conversationId: conversation.id,
    });
    expect((await httpSend(b, conversation.id, newMessage('Hi Ada'))).status).toBe(201);

    // "Reopen": open again, then load the history.
    const reopened = await b.client.post('/conversations', { userId: a.user.id });
    const res = await history(b, reopened.body.data.id);
    expect(res.status).toBe(200);
    expect(res.body.data.map((message) => [message.seq, message.text])).toEqual([
      [1, 'Hi Grace'],
      [2, 'Hi Ada'],
    ]);
    expect(res.body.meta).toEqual({ limit: 30, hasMore: false, nextCursor: null });
    expect(await Message.countDocuments({ conversation: conversation.id })).toBe(2);
  });

  it('never trusts a client-supplied sender and accepts text only', async () => {
    const { a, b, conversation } = await connectedPair(app);
    const spoofed = await httpSend(a, conversation.id, { ...newMessage(), senderId: b.user.id });
    expect(spoofed.status).toBe(400);
    const attachment = await httpSend(a, conversation.id, {
      ...newMessage(),
      attachments: [{ url: 'x' }],
    });
    expect(attachment.status).toBe(400);
    expect((await httpSend(a, conversation.id, newMessage('   '))).status).toBe(400);
    expect(
      (await httpSend(a, conversation.id, newMessage('x'.repeat(LIMITS.messageTextMaxLength + 1))))
        .status,
    ).toBe(400);
    expect(
      (await httpSend(a, conversation.id, { clientMessageId: 'not-a-uuid', text: 'hi' })).status,
    ).toBe(400);
    expect(await Message.countDocuments({ conversation: conversation.id })).toBe(0);

    const ok = await httpSend(a, conversation.id, newMessage('  trimmed  '));
    expect(ok.body.data.message).toMatchObject({ senderId: a.user.id, text: 'trimmed' });
  });

  it('paginates history with no missing or duplicated messages, even while new ones arrive', async () => {
    const { a, b, conversation } = await connectedPair(app);
    for (let index = 1; index <= 23; index++) {
      await httpSend(index % 2 ? a : b, conversation.id, newMessage(`message ${index}`));
    }

    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const res = await history(a, conversation.id, `?limit=5${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      const seqs = res.body.data.map((message) => message.seq);
      // Each page is in ascending order.
      expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
      seen.unshift(...seqs);
      cursor = res.body.meta.nextCursor;
      pages += 1;
      // New messages arriving during the scroll-back must not shift older pages.
      if (pages === 2) await httpSend(b, conversation.id, newMessage('arrived meanwhile'));
    } while (cursor);

    expect(seen).toEqual(Array.from({ length: 23 }, (_, index) => index + 1));
    expect(pages).toBe(5);

    // Forward synchronisation picks up the message that arrived meanwhile.
    const after = await history(a, conversation.id, '?after=23');
    expect(after.body.data.map((message) => message.text)).toEqual(['arrived meanwhile']);
  });

  it('rejects malformed cursors', async () => {
    const { a, conversation } = await connectedPair(app);
    expect((await history(a, conversation.id, '?cursor=abc')).status).toBe(400);
    expect((await history(a, conversation.id, '?cursor=2&after=1')).status).toBe(400);
    expect((await a.client.get('/conversations?cursor=%%%')).status).toBe(400);
  });
});

describe('membership', () => {
  it('a non-member cannot read the conversation, its history, or post to it', async () => {
    const { a, conversation } = await connectedPair(app);
    await httpSend(a, conversation.id);
    const outsider = await signedInUser(app);

    for (const res of [
      await outsider.client.get(`/conversations/${conversation.id}`),
      await history(outsider, conversation.id),
      await history(outsider, conversation.id, '?after=0'),
      await httpSend(outsider, conversation.id),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(JSON.stringify(res.body)).not.toContain('Hello there');
    }
    expect((await outsider.client.get('/conversations')).body.data).toEqual([]);
    expect((await outsider.client.get('/conversations/not-an-id')).status).toBe(404);
  });
});

describe('permissions after the conversation exists', () => {
  it('blocking stops messages in both directions immediately and never reveals the block', async () => {
    const { a, b, conversation } = await connectedPair(app);
    expect((await httpSend(b, conversation.id)).status).toBe(201);

    expect((await a.client.post('/blocks', { username: b.user.username })).status).toBe(201);

    const fromBlocked = await httpSend(b, conversation.id, newMessage('let me in'));
    expect(fromBlocked.status).toBe(403);
    expect(fromBlocked.body.error.code).toBe('MESSAGING_NOT_ALLOWED');
    expect(fromBlocked.body.error.message).not.toMatch(/block/i);

    const fromBlocker = await httpSend(a, conversation.id);
    expect(fromBlocker.status).toBe(403);
    expect(fromBlocker.body.error.message).toMatch(/unblock/i);

    // The blocked person can't open a new one either; the blocker looks like a missing account.
    expect((await b.client.post('/conversations', { userId: a.user.id })).status).toBe(404);

    const asB = await b.client.get(`/conversations/${conversation.id}`);
    expect(asB.body.data).toMatchObject({
      canMessage: false,
      messagingUnavailableReason: 'unavailable',
    });
    expect(asB.body.data.peer.presence).toEqual({ online: null, lastSeenAt: null });
    const asA = await a.client.get(`/conversations/${conversation.id}`);
    expect(asA.body.data.messagingUnavailableReason).toBe('blocked_by_you');

    expect(await Message.countDocuments({ text: 'let me in' })).toBe(0);

    // Unblocking restores messaging (they are still connected).
    expect((await a.client.delete(`/blocks/${b.user.id}`)).status).toBe(204);
    expect((await httpSend(b, conversation.id, newMessage('thanks'))).status).toBe(201);
  });
});

describe('idempotency', () => {
  it('a retry with the same key returns the stored message instead of creating another', async () => {
    const { a, conversation } = await connectedPair(app);
    const message = newMessage('only once');
    const first = await httpSend(a, conversation.id, message);
    const retry = await httpSend(a, conversation.id, message);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.data.duplicate).toBe(true);
    expect(retry.body.data.message).toEqual(first.body.data.message);
    expect(await Message.countDocuments({ clientMessageId: message.clientMessageId })).toBe(1);
  });

  it('rejects reusing a key for a different message', async () => {
    const { a, conversation } = await connectedPair(app);
    const message = newMessage('original');
    await httpSend(a, conversation.id, message);
    const conflict = await httpSend(a, conversation.id, { ...message, text: 'changed' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await Message.countDocuments({ clientMessageId: message.clientMessageId })).toBe(1);
  });

  it('concurrent submissions with one key store exactly one message', async () => {
    const { a, conversation } = await connectedPair(app);
    const message = newMessage('racing');
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => httpSend(a, conversation.id, message)),
    );
    expect(responses.every((res) => res.status === 200 || res.status === 201)).toBe(true);
    expect(responses.filter((res) => res.body.data.duplicate === false)).toHaveLength(1);
    expect(new Set(responses.map((res) => res.body.data.message.id)).size).toBe(1);
    expect(await Message.countDocuments({ clientMessageId: message.clientMessageId })).toBe(1);
  });

  it('concurrent different messages get distinct, gap-free sequence numbers', async () => {
    const { a, b, conversation } = await connectedPair(app);
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        httpSend(index % 2 ? a : b, conversation.id, newMessage(`m${index}`)),
      ),
    );
    expect(responses.every((res) => res.status === 201)).toBe(true);
    const seqs = responses.map((res) => res.body.data.message.seq).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    const summary = await a.client.get(`/conversations/${conversation.id}`);
    expect(summary.body.data.lastMessage.seq).toBe(12);
  });

  it('a database failure is reported as an error and nothing is stored', async () => {
    const { a, conversation } = await connectedPair(app);
    vi.spyOn(Message, 'create').mockRejectedValueOnce(new Error('connection reset'));
    const message = newMessage('may fail');
    const failed = await httpSend(a, conversation.id, message);
    expect(failed.status).toBe(500);
    expect(failed.body.error.code).toBe('INTERNAL_ERROR');
    expect(failed.body.data).toBeUndefined();
    expect(await Message.countDocuments({ clientMessageId: message.clientMessageId })).toBe(0);

    // Retrying with the same key succeeds once the database is back.
    const retried = await httpSend(a, conversation.id, message);
    expect(retried.status).toBe(201);
    expect(await Message.countDocuments({ clientMessageId: message.clientMessageId })).toBe(1);
  });

  it('a retry repairs the conversation summary if updating it failed after the insert', async () => {
    const { a, conversation } = await connectedPair(app);
    vi.spyOn(Conversation, 'updateOne').mockRejectedValueOnce(new Error('timeout'));
    const message = newMessage('summary later');
    expect((await httpSend(a, conversation.id, message)).status).toBe(500);
    expect((await Conversation.findById(conversation.id).lean()).lastMessage).toBeNull();

    const retried = await httpSend(a, conversation.id, message);
    expect(retried.status).toBe(200);
    expect(retried.body.data.duplicate).toBe(true);
    expect((await Conversation.findById(conversation.id).lean()).lastMessage.preview).toBe(
      'summary later',
    );
  });
});

describe('conversation list', () => {
  it('is sorted by latest activity and reorders after a new message', async () => {
    const me = await signedInUser(app);
    const others = [];
    for (let index = 0; index < 3; index++) {
      const other = await signedInUser(app);
      await connect(me, other);
      const opened = await me.client.post('/conversations', { userId: other.user.id });
      others.push({ user: other, conversationId: opened.body.data.id });
      await httpSend(other, opened.body.data.id, newMessage(`from ${index}`));
    }
    const ids = (res) => res.body.data.map((conversation) => conversation.id);
    const [first, second, third] = others.map((other) => other.conversationId);

    expect(ids(await me.client.get('/conversations'))).toEqual([third, second, first]);

    await httpSend(me, first, newMessage('bump'));
    const list = await me.client.get('/conversations');
    expect(ids(list)).toEqual([first, third, second]);
    expect(list.body.data[0].lastMessage).toMatchObject({ preview: 'bump', senderId: me.user.id });

    // Keyset pagination walks the same order without repeats.
    const page1 = await me.client.get('/conversations?limit=2');
    expect(page1.body.meta.hasMore).toBe(true);
    const page2 = await me.client.get(
      `/conversations?limit=2&cursor=${page1.body.meta.nextCursor}`,
    );
    expect([...ids(page1), ...ids(page2)]).toEqual([first, third, second]);
    expect(page2.body.meta.hasMore).toBe(false);
  });

  it('keeps unread counts per person', async () => {
    const { a, b, conversation } = await connectedPair(app);
    await httpSend(b, conversation.id, newMessage('one'));
    await httpSend(b, conversation.id, newMessage('two'));
    await httpSend(a, conversation.id, newMessage('reply'));

    const forA = (await a.client.get('/conversations')).body.data[0];
    const forB = (await b.client.get('/conversations')).body.data[0];
    expect(forA.unreadCount).toBe(2);
    expect(forB.unreadCount).toBe(1);
  });
});

describe('idempotency keys belong to their sender', () => {
  it('two people may use the same client message id', async () => {
    const { a, b, conversation } = await connectedPair(app);
    const clientMessageId = randomUUID();
    expect((await httpSend(a, conversation.id, { clientMessageId, text: 'a' })).status).toBe(201);
    expect((await httpSend(b, conversation.id, { clientMessageId, text: 'b' })).status).toBe(201);
  });
});

describe('models', () => {
  it('a conversation must have exactly two different participants', async () => {
    const { Types } = await import('mongoose');
    const [x, y, z] = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
    const base = { pairKey: `${x}:${y}`, lastActivityAt: new Date() };
    await expect(
      Conversation.create({ ...base, participants: [x, x], members: [{ user: x }, { user: x }] }),
    ).rejects.toThrow();
    await expect(
      Conversation.create({
        ...base,
        participants: [x, y, z],
        members: [{ user: x }, { user: y }, { user: z }],
      }),
    ).rejects.toThrow();
    await expect(
      Conversation.create({ ...base, participants: [x, y], members: [{ user: x }, { user: z }] }),
    ).rejects.toThrow();
  });

  it('declares the indexes messaging relies on', () => {
    const keys = (model) =>
      model.schema.indexes().map(([fields, options]) => ({ fields, options }));
    expect(keys(Message)).toEqual(
      expect.arrayContaining([
        { fields: { conversation: 1, seq: 1 }, options: expect.objectContaining({ unique: true }) },
        {
          fields: { sender: 1, clientMessageId: 1 },
          options: expect.objectContaining({ unique: true }),
        },
      ]),
    );
    expect(keys(Conversation)).toEqual(
      expect.arrayContaining([
        { fields: { pairKey: 1 }, options: expect.objectContaining({ unique: true }) },
        { fields: { participants: 1, lastActivityAt: -1, _id: -1 }, options: expect.any(Object) },
      ]),
    );
  });
});
