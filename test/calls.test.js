import { createHmac, randomUUID } from 'node:crypto';
import { CALL_SOCKET_EVENTS as EVENTS, SESSION_SOCKET_EVENTS } from '#shared';
import { io as connectSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Call } from '../src/models/call.model.js';
import { Message } from '../src/models/message.model.js';
import { Notification } from '../src/models/notification.model.js';
import { User } from '../src/models/user.model.js';
import { createGroup, ownerWithFriends } from './group-helpers.js';
import {
  connect,
  signedInUser,
  startTestServer,
  TEST_ORIGIN,
  TestClient,
  useTestDatabase,
} from './helpers.js';
import {
  collect,
  connectedPair,
  nextEvent,
  openSocket,
  pause,
  request,
  waitForDisconnect,
} from './messaging-helpers.js';

useTestDatabase();

const RING_MS = 600;
const GRACE_MS = 400;

let server;
const sockets = [];

beforeAll(async () => {
  server = await startTestServer({
    calls: { ringTimeoutMs: RING_MS, reconnectGraceMs: GRACE_MS },
    env: {
      TURN_URLS: 'turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349',
      TURN_SECRET: 'a-test-turn-secret-of-enough-length',
      TURN_CREDENTIAL_TTL_SECONDS: '600',
    },
  });
});
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.disconnect();
});
afterAll(async () => {
  await server.close();
});

const socketFor = (user) => openSocket(server, user, sockets);
const start = (socket, conversationId, type = 'audio', clientCallId = randomUUID()) =>
  request(socket, EVENTS.start, { conversationId, type, clientCallId });
const act = (socket, event, callId) => request(socket, event, { callId });
const offer = { kind: 'description', description: { type: 'offer', sdp: 'v=0\r\n' } };
const missedFor = (user) =>
  Notification.find({ recipient: user.user.id, type: 'call_missed' }).lean();
/** Polls an async condition (the shared `eventually` helper is synchronous). */
async function until(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await pause(25);
  }
}
const callLines = (conversationId) =>
  Message.find({ conversation: conversationId, 'system.kind': 'call' }).lean();

/** A connected pair, each online, plus a ringing call from a to b (b's tab answering). */
async function onlinePair() {
  const pair = await connectedPair(server.baseUrl);
  const [aSocket, bSocket] = await Promise.all([socketFor(pair.a), socketFor(pair.b)]);
  return { ...pair, aSocket, bSocket };
}

async function ongoingCall(type = 'audio') {
  const pair = await onlinePair();
  const incoming = nextEvent(pair.bSocket, EVENTS.incoming);
  const started = await start(pair.aSocket, pair.conversation.id, type);
  expect(started.ok).toBe(true);
  await incoming;
  const accepted = await act(pair.bSocket, EVENTS.accept, started.data.call.id);
  expect(accepted).toMatchObject({ ok: true, data: { call: { status: 'ongoing' } } });
  return { ...pair, callId: started.data.call.id };
}

describe('starting and answering', () => {
  it("rings every one of the callee's tabs; answering binds one device", async () => {
    const { a, b, conversation, aSocket, bSocket } = await onlinePair();
    const bTab2 = await socketFor(b);
    const outsider = await socketFor(await signedInUser(server.baseUrl));
    const overheard = [...collect(outsider, EVENTS.incoming), ...collect(outsider, EVENTS.updated)];
    const rings = Promise.all([
      nextEvent(bSocket, EVENTS.incoming),
      nextEvent(bTab2, EVENTS.incoming),
    ]);

    const started = await start(aSocket, conversation.id, 'video');
    expect(started.data.call).toMatchObject({
      status: 'ringing',
      type: 'video',
      direction: 'outgoing',
      callerId: a.user.id,
      calleeId: b.user.id,
      peer: { id: b.user.id },
    });
    const [ring1, ring2] = await rings;
    expect(ring1.call).toMatchObject({ id: started.data.call.id, direction: 'incoming' });
    expect(ring2.call.id).toBe(started.data.call.id);

    const callerSees = nextEvent(aSocket, EVENTS.updated, ({ call }) => call.status === 'ongoing');
    const otherTabSees = nextEvent(bTab2, EVENTS.updated, ({ call }) => call.status === 'ongoing');
    const accepted = await act(bSocket, EVENTS.accept, started.data.call.id);
    expect(accepted.data.call.answeredAt).not.toBeNull();
    await Promise.all([callerSees, otherTabSees]);

    // The other tab can't answer again, and isn't part of the signaling.
    const again = await act(bTab2, EVENTS.accept, started.data.call.id);
    expect(again.error.code).toBe('CALL_NOT_RINGING');
    const fromTab2 = await request(bTab2, EVENTS.signal, {
      callId: started.data.call.id,
      signal: offer,
    });
    expect(fromTab2.error.code).toBe('CALL_NOT_ACTIVE');

    await pause(100);
    expect(overheard).toEqual([]);
  });

  it('a retried start returns the same call', async () => {
    const { conversation, aSocket } = await onlinePair();
    const key = randomUUID();
    const first = await start(aSocket, conversation.id, 'audio', key);
    const retry = await start(aSocket, conversation.id, 'audio', key);
    expect(retry.data).toMatchObject({ duplicate: true, call: { id: first.data.call.id } });
    expect(await Call.countDocuments({ conversation: conversation.id })).toBe(1);
  });

  it('only the callee answers or declines', async () => {
    const { conversation, aSocket } = await onlinePair();
    const started = await start(aSocket, conversation.id);
    expect((await act(aSocket, EVENTS.accept, started.data.call.id)).error.code).toBe('FORBIDDEN');
    expect((await act(aSocket, EVENTS.decline, started.data.call.id)).error.code).toBe('FORBIDDEN');
  });
});

describe('who may call', () => {
  it('needs a connection, no block, membership and a one-to-one chat', async () => {
    const stranger = await signedInUser(server.baseUrl);
    const { a, b, conversation, aSocket, bSocket } = await onlinePair();
    const strangerSocket = await socketFor(stranger);

    // Not a member of the conversation: it doesn't exist for them.
    expect((await start(strangerSocket, conversation.id)).error.code).toBe('NOT_FOUND');

    await b.client.post('/blocks', { username: a.user.username });
    expect((await start(aSocket, conversation.id)).error.code).toBe('MESSAGING_NOT_ALLOWED');
    expect((await start(bSocket, conversation.id)).error.code).toBe('MESSAGING_NOT_ALLOWED');

    const { owner, friends } = await ownerWithFriends(server.baseUrl, 1);
    const group = await createGroup(owner, friends);
    const ownerSocket = await socketFor(owner);
    expect((await start(ownerSocket, group.id)).error.code).toBe('GROUP_CALLS_UNAVAILABLE');
    expect(await Call.countDocuments({ conversation: { $in: [conversation.id, group.id] } })).toBe(
      0,
    );
  });

  it('rejects invalid payloads and client-supplied identities', async () => {
    const { b, conversation, aSocket } = await onlinePair();
    const spoofed = await request(aSocket, EVENTS.start, {
      conversationId: conversation.id,
      type: 'audio',
      clientCallId: randomUUID(),
      callerId: b.user.id,
    });
    expect(spoofed.error.code).toBe('VALIDATION_ERROR');
    for (const payload of [
      { conversationId: conversation.id, type: 'screen', clientCallId: randomUUID() },
      { conversationId: 'nope', type: 'audio', clientCallId: randomUUID() },
      'garbage',
    ]) {
      expect((await request(aSocket, EVENTS.start, payload)).error.code).toBe('VALIDATION_ERROR');
    }
    expect((await act(aSocket, EVENTS.end, 'not-an-id')).error.code).toBe('VALIDATION_ERROR');
    expect(await Call.countDocuments({ conversation: conversation.id })).toBe(0);
  });

  it('nobody outside the call can act on it or signal into it', async () => {
    const { callId } = await ongoingCall();
    const outsiderSocket = await socketFor(await signedInUser(server.baseUrl));
    for (const event of [EVENTS.accept, EVENTS.decline, EVENTS.end, EVENTS.resume]) {
      expect((await act(outsiderSocket, event, callId)).error.code).toBe('NOT_FOUND');
    }
    const signal = await request(outsiderSocket, EVENTS.signal, { callId, signal: offer });
    expect(signal.error.code).toBe('NOT_FOUND');
    // There is no way to join a room.
    outsiderSocket.emit('join', `call:${callId}`);
    expect((await Call.findById(callId).lean()).status).toBe('ongoing');
  });
});

describe('signaling', () => {
  it('relays descriptions, candidates and media state between the two bound devices only', async () => {
    const { b, aSocket, bSocket, callId } = await ongoingCall();
    const bTab2 = await socketFor(b);
    const leaked = collect(bTab2, EVENTS.signal);

    const received = nextEvent(bSocket, EVENTS.signal);
    expect((await request(aSocket, EVENTS.signal, { callId, signal: offer })).ok).toBe(true);
    expect(await received).toEqual({ callId, signal: offer });

    const answer = { kind: 'description', description: { type: 'answer', sdp: 'v=0\r\n' } };
    const back = nextEvent(aSocket, EVENTS.signal);
    await request(bSocket, EVENTS.signal, { callId, signal: answer });
    expect((await back).signal).toEqual(answer);

    const candidate = {
      kind: 'candidate',
      candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0' },
    };
    const gotCandidate = nextEvent(bSocket, EVENTS.signal);
    await request(aSocket, EVENTS.signal, { callId, signal: candidate });
    expect((await gotCandidate).signal).toEqual(candidate);

    // Turning the camera on makes it a video call; the other side learns the state.
    const media = nextEvent(bSocket, EVENTS.media);
    await request(aSocket, EVENTS.media, { callId, audio: false, video: true });
    expect(await media).toEqual({ callId, audio: false, video: true });
    expect((await Call.findById(callId).lean()).type).toBe('video');

    await pause(100);
    expect(leaked).toEqual([]);
  });

  it('validates signaling payloads', async () => {
    const { aSocket, callId } = await ongoingCall();
    for (const signal of [
      { kind: 'description', description: { type: 'pranswer', sdp: 'x' } },
      { kind: 'description', description: { type: 'offer', sdp: 'x'.repeat(40_000) } },
      { kind: 'candidate', candidate: { candidate: 'x', extra: 1 } },
      { kind: 'something' },
    ]) {
      const response = await request(aSocket, EVENTS.signal, { callId, signal });
      expect(response.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('signaling is refused before the call is answered', async () => {
    const { conversation, aSocket } = await onlinePair();
    const started = await start(aSocket, conversation.id);
    const early = await request(aSocket, EVENTS.signal, {
      callId: started.data.call.id,
      signal: offer,
    });
    expect(early.error.code).toBe('CALL_NOT_ACTIVE');
  });
});

describe('busy and simultaneous calls', () => {
  it('a busy callee is recorded as a missed call; a caller in a call is refused', async () => {
    const { a, b, aSocket, callId } = await ongoingCall();
    const c = await signedInUser(server.baseUrl);
    await connect(c, b);
    const opened = await c.client.post('/conversations', { userId: b.user.id });
    const cSocket = await socketFor(c);
    const bRings = collect(await socketFor(b), EVENTS.incoming);

    const busy = await start(cSocket, opened.body.data.id);
    expect(busy.data.call).toMatchObject({ status: 'missed', endReason: 'busy' });
    await until(async () => (await missedFor(b)).length === 1);
    await pause(100);
    expect(bRings).toEqual([]);

    // Someone already in a call can't start another one.
    const d = await signedInUser(server.baseUrl);
    await connect(a, d);
    const withD = await a.client.post('/conversations', { userId: d.user.id });
    expect((await start(aSocket, withD.body.data.id)).error.code).toBe('ALREADY_IN_CALL');
    expect((await Call.findById(callId).lean()).status).toBe('ongoing');
  });

  it('two people calling each other at once get exactly one call', async () => {
    const { conversation, aSocket, bSocket } = await onlinePair();
    const [fromA, fromB] = await Promise.all([
      start(aSocket, conversation.id),
      start(bSocket, conversation.id),
    ]);
    const outcomes = [fromA, fromB];
    expect(outcomes.filter((r) => r.ok && r.data.call.status === 'ringing')).toHaveLength(1);
    expect(outcomes.filter((r) => !r.ok)).toMatchObject([{ error: { code: 'ALREADY_IN_CALL' } }]);
    expect(
      await Call.countDocuments({ conversation: conversation.id, lock: { $exists: true } }),
    ).toBe(1);
    // The one who lost the race can see the call ringing for them.
    const loser = fromA.ok ? bSocket : aSocket;
    expect((await request(loser, EVENTS.active, {})).data.call.status).toBe('ringing');
  });
});

describe('ending and cleanup', () => {
  it('declining ends it for both, records it and sends no missed-call notification', async () => {
    const { b, conversation, aSocket, bSocket } = await onlinePair();
    const started = await start(aSocket, conversation.id);
    const callerSees = nextEvent(aSocket, EVENTS.updated, ({ call }) => call.status === 'declined');
    const declined = await act(bSocket, EVENTS.decline, started.data.call.id);
    expect(declined.data.call).toMatchObject({ status: 'declined', endReason: 'declined' });
    await callerSees;
    expect((await act(bSocket, EVENTS.decline, started.data.call.id)).ok).toBe(true);

    const stored = await Call.findById(started.data.call.id).lean();
    expect(stored.lock).toBeUndefined();
    expect(stored.callerSocket).toBeNull();
    const lines = await callLines(conversation.id);
    expect(lines).toHaveLength(1);
    expect(lines[0].system).toMatchObject({
      actor: expect.anything(),
      call: { status: 'declined' },
    });
    expect(await missedFor(b)).toHaveLength(0);
  });

  it('a cancelled call is missed by the callee exactly once', async () => {
    const { b, conversation, aSocket } = await onlinePair();
    const started = await start(aSocket, conversation.id, 'video');
    const cancelled = await act(aSocket, EVENTS.end, started.data.call.id);
    expect(cancelled.data.call).toMatchObject({ status: 'cancelled' });
    // Ending again (a retry) changes nothing.
    expect((await act(aSocket, EVENTS.end, started.data.call.id)).data.call.status).toBe(
      'cancelled',
    );
    await server.services.notifications.callMissed(
      await Call.findById(started.data.call.id).lean(),
    );
    const missed = await missedFor(b);
    expect(missed).toHaveLength(1);
    expect(missed[0]).toMatchObject({ callType: 'video' });
    const list = (await b.client.get('/notifications')).body.data;
    expect(list.find((n) => n.type === 'call_missed')).toMatchObject({
      link: `/chats/${conversation.id}`,
      callType: 'video',
      available: true,
    });
    expect(await callLines(conversation.id)).toHaveLength(1);
  });

  it('an unanswered call becomes missed after the ring timeout', async () => {
    const { b, conversation, aSocket } = await onlinePair();
    const started = await start(aSocket, conversation.id);
    const missed = await nextEvent(
      aSocket,
      EVENTS.updated,
      ({ call }) => call.status === 'missed',
      RING_MS + 3_000,
    );
    expect(missed.call).toMatchObject({ id: started.data.call.id, endReason: 'no_answer' });
    await until(async () => (await missedFor(b)).length === 1);
    // The lock is released: a new call can start.
    expect((await start(aSocket, conversation.id)).data.call.status).toBe('ringing');
  });

  it('the sweep ends calls whose ring time passed (e.g. after a restart lost the timer)', async () => {
    const { conversation, aSocket } = await onlinePair();
    const started = await start(aSocket, conversation.id);
    await Call.updateOne(
      { _id: started.data.call.id, status: 'ringing' },
      { $set: { ringsUntil: new Date(Date.now() - 1_000) } },
    );
    await server.services.calls.sweep(() => true);
    expect((await Call.findById(started.data.call.id).lean()).status).toBe('missed');
  });

  it('hanging up completes the call with its duration and frees both people', async () => {
    const { conversation, aSocket, bSocket, callId } = await ongoingCall();
    await pause(1_100);
    const ended = nextEvent(bSocket, EVENTS.updated, ({ call }) => call.status === 'completed');
    const response = await act(aSocket, EVENTS.end, callId);
    expect(response.data.call).toMatchObject({ status: 'completed', endReason: 'hangup' });
    expect(response.data.call.durationSeconds).toBeGreaterThanOrEqual(1);
    await ended;
    const [line] = await callLines(conversation.id);
    expect(line.system.call).toMatchObject({ status: 'completed' });
    expect((await request(bSocket, EVENTS.active, {})).data.call).toBeNull();
    expect((await start(bSocket, conversation.id)).data.call.status).toBe('ringing');
  });

  it('a dropped device has a grace period to resume; otherwise the call ends', async () => {
    const { b, bSocket, aSocket, callId } = await ongoingCall();
    // Reconnects in time: the call continues on the new socket, the peer restarts ICE.
    bSocket.disconnect();
    const bAgain = await socketFor(b);
    const peerTold = nextEvent(aSocket, EVENTS.resumed);
    const resumed = await act(bAgain, EVENTS.resume, callId);
    expect(resumed.data.call.status).toBe('ongoing');
    expect(await peerTold).toEqual({ callId });
    await pause(GRACE_MS + 200);
    expect((await Call.findById(callId).lean()).status).toBe('ongoing');

    // Drops for good: ended as a lost connection.
    const ended = nextEvent(
      aSocket,
      EVENTS.updated,
      ({ call }) => call.status === 'completed',
      4_000,
    );
    bAgain.disconnect();
    expect((await ended).call.endReason).toBe('connection_lost');
  });
});

describe('failures, preferences and history lines', () => {
  it('a media failure reported by a device is recorded as a failed call', async () => {
    const { aSocket, callId } = await ongoingCall();
    const response = await request(aSocket, EVENTS.end, { callId, reason: 'media_failed' });
    expect(response.data.call).toMatchObject({ status: 'failed', endReason: 'media_failed' });
    expect((await request(aSocket, EVENTS.end, { callId, reason: 'bogus' })).error.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('"Missed calls" off: no notification, but the call still rang and is in the history', async () => {
    const { b, conversation, aSocket, bSocket } = await onlinePair();
    await b.client.patch('/notifications/preferences', { calls: false });
    const rang = nextEvent(bSocket, EVENTS.incoming);
    const started = await start(aSocket, conversation.id);
    await rang;
    await act(aSocket, EVENTS.end, started.data.call.id);
    expect(await missedFor(b)).toHaveLength(0);

    const history = await b.client.get(`/conversations/${conversation.id}/messages`);
    const line = history.body.data.find((message) => message.system?.kind === 'call');
    expect(line.system).toMatchObject({
      kind: 'call',
      call: { id: started.data.call.id, type: 'audio', status: 'cancelled' },
    });
    const summary = await b.client.get(`/conversations/${conversation.id}`);
    expect(summary.body.data.lastMessage.preview).toBe('Missed audio call');
    // Call lines never count as unread messages.
    expect(summary.body.data.unreadCount).toBe(0);
  });
});

describe('sessions, suspension and blocks', () => {
  it('signing out ends the call at once and the revoked socket is closed', async () => {
    const { a, aSocket, bSocket } = await ongoingCall();
    const closed = waitForDisconnect(aSocket);
    const ended = nextEvent(bSocket, EVENTS.updated, ({ call }) => call.status === 'completed');
    await a.client.post('/auth/logout');
    await closed;
    expect((await ended).call.endReason).toBe('session_ended');
  });

  it('a suspended account cannot keep signaling', async () => {
    const { b, bSocket, callId } = await ongoingCall();
    await User.updateOne(
      { _id: b.user.id, status: { $in: ['active', 'pending_verification'] } },
      { $set: { status: 'suspended' } },
    );
    const revoked = nextEvent(bSocket, SESSION_SOCKET_EVENTS.revoked);
    const response = await act(bSocket, EVENTS.end, callId);
    expect(response.error.code).toBe('ACCOUNT_SUSPENDED');
    await revoked;
    await waitForDisconnect(bSocket);
  });

  it('blocking during a call ends it without a missed-call notification', async () => {
    const { a, b, conversation, aSocket } = await onlinePair();
    const started = await start(aSocket, conversation.id);
    await b.client.post('/blocks', { username: a.user.username });
    const stored = await Call.findById(started.data.call.id).lean();
    expect(stored).toMatchObject({ status: 'cancelled', endReason: 'unavailable' });
    expect(await missedFor(b)).toHaveLength(0);
  });

  it('sockets without a valid session cannot connect at all', async () => {
    const socket = connectSocket(server.baseUrl, {
      transports: ['websocket'],
      extraHeaders: { Origin: TEST_ORIGIN },
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    const error = await new Promise((resolve) => socket.once('connect_error', resolve));
    expect(error.message).toBe('UNAUTHORIZED');
  });
});

describe('history and ICE servers', () => {
  it('only participants can see a call', async () => {
    const { a, b, conversation, aSocket } = await onlinePair();
    const started = await start(aSocket, conversation.id);
    await act(aSocket, EVENTS.end, started.data.call.id);
    const outsider = await signedInUser(server.baseUrl);

    const own = await a.client.get('/calls');
    expect(own.body.data.map((call) => call.id)).toContain(started.data.call.id);
    const theirs = await b.client.get(`/calls/${started.data.call.id}`);
    expect(theirs.body.data).toMatchObject({ direction: 'incoming', status: 'cancelled' });
    expect((await outsider.client.get(`/calls/${started.data.call.id}`)).status).toBe(404);
    expect((await outsider.client.get('/calls')).body.data).toEqual([]);
    expect((await outsider.client.get(`/conversations/${conversation.id}/messages`)).status).toBe(
      404,
    );
    expect((await new TestClient(server.baseUrl).get('/calls')).status).toBe(401);
  });

  it('hands out STUN and short-lived TURN credentials (never the secret)', async () => {
    const { a: user, conversation, aSocket } = await onlinePair();
    // No call: STUN only, so the TURN relay can't be used outside calls.
    const idle = await user.client.get('/calls/ice-servers');
    expect(idle.body.data).toMatchObject({ ttlSeconds: null });
    expect(idle.body.data.iceServers.some((entry) => entry.username)).toBe(false);

    await start(aSocket, conversation.id);
    const res = await user.client.get('/calls/ice-servers');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { iceServers, ttlSeconds } = res.body.data;
    expect(ttlSeconds).toBe(600);
    const turn = iceServers.find((server) => server.username);
    const [expires, userId] = turn.username.split(':');
    expect(userId).toBe(user.user.id);
    expect(Number(expires) - Date.now() / 1_000).toBeGreaterThan(590);
    expect(turn.credential).toBe(
      createHmac('sha1', 'a-test-turn-secret-of-enough-length')
        .update(turn.username)
        .digest('base64'),
    );
    expect(JSON.stringify(res.body)).not.toContain('a-test-turn-secret');
    expect((await new TestClient(server.baseUrl).get('/calls/ice-servers')).status).toBe(401);
  });
});
