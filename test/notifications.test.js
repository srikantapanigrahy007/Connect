import { NOTIFICATION_SOCKET_EVENTS as EVENTS } from '#shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Conversation } from '../src/models/conversation.model.js';
import { Message } from '../src/models/message.model.js';
import { Notification } from '../src/models/notification.model.js';
import { User } from '../src/models/user.model.js';
import { createGroup, ownerWithFriends } from './group-helpers.js';
import {
  connect,
  eventually,
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
const list = async (user, query = '') => {
  const res = await user.client.get(`/notifications${query}`);
  expect(res.status).toBe(200);
  return res.body.data;
};
/** Entries of one type from the API (setup helpers also create request notifications). */
const listOf = async (user, type) => (await list(user)).filter((n) => n.type === type);
const unread = async (user) =>
  (await user.client.get('/notifications/unread-count')).body.data.unread;
const stored = (user, filter = {}) =>
  Notification.find({ recipient: user.user.id, ...filter }).lean();
const messageEntries = (user) => stored(user, { type: 'message_received' });

/** Account status changes must name the current state (see the state-machine plugin). */
const setStatus = (user, status) =>
  User.updateOne(
    { _id: user.user.id, status: { $in: ['active', 'pending_verification'] } },
    { $set: { status } },
  );

/** Records that `user` read `conversationId` up to `seq` (what the web app does over the socket). */
async function readUpTo(user, conversationId, seq) {
  await server.services.messaging.markDelivered(user.user.id, conversationId, seq);
  await server.services.messaging.markRead(user.user.id, conversationId, seq);
}

describe('message notifications', () => {
  it('notifies the recipient (never the sender), collapses a chat and is read with it', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const first = await httpSend(a, conversation.id, newMessage('secret plans'));
    expect(first.status).toBe(201);

    const [entry] = await listOf(b, 'message_received');
    expect(entry).toMatchObject({
      read: false,
      count: 1,
      conversationId: conversation.id,
      conversationType: 'direct',
      link: `/chats/${conversation.id}`,
      available: true,
      actor: { id: a.user.id },
    });
    // Message text is never copied into notifications.
    expect(JSON.stringify(await stored(b))).not.toContain('secret plans');
    expect(await messageEntries(a)).toEqual([]);

    await httpSend(a, conversation.id, newMessage('more'));
    const [collapsed] = await listOf(b, 'message_received');
    expect(collapsed).toMatchObject({ id: entry.id, count: 2, read: false });
    const before = await unread(b);

    await readUpTo(b, conversation.id, 2);
    expect((await listOf(b, 'message_received'))[0].read).toBe(true);
    expect(await unread(b)).toBe(before - 1);

    // The next message starts a fresh count on the same entry.
    await httpSend(a, conversation.id, newMessage('again'));
    const [fresh] = await listOf(b, 'message_received');
    expect(fresh).toMatchObject({ id: entry.id, count: 1, read: false });
  });

  it('a retried send (same idempotency key) is not counted twice', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const message = newMessage('once');
    await httpSend(a, conversation.id, message);
    const retry = await httpSend(a, conversation.id, message);
    expect(retry.body.data.duplicate).toBe(true);
    const docs = await messageEntries(b);
    expect(docs).toHaveLength(1);
    expect(docs[0].count).toBe(1);
  });

  it('concurrent and repeated processing of one event stores one entry', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const sent = await httpSend(a, conversation.id, newMessage());
    const message = await Message.findById(sent.body.data.message.id).lean();
    const doc = await Conversation.findById(conversation.id).lean();
    const race = () =>
      Promise.all(
        Array.from({ length: 6 }, () => server.services.notifications.messageSent(doc, message)),
      );
    // Replays of an event already stored.
    await race();
    expect(await messageEntries(b)).toMatchObject([{ count: 1 }]);
    // Racing first inserts: the unique index keeps exactly one.
    await Notification.deleteMany({ recipient: b.user.id, type: 'message_received' });
    await race();
    expect(await messageEntries(b)).toMatchObject([{ count: 1 }]);
  });

  it('a muted chat creates no notifications', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const muted = await b.client.patch(`/conversations/${conversation.id}/preferences`, {
      muted: 'always',
    });
    expect(muted.status).toBe(200);
    await httpSend(a, conversation.id, newMessage());
    expect(await messageEntries(b)).toHaveLength(0);

    await b.client.patch(`/conversations/${conversation.id}/preferences`, { muted: 'off' });
    await httpSend(a, conversation.id, newMessage());
    expect(await messageEntries(b)).toHaveLength(1);
  });

  it('group messages reach members, but not muted ones or people in a block with the sender', async () => {
    const { owner, friends } = await ownerWithFriends(server.baseUrl, 3);
    const [plain, muting, blocking] = friends;
    const group = await createGroup(owner, friends, 'Climbers');
    await muting.client.patch(`/conversations/${group.id}/preferences`, { muted: '8h' });
    await blocking.client.post('/blocks', { username: owner.user.username });

    await httpSend(owner, group.id, newMessage('Saturday?'));
    const [entry] = await listOf(plain, 'message_received');
    expect(entry).toMatchObject({ conversationType: 'group', groupName: 'Climbers', count: 1 });
    expect(await messageEntries(muting)).toHaveLength(0);
    expect(await messageEntries(blocking)).toHaveLength(0);
    expect(await messageEntries(owner)).toHaveLength(0);
  });
});

describe('message requests', () => {
  it('notifies the recipient; accepting notifies the sender and settles the original', async () => {
    const a = await signedInUser(server.baseUrl);
    const b = await signedInUser(server.baseUrl);
    const sent = await sendRequest(a, b, 'hi');
    expect(sent.status).toBe(201);

    const [received] = await list(b);
    expect(received).toMatchObject({
      type: 'message_request_received',
      actor: { id: a.user.id },
      link: '/requests',
    });
    expect(await list(a)).toEqual([]);

    await b.client.post(`/message-requests/${sent.body.data.id}/accept`);
    expect((await list(b))[0].read).toBe(true);
    const [accepted] = await list(a);
    expect(accepted).toMatchObject({
      type: 'message_request_accepted',
      actor: { id: b.user.id },
      link: `/users/${b.user.username}`,
    });
  });

  it('rejecting tells no one; cancelling removes the request from the recipient', async () => {
    const a = await signedInUser(server.baseUrl);
    const b = await signedInUser(server.baseUrl);
    const c = await signedInUser(server.baseUrl);
    const toB = await sendRequest(a, b);
    await b.client.post(`/message-requests/${toB.body.data.id}/reject`);
    expect((await list(b))[0].read).toBe(true);
    expect(await list(a)).toEqual([]);

    const toC = await sendRequest(a, c);
    expect(await list(c)).toHaveLength(1);
    await a.client.post(`/message-requests/${toC.body.data.id}/cancel`);
    expect(await list(c)).toEqual([]);
  });

  it('blocking removes request and one-to-one chat notifications between the two', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    await httpSend(a, conversation.id, newMessage());
    expect(await stored(a, { type: 'message_request_accepted' })).toHaveLength(1);
    expect(await messageEntries(b)).toHaveLength(1);

    const bSocket = await socketFor(b);
    const removed = nextEvent(bSocket, EVENTS.removed);
    expect((await b.client.post('/blocks', { username: a.user.username })).status).toBe(201);
    expect((await removed).unreadCount).toBe(0);
    expect(await stored(a)).toHaveLength(0);
    expect(await stored(b)).toHaveLength(0);
  });

  it('follows "Who can message me?": no request, no notification', async () => {
    const a = await signedInUser(server.baseUrl);
    const b = await signedInUser(server.baseUrl);
    await b.client.patch('/me/privacy', { messagePermission: 'nobody' });
    expect((await sendRequest(a, b)).status).toBe(403);
    expect(await list(b)).toEqual([]);
  });
});

describe('groups', () => {
  it('added, role changes, removal and deletion reach the person affected', async () => {
    const { owner, friends } = await ownerWithFriends(server.baseUrl, 3);
    const [first, second, later] = friends;
    const group = await createGroup(owner, [first, second], 'Readers');

    const [added] = await listOf(first, 'group_member_added');
    expect(added).toMatchObject({
      groupName: 'Readers',
      actor: { id: owner.user.id },
      link: `/groups/${group.id}`,
      available: true,
    });
    expect(await listOf(owner, 'group_member_added')).toEqual([]);

    await owner.client.post(`/groups/${group.id}/members`, { userIds: [later.user.id] });
    expect(await listOf(later, 'group_member_added')).toHaveLength(1);

    await owner.client.patch(`/groups/${group.id}/members/${first.user.id}`, { role: 'admin' });
    expect(await stored(first, { type: 'group_role_changed' })).toMatchObject([{ role: 'admin' }]);
    // Setting the same role again is not a change.
    await owner.client.patch(`/groups/${group.id}/members/${first.user.id}`, { role: 'admin' });
    expect(await stored(first, { type: 'group_role_changed' })).toHaveLength(1);

    await owner.client.post(`/groups/${group.id}/transfer`, { userId: second.user.id });
    expect(await stored(second, { type: 'group_role_changed' })).toMatchObject([{ role: 'owner' }]);

    await second.client.delete(`/groups/${group.id}/members/${later.user.id}`);
    // One entry per group: "added" became "removed".
    expect(await listOf(later, 'group_member_added')).toEqual([]);
    const removed = await listOf(later, 'group_member_removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ groupName: 'Readers', link: null });

    // first's message notification for the group becomes unavailable once the group is gone.
    await httpSend(owner, group.id, newMessage());
    await second.client.delete(`/groups/${group.id}`);
    const [deleted] = await listOf(first, 'group_deleted');
    expect(deleted).toMatchObject({ groupName: 'Readers', actor: { id: second.user.id } });
    const [message] = await listOf(first, 'message_received');
    expect(message).toMatchObject({ available: false, link: null, conversationId: null });
  });

  it("tells an invitation's creator when someone joins with it", async () => {
    const { owner, friends } = await ownerWithFriends(server.baseUrl, 1);
    const group = await createGroup(owner, friends, 'Open house');
    const invite = (await owner.client.post(`/groups/${group.id}/invites`, {})).body.data;
    const joiner = await signedInUser(server.baseUrl);
    const joined = await joiner.client.post('/group-invites/join', { token: invite.token });
    expect(joined.status).toBe(201);
    const [used] = await listOf(owner, 'group_invite_used');
    expect(used).toMatchObject({ actor: { id: joiner.user.id }, link: `/groups/${group.id}` });
    expect(await list(joiner)).toEqual([]);
  });

  it('hides the actor from someone who blocked them', async () => {
    const { owner, friends } = await ownerWithFriends(server.baseUrl, 1);
    const [friend] = friends;
    const group = await createGroup(owner, friends);
    await friend.client.post('/blocks', { username: owner.user.username });
    const [added] = await listOf(friend, 'group_member_added');
    expect(added).toMatchObject({ actor: null, link: `/groups/${group.id}` });
  });
});

describe('reading, dismissing and ownership', () => {
  async function withNotifications(count) {
    const target = await signedInUser(server.baseUrl);
    for (let i = 0; i < count; i++) {
      const sender = await signedInUser(server.baseUrl);
      await sendRequest(sender, target);
    }
    return target;
  }

  it('counts unread, marks one and all read, and paginates without duplicates', async () => {
    const target = await withNotifications(5);
    expect(await unread(target)).toBe(5);

    const page1 = await target.client.get('/notifications?limit=2');
    expect(page1.body.meta).toMatchObject({ limit: 2, hasMore: true });
    const page2 = await target.client.get(
      `/notifications?limit=2&cursor=${page1.body.meta.nextCursor}`,
    );
    const page3 = await target.client.get(
      `/notifications?limit=2&cursor=${page2.body.meta.nextCursor}`,
    );
    const ids = [...page1.body.data, ...page2.body.data, ...page3.body.data].map((n) => n.id);
    expect(new Set(ids).size).toBe(5);
    expect(page3.body.meta.hasMore).toBe(false);

    const one = await target.client.post(`/notifications/${ids[0]}/read`);
    expect(one.status).toBe(200);
    expect(one.body.data).toMatchObject({ notification: { id: ids[0], read: true }, unread: 4 });
    // Idempotent.
    expect((await target.client.post(`/notifications/${ids[0]}/read`)).body.data.unread).toBe(4);
    expect(await list(target, '?filter=unread')).toHaveLength(4);

    const all = await target.client.post('/notifications/read-all');
    expect(all.body.data.unread).toBe(0);
    expect(await list(target, '?filter=unread')).toEqual([]);

    expect((await target.client.delete(`/notifications/${ids[1]}`)).status).toBe(204);
    expect(await list(target)).toHaveLength(4);
  });

  it("nobody can read, change or remove another person's notifications", async () => {
    const target = await withNotifications(1);
    const intruder = await signedInUser(server.baseUrl);
    const [entry] = await list(target);
    expect(await list(intruder)).toEqual([]);
    expect((await intruder.client.post(`/notifications/${entry.id}/read`)).status).toBe(404);
    expect((await intruder.client.delete(`/notifications/${entry.id}`)).status).toBe(404);
    await intruder.client.post('/notifications/read-all');
    expect((await list(target))[0].read).toBe(false);
    // There is no way to ask for someone else's list.
    const spoofed = await intruder.client.get(`/notifications?recipient=${target.user.id}`);
    expect(spoofed.body.data).toEqual([]);
  });

  it('validates identifiers, filters, cursors and requires a session', async () => {
    const user = await signedInUser(server.baseUrl);
    expect((await user.client.post('/notifications/not-an-id/read')).status).toBe(400);
    expect((await user.client.get('/notifications?filter=everything')).status).toBe(400);
    expect((await user.client.get('/notifications?limit=1000')).status).toBe(400);
    expect((await user.client.get('/notifications?cursor=abc')).status).toBe(400);
    const anonymous = new TestClient(server.baseUrl);
    expect((await anonymous.get('/notifications')).status).toBe(401);
  });
});

describe('preferences', () => {
  it('persist across sessions, validate input and are enforced', async () => {
    const a = await signedInUser(server.baseUrl);
    const b = await signedInUser(server.baseUrl);
    expect((await b.client.get('/notifications/preferences')).body.data).toEqual({
      enabled: true,
      messages: true,
      requests: true,
      groups: true,
      calls: true,
      desktop: false,
    });
    expect((await b.client.patch('/notifications/preferences', {})).status).toBe(400);
    expect((await b.client.patch('/notifications/preferences', { sms: true })).status).toBe(400);
    const saved = await b.client.patch('/notifications/preferences', { requests: false });
    expect(saved.body.data.requests).toBe(false);

    // A new sign-in (which replaces the old session) sees the same preferences.
    const again = { client: new TestClient(server.baseUrl), user: b.user };
    await again.client.post('/auth/login', { email: b.user.email, password: b.user.password });
    expect((await again.client.get('/notifications/preferences')).body.data.requests).toBe(false);

    expect((await sendRequest(a, again)).status).toBe(201);
    expect(await list(again)).toEqual([]);

    await again.client.patch('/notifications/preferences', { requests: true, enabled: false });
    const c = await signedInUser(server.baseUrl);
    expect((await sendRequest(c, again)).status).toBe(201);
    expect(await list(again)).toEqual([]);
  });

  it('group and message switches are separate', async () => {
    const { owner, friends } = await ownerWithFriends(server.baseUrl, 1);
    const [friend] = friends;
    await friend.client.patch('/notifications/preferences', { groups: false });
    const group = await createGroup(owner, friends);
    expect(await stored(friend, { type: 'group_member_added' })).toHaveLength(0);
    await httpSend(owner, group.id, newMessage());
    expect(await messageEntries(friend)).toHaveLength(1);
  });
});

describe('real time', () => {
  it('delivers stored notifications to every tab of the recipient only', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const outsider = await signedInUser(server.baseUrl);
    const [tab1, tab2, aSocket, outsiderSocket] = await Promise.all([
      socketFor(b),
      socketFor(b),
      socketFor(a),
      socketFor(outsider),
    ]);
    const overheard = collect(outsiderSocket, EVENTS.upsert);
    const ownEcho = collect(aSocket, EVENTS.upsert);
    const both = Promise.all([nextEvent(tab1, EVENTS.upsert), nextEvent(tab2, EVENTS.upsert)]);
    const unreadBefore = await unread(b);

    await httpSend(a, conversation.id, newMessage());
    const [one, two] = await both;
    expect(one).toEqual(two);
    expect(one.notification.type).toBe('message_received');
    expect(one.unreadCount).toBe(unreadBefore + 1);
    // Stored before it was announced.
    expect(await Notification.exists({ _id: one.notification.id })).not.toBeNull();

    // Reading on one tab is reflected on the other.
    const synced = nextEvent(tab2, EVENTS.read);
    await b.client.post(`/notifications/${one.notification.id}/read`);
    expect(await synced).toEqual({ ids: [one.notification.id], unreadCount: unreadBefore });

    await pause(150);
    expect(overheard).toEqual([]);
    expect(ownEcho).toEqual([]);
  });

  it('a replayed event is not announced again', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const bSocket = await socketFor(b);
    const received = collect(bSocket, EVENTS.upsert);
    const message = newMessage();
    await httpSend(a, conversation.id, message);
    await eventually(() => received.length === 1);
    await httpSend(a, conversation.id, message);
    await pause(200);
    expect(received).toHaveLength(1);
  });

  it('preference changes reach your other tabs', async () => {
    const user = await signedInUser(server.baseUrl);
    const socket = await socketFor(user);
    const changed = nextEvent(socket, EVENTS.preferences);
    await user.client.patch('/notifications/preferences', { desktop: true });
    expect((await changed).preferences.desktop).toBe(true);
  });

  it('revoked sessions lose their socket and suspended accounts get nothing', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const bSocket = await socketFor(b);
    const closed = waitForDisconnect(bSocket);
    await b.client.post('/auth/logout');
    await closed;

    await setStatus(b, 'suspended');
    expect((await httpSend(a, conversation.id, newMessage())).status).toBe(403);
    expect(await messageEntries(b)).toHaveLength(0);

    const { owner, friends } = await ownerWithFriends(server.baseUrl, 1);
    const [member] = friends;
    const group = await createGroup(owner, friends);
    await setStatus(member, 'suspended');
    await httpSend(owner, group.id, newMessage());
    expect(await messageEntries(member)).toHaveLength(0);
    expect((await member.client.get('/notifications')).status).toBe(403);
  });
});

describe('account deletion', () => {
  it("removes the account's own notifications and hides it as an actor", async () => {
    const a = await signedInUser(server.baseUrl);
    const b = await signedInUser(server.baseUrl);
    await connect(a, b);
    expect(await stored(b)).toHaveLength(1);
    expect(await stored(a, { type: 'message_request_accepted' })).toHaveLength(1);

    // A fresh sign-up counts as a recent sign-in, so no re-authentication is needed.
    expect((await b.client.delete('/account')).status).toBe(204);
    expect(await stored(b)).toHaveLength(0);
    const [accepted] = await list(a);
    expect(accepted).toMatchObject({ type: 'message_request_accepted', actor: null, link: null });
  });
});
