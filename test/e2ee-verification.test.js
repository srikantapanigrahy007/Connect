import {
  DeviceId,
  initAsync,
  UserId,
  VerificationMethod,
} from '@matrix-org/matrix-sdk-crypto-wasm';
import { toE2eeUserId } from '#shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { E2eeToDeviceEvent } from '../src/models/e2ee-to-device-event.model.js';
import { ApiDevice } from './e2ee-helpers.js';
import { buildTestApp, useTestDatabase } from './helpers.js';
import { connectedPair } from './messaging-helpers.js';

// SAS (emoji) device verification between real library devices, relayed by the real API
// (checkpoint F). A device counts as verified only when the library says so after both people
// confirmed matching emoji.

useTestDatabase();

let app;
beforeAll(async () => {
  await initAsync();
  ({ app } = buildTestApp({ e2ee: { enabled: true } }));
});

const uid = (device) => new UserId(toE2eeUserId(device.userId));

async function pairWithKeys() {
  const { a, b } = await connectedPair(app);
  const alice = await ApiDevice.create(a);
  const bob = await ApiDevice.create(b);
  await alice.machine.updateTrackedUsers([uid(bob)]);
  await bob.machine.updateTrackedUsers([uid(alice)]);
  await alice.flush();
  await bob.flush();
  return { alice, bob };
}

const deviceOf = (viewer, owner) =>
  viewer.machine.getDevice(uid(owner), new DeviceId(owner.deviceId));

async function syncBoth(alice, bob, rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    await alice.sync();
    await bob.sync();
  }
}

/** Runs the flow up to both sides showing emoji; `alterKey` tampers with Bob's key message. */
async function startSas(alice, bob, { alterKey } = {}) {
  const [aliceRequest, request] = (await deviceOf(alice, bob)).requestVerification([
    VerificationMethod.SasV1,
  ]);
  await alice.send(request);
  await bob.sync();
  const [bobRequest] = bob.machine.getVerificationRequests(uid(alice));
  await bob.send(bobRequest.acceptWithMethods([VerificationMethod.SasV1]));
  await alice.sync();
  const [aliceSas, start] = await aliceRequest.startSas();
  await alice.send(start);
  await bob.sync();
  const bobSas = bobRequest.getVerification();
  await bob.send(bobSas.accept());
  if (alterKey) {
    const original = bob.send.bind(bob);
    bob.send = (outgoing) => {
      if (outgoing.event_type === 'm.key.verification.key') {
        const body = JSON.parse(outgoing.body);
        for (const devices of Object.values(body.messages)) {
          for (const content of Object.values(devices)) content.key = alterKey;
        }
        return original({
          ...outgoing,
          id: outgoing.id,
          type: outgoing.type,
          txn_id: outgoing.txn_id,
          event_type: outgoing.event_type,
          body: JSON.stringify(body),
        });
      }
      return original(outgoing);
    };
  }
  await syncBoth(alice, bob);
  return { aliceSas, bobSas };
}

describe('SAS emoji verification through the API', () => {
  it('matching emoji confirmed by both people verifies each other’s device', async () => {
    const { alice, bob } = await pairWithKeys();
    expect((await deviceOf(alice, bob)).isVerified()).toBe(false);
    const { aliceSas, bobSas } = await startSas(alice, bob);
    const aliceEmoji = aliceSas.emoji().map((emoji) => emoji.symbol);
    expect(aliceEmoji).toHaveLength(7);
    expect(bobSas.emoji().map((emoji) => emoji.symbol)).toEqual(aliceEmoji);
    // Not verified on emoji alone: only after both confirmations.
    expect((await deviceOf(alice, bob)).isVerified()).toBe(false);
    for (const message of await aliceSas.confirm()) await alice.send(message);
    expect((await deviceOf(alice, bob)).isVerified()).toBe(false);
    await bob.sync();
    for (const message of await bobSas.confirm()) await bob.send(message);
    await syncBoth(alice, bob);
    expect(aliceSas.isDone() && bobSas.isDone()).toBe(true);
    expect((await deviceOf(alice, bob)).isVerified()).toBe(true);
    expect((await deviceOf(bob, alice)).isVerified()).toBe(true);
    // Everything relayed was delivered and acknowledged.
    await syncBoth(alice, bob, 1);
    expect(await E2eeToDeviceEvent.countDocuments({})).toBe(0);
  });

  it('a key swapped in transit never ends in a verified device', async () => {
    const { alice, bob } = await pairWithKeys();
    const { aliceSas, bobSas } = await startSas(alice, bob, {
      alterKey: alice.machine.identityKeys.curve25519.toBase64(),
    });
    // The commitment check fails (cancelled) or the emoji differ; confirming can't verify.
    const same =
      !aliceSas.isCancelled() &&
      JSON.stringify(aliceSas.emoji()?.map((e) => e.symbol)) ===
        JSON.stringify(bobSas.emoji()?.map((e) => e.symbol));
    expect(same).toBe(false);
    for (const message of (await aliceSas.confirm().catch(() => [])) ?? [])
      await alice.send(message);
    await syncBoth(alice, bob);
    expect((await deviceOf(alice, bob)).isVerified()).toBe(false);
  });

  it('verification messages are relayed only between people who may message each other', async () => {
    const { alice } = await pairWithKeys();
    const stranger = await connectedPair(app);
    const outsider = await ApiDevice.create(stranger.a);
    const res = await alice.client.send('put', '/e2ee/to-device/t1', {
      type: 'm.key.verification.request',
      messages: {
        [toE2eeUserId(outsider.userId)]: {
          [outsider.deviceId]: { transaction_id: 'x', from_device: alice.deviceId, methods: [] },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(await E2eeToDeviceEvent.countDocuments({ user: outsider.userId })).toBe(0);
    // Oversized or malformed verification content is refused.
    const big = await alice.client.send('put', '/e2ee/to-device/t2', {
      type: 'm.key.verification.start',
      messages: {
        [toE2eeUserId(alice.userId)]: {
          [alice.deviceId]: { transaction_id: 'x', pad: 'a'.repeat(5000) },
        },
      },
    });
    expect(big.status).toBe(400);
  });
});
