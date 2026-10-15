import { randomInt } from 'node:crypto';
import {
  DeviceId,
  DeviceLists,
  initAsync,
  OlmMachine,
  ProcessedToDeviceEventType,
  RequestType,
  UserId,
} from '@matrix-org/matrix-sdk-crypto-wasm';
import { toE2eeUserId } from '#shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { E2eeOneTimeKey } from '../src/models/e2ee-one-time-key.model.js';
import { User } from '../src/models/user.model.js';
import { buildTestApp, connect, signedInUser, TestClient, useTestDatabase } from './helpers.js';

// Every device here is a real Matrix crypto device (the library's Node build) talking to the
// real API and the real test MongoDB. "Session established" is only asserted when a message
// encrypted by one device is actually decrypted by the other. The only test-only shortcut is
// handing that encrypted message straight to the recipient (to-device delivery is checkpoint D).

useTestDatabase();

let app;
beforeAll(async () => {
  await initAsync();
  ({ app } = buildTestApp());
});

const newDeviceId = () =>
  Array.from({ length: 10 }, () => String.fromCharCode(65 + randomInt(26))).join('');
const uid = (user) => new UserId(toE2eeUserId(user.user.id));
const pending = async (device, type) =>
  (await device.machine.outgoingRequests()).find((request) => request.type === type);

/** A real device, registered (checkpoint B) but with no keys uploaded yet. */
async function registeredDevice(user) {
  const deviceId = newDeviceId();
  const machine = await OlmMachine.initialize(uid(user), new DeviceId(deviceId));
  const device = { user, deviceId, machine };
  const upload = await pending(device, RequestType.KeysUpload);
  const res = await user.client.send('put', `/e2ee/devices/${deviceId}`, {
    deviceKeys: JSON.parse(upload.body).device_keys,
  });
  expect(res.status).toBe(201);
  return device;
}

/** The client's upload loop: send the pending upload; tell the library only on success. */
async function uploadKeys(device) {
  for (let round = 0; round < 5; round++) {
    const request = await pending(device, RequestType.KeysUpload);
    if (!request) return null;
    const res = await device.user.client.post(
      `/e2ee/devices/${device.deviceId}/keys`,
      JSON.parse(request.body),
    );
    if (res.status !== 200) {
      return res;
    }
    await device.machine.markRequestAsSent(request.id, request.type, JSON.stringify(res.body.data));
  }
  return null;
}

async function readyDevice(user) {
  const device = await registeredDevice(user);
  expect(await uploadKeys(device)).toBeNull();
  return device;
}

/** Library KeysQuery through the API. */
async function runQueries(device) {
  for (let round = 0; round < 3; round++) {
    const request = await pending(device, RequestType.KeysQuery);
    if (!request) return;
    const res = await device.user.client.post('/e2ee/keys/query', JSON.parse(request.body));
    expect(res.status).toBe(200);
    await device.machine.markRequestAsSent(request.id, request.type, JSON.stringify(res.body.data));
  }
}

/** Library session setup with `targets` through the API; returns the claim response. */
async function claimSessions(device, targets, { tamper } = {}) {
  await device.machine.updateTrackedUsers(targets.map(uid));
  await runQueries(device);
  const claim = await device.machine.getMissingSessions(targets.map(uid));
  if (!claim) return null;
  const res = await device.user.client.post('/e2ee/keys/claim', JSON.parse(claim.body));
  expect(res.status).toBe(200);
  const response = tamper ? tamper(structuredClone(res.body.data)) : res.body.data;
  await device.machine.markRequestAsSent(claim.id, claim.type, JSON.stringify(response));
  return res.body.data;
}

/** Observable proof of an outbound Olm session: only possible when one exists. */
async function canEncryptTo(device, target) {
  const other = await device.machine.getDevice(uid(target.user), new DeviceId(target.deviceId));
  try {
    return await other.encryptToDeviceEvent('m.connect.test', { check: target.deviceId });
  } catch {
    return null;
  }
}

/** Delivers an Olm message straight to the recipient (test-only) and returns what it decrypted. */
async function deliver(recipient, sender, content, { claimedSender = sender.user } = {}) {
  await recipient.machine.updateTrackedUsers([uid(sender.user), uid(claimedSender)]);
  await runQueries(recipient);
  const processed = await recipient.machine.receiveSyncChanges(
    JSON.stringify([
      {
        sender: toE2eeUserId(claimedSender.user.id),
        type: 'm.room.encrypted',
        content: JSON.parse(content),
      },
    ]),
    new DeviceLists(),
    new Map(),
    new Set(),
  );
  const decrypted = processed.find((event) => event.type === ProcessedToDeviceEventType.Decrypted);
  return decrypted ? JSON.parse(decrypted.rawEvent).content : null;
}

const claimedKeyIds = (response, user, deviceId) =>
  Object.keys(response?.one_time_keys?.[toE2eeUserId(user.user.id)]?.[deviceId] ?? {});
const available = (user, deviceId) =>
  E2eeOneTimeKey.countDocuments({ user: user.user.id, deviceId, fallback: false, claimedAt: null });

describe('upload', () => {
  it('stores the 50 signed one-time keys the library generates, and the library completes the upload', async () => {
    const alice = await signedInUser(app);
    const device = await registeredDevice(alice);
    const request = await pending(device, RequestType.KeysUpload);
    const body = JSON.parse(request.body);
    expect(Object.keys(body.one_time_keys)).toHaveLength(50); // verified, not assumed

    const res = await alice.client.post(`/e2ee/devices/${device.deviceId}/keys`, body);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ one_time_key_counts: { signed_curve25519: 50 } });
    await device.machine.markRequestAsSent(request.id, request.type, JSON.stringify(res.body.data));
    expect(await pending(device, RequestType.KeysUpload)).toBeUndefined();

    const stored = await E2eeOneTimeKey.find({ user: alice.user.id }).lean();
    expect(stored).toHaveLength(50);
    expect(JSON.stringify(stored)).not.toMatch(/private|pickle|secret/i);
  });

  it('a failed upload is never acknowledged: the library keeps offering the same keys', async () => {
    const alice = await signedInUser(app);
    const deviceId = newDeviceId();
    const machine = await OlmMachine.initialize(uid(alice), new DeviceId(deviceId));
    const device = { user: alice, deviceId, machine };
    const first = await pending(device, RequestType.KeysUpload);
    // Not registered yet: refused, so the client does not tell the library.
    const failed = await uploadKeys(device);
    expect(failed.status).toBe(404);
    expect(failed.body.error.code).toBe('DEVICE_NOT_REGISTERED');
    const again = await pending(device, RequestType.KeysUpload);
    expect(JSON.parse(again.body).one_time_keys).toEqual(JSON.parse(first.body).one_time_keys);
    expect(await E2eeOneTimeKey.countDocuments({ user: alice.user.id })).toBe(0);
  });

  it('retries and simultaneous identical uploads store each key once', async () => {
    const alice = await signedInUser(app);
    const device = await registeredDevice(alice);
    const request = await pending(device, RequestType.KeysUpload);
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        alice.client.post(`/e2ee/devices/${device.deviceId}/keys`, JSON.parse(request.body)),
      ),
    );
    expect(responses.every((res) => res.status === 200)).toBe(true);
    expect(await E2eeOneTimeKey.countDocuments({ user: alice.user.id })).toBe(50);
  });

  it('a retry after a lost response never brings back a key that was claimed meanwhile', async () => {
    const alice = await signedInUser(app);
    const bob = await signedInUser(app);
    await connect(alice, bob);
    const aliceDevice = await registeredDevice(alice);
    const request = await pending(aliceDevice, RequestType.KeysUpload);
    // Stored on the server, but the response is "lost": the library is not told.
    await alice.client.post(`/e2ee/devices/${aliceDevice.deviceId}/keys`, JSON.parse(request.body));

    const bobDevice = await readyDevice(bob);
    const firstClaim = await claimSessions(bobDevice, [alice]);
    const [taken] = claimedKeyIds(firstClaim, alice, aliceDevice.deviceId);
    expect(taken).toBeTruthy();

    // The client retries the same pending upload (same key ids, including the claimed one).
    const retry = await alice.client.post(
      `/e2ee/devices/${aliceDevice.deviceId}/keys`,
      JSON.parse((await pending(aliceDevice, RequestType.KeysUpload)).body),
    );
    expect(retry.body.data.one_time_key_counts.signed_curve25519).toBe(49);
    expect(await E2eeOneTimeKey.countDocuments({ user: alice.user.id, keyId: taken })).toBe(1);
    expect(await E2eeOneTimeKey.countDocuments({ keyId: taken, claimedAt: { $ne: null } })).toBe(1);
  });

  it('rejects tampered keys, foreign signatures, wrong flags, extra fields and identity changes (nothing stored)', async () => {
    const alice = await signedInUser(app);
    const bob = await signedInUser(app);
    const aliceDevice = await registeredDevice(alice);
    const bobDevice = await registeredDevice(bob);
    const body = JSON.parse((await pending(aliceDevice, RequestType.KeysUpload)).body);
    const [firstId] = Object.keys(body.one_time_keys);
    const first = body.one_time_keys[firstId];
    const swap = (key) => `${key[0] === 'A' ? 'B' : 'A'}${key.slice(1)}`;
    const post = (payload, deviceId = aliceDevice.deviceId) =>
      alice.client.post(`/e2ee/devices/${deviceId}/keys`, payload);

    const tampered = await post({
      one_time_keys: { ...body.one_time_keys, [firstId]: { ...first, key: swap(first.key) } },
    });
    expect(tampered.status).toBe(400);
    expect(tampered.body.error.code).toBe('INVALID_KEY_SIGNATURE');

    // Bob's genuine keys uploaded as Alice's device: not signed by her device.
    const bobBody = JSON.parse((await pending(bobDevice, RequestType.KeysUpload)).body);
    expect((await post({ one_time_keys: bobBody.one_time_keys })).body.error.code).toBe(
      'INVALID_KEY_SIGNATURE',
    );
    // Alice uploading to Bob's device: not hers.
    expect((await post(body, bobDevice.deviceId)).status).toBe(404);

    for (const payload of [
      { one_time_keys: { [firstId]: { ...first, fallback: true } } }, // flag changes signed data
      { fallback_keys: { [firstId]: first } }, // a one-time key presented as fallback
      { one_time_keys: { [firstId]: { ...first, private_key: 'x'.repeat(43) } } },
      { one_time_keys: { 'curve25519:AAAA': first } },
      { one_time_keys: body.one_time_keys, extra: true },
    ]) {
      expect((await post(payload)).status).toBe(400);
    }
    const otherIdentity = JSON.parse((await pending(bobDevice, RequestType.KeysUpload)).body);
    const identity = await post({ device_keys: otherIdentity.device_keys });
    expect(identity.status).toBe(409);
    expect(identity.body.error.code).toBe('DEVICE_KEYS_IMMUTABLE');
    expect(await E2eeOneTimeKey.countDocuments({ user: alice.user.id })).toBe(0);
  });

  it('a key id is never re-used for a different key', async () => {
    const alice = await signedInUser(app);
    const one = await readyDevice(alice);
    const stored = await E2eeOneTimeKey.findOne({
      user: alice.user.id,
      deviceId: one.deviceId,
    }).lean();
    // A genuine key of another of Alice's devices, presented under an existing key id.
    const other = await registeredDevice(alice);
    const otherBody = JSON.parse((await pending(other, RequestType.KeysUpload)).body);
    const otherKey = Object.values(otherBody.one_time_keys)[0];
    const res = await alice.client.post(`/e2ee/devices/${other.deviceId}/keys`, {
      one_time_keys: { [stored.keyId]: otherKey },
    });
    // Valid for `other`, so it's stored under `other`; the same id on `one` is untouched.
    expect(res.status).toBe(200);
    const again = await alice.client.post(`/e2ee/devices/${other.deviceId}/keys`, {
      one_time_keys: { [stored.keyId]: Object.values(otherBody.one_time_keys)[1] },
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('KEY_ID_REUSED');
  });
});

describe('atomic claiming', () => {
  it('60 simultaneous claims for one device get 50 distinct keys and never the same key twice', async () => {
    const alice = await signedInUser(app);
    const aliceDevice = await readyDevice(alice);
    const claimers = [];
    for (let i = 0; i < 3; i++) {
      const claimer = await signedInUser(app);
      await connect(alice, claimer);
      claimers.push(claimer);
    }
    const body = {
      one_time_keys: {
        [toE2eeUserId(alice.user.id)]: { [aliceDevice.deviceId]: 'signed_curve25519' },
      },
    };
    const responses = await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        claimers[index % claimers.length].client.post('/e2ee/keys/claim', body),
      ),
    );
    expect(responses.every((res) => res.status === 200)).toBe(true);
    const handedOut = responses.flatMap((res) =>
      claimedKeyIds(res.body.data, alice, aliceDevice.deviceId),
    );
    expect(handedOut).toHaveLength(50);
    expect(new Set(handedOut).size).toBe(50); // no key returned twice
    expect(await available(alice, aliceDevice.deviceId)).toBe(0);
    expect(
      await E2eeOneTimeKey.countDocuments({ user: alice.user.id, claimedAt: { $ne: null } }),
    ).toBe(50);
  });

  it('exhausted devices fall back to their fallback key; empty pools return nothing', async () => {
    const alice = await signedInUser(app);
    const bob = await signedInUser(app);
    await connect(alice, bob);
    const aliceDevice = await readyDevice(alice);
    const one = {
      one_time_keys: {
        [toE2eeUserId(alice.user.id)]: { [aliceDevice.deviceId]: 'signed_curve25519' },
      },
    };
    for (let i = 0; i < 50; i++) await bob.client.post('/e2ee/keys/claim', one);
    // Empty pool, no fallback key: absent.
    expect((await bob.client.post('/e2ee/keys/claim', one)).body.data.one_time_keys).toEqual({});

    // The device learns its counts (a sync) and uploads a fallback key and new one-time keys.
    const counts = await alice.client.get(`/e2ee/devices/${aliceDevice.deviceId}/keys/count`);
    expect(counts.body.data).toEqual({
      one_time_key_counts: { signed_curve25519: 0 },
      unused_fallback_key_types: [],
    });
    await aliceDevice.machine.receiveSyncChanges(
      '[]',
      new DeviceLists(),
      new Map([['signed_curve25519', 0]]),
      new Set(),
    );
    expect(await uploadKeys(aliceDevice)).toBeNull();
    expect(await E2eeOneTimeKey.countDocuments({ user: alice.user.id, fallback: true })).toBe(1);
    expect(await available(alice, aliceDevice.deviceId)).toBeGreaterThan(0);

    // Use up the new keys too: then the fallback key is served, and served again.
    while ((await available(alice, aliceDevice.deviceId)) > 0) {
      await bob.client.post('/e2ee/keys/claim', one);
    }
    const fallbackA = await bob.client.post('/e2ee/keys/claim', one);
    const fallbackB = await bob.client.post('/e2ee/keys/claim', one);
    const [idA] = claimedKeyIds(fallbackA.body.data, alice, aliceDevice.deviceId);
    expect(idA).toBeTruthy();
    expect(claimedKeyIds(fallbackB.body.data, alice, aliceDevice.deviceId)).toEqual([idA]);
    const served =
      fallbackA.body.data.one_time_keys[toE2eeUserId(alice.user.id)][aliceDevice.deviceId][idA];
    expect(served.fallback).toBe(true);
    const after = await alice.client.get(`/e2ee/devices/${aliceDevice.deviceId}/keys/count`);
    expect(after.body.data.unused_fallback_key_types).toEqual([]); // tells the device to rotate it
  });

  it('claims are only for registered devices of people you may message', async () => {
    const alice = await signedInUser(app);
    const stranger = await signedInUser(app);
    const blocker = await signedInUser(app);
    const suspended = await signedInUser(app);
    await connect(alice, blocker);
    await connect(alice, suspended);
    const devices = {};
    for (const [name, user] of Object.entries({ stranger, blocker, suspended })) {
      devices[name] = await readyDevice(user);
    }
    await blocker.client.post('/blocks', { username: alice.user.username });
    await User.updateOne(
      { _id: suspended.user.id, status: { $in: ['active', 'pending_verification'] } },
      { $set: { status: 'suspended' } },
    );
    const request = {
      one_time_keys: Object.fromEntries(
        Object.entries({ stranger, blocker, suspended }).map(([name, user]) => [
          toE2eeUserId(user.user.id),
          { [devices[name].deviceId]: 'signed_curve25519' },
        ]),
      ),
    };
    request.one_time_keys['@64b0000000000000000000ff:connect'] = {
      ABCDEFGHIJ: 'signed_curve25519',
    };
    const res = await alice.client.post('/e2ee/keys/claim', request);
    expect(res.body.data).toEqual({ one_time_keys: {}, failures: {} });
    expect(
      await E2eeOneTimeKey.countDocuments({
        user: { $in: [stranger.user.id, blocker.user.id, suspended.user.id] },
        claimedAt: { $ne: null },
      }),
    ).toBe(0);
    // A suspended account can't claim (or upload) at all.
    expect((await suspended.client.post('/e2ee/keys/claim', request)).status).toBe(403);
  });

  it('a revoked device has no keys left to claim; deleting the account removes all keys', async () => {
    const alice = await signedInUser(app);
    const bob = await signedInUser(app);
    await connect(alice, bob);
    const aliceDevice = await readyDevice(alice);
    expect((await alice.client.delete(`/e2ee/devices/${aliceDevice.deviceId}`)).status).toBe(204);
    expect(await E2eeOneTimeKey.countDocuments({ user: alice.user.id })).toBe(0);
    const res = await bob.client.post('/e2ee/keys/claim', {
      one_time_keys: {
        [toE2eeUserId(alice.user.id)]: { [aliceDevice.deviceId]: 'signed_curve25519' },
      },
    });
    expect(res.body.data.one_time_keys).toEqual({});

    await readyDevice(alice);
    expect((await alice.client.delete('/account')).status).toBe(204);
    expect(await E2eeOneTimeKey.countDocuments({ user: alice.user.id })).toBe(0);
  });

  it('claims are rate limited', async () => {
    const { app: limited } = buildTestApp({
      rateLimitsEnabled: true,
      rateLimits: { e2eeKeysClaimPerUser: { windowMs: 60_000, limit: 2 } },
    });
    const user = await signedInUser(limited);
    const body = { one_time_keys: {} };
    expect((await user.client.post('/e2ee/keys/claim', body)).status).toBe(200);
    expect((await user.client.post('/e2ee/keys/claim', body)).status).toBe(200);
    expect((await user.client.post('/e2ee/keys/claim', body)).status).toBe(429);
    expect((await new TestClient(limited).post('/e2ee/keys/claim', body)).status).toBe(401);
  });
});

describe('real sessions between separate devices', () => {
  it('Bob establishes an Olm session with Alice through the API, and Alice decrypts his message', async () => {
    const alice = await signedInUser(app);
    const bob = await signedInUser(app);
    await connect(alice, bob);
    const aliceDevice = await readyDevice(alice);
    const bobDevice = await readyDevice(bob);

    // Before claiming: no session, so the library refuses to encrypt.
    await bobDevice.machine.updateTrackedUsers([uid(alice)]);
    await runQueries(bobDevice);
    expect(await canEncryptTo(bobDevice, aliceDevice)).toBeNull();

    const claim = await claimSessions(bobDevice, [alice]);
    expect(claimedKeyIds(claim, alice, aliceDevice.deviceId)).toHaveLength(1);
    expect(await bobDevice.machine.getMissingSessions([uid(alice)])).toBeFalsy();

    // Alice is "offline" (her device isn't touched until now); she decrypts on her next sync.
    const encrypted = await canEncryptTo(bobDevice, aliceDevice);
    expect(encrypted).toBeTruthy();
    expect(await deliver(aliceDevice, bobDevice, encrypted)).toEqual({
      check: aliceDevice.deviceId,
    });
    // The keys are still only cryptographically valid: Bob has not verified Alice's device.
    const seen = await bobDevice.machine.getDevice(uid(alice), new DeviceId(aliceDevice.deviceId));
    expect(seen.isVerified()).toBe(false);
  });

  it('a user with several devices: a session with each, each key from the right device', async () => {
    const alice = await signedInUser(app);
    const bob = await signedInUser(app);
    await connect(alice, bob);
    const laptop = await readyDevice(alice);
    const phone = await readyDevice(alice);
    const bobDevice = await readyDevice(bob);

    const claim = await claimSessions(bobDevice, [alice]);
    for (const device of [laptop, phone]) {
      const [keyId] = claimedKeyIds(claim, alice, device.deviceId);
      expect(
        await E2eeOneTimeKey.countDocuments({
          user: alice.user.id,
          deviceId: device.deviceId,
          keyId,
          claimedAt: { $ne: null },
        }),
      ).toBe(1);
      const encrypted = await canEncryptTo(bobDevice, device);
      expect(await deliver(device, bobDevice, encrypted)).toEqual({ check: device.deviceId });
    }
  });

  it('a message relayed under another account name is not accepted', async () => {
    const alice = await signedInUser(app);
    const bob = await signedInUser(app);
    const mallory = await signedInUser(app);
    await connect(alice, bob);
    await connect(alice, mallory);
    const aliceDevice = await readyDevice(alice);
    const bobDevice = await readyDevice(bob);
    await claimSessions(bobDevice, [alice]);
    const encrypted = await canEncryptTo(bobDevice, aliceDevice);
    // The encrypted payload names Bob as its sender; the relay claims it is from Mallory.
    expect(await deliver(aliceDevice, bobDevice, encrypted, { claimedSender: mallory })).toBeNull();
  });

  it('a key altered on the way is rejected by the library: no session, nothing to encrypt with', async () => {
    const alice = await signedInUser(app);
    const bob = await signedInUser(app);
    await connect(alice, bob);
    const aliceDevice = await readyDevice(alice);
    const bobDevice = await readyDevice(bob);
    await claimSessions(bobDevice, [alice], {
      tamper: (response) => {
        const keys = response.one_time_keys[toE2eeUserId(alice.user.id)][aliceDevice.deviceId];
        const [keyId] = Object.keys(keys);
        keys[keyId].key = `${keys[keyId].key[0] === 'A' ? 'B' : 'A'}${keys[keyId].key.slice(1)}`;
        return response;
      },
    });
    // getMissingSessions does NOT tell success from failure here; encrypting does.
    expect(await canEncryptTo(bobDevice, aliceDevice)).toBeNull();
  });

  it('no session when the recipient has no keys left (and nothing is reported as established)', async () => {
    const alice = await signedInUser(app);
    const bob = await signedInUser(app);
    await connect(alice, bob);
    const aliceDevice = await registeredDevice(alice); // registered, keys never uploaded
    const bobDevice = await readyDevice(bob);
    const claim = await claimSessions(bobDevice, [alice]);
    expect(claim.one_time_keys).toEqual({});
    expect(await canEncryptTo(bobDevice, aliceDevice)).toBeNull();
  });
});
