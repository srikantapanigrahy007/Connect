import { randomInt } from 'node:crypto';
import {
  DeviceId,
  initAsync,
  OlmMachine,
  RequestType,
  UserId,
} from '@matrix-org/matrix-sdk-crypto-wasm';
import { toE2eeUserId } from '#shared';
import mongoose from 'mongoose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { assignAllMissingSlots } from '../scripts/e2ee-device-slots.js';
import { E2eeDevice } from '../src/models/e2ee-device.model.js';
import { User } from '../src/models/user.model.js';
import { buildTestApp, connect, signedInUser, TestClient, useTestDatabase } from './helpers.js';

// Devices here are real Matrix crypto devices (the library's Node build), so keys, signatures
// and the KeysQuery round trip are the library's own, not hand-made fixtures.

useTestDatabase();

let app;
beforeAll(async () => {
  await initAsync();
  ({ app } = buildTestApp());
});

const newDeviceId = () =>
  Array.from({ length: 10 }, () => String.fromCharCode(65 + randomInt(26))).join('');

/** A real device for `user` and its signed device_keys (as the client sends them). */
async function realDevice(user, deviceId = newDeviceId()) {
  const machine = await OlmMachine.initialize(
    new UserId(toE2eeUserId(user.user.id)),
    new DeviceId(deviceId),
  );
  const upload = (await machine.outgoingRequests()).find(
    (request) => request.type === RequestType.KeysUpload,
  );
  return { machine, deviceId, deviceKeys: JSON.parse(upload.body).device_keys };
}

const register = (user, device, body = { deviceKeys: device.deviceKeys }) =>
  user.client.send('put', `/e2ee/devices/${device.deviceId}`, body);
const query = (user, users) =>
  user.client.post('/e2ee/keys/query', {
    device_keys: Object.fromEntries(users.map((u) => [toE2eeUserId(u.user.id), []])),
  });

describe('device registration', () => {
  it('registers your device (idempotently) and stores only its public keys', async () => {
    const alice = await signedInUser(app);
    const device = await realDevice(alice);

    const created = await register(alice, device);
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      deviceId: device.deviceId,
      ed25519: device.machine.identityKeys.ed25519.toBase64(),
      curve25519: device.machine.identityKeys.curve25519.toBase64(),
    });
    expect((await register(alice, device)).status).toBe(200);
    expect((await alice.client.get('/e2ee/devices')).body.data).toHaveLength(1);

    const stored = await E2eeDevice.findOne({ deviceId: device.deviceId }).lean();
    expect(Object.keys(stored.deviceKeys).sort()).toEqual([
      'algorithms',
      'device_id',
      'keys',
      'signatures',
      'user_id',
    ]);
    expect(JSON.stringify(stored)).not.toMatch(/one_time|fallback|pickle|private|secret/i);
  });

  it('rejects keys for another account, another device id, or with a broken signature', async () => {
    const alice = await signedInUser(app);
    const bob = await signedInUser(app);
    const bobDevice = await realDevice(bob);

    // Bob's genuine keys presented by Alice: refused (no device impersonation).
    const stolen = await register(alice, bobDevice);
    expect(stolen.status).toBe(403);

    const own = await realDevice(alice);
    const wrongId = await alice.client.send('put', `/e2ee/devices/${newDeviceId()}`, {
      deviceKeys: own.deviceKeys,
    });
    expect(wrongId.status).toBe(400);

    const keyId = `curve25519:${own.deviceId}`;
    const original = own.deviceKeys.keys[keyId];
    const tampered = {
      ...own.deviceKeys,
      keys: {
        ...own.deviceKeys.keys,
        [keyId]: `${original[0] === 'A' ? 'B' : 'A'}${original.slice(1)}`,
      },
    };
    const forged = await register(alice, own, { deviceKeys: tampered });
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe('INVALID_DEVICE_SIGNATURE');
    expect(await E2eeDevice.countDocuments({ user: alice.user.id })).toBe(0);
  });

  it('accepts nothing but the signed public key object (no extra or secret fields)', async () => {
    const alice = await signedInUser(app);
    const device = await realDevice(alice);
    const user = device.deviceKeys.user_id;
    for (const body of [
      { deviceKeys: device.deviceKeys, one_time_keys: { 'signed_curve25519:AAAA': {} } },
      { deviceKeys: { ...device.deviceKeys, private_key: 'x'.repeat(43) } },
      { deviceKeys: { ...device.deviceKeys, unsigned: { device_display_name: 'Laptop' } } },
      { deviceKeys: { ...device.deviceKeys, algorithms: ['m.megolm.v1.aes-sha2'] } },
      {
        deviceKeys: {
          ...device.deviceKeys,
          signatures: { ...device.deviceKeys.signatures, '@someone:connect': {} },
        },
      },
      { deviceKeys: { ...device.deviceKeys, signatures: { [user]: {} } } },
      {},
    ]) {
      expect((await register(alice, device, body)).status).toBe(400);
    }
    expect((await alice.client.send('put', '/e2ee/devices/lowercase1', {})).status).toBe(400);
    expect((await new TestClient(app).get('/e2ee/devices')).status).toBe(401);
    expect(await E2eeDevice.countDocuments({ user: alice.user.id })).toBe(0);
  });

  it("a device's keys can never be replaced, and the same registration racing stores one", async () => {
    const alice = await signedInUser(app);
    const device = await realDevice(alice);
    const statuses = (await Promise.all([register(alice, device), register(alice, device)]))
      .map((res) => res.status)
      .sort();
    expect(statuses).toEqual([200, 201]);

    // A different (genuine) key set for the same device id: refused, original kept.
    const impostor = await realDevice(alice, device.deviceId);
    const replaced = await register(alice, impostor);
    expect(replaced.status).toBe(409);
    expect(replaced.body.error.code).toBe('DEVICE_KEYS_IMMUTABLE');
    const stored = await E2eeDevice.findOne({ user: alice.user.id }).lean();
    expect(stored.ed25519).toBe(device.machine.identityKeys.ed25519.toBase64());
  });

  it('limits devices per account and lets you remove only your own', async () => {
    const alice = await signedInUser(app);
    const bob = await signedInUser(app);
    const devices = [];
    for (let i = 0; i < 10; i++) {
      const device = await realDevice(alice);
      expect((await register(alice, device)).status).toBe(201);
      devices.push(device);
    }
    const eleventh = await register(alice, await realDevice(alice));
    expect(eleventh.status).toBe(409);
    expect(eleventh.body.error.code).toBe('DEVICE_LIMIT_REACHED');

    expect((await bob.client.delete(`/e2ee/devices/${devices[0].deviceId}`)).status).toBe(404);
    expect((await alice.client.delete(`/e2ee/devices/${devices[0].deviceId}`)).status).toBe(204);
    expect((await alice.client.delete(`/e2ee/devices/${devices[0].deviceId}`)).status).toBe(404);
    expect((await alice.client.get('/e2ee/devices')).body.data).toHaveLength(9);
    expect((await register(alice, await realDevice(alice))).status).toBe(201);
  });
});

describe('key query (the library KeysQuery)', () => {
  it("returns a contact's signed keys, and the crypto library accepts the response", async () => {
    const alice = await signedInUser(app);
    const bob = await signedInUser(app);
    await connect(alice, bob);
    const aliceDevice = await realDevice(alice);
    await register(alice, aliceDevice);

    // Bob's real device asks for Alice's devices exactly as the library does.
    const bobDevice = await realDevice(bob);
    await bobDevice.machine.updateTrackedUsers([new UserId(toE2eeUserId(alice.user.id))]);
    const keysQuery = (await bobDevice.machine.outgoingRequests()).find(
      (request) => request.type === RequestType.KeysQuery,
    );
    const response = await bob.client.post('/e2ee/keys/query', JSON.parse(keysQuery.body));
    expect(response.status).toBe(200);
    expect(response.body.data.device_keys[toE2eeUserId(alice.user.id)]).toEqual({
      [aliceDevice.deviceId]: aliceDevice.deviceKeys,
    });

    await bobDevice.machine.markRequestAsSent(
      keysQuery.id,
      keysQuery.type,
      JSON.stringify(response.body.data),
    );
    const seen = await bobDevice.machine.getDevice(
      new UserId(toE2eeUserId(alice.user.id)),
      new DeviceId(aliceDevice.deviceId),
    );
    expect(seen.ed25519Key.toBase64()).toBe(aliceDevice.machine.identityKeys.ed25519.toBase64());
    expect(seen.curve25519Key.toBase64()).toBe(
      aliceDevice.machine.identityKeys.curve25519.toBase64(),
    );
  });

  it('reveals nothing about strangers, people in a block, or unreachable accounts', async () => {
    const alice = await signedInUser(app);
    const stranger = await signedInUser(app);
    const blocker = await signedInUser(app);
    const suspended = await signedInUser(app);
    await connect(alice, blocker);
    await connect(alice, suspended);
    for (const user of [stranger, blocker, suspended]) await register(user, await realDevice(user));
    await blocker.client.post('/blocks', { username: alice.user.username });
    await User.updateOne(
      { _id: suspended.user.id, status: { $in: ['active', 'pending_verification'] } },
      { $set: { status: 'suspended' } },
    );

    const response = await query(alice, [stranger, blocker, suspended]);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ device_keys: {}, failures: {} });

    const malformed = await alice.client.post('/e2ee/keys/query', {
      device_keys: { '@not-a-connect-id:example.org': [], '@64b0000000000000000000ff:connect': [] },
    });
    // Unknown users look exactly like strangers: absent.
    expect(malformed.body.data.device_keys).toEqual({});
  });

  it('filters by device id, includes your own devices, and validates the request', async () => {
    const alice = await signedInUser(app);
    const first = await realDevice(alice);
    const second = await realDevice(alice);
    await register(alice, first);
    await register(alice, second);
    const own = toE2eeUserId(alice.user.id);

    const all = await query(alice, [alice]);
    expect(Object.keys(all.body.data.device_keys[own]).sort()).toEqual(
      [first.deviceId, second.deviceId].sort(),
    );
    const one = await alice.client.post('/e2ee/keys/query', {
      device_keys: { [own]: [second.deviceId] },
    });
    expect(Object.keys(one.body.data.device_keys[own])).toEqual([second.deviceId]);

    const tooMany = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`@${String(i).padStart(24, '0')}:connect`, []]),
    );
    expect((await alice.client.post('/e2ee/keys/query', { device_keys: tooMany })).status).toBe(
      400,
    );
    expect(
      (await alice.client.post('/e2ee/keys/query', { device_keys: {}, extra: true })).status,
    ).toBe(400);
  });
});

describe('account lifecycle', () => {
  it('suspended accounts cannot use the API; deleting an account removes its devices', async () => {
    const alice = await signedInUser(app);
    await register(alice, await realDevice(alice));
    expect((await alice.client.delete('/account')).status).toBe(204);
    expect(await E2eeDevice.countDocuments({ user: alice.user.id })).toBe(0);

    const bob = await signedInUser(app);
    await User.updateOne(
      { _id: bob.user.id, status: { $in: ['active', 'pending_verification'] } },
      { $set: { status: 'suspended' } },
    );
    expect((await bob.client.get('/e2ee/devices')).status).toBe(403);
    expect((await register(bob, await realDevice(bob))).status).toBe(403);
  });
});

// Real-database concurrency: every request below is in flight at the same time against the real
// mongod of the test run (no mocks), with real library-generated keys. The limit has to come from
// the (user, slot) unique index.
describe('device limit under concurrent registration (real database)', () => {
  /** Registers `count` devices one by one; returns them. */
  async function withDevices(user, count) {
    const devices = [];
    for (let i = 0; i < count; i++) {
      const device = await realDevice(user);
      expect((await register(user, device)).status).toBe(201);
      devices.push(device);
    }
    return devices;
  }
  const slotsOf = async (user) =>
    (await E2eeDevice.find({ user: user.user.id }, { slot: 1 }).lean())
      .map((device) => device.slot)
      .sort((a, b) => a - b);

  it('nine devices + six simultaneous registrations: exactly one wins, never more than 10 (x5)', async () => {
    for (let round = 0; round < 5; round++) {
      const alice = await signedInUser(app);
      await withDevices(alice, 9);
      const batch = await Promise.all(Array.from({ length: 6 }, () => realDevice(alice)));
      const responses = await Promise.all(batch.map((device) => register(alice, device)));

      expect(responses.filter((res) => res.status === 201)).toHaveLength(1);
      const refused = responses.filter((res) => res.status !== 201);
      expect(refused).toHaveLength(5);
      for (const res of refused) {
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('DEVICE_LIMIT_REACHED');
      }
      expect(await E2eeDevice.countDocuments({ user: alice.user.id })).toBe(10);
      expect(await slotsOf(alice)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    }
  });

  it('no devices + fifteen simultaneous registrations: exactly ten win, each in its own slot', async () => {
    const createSpy = vi.spyOn(E2eeDevice, 'create');
    try {
      const alice = await signedInUser(app);
      const batch = await Promise.all(Array.from({ length: 15 }, () => realDevice(alice)));
      const responses = await Promise.all(batch.map((device) => register(alice, device)));

      const accepted = responses.filter((res) => res.status === 201);
      const refused = responses.filter((res) => res.status !== 201);
      expect(accepted).toHaveLength(10);
      expect(refused).toHaveLength(5);
      for (const res of refused) {
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('DEVICE_LIMIT_REACHED');
      }

      // Exactly 10 records, each in its own slot between 0 and 9…
      const stored = await E2eeDevice.find({ user: alice.user.id }).lean();
      expect(stored).toHaveLength(10);
      const slots = stored.map((device) => device.slot);
      expect(new Set(slots).size).toBe(10);
      expect(slots.every((slot) => Number.isInteger(slot) && slot >= 0 && slot <= 9)).toBe(true);
      expect(await slotsOf(alice)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      // …and they are exactly the devices whose registration was accepted.
      expect(stored.map((device) => device.deviceId).sort()).toEqual(
        accepted.map((res) => res.body.data.deviceId).sort(),
      );
      // Requests collided on slots and retried: more inserts were attempted than succeeded.
      expect(createSpy.mock.calls.length).toBeGreaterThan(10);
    } finally {
      createSpy.mockRestore();
    }
  });

  // Includes the case where the identical device takes the LAST slot: the other copies must still
  // be told "already registered", not "limit reached" (a race found under load and fixed).
  it('the same device registered six times at once is stored once and answered idempotently (x5)', async () => {
    const createSpy = vi.spyOn(E2eeDevice, 'create');
    let concurrentInserts = 0;
    try {
      for (let round = 0; round < 5; round++) {
        const alice = await signedInUser(app);
        const before = round % 2 === 0 ? 9 : 0; // 9: the device takes the very last slot
        await withDevices(alice, before);
        const device = await realDevice(alice);
        const callsBefore = createSpy.mock.calls.length;
        const responses = await Promise.all(
          Array.from({ length: 6 }, () => register(alice, device)),
        );

        expect(responses.map((res) => res.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
        // Every answer is a success for this same device, never DEVICE_LIMIT_REACHED (or any
        // other error), even when it took the account's last slot.
        for (const res of responses) {
          expect(res.body.error).toBeUndefined();
          expect(res.body.data).toMatchObject({
            deviceId: device.deviceId,
            ed25519: device.machine.identityKeys.ed25519.toBase64(),
            curve25519: device.machine.identityKeys.curve25519.toBase64(),
          });
        }
        expect(
          await E2eeDevice.countDocuments({ user: alice.user.id, deviceId: device.deviceId }),
        ).toBe(1);
        expect(await E2eeDevice.countDocuments({ user: alice.user.id })).toBe(before + 1);
        // Requests that got past "already registered?" before the first insert landed.
        concurrentInserts += createSpy.mock.calls.length - callsBefore - 1;
      }
    } finally {
      createSpy.mockRestore();
    }
    // Evidence the requests really overlapped: some of them raced into the insert.
    expect(concurrentInserts).toBeGreaterThan(0);
  });

  it('removing a device frees its slot for the next registration', async () => {
    const alice = await signedInUser(app);
    const devices = await withDevices(alice, 10);
    const freed = (await E2eeDevice.findOne({ deviceId: devices[3].deviceId }).lean()).slot;
    expect((await alice.client.delete(`/e2ee/devices/${devices[3].deviceId}`)).status).toBe(204);

    const replacement = await realDevice(alice);
    expect((await register(alice, replacement)).status).toBe(201);
    expect((await E2eeDevice.findOne({ deviceId: replacement.deviceId }).lean()).slot).toBe(freed);
    expect((await register(alice, await realDevice(alice))).status).toBe(409);
  });
});

describe('devices registered before slots existed', () => {
  /** Inserts genuine device records without a slot, as Checkpoint B stored them. */
  async function legacyDevices(user, count) {
    const devices = [];
    for (let i = 0; i < count; i++) {
      const device = await realDevice(user);
      await E2eeDevice.collection.insertOne({
        user: new mongoose.Types.ObjectId(user.user.id),
        deviceId: device.deviceId,
        deviceKeys: device.deviceKeys,
        ed25519: device.machine.identityKeys.ed25519.toBase64(),
        curve25519: device.machine.identityKeys.curve25519.toBase64(),
        registeredBySession: null,
        createdAt: new Date(Date.now() + i),
        updatedAt: new Date(),
      });
      devices.push(device);
    }
    return devices;
  }

  it('get slots before a new registration, so they count toward the limit', async () => {
    const alice = await signedInUser(app);
    const legacy = await legacyDevices(alice, 9);
    const batch = await Promise.all(Array.from({ length: 4 }, () => realDevice(alice)));
    const responses = await Promise.all(batch.map((device) => register(alice, device)));
    expect(responses.filter((res) => res.status === 201)).toHaveLength(1);

    const stored = await E2eeDevice.find({ user: alice.user.id }).lean();
    expect(stored).toHaveLength(10);
    expect(stored.map((device) => device.slot).sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    // The legacy devices kept their identities, oldest first in slots 0–8.
    for (const [index, device] of legacy.entries()) {
      const record = stored.find((entry) => entry.deviceId === device.deviceId);
      expect(record.slot).toBe(index);
      expect(record.deviceKeys).toEqual(device.deviceKeys);
    }
  });

  it('the migration is idempotent and never deletes devices beyond the limit', async () => {
    const alice = await signedInUser(app);
    const bob = await signedInUser(app);
    await legacyDevices(alice, 12); // only possible through the old race
    await legacyDevices(bob, 2);

    const first = await assignAllMissingSlots();
    expect(first).toMatchObject({
      assigned: 12,
      overLimitAccounts: 1,
      devicesWithoutSlot: 2,
    });
    const second = await assignAllMissingSlots();
    expect(second).toMatchObject({ assigned: 0, overLimitAccounts: 1, devicesWithoutSlot: 2 });

    expect(await E2eeDevice.countDocuments({ user: alice.user.id })).toBe(12); // nothing deleted
    expect(
      await E2eeDevice.countDocuments({ user: alice.user.id, slot: { $type: 'number' } }),
    ).toBe(10);
    expect(await E2eeDevice.countDocuments({ user: bob.user.id, slot: { $type: 'number' } })).toBe(
      2,
    );
    // The over-limit account can't add more; its existing devices still answer key queries.
    expect((await register(alice, await realDevice(alice))).status).toBe(409);
    const own = await alice.client.post('/e2ee/keys/query', {
      device_keys: { [toE2eeUserId(alice.user.id)]: [] },
    });
    expect(Object.keys(own.body.data.device_keys[toE2eeUserId(alice.user.id)])).toHaveLength(12);
  });
});
