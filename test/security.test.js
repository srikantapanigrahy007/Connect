import { randomUUID } from 'node:crypto';
import { CALL_SOCKET_EVENTS, MESSAGING_SOCKET_EVENTS } from '#shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Conversation } from '../src/models/conversation.model.js';
import { Notification } from '../src/models/notification.model.js';
import { User } from '../src/models/user.model.js';
import { createGroup, ownerWithFriends } from './group-helpers.js';
import {
  buildTestApp,
  sendRequest,
  signedInUser,
  startTestServer,
  TestClient,
  useTestDatabase,
} from './helpers.js';
import {
  connectedPair,
  httpSend,
  newMessage,
  openSocket,
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

describe('cross-user ID manipulation', () => {
  it('every resource of one person is unreachable for another (404/403, nothing changes)', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const sent = await httpSend(a, conversation.id, newMessage('private'));
    const messageId = sent.body.data.message.id;
    const upload = await a.client.upload(
      `/conversations/${conversation.id}/attachments`,
      'file',
      Buffer.from('%PDF-1.4\n%secret\n'),
      { filename: 'secret.pdf', contentType: 'application/pdf' },
    );
    const { owner, friends } = await ownerWithFriends(server.baseUrl, 1);
    const group = await createGroup(owner, friends, 'Private group');
    const [notification] = (await b.client.get('/notifications')).body.data;
    const intruder = await signedInUser(server.baseUrl);
    const c = intruder.client;

    const attempts = [
      c.get(`/conversations/${conversation.id}`),
      c.get(`/conversations/${conversation.id}/messages`),
      c.post(`/conversations/${conversation.id}/messages`, newMessage('injected')),
      c.patch(`/conversations/${conversation.id}/preferences`, { muted: 'always' }),
      c.delete(`/conversations/${conversation.id}`),
      c.patch(`/conversations/${conversation.id}/messages/${messageId}`, { text: 'edited' }),
      c.send('delete', `/conversations/${conversation.id}/messages/${messageId}?scope=everyone`),
      c.send('put', `/conversations/${conversation.id}/messages/${messageId}/reaction`, {
        emoji: '👍',
      }),
      upload.body?.data?.id ? c.get(`/attachments/${upload.body.data.id}`) : null,
      c.get(`/groups/${group.id}`),
      c.patch(`/groups/${group.id}`, { name: 'Taken over' }),
      c.post(`/groups/${group.id}/invites`, {}),
      c.post(`/notifications/${notification.id}/read`),
      c.delete(`/notifications/${notification.id}`),
    ].filter(Boolean);
    const statuses = (await Promise.all(attempts)).map((res) => res.status);
    expect(statuses.every((status) => status === 404 || status === 403)).toBe(true);

    // Nothing changed for the owners.
    const history = await b.client.get(`/conversations/${conversation.id}/messages`);
    expect(history.body.data.map((m) => m.text)).toEqual(['private']);
    expect((await owner.client.get(`/groups/${group.id}`)).body.data.name).toBe('Private group');
    expect((await Notification.findById(notification.id).lean()).readAt).toBeNull();
    const stored = await Conversation.findById(conversation.id).lean();
    expect(stored.members.every((member) => member.mutedUntil === null)).toBe(true);
  });

  it('a request belonging to two other people cannot be answered by a third', async () => {
    const a = await signedInUser(server.baseUrl);
    const b = await signedInUser(server.baseUrl);
    const intruder = await signedInUser(server.baseUrl);
    const sent = await sendRequest(a, b);
    for (const action of ['accept', 'reject', 'cancel']) {
      const res = await intruder.client.post(`/message-requests/${sent.body.data.id}/${action}`);
      expect(res.status).toBe(404);
    }
  });
});

describe('injection and mass assignment', () => {
  it('rejects MongoDB operators and nested objects where strings are expected', async () => {
    const { client } = await signedInUser(server.baseUrl);
    const anonymous = new TestClient(server.baseUrl);
    const login = await anonymous.post('/auth/login', {
      email: { $ne: null },
      password: { $ne: null },
    });
    expect(login.status).toBe(400);
    const forgot = await anonymous.post('/auth/password/forgot', { email: { $gt: '' } });
    expect(forgot.status).toBe(400);
    const search = await client.get('/users/search?q[$ne]=x');
    expect(search.status).toBe(400);
    const reset = await anonymous.post('/auth/password/reset', {
      token: { $ne: null },
      password: 'a brand new password',
    });
    expect(reset.status).toBe(400);
  });

  it('protected account fields cannot be set through profile or preference updates', async () => {
    const { client, user } = await signedInUser(server.baseUrl);
    for (const [path, body] of [
      ['/me/profile', { role: 'super_admin' }],
      ['/me/profile', { displayName: 'Fine', status: 'active', emailVerifiedAt: new Date() }],
      ['/me/privacy', { readReceipts: false, role: 'admin' }],
      ['/notifications/preferences', { calls: false, recipient: 'someone' }],
    ]) {
      expect((await client.patch(path, body)).status).toBe(400);
    }
    const stored = await User.findById(user.id).lean();
    expect(stored).toMatchObject({ role: 'user', status: 'pending_verification' });
    expect(stored.emailVerifiedAt).toBeNull();
  });

  it('a __proto__ payload never reaches the object prototype', async () => {
    const { client } = await signedInUser(server.baseUrl);
    const res = await client.send('patch', '/me/profile', undefined, (test) =>
      test
        .set('Content-Type', 'application/json')
        .send('{"bio":"hi","__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}'),
    );
    expect([200, 400]).toContain(res.status);
    expect({}.polluted).toBeUndefined();
    expect({}.x).toBeUndefined();
  });

  it('malformed and oversized bodies get generic errors without internals', async () => {
    const { client } = await signedInUser(server.baseUrl);
    const malformed = await client.send('patch', '/me/profile', undefined, (test) =>
      test.set('Content-Type', 'application/json').send('{"bio": '),
    );
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatchObject({ code: 'BAD_REQUEST' });
    const huge = await client.patch('/me/profile', { bio: 'x'.repeat(200_000) });
    expect(huge.status).toBe(413);
    for (const res of [malformed, huge]) {
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/stack|node_modules|at [A-Za-z]+ \(|mongodb:\/\//i);
    }
  });
});

describe('rate limits behind proxies', () => {
  it('a forged X-Forwarded-For header does not reset the per-IP login limit', async () => {
    const { app } = buildTestApp({
      rateLimitsEnabled: true,
      rateLimits: { loginPerIp: { windowMs: 60_000, limit: 2 } },
    });
    const client = new TestClient(app);
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      const res = await client.send('post', '/auth/login', undefined, (test) =>
        test
          .set('X-Forwarded-For', `203.0.113.${i}`)
          .send({ email: `nobody${i}@example.com`, password: 'wrong password' }),
      );
      statuses.push(res.status);
    }
    expect(statuses).toEqual([401, 401, 429, 429]);
  });
});

describe('socket abuse', () => {
  it('one account cannot hold an unlimited number of real-time connections', async () => {
    const user = await signedInUser(server.baseUrl);
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () => openSocket(server, user, sockets)),
    );
    // Give the server a moment to close connections over the limit.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const open = sockets.filter((socket) => socket.connected).length;
    expect(results.length).toBe(25);
    expect(open).toBeLessThanOrEqual(server.ctx.config.realtime.maxSocketsPerUser);
  });

  it('a socket whose account was deleted cannot keep messaging or calling', async () => {
    const { a, conversation } = await connectedPair(server.baseUrl);
    const socket = await openSocket(server, a, sockets);
    const closed = waitForDisconnect(socket);
    expect((await a.client.delete('/account')).status).toBe(204);
    await closed;
    expect(socket.connected).toBe(false);
    const again = await a.client.post(`/conversations/${conversation.id}/messages`, newMessage());
    expect(again.status).toBe(401);
  });

  it('events with forged identities are refused on every channel', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const socket = await openSocket(server, a, sockets);
    const send = await request(socket, MESSAGING_SOCKET_EVENTS.send, {
      conversationId: conversation.id,
      message: { ...newMessage(), senderId: b.user.id },
    });
    expect(send.ok).toBe(false);
    const call = await request(socket, CALL_SOCKET_EVENTS.start, {
      conversationId: conversation.id,
      type: 'audio',
      clientCallId: randomUUID(),
      calleeId: b.user.id,
    });
    expect(call.error.code).toBe('VALIDATION_ERROR');
  });
});
