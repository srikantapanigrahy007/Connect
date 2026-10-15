import { randomUUID } from 'node:crypto';
import { DeviceId, initAsync, UserId } from '@matrix-org/matrix-sdk-crypto-wasm';
import { E2EE_SOCKET_EVENTS, toE2eeUserId } from '#shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Conversation } from '../src/models/conversation.model.js';
import { E2eeDevice } from '../src/models/e2ee-device.model.js';
import { E2eeToDeviceEvent } from '../src/models/e2ee-to-device-event.model.js';
import { Message } from '../src/models/message.model.js';
import { Session } from '../src/models/session.model.js';
import { ApiDevice, encryptedText } from './e2ee-helpers.js';
import { buildTestApp, signedInUser, startTestServer, useTestDatabase } from './helpers.js';
import { connectedPair, nextEvent, openSocket, request } from './messaging-helpers.js';

// Real library devices (Node build) against the real API and the test MongoDB. Only the
// transport between the test and the API is a test client; every key, payload and decryption is
// the library's own.

useTestDatabase();

let app;
let server;
const sockets = [];
beforeAll(async () => {
  await initAsync();
  ({ app } = buildTestApp({ e2ee: { enabled: true } }));
  server = await startTestServer({ e2ee: { enabled: true } });
});
afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  await server.close();
});

/** Alice and Bob, connected, with their conversation and one bound, keyed device each. */
async function readyPair(target = app, { enable = true } = {}) {
  const { a, b, conversation } = await connectedPair(target);
  const alice = await ApiDevice.create(a);
  const bob = await ApiDevice.create(b);
  if (enable) {
    const res = await a.client.post(`/e2ee/conversations/${conversation.id}/enable`);
    expect(res.status).toBe(200);
  }
  return { a, b, conversation, alice, bob };
}

/** Megolm payload for `text` from `device`, for both members of `conversation`. */
async function encryptFor(device, pair, text, clientMessageId = randomUUID()) {
  const { content } = encryptedText(text, clientMessageId);
  return {
    clientMessageId,
    encrypted: await device.encrypt(
      pair.conversation.id,
      [pair.a.user.id, pair.b.user.id],
      content,
    ),
  };
}

const sendEncrypted = (account, conversationId, body) =>
  account.client.post(`/conversations/${conversationId}/messages`, body);

describe('device binding (proof that this sign-in holds the device key)', () => {
  it('binds the session to the device that signed the challenge', async () => {
    const alice = await signedInUser(app);
    const device = await ApiDevice.create(alice, { bind: false, upload: false });
    expect((await Session.findOne({ user: alice.user.id }).lean()).e2eeDeviceId).toBeNull();
    await device.bind();
    expect((await Session.findOne({ user: alice.user.id }).lean()).e2eeDeviceId).toBe(
      device.deviceId,
    );
  });

  it('refuses another device’s signature, another session’s challenge, stale challenges and unknown devices', async () => {
    const alice = await signedInUser(app);
    const mine = await ApiDevice.create(alice, { bind: false, upload: false });
    const other = await ApiDevice.create(alice, { bind: false, upload: false });
    const challenge = (await alice.client.post(`/e2ee/devices/${mine.deviceId}/binding-challenge`))
      .body.data.challenge;
    const bind = (deviceId, body) =>
      alice.client.send('put', `/e2ee/devices/${deviceId}/binding`, body);

    // Signed by a different device (a stolen sign-in without this device's key).
    const foreign = await bind(mine.deviceId, {
      challenge,
      signature: await other.sign(challenge),
    });
    expect(foreign.body.error.code).toBe('INVALID_BINDING_SIGNATURE');
    // A valid signature, presented for another device id.
    const swapped = await bind(other.deviceId, {
      challenge,
      signature: await mine.sign(challenge),
    });
    expect(swapped.body.error.code).toBe('INVALID_BINDING');
    // Another session's challenge.
    const elsewhere = challenge.replace(/:[a-f0-9]{24}:/, `:${'a'.repeat(24)}:`);
    const wrongSession = await bind(mine.deviceId, {
      challenge: elsewhere,
      signature: await mine.sign(elsewhere),
    });
    expect(wrongSession.body.error.code).toBe('INVALID_BINDING');
    // A stale challenge, correctly signed.
    const stale = challenge.replace(/:(\d{13}):/, `:${Date.now() - 6 * 60_000}:`);
    const old = await bind(mine.deviceId, { challenge: stale, signature: await mine.sign(stale) });
    expect(old.body.error.code).toBe('INVALID_BINDING');
    // Not even a challenge format the client would sign.
    expect(
      (await bind(mine.deviceId, { challenge: '{"key":"x"}', signature: 'A'.repeat(86) })).status,
    ).toBe(400);
    // Someone else's device: not found.
    const bob = await signedInUser(app);
    const bobs = await ApiDevice.create(bob, { bind: false, upload: false });
    expect(
      (await alice.client.post(`/e2ee/devices/${bobs.deviceId}/binding-challenge`)).status,
    ).toBe(404);

    expect((await Session.findOne({ user: alice.user.id }).lean()).e2eeDeviceId).toBeNull();
  });

  it('removing the device unbinds every session holding it', async () => {
    const alice = await signedInUser(app);
    const device = await ApiDevice.create(alice);
    expect((await alice.client.delete(`/e2ee/devices/${device.deviceId}`)).status).toBe(204);
    expect((await Session.findOne({ user: alice.user.id }).lean()).e2eeDeviceId).toBeNull();
    const res = await alice.client.post(`/e2ee/devices/${device.deviceId}/to-device`, {});
    expect(res.body.error.code).toBe('DEVICE_NOT_BOUND');
  });
});

describe('to-device queue', () => {
  /** n real Olm payloads from `from` to `to` (one Megolm room key share per room). */
  async function shareKeys(from, to, rooms) {
    const users = () => [new UserId(toE2eeUserId(to.userId))];
    await from.machine.updateTrackedUsers(users());
    await from.flush();
    const claim = await from.machine.getMissingSessions(users());
    if (claim) await from.send(claim);
    const requests = [];
    for (const room of rooms) {
      const { RoomId, EncryptionSettings } = await import('@matrix-org/matrix-sdk-crypto-wasm');
      requests.push(
        ...(await from.machine.shareRoomKey(
          new RoomId(`!${room}:connect`),
          users(),
          new EncryptionSettings(),
        )),
      );
    }
    return requests;
  }

  it('only the bound device reads and acknowledges its queue', async () => {
    const { a, alice, bob } = await readyPair(app, { enable: false });
    // Alice's sign-in is bound to her device; Bob's device queue isn't hers.
    expect((await a.client.post(`/e2ee/devices/${bob.deviceId}/to-device`, {})).status).toBe(403);
    // Her own second device (registered, but this sign-in is bound to the first one).
    const second = await ApiDevice.create(a, { bind: false, upload: false });
    const res = await a.client.post(`/e2ee/devices/${second.deviceId}/to-device`, {});
    expect(res.body.error.code).toBe('DEVICE_NOT_BOUND');
    expect((await alice.sync()).events).toEqual([]);
  });

  it('delivers in order, acknowledges only processed events and never re-uses a seq', async () => {
    const { alice, bob } = await readyPair(app, { enable: false });
    const requests = await shareKeys(alice, bob, ['r1', 'r2', 'r3']);
    for (const request of requests) await alice.send(request);

    const first = await bob.client.post(`/e2ee/devices/${bob.deviceId}/to-device`, { limit: 2 });
    expect(first.body.data.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(first.body.data.hasMore).toBe(true);
    expect(first.body.data.events[0]).toMatchObject({
      sender: toE2eeUserId(alice.userId),
      type: 'm.room.encrypted',
    });
    // Not acknowledged: fetched again.
    const again = await bob.client.post(`/e2ee/devices/${bob.deviceId}/to-device`, {});
    expect(again.body.data.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    // Acknowledge 2: only 3 is left; acknowledge 3: empty.
    const after2 = await bob.client.post(`/e2ee/devices/${bob.deviceId}/to-device`, { ackUpTo: 2 });
    expect(after2.body.data.events.map((event) => event.seq)).toEqual([3]);
    await bob.client.post(`/e2ee/devices/${bob.deviceId}/to-device`, { ackUpTo: 3 });
    expect(await E2eeToDeviceEvent.countDocuments({ deviceId: bob.deviceId })).toBe(0);

    // The queue is empty now; the next event is numbered after the acknowledgment, not 1.
    for (const request of await shareKeys(alice, bob, ['r4'])) await alice.send(request);
    const next = await bob.client.post(`/e2ee/devices/${bob.deviceId}/to-device`, { ackUpTo: 3 });
    expect(next.body.data.events.map((event) => event.seq)).toEqual([4]);
  });

  it('a retried transaction is stored once; the same id with different content is refused', async () => {
    const { alice, bob } = await readyPair(app, { enable: false });
    const [one, two] = await shareKeys(alice, bob, ['t1', 't2']);
    const put = (txnId, request) =>
      alice.client.send('put', `/e2ee/to-device/${txnId}`, {
        type: request.event_type,
        messages: JSON.parse(request.body).messages,
      });
    const results = await Promise.all([
      put(one.txn_id, one),
      put(one.txn_id, one),
      put(one.txn_id, one),
    ]);
    expect(results.map((res) => res.status)).toEqual([200, 200, 200]);
    expect(await E2eeToDeviceEvent.countDocuments({ deviceId: bob.deviceId })).toBe(1);
    const reused = await put(one.txn_id, two);
    expect(reused.body.error.code).toBe('TRANSACTION_ID_REUSED');
    expect(await E2eeToDeviceEvent.countDocuments({ deviceId: bob.deviceId })).toBe(1);
  });

  it('accepts only Olm ciphertext from the bound device, for registered devices of allowed people', async () => {
    const { alice, bob } = await readyPair(app, { enable: false });
    const [share] = await shareKeys(alice, bob, ['v1']);
    const messages = JSON.parse(share.body).messages;
    const content = messages[toE2eeUserId(bob.userId)][bob.deviceId];
    const put = (body) => alice.client.send('put', `/e2ee/to-device/${randomUUID()}`, body);
    const to = (payload, deviceId = bob.deviceId, userId = bob.userId) => ({
      type: 'm.room.encrypted',
      messages: { [toE2eeUserId(userId)]: { [deviceId]: payload } },
    });

    // Plaintext, other algorithms, extra fields, other event types: refused by validation.
    for (const body of [
      to({ body: 'hello' }),
      to({ ...content, algorithm: 'm.megolm.v1.aes-sha2' }),
      to({ ...content, plaintext: 'hello' }),
      { ...to(content), type: 'm.room_key' },
    ]) {
      expect((await put(body)).status).toBe(400);
    }
    // Not from this sign-in's device key.
    const otherSender = { ...content, sender_key: bob.machine.identityKeys.curve25519.toBase64() };
    expect((await put(to(otherSender))).body.error.code).toBe('SENDER_KEY_MISMATCH');
    // Encrypted for a different device than the one addressed.
    const bobPhone = await ApiDevice.create(bob.account, { bind: false });
    expect((await put(to(content, bobPhone.deviceId))).body.error.code).toBe(
      'RECIPIENT_KEY_MISMATCH',
    );
    // A stranger (not connected) and an unknown device: skipped, nothing stored.
    const stranger = await signedInUser(app);
    const strangerDevice = await ApiDevice.create(stranger);
    expect((await put(to(content, strangerDevice.deviceId, stranger.user.id))).status).toBe(200);
    expect((await put(to(content, 'ZZZZZZZZZZ'))).status).toBe(200);
    expect(await E2eeToDeviceEvent.countDocuments({ sender: alice.userId })).toBe(0);
    // An unbound sign-in can't send at all.
    const fresh = await signedInUser(app);
    await ApiDevice.create(fresh, { bind: false });
    const unbound = await fresh.client.send('put', `/e2ee/to-device/${randomUUID()}`, to(content));
    expect(unbound.body.error.code).toBe('DEVICE_NOT_BOUND');
  });

  it('caps a device queue and keeps undelivered events at most 30 days', async () => {
    const { app: small } = buildTestApp({ e2ee: { enabled: true, toDeviceQueueMax: 2 } });
    const { alice, bob } = await readyPair(small, { enable: false });
    const requests = await shareKeys(alice, bob, ['q1', 'q2', 'q3']);
    await alice.send(requests[0]);
    await alice.send(requests[1]);
    await expect(alice.send(requests[2])).rejects.toMatchObject({
      res: { body: { error: { code: 'RECIPIENT_QUEUE_FULL' } } },
    });
    expect(await E2eeToDeviceEvent.countDocuments({ deviceId: bob.deviceId })).toBe(2);

    const ttl = (await E2eeToDeviceEvent.collection.indexes()).find((index) => index.key.createdAt);
    expect(ttl.expireAfterSeconds).toBe(30 * 86_400);
  });

  it('hints the recipient’s own tabs over Socket.IO, without keys or content', async () => {
    const { a, b, alice, bob } = await readyPair(server.baseUrl, { enable: false });
    const bobSocket = await openSocket(server, b, sockets);
    const aliceSocket = await openSocket(server, a, sockets);
    const hint = nextEvent(bobSocket, E2EE_SOCKET_EVENTS.toDevice);
    let aliceHinted = false;
    aliceSocket.on(E2EE_SOCKET_EVENTS.toDevice, () => {
      aliceHinted = true;
    });
    for (const request of await shareKeys(alice, bob, ['h1'])) await alice.send(request);
    expect(await hint).toEqual({ deviceId: bob.deviceId });
    expect(aliceHinted).toBe(false);
  });
});

describe('opting a conversation in', () => {
  it('is off unless the server allows it, and needs both people ready', async () => {
    const { app: off } = buildTestApp();
    const disabled = await connectedPair(off);
    await ApiDevice.create(disabled.a);
    await ApiDevice.create(disabled.b);
    const status = await disabled.a.client.get(`/e2ee/conversations/${disabled.conversation.id}`);
    expect(status.body.data).toMatchObject({
      enabled: false,
      canEnable: false,
      reason: 'disabled',
    });
    const refused = await disabled.a.client.post(
      `/e2ee/conversations/${disabled.conversation.id}/enable`,
    );
    expect(refused.body.error.code).toBe('E2EE_DISABLED');
    expect((await disabled.a.client.get('/e2ee/status')).body.data).toEqual({ enabled: false });

    const { a, b, conversation } = await connectedPair(app);
    const reason = async () =>
      (await a.client.get(`/e2ee/conversations/${conversation.id}`)).body.data.reason;
    expect(await reason()).toBe('no_device');
    await ApiDevice.create(a);
    expect(await reason()).toBe('peer_no_device');
    await ApiDevice.create(b, { bind: false });
    expect(await reason()).toBeNull();
  });

  it('switches once, for both people, with a history line; there is no way back', async () => {
    const { a, b, conversation } = await readyPair(app, { enable: false });
    const results = await Promise.all([
      a.client.post(`/e2ee/conversations/${conversation.id}/enable`),
      a.client.post(`/e2ee/conversations/${conversation.id}/enable`),
      b.client.post(`/e2ee/conversations/${conversation.id}/enable`),
    ]);
    expect(results.every((res) => res.status === 200 && res.body.data.enabled)).toBe(true);
    const lines = await Message.find({ conversation: conversation.id, type: 'system' }).lean();
    expect(lines.map((line) => line.system.kind)).toEqual(['e2ee_enabled']);
    const summary = (await b.client.get(`/conversations/${conversation.id}`)).body.data;
    expect(summary.e2ee).toEqual({ enabledAt: expect.any(String) });
    // Nothing turns it off.
    expect((await Conversation.findById(conversation.id).lean()).e2ee).not.toBeNull();
  });

  it('groups and legacy chats are untouched', async () => {
    const { a, conversation } = await connectedPair(app);
    const legacy = await a.client.post(`/conversations/${conversation.id}/messages`, {
      clientMessageId: randomUUID(),
      text: 'plain as before',
    });
    expect(legacy.status).toBe(201);
    expect(legacy.body.data.message).toMatchObject({
      text: 'plain as before',
      encryption: 'none',
      encrypted: null,
    });
    expect((await a.client.get(`/conversations/${conversation.id}`)).body.data.e2ee).toBeNull();
  });
});

describe('encrypted direct messages', () => {
  it('the server stores only ciphertext; an offline recipient decrypts it later', async () => {
    const pair = await readyPair();
    const { a, b, conversation, alice, bob } = pair;
    const body = await encryptFor(alice, pair, 'meet at 7, the code is 4417');
    const sent = await sendEncrypted(a, conversation.id, body);
    expect(sent.status).toBe(201);
    expect(sent.body.data.message).toMatchObject({ text: '', encryption: 'e2ee_v1', type: 'text' });

    // Nothing readable on the server: messages, previews, queue.
    const stored = await Message.findById(sent.body.data.message.id).lean();
    const everything = JSON.stringify([
      stored,
      await Conversation.findById(conversation.id).lean(),
      await E2eeToDeviceEvent.find({}).lean(),
    ]);
    expect(everything).not.toContain('meet at 7');
    expect(everything).not.toContain('4417');
    const list = (await b.client.get('/conversations')).body.data;
    expect(list.find((item) => item.id === conversation.id).lastMessage.preview).toBe(
      'Encrypted message',
    );

    // Bob comes online: history (as any client loads it), then his queue, then decryption.
    const history = (await b.client.get(`/conversations/${conversation.id}/messages`)).body.data;
    const message = history.find((item) => item.encryption === 'e2ee_v1');
    await expect(bob.decrypt(message)).rejects.toBeTruthy(); // no key yet
    const { events } = await bob.sync();
    expect(events.length).toBeGreaterThan(0);
    const { content, decrypted } = await bob.decrypt(message);
    expect(content.body).toBe('meet at 7, the code is 4417');
    expect(content['connect.message'].clientMessageId).toBe(message.clientMessageId);
    // Who sent it, according to the Megolm session (not the server's claim). The client first
    // fetches the claimed sender's devices.
    await bob.machine.updateTrackedUsers([new UserId(toE2eeUserId(a.user.id))]);
    await bob.flush();
    const device = await bob.machine.getDevice(
      new UserId(toE2eeUserId(a.user.id)),
      new DeviceId(alice.deviceId),
    );
    expect(decrypted.senderCurve25519Key).toBe(device.curve25519Key.toBase64());
    expect(decrypted.shieldState(false).code).not.toBe(5); // not MismatchedSender
    // And Alice reads her own message on her device.
    expect((await alice.decrypt(message)).content.body).toBe('meet at 7, the code is 4417');
  });

  it('a redelivered queue (crash before acknowledging) is harmless', async () => {
    const pair = await readyPair();
    const sent = await sendEncrypted(
      pair.a,
      pair.conversation.id,
      await encryptFor(pair.alice, pair, 'once'),
    );
    await pair.bob.sync({ ack: false });
    // The device "crashed" before acknowledging: the same events come again.
    const replay = await pair.bob.sync({ ack: false });
    expect(replay.events.length).toBeGreaterThan(0);
    expect((await pair.bob.decrypt(sent.body.data.message)).content.body).toBe('once');
    await pair.bob.sync(); // acknowledges
    expect(await E2eeToDeviceEvent.countDocuments({ deviceId: pair.bob.deviceId })).toBe(0);
  });

  it('a relabelled sender is detected (the library reports MismatchedSender)', async () => {
    const pair = await readyPair();
    const sent = await sendEncrypted(
      pair.a,
      pair.conversation.id,
      await encryptFor(pair.alice, pair, 'from alice'),
    );
    await pair.bob.sync();
    // A malicious server claims Bob wrote it.
    const forged = { ...sent.body.data.message, senderId: pair.b.user.id };
    const { decrypted } = await pair.bob.decrypt(forged);
    expect(decrypted.shieldState(false).code).toBe(5);
    expect(decrypted.senderDevice).toBeUndefined();
  });

  it('no downgrade: readable content is refused in an encrypted chat (HTTP and socket)', async () => {
    const { a, b, conversation } = await readyPair(server.baseUrl);
    const plain = await a.client.post(`/conversations/${conversation.id}/messages`, {
      clientMessageId: randomUUID(),
      text: 'hello',
    });
    expect(plain.body.error.code).toBe('E2EE_REQUIRED');
    const sticker = await b.client.post(`/conversations/${conversation.id}/messages`, {
      clientMessageId: randomUUID(),
      sticker: 'wave',
    });
    expect(sticker.status).toBeGreaterThanOrEqual(400);
    const socket = await openSocket(server, a, sockets);
    const viaSocket = await request(socket, 'message:send', {
      conversationId: conversation.id,
      clientMessageId: randomUUID(),
      text: 'hello',
    });
    expect(viaSocket.error.code).toBe('E2EE_REQUIRED');
    expect(
      await Message.countDocuments({ conversation: conversation.id, type: { $ne: 'system' } }),
    ).toBe(0);
  });

  it('encrypted content only from the bound device, only in encrypted chats', async () => {
    const pair = await readyPair();
    const body = await encryptFor(pair.alice, pair, 'hi');
    // From Bob's sign-in, Alice's payload is not his device's.
    const asBob = await sendEncrypted(pair.b, pair.conversation.id, {
      ...body,
      clientMessageId: randomUUID(),
    });
    expect(asBob.body.error.code).toBe('DEVICE_NOT_BOUND');
    // An encrypted payload in an ordinary chat.
    const other = await connectedPair(app);
    await ApiDevice.create(other.a);
    const notEnabled = await sendEncrypted(other.a, other.conversation.id, {
      clientMessageId: randomUUID(),
      encrypted: body.encrypted,
    });
    expect(notEnabled.body.error.code).toBe('E2EE_NOT_ENABLED');
    // Strict payload: extra fields or plaintext alongside are refused.
    const mixed = await sendEncrypted(pair.a, pair.conversation.id, { ...body, text: 'hi' });
    expect(mixed.status).toBe(400);
    const extra = await sendEncrypted(pair.a, pair.conversation.id, {
      ...body,
      encrypted: { ...body.encrypted, body: 'hi' },
    });
    expect(extra.status).toBe(400);
  });

  it('retries are idempotent on the ciphertext; edits, replies and deletes keep working', async () => {
    const pair = await readyPair();
    const { a, b, conversation, alice, bob } = pair;
    const body = await encryptFor(alice, pair, 'first');
    const first = await sendEncrypted(a, conversation.id, body);
    expect((await sendEncrypted(a, conversation.id, body)).body.data.duplicate).toBe(true);
    const changed = await encryptFor(alice, pair, 'different', body.clientMessageId);
    expect((await sendEncrypted(a, conversation.id, changed)).body.error.code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );

    // A reply (metadata only) and an edit (new ciphertext).
    const reply = await sendEncrypted(b, conversation.id, {
      ...(await encryptFor(bob, pair, 'answer')),
      replyToId: first.body.data.message.id,
    });
    expect(reply.body.data.message.replyTo).toMatchObject({
      kind: 'encrypted',
      preview: 'Encrypted message',
    });
    const edited = await a.client.send(
      'patch',
      `/conversations/${conversation.id}/messages/${first.body.data.message.id}`,
      { encrypted: (await encryptFor(alice, pair, 'first, edited')).encrypted },
    );
    expect(edited.status).toBe(200);
    expect(edited.body.data.editedAt).not.toBeNull();
    await bob.sync();
    expect((await bob.decrypt(edited.body.data)).content.body).toBe('first, edited');
    // A readable edit is refused.
    const plainEdit = await a.client.send(
      'patch',
      `/conversations/${conversation.id}/messages/${first.body.data.message.id}`,
      { text: 'plain' },
    );
    expect(plainEdit.status).toBe(400);

    // Forwarding encrypted messages is refused (the server can't re-encrypt them).
    const elsewhere = await connectedPair(app);
    const forward = await a.client.post(`/conversations/${conversation.id}/messages`, {
      clientMessageId: randomUUID(),
      forwardOfId: first.body.data.message.id,
    });
    expect(forward.status).toBeGreaterThanOrEqual(400);
    expect(elsewhere).toBeTruthy();

    // Delete for everyone wipes the ciphertext.
    await a.client.delete(
      `/conversations/${conversation.id}/messages/${first.body.data.message.id}?scope=everyone`,
    );
    const wiped = await Message.findById(first.body.data.message.id).lean();
    expect(wiped.encrypted).toBeNull();
    expect(wiped.deletedAt).not.toBeNull();
  });

  it('messages from before encryption stay readable and can’t be edited into the encrypted chat', async () => {
    const { a, b, conversation } = await connectedPair(app);
    const before = await a.client.post(`/conversations/${conversation.id}/messages`, {
      clientMessageId: randomUUID(),
      text: 'before',
    });
    await ApiDevice.create(a);
    await ApiDevice.create(b);
    await a.client.post(`/e2ee/conversations/${conversation.id}/enable`);
    const history = (await b.client.get(`/conversations/${conversation.id}/messages`)).body.data;
    expect(history.map((m) => [m.type, m.text, m.encryption])).toEqual([
      ['text', 'before', 'none'],
      ['system', '', 'none'],
    ]);
    const edit = await a.client.send(
      'patch',
      `/conversations/${conversation.id}/messages/${before.body.data.message.id}`,
      { text: 'changed' },
    );
    expect(edit.body.error.code).toBe('E2EE_REQUIRED');
  });

  it('a claimed-down key pool hints its owner', async () => {
    const pair = await readyPair(server.baseUrl, { enable: false });
    const bobSocket = await openSocket(server, pair.b, sockets);
    const hint = nextEvent(bobSocket, E2EE_SOCKET_EVENTS.keysLow, () => true, 10_000);
    const one = {
      one_time_keys: {
        [toE2eeUserId(pair.b.user.id)]: { [pair.bob.deviceId]: 'signed_curve25519' },
      },
    };
    for (let i = 0; i < 41; i++) await pair.a.client.post('/e2ee/keys/claim', one);
    expect(await hint).toEqual({ deviceId: pair.bob.deviceId });
    // The device refreshes its counts and tops up.
    await pair.bob.sync();
    expect(
      await E2eeDevice.exists({ user: pair.b.user.id, deviceId: pair.bob.deviceId }),
    ).toBeTruthy();
  });
});
