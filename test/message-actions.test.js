import { MESSAGING_SOCKET_EVENTS as EVENTS, PINNED_MESSAGES_LIMIT } from '#shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Conversation } from '../src/models/conversation.model.js';
import { Message } from '../src/models/message.model.js';
import { connect, signedInUser, startTestServer, useTestDatabase } from './helpers.js';
import {
  collect,
  connectedPair,
  httpSend,
  newMessage,
  nextEvent,
  openSocket,
  pause,
  request,
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

const path = (conversationId, messageId, suffix = '') =>
  `/conversations/${conversationId}/messages/${messageId}${suffix}`;
const sendText = async (user, conversationId, text = 'hello') =>
  (await httpSend(user, conversationId, newMessage(text))).body.data.message;
const history = async (user, conversationId) =>
  (await user.client.get(`/conversations/${conversationId}/messages`)).body.data;
// createdAt is immutable in Mongoose, so back-date it directly in the collection.
const ageMessage = (id, ms) =>
  Message.collection.updateOne(
    { _id: new Message.base.Types.ObjectId(id) },
    { $set: { createdAt: new Date(Date.now() - ms) } },
  );

describe('reply', () => {
  it('references the original with a safe preview, and degrades when it is deleted', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const original = await sendText(a, conversation.id, '<b>Lunch?</b>');
    const reply = await httpSend(b, conversation.id, {
      ...newMessage('Yes!'),
      replyToId: original.id,
    });
    expect(reply.status).toBe(201);
    expect(reply.body.data.message.replyTo).toEqual({
      id: original.id,
      senderId: a.user.id,
      kind: 'text',
      preview: '<b>Lunch?</b>',
    });

    await a.client.delete(`${path(conversation.id, original.id)}?scope=everyone`);
    const [, again] = await history(b, conversation.id);
    expect(again.replyTo).toMatchObject({ kind: 'deleted', preview: 'This message was deleted' });
  });

  it('cannot reply to a message from another conversation, or one deleted for you', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const other = await connectedPair(server.baseUrl);
    const foreign = await sendText(other.a, other.conversation.id, 'secret');
    const res = await httpSend(a, conversation.id, { ...newMessage('hi'), replyToId: foreign.id });
    expect(res.status).toBe(400);

    const mine = await sendText(b, conversation.id, 'hide me');
    await a.client.delete(`${path(conversation.id, mine.id)}?scope=me`);
    const hidden = await httpSend(a, conversation.id, { ...newMessage('re'), replyToId: mine.id });
    expect(hidden.status).toBe(400);
  });
});

describe('edit', () => {
  it('edits your own text message for both people, with edit metadata and a live update', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const bSocket = await openSocket(server, b, sockets);
    const message = await sendText(a, conversation.id, 'helo');
    const updated = nextEvent(bSocket, EVENTS.updated);

    const res = await a.client.patch(path(conversation.id, message.id), { text: 'hello' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ text: 'hello', rev: 1 });
    expect(res.body.data.editedAt).toEqual(expect.any(String));
    expect((await updated).message).toMatchObject({ id: message.id, text: 'hello', rev: 1 });
    expect((await history(b, conversation.id))[0].text).toBe('hello');
    const summary = await b.client.get(`/conversations/${conversation.id}`);
    expect(summary.body.data.lastMessage.preview).toBe('hello');
  });

  it('refuses other people’s messages, non-text messages, deleted ones and expired windows', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const message = await sendText(a, conversation.id, 'mine');
    const notYours = await b.client.patch(path(conversation.id, message.id), { text: 'hacked' });
    expect(notYours.status).toBe(403);

    const sticker = await httpSend(a, conversation.id, {
      clientMessageId: newMessage().clientMessageId,
      sticker: 'wave',
    });
    expect(
      (await a.client.patch(path(conversation.id, sticker.body.data.message.id), { text: 'x' }))
        .status,
    ).toBe(400);

    const old = await sendText(a, conversation.id, 'old');
    await ageMessage(old.id, 16 * 60_000);
    const expired = await a.client.patch(path(conversation.id, old.id), { text: 'new' });
    expect(expired.status).toBe(403);
    expect(expired.body.error.code).toBe('ACTION_WINDOW_EXPIRED');

    await a.client.delete(`${path(conversation.id, message.id)}?scope=everyone`);
    expect((await a.client.patch(path(conversation.id, message.id), { text: 'back' })).status).toBe(
      409,
    );
    expect((await Message.findById(message.id).lean()).text).toBe('');
  });

  it('honours a disabled edit window from configuration', async () => {
    const strict = await startTestServer({ messages: { editWindowMs: 0, deleteWindowMs: 0 } });
    try {
      const { a, conversation } = await connectedPair(strict.baseUrl);
      const message = await sendText(a, conversation.id, 'x');
      expect(
        (await a.client.patch(path(conversation.id, message.id), { text: 'y' })).body.error.code,
      ).toBe('ACTION_WINDOW_EXPIRED');
      expect(
        (await a.client.delete(`${path(conversation.id, message.id)}?scope=everyone`)).body.error
          .code,
      ).toBe('ACTION_WINDOW_EXPIRED');
    } finally {
      await strict.close();
    }
  });

  it('a blocked user cannot edit', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const message = await sendText(a, conversation.id, 'x');
    await b.client.post('/blocks', { username: a.user.username });
    expect((await a.client.patch(path(conversation.id, message.id), { text: 'y' })).status).toBe(
      403,
    );
  });
});

describe('delete', () => {
  it('delete for me hides it only for you; the shared message is untouched', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const aSocket = await openSocket(server, a, sockets);
    const bSocket = await openSocket(server, b, sockets);
    const bState = collect(bSocket, EVENTS.state);
    const message = await sendText(b, conversation.id, 'keep for B');
    const state = nextEvent(aSocket, EVENTS.state);

    const res = await a.client.delete(`${path(conversation.id, message.id)}?scope=me`);
    expect(res.body.data.state).toEqual({
      conversationId: conversation.id,
      messageId: message.id,
      starred: false,
      hidden: true,
    });
    expect((await state).hidden).toBe(true);
    const [forA] = await history(a, conversation.id);
    expect(forA).toMatchObject({ id: message.id, hidden: true, text: '' });
    const [forB] = await history(b, conversation.id);
    expect(forB).toMatchObject({ hidden: false, text: 'keep for B', deletedAt: null });
    expect((await Message.findById(message.id).lean()).text).toBe('keep for B');
    await pause(100);
    expect(bState).toEqual([]);
  });

  it('delete for everyone wipes the content for both, by the sender, within the window', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const bSocket = await openSocket(server, b, sockets);
    const message = await sendText(a, conversation.id, 'oops');
    expect(
      (await b.client.delete(`${path(conversation.id, message.id)}?scope=everyone`)).status,
    ).toBe(403);

    const updated = nextEvent(bSocket, EVENTS.updated);
    const res = await a.client.delete(`${path(conversation.id, message.id)}?scope=everyone`);
    expect(res.status).toBe(200);
    expect(res.body.data.message).toMatchObject({ text: '', reactions: [] });
    expect(res.body.data.message.deletedAt).toEqual(expect.any(String));
    expect((await updated).message.deletedAt).toEqual(expect.any(String));
    const [forB] = await history(b, conversation.id);
    expect(forB).toMatchObject({ text: '', seq: 1 });
    expect(
      (await b.client.get(`/conversations/${conversation.id}`)).body.data.lastMessage.preview,
    ).toBe('This message was deleted');
    // Repeating it is harmless.
    expect(
      (await a.client.delete(`${path(conversation.id, message.id)}?scope=everyone`)).status,
    ).toBe(200);

    const old = await sendText(a, conversation.id, 'old');
    await ageMessage(old.id, 2 * 60 * 60_000);
    expect(
      (await a.client.delete(`${path(conversation.id, old.id)}?scope=everyone`)).body.error.code,
    ).toBe('ACTION_WINDOW_EXPIRED');
  });
});

describe('reactions', () => {
  it('one reaction per person, replaced by a new one, removable, live for both', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const aSocket = await openSocket(server, a, sockets);
    const message = await sendText(a, conversation.id);
    const live = nextEvent(aSocket, EVENTS.updated);

    const first = await b.client.send('put', path(conversation.id, message.id, '/reaction'), {
      emoji: '👍',
    });
    expect(first.body.data.reactions).toEqual([{ userId: b.user.id, emoji: '👍' }]);
    expect((await live).message.reactions).toEqual([{ userId: b.user.id, emoji: '👍' }]);

    const same = await b.client.send('put', path(conversation.id, message.id, '/reaction'), {
      emoji: '👍',
    });
    expect(same.body.data.rev).toBe(first.body.data.rev);
    const replaced = await b.client.send('put', path(conversation.id, message.id, '/reaction'), {
      emoji: '❤️',
    });
    expect(replaced.body.data.reactions).toEqual([{ userId: b.user.id, emoji: '❤️' }]);
    await a.client.send('put', path(conversation.id, message.id, '/reaction'), { emoji: '😂' });

    const removed = await b.client.delete(path(conversation.id, message.id, '/reaction'));
    expect(removed.body.data.reactions).toEqual([{ userId: a.user.id, emoji: '😂' }]);
  });

  it('concurrent reactions never duplicate a person’s reaction', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const message = await sendText(a, conversation.id);
    const emoji = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        b.client.send('put', path(conversation.id, message.id, '/reaction'), {
          emoji: emoji[i % 6],
        }),
      ),
    );
    const stored = await Message.findById(message.id).lean();
    expect(stored.reactions.filter((r) => String(r.user) === b.user.id)).toHaveLength(1);
  });

  it('rejects unknown emoji, outsiders and blocked users', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const message = await sendText(a, conversation.id);
    expect(
      (await b.client.send('put', path(conversation.id, message.id, '/reaction'), { emoji: '💩' }))
        .status,
    ).toBe(400);
    const outsider = await signedInUser(server.baseUrl);
    expect(
      (
        await outsider.client.send('put', path(conversation.id, message.id, '/reaction'), {
          emoji: '👍',
        })
      ).status,
    ).toBe(404);
    await a.client.post('/blocks', { username: b.user.username });
    expect(
      (await b.client.send('put', path(conversation.id, message.id, '/reaction'), { emoji: '👍' }))
        .status,
    ).toBe(403);
  });
});

describe('pins', () => {
  it(`allows at most ${PINNED_MESSAGES_LIMIT} pins, even when pinned concurrently, synced to both`, async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const bSocket = await openSocket(server, b, sockets);
    const messages = [];
    for (let i = 0; i < 5; i++) messages.push(await sendText(a, conversation.id, `m${i}`));
    const live = nextEvent(bSocket, EVENTS.pins);

    const results = await Promise.all(
      messages.map((message, i) =>
        (i % 2 ? a : b).client.send('put', path(conversation.id, message.id, '/pin')),
      ),
    );
    expect(results.filter((res) => res.status === 200)).toHaveLength(PINNED_MESSAGES_LIMIT);
    expect(results.filter((res) => res.body.error?.code === 'PIN_LIMIT_REACHED')).toHaveLength(2);
    expect((await Conversation.findById(conversation.id).lean()).pins).toHaveLength(
      PINNED_MESSAGES_LIMIT,
    );
    expect((await live).conversationId).toBe(conversation.id);

    const pinned = (await a.client.get(`/conversations/${conversation.id}`)).body.data.pins;
    const unpinned = await b.client.delete(path(conversation.id, pinned[0].messageId, '/pin'));
    expect(unpinned.body.data).toHaveLength(PINNED_MESSAGES_LIMIT - 1);
  });

  it('deleting a pinned message for everyone unpins it', async () => {
    const { a, conversation } = await connectedPair(server.baseUrl);
    const message = await sendText(a, conversation.id);
    await a.client.send('put', path(conversation.id, message.id, '/pin'));
    await a.client.delete(`${path(conversation.id, message.id)}?scope=everyone`);
    expect((await a.client.get(`/conversations/${conversation.id}`)).body.data.pins).toEqual([]);
    expect((await a.client.send('put', path(conversation.id, message.id, '/pin'))).status).toBe(
      409,
    );
  });
});

describe('star', () => {
  it('is private to the person who starred it', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const message = await sendText(b, conversation.id, 'remember this');
    expect(
      (await a.client.send('put', path(conversation.id, message.id, '/star'))).body.data.starred,
    ).toBe(true);
    expect((await history(a, conversation.id))[0].starred).toBe(true);
    expect((await history(b, conversation.id))[0].starred).toBe(false);
    const starred = await a.client.get(`/conversations/${conversation.id}/starred`);
    expect(starred.body.data.map((m) => m.text)).toEqual(['remember this']);
    expect((await b.client.get(`/conversations/${conversation.id}/starred`)).body.data).toEqual([]);
    expect(
      (await a.client.delete(path(conversation.id, message.id, '/star'))).body.data.starred,
    ).toBe(false);
  });
});

describe('forward', () => {
  it('forwards to another permitted conversation without revealing the source', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const c = await signedInUser(server.baseUrl);
    await connect(a, c);
    const ac = (await a.client.post('/conversations', { userId: c.user.id })).body.data;
    const original = await sendText(b, conversation.id, 'pass it on');

    const forward = { clientMessageId: newMessage().clientMessageId, forwardOfId: original.id };
    const res = await httpSend(a, ac.id, forward);
    expect(res.status).toBe(201);
    expect(res.body.data.message).toMatchObject({
      text: 'pass it on',
      forwarded: true,
      senderId: a.user.id,
    });
    expect(JSON.stringify(res.body.data.message)).not.toContain(b.user.id);
    // Idempotent retry.
    expect((await httpSend(a, ac.id, forward)).body.data.duplicate).toBe(true);

    // C can't forward B's message: C isn't in that conversation.
    const stolen = await httpSend(c, ac.id, {
      clientMessageId: newMessage().clientMessageId,
      forwardOfId: original.id,
    });
    expect(stolen.status).toBe(404);

    // Not to a conversation where messaging is blocked.
    await c.client.post('/blocks', { username: a.user.username });
    const blocked = await httpSend(a, ac.id, {
      clientMessageId: newMessage().clientMessageId,
      forwardOfId: original.id,
    });
    expect(blocked.status).toBe(403);

    // Deleted messages can't be forwarded.
    await b.client.delete(`${path(conversation.id, original.id)}?scope=everyone`);
    const other = await signedInUser(server.baseUrl);
    await connect(a, other);
    const ao = (await a.client.post('/conversations', { userId: other.user.id })).body.data;
    expect(
      (
        await httpSend(a, ao.id, {
          clientMessageId: newMessage().clientMessageId,
          forwardOfId: original.id,
        })
      ).status,
    ).toBe(404);
  });
});

describe('reconnection', () => {
  it('a sync with changesSince returns edits, deletions and reactions made while offline', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const m1 = await sendText(a, conversation.id, 'one');
    const m2 = await sendText(a, conversation.id, 'two');
    const bSocket = await openSocket(server, b, sockets);
    const first = await request(bSocket, EVENTS.sync, {
      conversationId: conversation.id,
      afterSeq: 0,
    });
    const { serverTime } = first.data;
    bSocket.disconnect();

    await pause(5);
    await a.client.patch(path(conversation.id, m1.id), { text: 'one (edited)' });
    await a.client.delete(`${path(conversation.id, m2.id)}?scope=everyone`);

    const back = await openSocket(server, b, sockets);
    const res = await request(back, EVENTS.sync, {
      conversationId: conversation.id,
      afterSeq: 2,
      changesSince: serverTime,
    });
    expect(res.ok).toBe(true);
    const byId = Object.fromEntries(res.data.changes.map((m) => [m.id, m]));
    expect(byId[m1.id]).toMatchObject({ text: 'one (edited)', rev: 1 });
    expect(byId[m2.id].deletedAt).toEqual(expect.any(String));
    expect(res.data.messages).toEqual([]);
  });
});
