import { CONVERSATION_PIN_LIMIT, MESSAGING_SOCKET_EVENTS as EVENTS } from '#shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Conversation } from '../src/models/conversation.model.js';
import { Message } from '../src/models/message.model.js';
import {
  connect,
  sendRequest,
  signedInUser,
  startTestServer,
  TestClient,
  useTestDatabase,
} from './helpers.js';
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

const prefs = (user, conversationId, body) =>
  user.client.patch(`/conversations/${conversationId}/preferences`, body);
const list = async (user, query = '') =>
  (await user.client.get(`/conversations${query}`)).body.data;
const ids = (conversations) => conversations.map((conversation) => conversation.id);
const summary = async (user, conversationId) =>
  (await user.client.get(`/conversations/${conversationId}`)).body.data;

/** Signs the same account in again on a "new device" (a fresh client). */
async function relogin(user) {
  const client = new TestClient(server.baseUrl);
  const res = await client.post('/auth/login', {
    email: user.user.email,
    password: user.user.password,
  });
  expect(res.status).toBe(200);
  return { ...user, client };
}

describe('per-user chat preferences', () => {
  it('each participant has their own settings, and they persist after signing in again', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const res = await prefs(a, conversation.id, { pinned: true, favorite: true, muted: 'always' });
    expect(res.status).toBe(200);
    expect(res.body.data.preferences).toMatchObject({
      pinned: true,
      favorite: true,
      archived: false,
    });
    expect(res.body.data.preferences.mutedUntil).toMatch(/^9999-/);

    expect((await summary(b, conversation.id)).preferences).toEqual({
      pinned: false,
      favorite: false,
      archived: false,
      markedUnread: false,
      mutedUntil: null,
    });
    await prefs(b, conversation.id, { archived: true });
    expect((await summary(a, conversation.id)).preferences.archived).toBe(false);

    const again = await relogin(a);
    expect((await summary(again, conversation.id)).preferences).toMatchObject({
      pinned: true,
      favorite: true,
    });
    // The other person's settings are never exposed.
    expect(JSON.stringify(await summary(again, conversation.id))).not.toContain('archivedAt');
  });

  it('cannot change someone else’s settings or address them', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const outsider = await signedInUser(server.baseUrl);
    expect((await prefs(outsider, conversation.id, { archived: true })).status).toBe(404);
    expect((await prefs(a, conversation.id, { userId: b.user.id, archived: true })).status).toBe(
      400,
    );
    expect((await prefs(a, conversation.id, { 'members.1.archivedAt': 1 })).status).toBe(400);
    expect((await prefs(a, conversation.id, {})).status).toBe(400);
    expect((await prefs(a, conversation.id, { muted: 'forever' })).status).toBe(400);
    expect((await outsider.client.delete(`/conversations/${conversation.id}`)).status).toBe(404);
    const stored = await Conversation.findById(conversation.id).lean();
    expect(stored.members.every((member) => !member.archivedAt && !member.hiddenAt)).toBe(true);
  });

  it('syncs settings to your other tabs in real time, never to the other person', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const aSocket = await openSocket(server, a, sockets);
    const bSocket = await openSocket(server, b, sockets);
    const bEvents = collect(bSocket, EVENTS.preferences);
    const event = nextEvent(aSocket, EVENTS.preferences);
    await prefs(a, conversation.id, { favorite: true });
    expect(await event).toMatchObject({
      conversationId: conversation.id,
      preferences: { favorite: true },
      removed: false,
    });
    await pause(100);
    expect(bEvents).toEqual([]);
  });
});

describe('archive, pin, favorite, mute and unread in the list', () => {
  async function userWithChats(count) {
    const me = await signedInUser(server.baseUrl);
    const chats = [];
    for (let i = 0; i < count; i++) {
      const other = await signedInUser(server.baseUrl, { displayName: `Friend ${i}` });
      await connect(me, other);
      const opened = await me.client.post('/conversations', { userId: other.user.id });
      await httpSend(other, opened.body.data.id, newMessage(`hi from ${i}`));
      chats.push({ other, id: opened.body.data.id });
    }
    return { me, chats };
  }

  it('archived chats leave the main list and appear under "archived"', async () => {
    const { me, chats } = await userWithChats(2);
    await prefs(me, chats[0].id, { archived: true });
    expect(ids(await list(me))).toEqual([chats[1].id]);
    expect(ids(await list(me, '?filter=archived'))).toEqual([chats[0].id]);
    await prefs(me, chats[0].id, { archived: false });
    expect(ids(await list(me))).toHaveLength(2);
  });

  it('a new message unarchives an unmuted chat, but a muted chat stays archived', async () => {
    const { me, chats } = await userWithChats(2);
    await prefs(me, chats[0].id, { archived: true });
    await prefs(me, chats[1].id, { archived: true, muted: '8h' });
    await httpSend(chats[0].other, chats[0].id, newMessage('wake up'));
    await httpSend(chats[1].other, chats[1].id, newMessage('shh'));
    expect(ids(await list(me))).toEqual([chats[0].id]);
    expect(ids(await list(me, '?filter=archived'))).toEqual([chats[1].id]);
    // The muted chat still counts its unread messages.
    expect((await summary(me, chats[1].id)).unreadCount).toBe(2);
    // Sending your own message doesn't unarchive your chat.
    await httpSend(me, chats[1].id, newMessage('mine'));
    expect((await summary(me, chats[1].id)).preferences.archived).toBe(true);
  });

  it('pinned chats come first, archiving unpins, and the pin limit holds', async () => {
    const { me, chats } = await userWithChats(CONVERSATION_PIN_LIMIT + 1);
    await prefs(me, chats[0].id, { pinned: true });
    const first = await list(me);
    expect(first[0].id).toBe(chats[0].id);
    expect(first[0].preferences.pinned).toBe(true);
    // Pinned chats are not repeated on later pages.
    const paged = await me.client.get('/conversations?limit=2');
    const next = await me.client.get(`/conversations?limit=2&cursor=${paged.body.meta.nextCursor}`);
    expect(ids(next.body.data)).not.toContain(chats[0].id);

    await prefs(me, chats[0].id, { archived: true });
    expect((await summary(me, chats[0].id)).preferences).toMatchObject({
      pinned: false,
      archived: true,
    });

    const results = await Promise.all(chats.map((chat) => prefs(me, chat.id, { pinned: true })));
    expect(results.filter((res) => res.status === 200)).toHaveLength(CONVERSATION_PIN_LIMIT);
    expect(results.find((res) => res.status !== 200).body.error.code).toBe('PIN_LIMIT_REACHED');
    const pinnedCount = (await list(me)).filter((c) => c.preferences.pinned).length;
    expect(pinnedCount).toBe(CONVERSATION_PIN_LIMIT);
  });

  it('favorites and unread filters, and "mark as unread" cleared by reading', async () => {
    const { me, chats } = await userWithChats(3);
    await prefs(me, chats[2].id, { favorite: true });
    expect(ids(await list(me, '?filter=favorites'))).toEqual([chats[2].id]);

    // Everything has one unread message from the other person.
    expect(ids(await list(me, '?filter=unread')).sort()).toEqual(ids(chats).sort());

    const socket = await openSocket(server, me, sockets);
    for (const chat of chats) {
      await request(socket, EVENTS.delivered, { conversationId: chat.id, seq: 1 });
      await request(socket, EVENTS.read, { conversationId: chat.id, seq: 1 });
    }
    expect(await list(me, '?filter=unread')).toEqual([]);

    await prefs(me, chats[1].id, { markedUnread: true });
    const unread = await list(me, '?filter=unread');
    expect(ids(unread)).toEqual([chats[1].id]);
    expect(unread[0]).toMatchObject({ unreadCount: 0, preferences: { markedUnread: true } });

    // A new message doesn't clear it; reading does.
    await httpSend(chats[1].other, chats[1].id, newMessage('again'));
    expect((await summary(me, chats[1].id)).preferences.markedUnread).toBe(true);
    await request(socket, EVENTS.delivered, { conversationId: chats[1].id, seq: 2 });
    await request(socket, EVENTS.read, { conversationId: chats[1].id, seq: 2 });
    expect((await summary(me, chats[1].id)).preferences.markedUnread).toBe(false);
  });

  it('unread counts stay correct as new messages arrive, whatever the settings', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    await prefs(a, conversation.id, { muted: 'always', pinned: true, markedUnread: true });
    for (let i = 0; i < 3; i++) await httpSend(b, conversation.id, newMessage(`m${i}`));
    await httpSend(a, conversation.id, newMessage('mine'));
    const forA = await summary(a, conversation.id);
    expect(forA.unreadCount).toBe(3);
    expect((await summary(b, conversation.id)).unreadCount).toBe(1);
    expect(forA.preferences).toMatchObject({ pinned: true, markedUnread: true });
  });
});

describe('remove from list', () => {
  it('hides it only for you; messages and the other person’s list are untouched', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    await httpSend(a, conversation.id, newMessage('keep me'));
    expect((await a.client.delete(`/conversations/${conversation.id}`)).status).toBe(204);

    expect(ids(await list(a))).not.toContain(conversation.id);
    expect(ids(await list(a, '?filter=archived'))).not.toContain(conversation.id);
    expect(ids(await list(b))).toContain(conversation.id);
    expect(await Message.countDocuments({ conversation: conversation.id })).toBe(1);
    // Still reachable directly, with its history.
    const history = await a.client.get(`/conversations/${conversation.id}/messages`);
    expect(history.body.data.map((m) => m.text)).toEqual(['keep me']);

    // The next message brings it back.
    await httpSend(b, conversation.id, newMessage('hello again'));
    expect(ids(await list(a))).toContain(conversation.id);
  });

  it('opening the conversation again restores it', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    await a.client.delete(`/conversations/${conversation.id}`);
    await a.client.post('/conversations', { userId: b.user.id });
    expect(ids(await list(a))).toContain(conversation.id);
  });
});

describe('search', () => {
  it('finds your conversations by username or display name, and nobody else’s', async () => {
    const me = await signedInUser(server.baseUrl);
    const grace = await signedInUser(server.baseUrl, { displayName: 'Grace Hopper' });
    const alan = await signedInUser(server.baseUrl, { displayName: 'Alan Turing' });
    await connect(me, grace);
    await connect(me, alan);
    const g = (await me.client.post('/conversations', { userId: grace.user.id })).body.data;
    const t = (await me.client.post('/conversations', { userId: alan.user.id })).body.data;
    // A conversation between two other people.
    const strangers = await connectedPair(server.baseUrl);

    expect(ids(await list(me, '?q=hopp'))).toEqual([g.id]);
    // "@" + full username (all test usernames share the "ada_" prefix).
    expect(ids(await list(me, `?q=@${alan.user.username}`))).toEqual([t.id]);
    expect(await list(me, `?q=${strangers.b.user.username}`)).toEqual([]);
    expect(await list(me, '?q=.*')).toEqual([]);
    await prefs(me, g.id, { archived: true });
    expect(ids(await list(me, '?filter=archived&q=grace'))).toEqual([g.id]);
    expect(await list(me, '?q=grace')).toEqual([]);
  });
});

describe('blocking across HTTP, Socket.IO and attachments', () => {
  it('a block stops sending, typing, uploads and the blocked person’s attachment access; history stays', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    await httpSend(a, conversation.id, newMessage('before the block'));
    const uploaded = await a.client.send(
      'post',
      `/conversations/${conversation.id}/attachments`,
      undefined,
      (t) => t.attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'x.pdf' }),
    );
    await httpSend(a, conversation.id, {
      clientMessageId: newMessage().clientMessageId,
      attachmentId: uploaded.body.data.id,
    });
    const url = `/attachments/${uploaded.body.data.id}/content`;
    expect((await b.client.get(url)).status).toBe(200);

    const aSocket = await openSocket(server, a, sockets);
    const bSocket = await openSocket(server, b, sockets);
    await request(bSocket, EVENTS.typingStart, { conversationId: conversation.id });
    const changedForB = nextEvent(bSocket, EVENTS.changed);
    const typingCleared = nextEvent(aSocket, EVENTS.typingStop);

    // A blocks B.
    expect((await a.client.post('/blocks', { username: b.user.username })).status).toBe(201);
    expect(await changedForB).toEqual({ conversationId: conversation.id });
    expect((await typingCleared).conversationId).toBe(conversation.id);

    // B: no sending (HTTP or socket), typing, uploads, reactions, opening, or file downloads.
    expect((await httpSend(b, conversation.id)).status).toBe(403);
    expect(
      (await request(bSocket, EVENTS.send, { conversationId: conversation.id, ...newMessage() }))
        .error.code,
    ).toBe('MESSAGING_NOT_ALLOWED');
    expect(
      (await request(bSocket, EVENTS.typingStart, { conversationId: conversation.id })).error.code,
    ).toBe('MESSAGING_NOT_ALLOWED');
    const upload = await b.client.send(
      'post',
      `/conversations/${conversation.id}/attachments`,
      undefined,
      (t) => t.attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'y.pdf' }),
    );
    expect(upload.status).toBe(403);
    expect((await b.client.get(url)).status).toBe(404);
    expect((await b.client.post('/conversations', { userId: a.user.id })).status).toBe(404);
    expect((await sendRequest(b, a)).status).toBe(404);

    // History isn't deleted: both still read it, and the blocker keeps their files.
    const history = await b.client.get(`/conversations/${conversation.id}/messages`);
    expect(history.body.data[0].text).toBe('before the block');
    const sync = await request(bSocket, EVENTS.sync, {
      conversationId: conversation.id,
      afterSeq: 0,
    });
    expect(sync.data.messages).toHaveLength(2);
    expect(sync.data.conversation).toMatchObject({
      canMessage: false,
      messagingUnavailableReason: 'unavailable',
    });
    expect(sync.data.conversation.peer.presence).toEqual({ online: null, lastSeenAt: null });
    expect((await a.client.get(url)).status).toBe(200);
  });

  it('unblocking restores only what current permissions allow', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    await a.client.post('/blocks', { username: b.user.username });
    const bSocket = await openSocket(server, b, sockets);
    const changed = nextEvent(bSocket, EVENTS.changed);
    expect((await a.client.delete(`/blocks/${b.user.id}`)).status).toBe(204);
    await changed;
    // Still connected: messaging resumes.
    expect((await httpSend(b, conversation.id)).status).toBe(201);
    expect((await summary(b, conversation.id)).canMessage).toBe(true);

    // People who were never connected still can't message after an unblock.
    const c = await signedInUser(server.baseUrl);
    await c.client.post('/blocks', { username: a.user.username });
    await c.client.delete(`/blocks/${a.user.id}`);
    expect((await a.client.post('/conversations', { userId: c.user.id })).status).toBe(403);
  });
});
