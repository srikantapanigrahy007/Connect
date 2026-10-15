import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  E2EE_BINDING_CHALLENGE_PATTERN,
  E2EE_BINDING_CHALLENGE_TTL_MS,
  E2EE_BINDING_PREFIX,
  E2EE_ONE_TIME_KEY_ALGORITHM,
  E2EE_TO_DEVICE_EVENT_TYPE,
  fromE2eeUserId,
  toE2eeUserId,
} from '#shared';
import mongoose from 'mongoose';
import { E2eeDevice, MAX_E2EE_DEVICES_PER_USER } from '../models/e2ee-device.model.js';
import { Conversation } from '../models/conversation.model.js';
import { E2eeOneTimeKey } from '../models/e2ee-one-time-key.model.js';
import { E2eeToDeviceEvent } from '../models/e2ee-to-device-event.model.js';
import { Session } from '../models/session.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { loadRelationships, messagingUnavailableReason } from './policy.js';

export { MAX_E2EE_DEVICES_PER_USER };
/** Slot collisions one registration retries before giving up (each retry re-reads the slots). */
const SLOT_ATTEMPTS = MAX_E2EE_DEVICES_PER_USER * 3;

/** Which unique index a MongoDB E11000 came from. */
const duplicateKeyOn = (error, field) =>
  error?.code === 11000 && Object.hasOwn(error.keyPattern ?? {}, field);

/** The lowest slot not in `used`, or null when every slot is taken. */
function freeSlot(used) {
  const taken = new Set(used);
  for (let slot = 0; slot < MAX_E2EE_DEVICES_PER_USER; slot++) if (!taken.has(slot)) return slot;
  return null;
}
const usedSlots = (userId) =>
  E2eeDevice.distinct('slot', { user: userId, slot: { $type: 'number' } });

/**
 * Gives every device of `userId` that has no slot yet (registered before slots existed) the lowest
 * free slot, oldest first, through the same unique index. Idempotent. Devices beyond the limit
 * keep no slot and are left as they are (never deleted); the account then can't register more.
 *
 * @returns {Promise<{ assigned: number, withoutSlot: number }>}
 */
export async function assignMissingSlots(userId) {
  const pending = await E2eeDevice.find({ user: userId, slot: { $exists: false } }, { _id: 1 })
    .sort({ createdAt: 1, _id: 1 })
    .lean();
  let assigned = 0;
  for (const device of pending) {
    for (let attempt = 0; attempt < SLOT_ATTEMPTS; attempt++) {
      const slot = freeSlot(await usedSlots(userId));
      if (slot === null) break;
      try {
        const result = await E2eeDevice.updateOne(
          { _id: device._id, slot: { $exists: false } },
          { $set: { slot } },
        );
        if (result.modifiedCount === 1) assigned += 1;
        break; // assigned now, or by someone else meanwhile
      } catch (error) {
        if (!duplicateKeyOn(error, 'slot')) throw error; // taken meanwhile: try the next one
      }
    }
  }
  const withoutSlot = await E2eeDevice.countDocuments({ user: userId, slot: { $exists: false } });
  return { assigned, withoutSlot };
}

/**
 * Matrix canonical JSON (keys sorted, no insignificant whitespace), the format device
 * self-signatures cover. The validated device_keys object only contains strings, arrays and
 * objects of ASCII strings, so JSON.stringify's string escaping is the canonical one.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Checks a Matrix-style signed object: `object.signatures[signerUserId][signingKeyId]` must be a
 * valid Ed25519 signature by `ed25519Base64` over the object's canonical JSON without
 * `signatures` and `unsigned` (Node's built-in Ed25519).
 */
function hasValidSignature(object, signerUserId, signingKeyId, ed25519Base64) {
  const { signatures, unsigned: _unsigned, ...signed } = object;
  const signature = signatures?.[signerUserId]?.[signingKeyId];
  if (typeof signature !== 'string' || typeof ed25519Base64 !== 'string') return false;
  try {
    const publicKey = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(ed25519Base64, 'base64').toString('base64url'),
      },
      format: 'jwk',
    });
    return verify(
      null,
      Buffer.from(canonicalJson(signed)),
      publicKey,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/** The device's Ed25519 self-signature over its own key object. */
function hasValidSelfSignature(deviceKeys) {
  const keyId = `ed25519:${deviceKeys.device_id}`;
  return hasValidSignature(deviceKeys, deviceKeys.user_id, keyId, deviceKeys.keys[keyId]);
}

/**
 * Of `targetIds`, the people `userId` may fetch keys of or claim keys from: themselves, and
 * those they may message right now (connection, no block either way, reachable account).
 */
async function visibleTargets(userId, targetIds) {
  const others = [...new Set(targetIds)].filter((id) => id !== String(userId));
  const [users, relationships] = others.length
    ? await Promise.all([
        User.find({ _id: { $in: others } }, { status: 1 }).lean(),
        loadRelationships(userId, others),
      ])
    : [[], new Map()];
  const usersById = new Map(users.map((user) => [String(user._id), user]));
  const allowed = new Set(
    others.filter(
      (id) => messagingUnavailableReason(usersById.get(id) ?? null, relationships.get(id)) === null,
    ),
  );
  allowed.add(String(userId));
  return allowed;
}

/** Unclaimed one-time keys of a device, as the library's `one_time_key_counts`. */
async function keyCountsOf(userId, deviceId) {
  const [available, unusedFallback] = await Promise.all([
    E2eeOneTimeKey.countDocuments({ user: userId, deviceId, fallback: false, claimedAt: null }),
    E2eeOneTimeKey.exists({ user: userId, deviceId, fallback: true, usedAt: null }),
  ]);
  return {
    one_time_key_counts: { [E2EE_ONE_TIME_KEY_ALGORITHM]: available },
    unused_fallback_key_types: unusedFallback ? [E2EE_ONE_TIME_KEY_ALGORITHM] : [],
  };
}

const sameKeys = (a, b) => canonicalJson(a) === canonicalJson(b);
const deviceNotFound = () => new AppError(404, 'NOT_FOUND', 'Device not found.');

/** Verifies a raw Ed25519 signature (base64) over `message`'s UTF-8 bytes. */
function hasValidRawSignature(message, signature, ed25519Base64) {
  try {
    const publicKey = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(ed25519Base64, 'base64').toString('base64url'),
      },
      format: 'jwk',
    });
    return verify(null, Buffer.from(message, 'utf8'), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/**
 * The E2EE device the signed-in session proved it holds (see `bind`), if it is still
 * registered; otherwise null. Used wherever an action must come from a specific device:
 * reading or acknowledging its to-device queue, sending to-device events, sending encrypted
 * messages.
 */
export async function loadBoundDevice(userId, sessionId) {
  if (!sessionId || !mongoose.isValidObjectId(sessionId)) return null;
  const session = await Session.findOne(
    { _id: sessionId, user: userId, revokedAt: null },
    { e2eeDeviceId: 1 },
  ).lean();
  if (!session?.e2eeDeviceId) return null;
  return E2eeDevice.findOne({ user: userId, deviceId: session.e2eeDeviceId }).lean();
}

const notBound = () =>
  new AppError(
    403,
    'DEVICE_NOT_BOUND',
    "This sign-in hasn't proved it holds that encryption device. Set it up again.",
  );

/** One-time keys left below this make the server hint the device to upload more. */
const KEYS_LOW_THRESHOLD = 10;
/** Undelivered events one sender device may have waiting for one recipient device. */
const PER_SENDER_QUEUE_MAX = 200;
/** Seq collisions a to-device insert retries (like message seqs). */
const SEQ_ATTEMPTS = 25;

function toDeviceDto(device) {
  return {
    deviceId: device.deviceId,
    ed25519: device.ed25519,
    curve25519: device.curve25519,
    createdAt: device.createdAt.toISOString(),
  };
}

/**
 * End-to-end encryption device registry (Phase 15, Stage B, checkpoint B). Public keys only.
 * Not used by messaging yet; E2EE stays off.
 *
 * Who may see whose devices: your own, and those of people you may message right now
 * (connection, no block either way, account reachable) — the same rule as messaging, so device
 * lists never reveal anything about strangers or people in a block with you. Anyone else is left
 * out of query results exactly like an unknown user.
 */
export function createE2eeService({ config, messaging } = {}) {
  const events = new EventEmitter();

  /**
   * Stores one to-device event with the device's next seq: above both the newest stored event
   * and the device's acknowledged floor, so a seq is never re-used below an acknowledgment. The
   * unique { user, deviceId, seq } index rejects a concurrent insert that picked the same number
   * (it retries), so seq N is only written once N - 1 is visible. Reads the newest event before
   * the floor: an acknowledgment raises the floor before deleting, so one of the two reads always
   * sees how far the device got. Returns false when this exact delivery was stored already.
   */
  async function insertToDevice(fields) {
    const queue = { user: fields.user, deviceId: fields.deviceId };
    for (let attempt = 0; attempt < SEQ_ATTEMPTS; attempt++) {
      const newest = await E2eeToDeviceEvent.findOne(queue, { seq: 1 }).sort({ seq: -1 }).lean();
      const device = await E2eeDevice.findOne(queue, { toDeviceAckedSeq: 1 }).lean();
      if (!device) return false; // removed meanwhile
      const seq = Math.max(newest?.seq ?? 0, device.toDeviceAckedSeq ?? 0) + 1;
      try {
        await E2eeToDeviceEvent.create({ ...fields, seq });
        return true;
      } catch (error) {
        if (duplicateKeyOn(error, 'txnId')) return false; // a concurrent identical retry
        if (!duplicateKeyOn(error, 'seq')) throw error;
      }
    }
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Too many deliveries at once. Try again.');
  }

  /** A conversation you are a participant of, or 404. */
  async function loadOwnConversation(userId, conversationId) {
    const conversation = mongoose.isValidObjectId(conversationId)
      ? await Conversation.findOne({ _id: conversationId, participants: userId }).lean()
      : null;
    if (!conversation) throw new AppError(404, 'NOT_FOUND', 'Conversation not found.');
    return conversation;
  }

  /** Why `userId` can't switch this conversation to encryption right now, or null. */
  async function enableBlocker(userId, sessionId, conversation) {
    if (!config?.e2ee?.enabled) return 'disabled';
    if (conversation.type !== 'direct') return 'not_direct';
    const peerId = String(conversation.participants.find((id) => String(id) !== String(userId)));
    if (!(await visibleTargets(userId, [peerId])).has(peerId)) return 'not_allowed';
    if (!(await loadBoundDevice(userId, sessionId))) return 'no_device';
    if (!(await E2eeDevice.exists({ user: peerId }))) return 'peer_no_device';
    return null;
  }

  function enableRefused(reason) {
    switch (reason) {
      case 'disabled':
        return new AppError(403, 'E2EE_DISABLED', 'End-to-end encryption is not available yet.');
      case 'not_direct':
        return AppError.badRequest('Only one-to-one chats can be end-to-end encrypted.');
      case 'not_allowed':
        return new AppError(
          403,
          'MESSAGING_NOT_ALLOWED',
          "You can't message this person right now.",
        );
      case 'no_device':
        return new AppError(
          409,
          'E2EE_DEVICE_REQUIRED',
          'Set up end-to-end encryption on this browser first.',
        );
      default:
        return new AppError(
          409,
          'E2EE_PEER_NOT_READY',
          "The other person hasn't set up end-to-end encryption yet.",
        );
    }
  }

  return {
    /** to-device { userId, deviceId } and keysLow { userId, deviceId } hints (no content). */
    events,

    /**
     * Registers (or confirms) a device of the signed-in user. The key object must be this
     * user's, for this device id, correctly self-signed. Re-registering identical keys is a
     * no-op; different keys for an existing device id are refused (keys are immutable).
     *
     * @returns {Promise<{ device: object, created: boolean }>}
     */
    async register(userId, sessionId, deviceId, deviceKeys) {
      if (deviceKeys.user_id !== toE2eeUserId(userId)) {
        throw new AppError(403, 'FORBIDDEN', 'You can only register devices for your account.');
      }
      if (deviceKeys.device_id !== deviceId) {
        throw AppError.badRequest("The keys don't belong to this device id.");
      }
      if (!hasValidSelfSignature(deviceKeys)) {
        throw new AppError(
          400,
          'INVALID_DEVICE_SIGNATURE',
          'The device keys are not validly signed.',
        );
      }

      const limitReached = () =>
        new AppError(
          409,
          'DEVICE_LIMIT_REACHED',
          `You can have up to ${MAX_E2EE_DEVICES_PER_USER} encryption devices. Remove one first.`,
        );
      const keysImmutable = () =>
        new AppError(
          409,
          'DEVICE_KEYS_IMMUTABLE',
          "This device's keys can't be replaced. Remove it and register a new device.",
        );

      /** This device's record if it exists now: identical keys → already registered. */
      const alreadyRegistered = async () => {
        const existing = await E2eeDevice.findOne({ user: userId, deviceId }).lean();
        if (!existing) return null;
        if (!sameKeys(existing.deviceKeys, deviceKeys)) throw keysImmutable();
        return { device: toDeviceDto(existing), created: false };
      };

      // Older devices without a slot take theirs first, so they count toward the limit.
      await assignMissingSlots(userId);

      // The limit is the unique (user, slot) index: pick the lowest free slot and insert; if
      // another registration took it at the same moment, the insert fails and we look again.
      for (let attempt = 0; attempt < SLOT_ATTEMPTS; attempt++) {
        const registered = await alreadyRegistered();
        if (registered) return registered;
        const slot = freeSlot(await usedSlots(userId));
        if (slot === null) {
          // The last slot may have just gone to this very device (a concurrent identical request).
          const raced = await alreadyRegistered();
          if (raced) return raced;
          throw limitReached();
        }
        try {
          const created = await E2eeDevice.create({
            user: userId,
            deviceId,
            deviceKeys,
            ed25519: deviceKeys.keys[`ed25519:${deviceId}`],
            curve25519: deviceKeys.keys[`curve25519:${deviceId}`],
            slot,
            registeredBySession: sessionId ?? null,
          });
          return { device: toDeviceDto(created.toObject()), created: true };
        } catch (error) {
          if (duplicateKeyOn(error, 'slot') || duplicateKeyOn(error, 'deviceId')) {
            continue; // a concurrent registration: re-read and retry (or answer idempotently)
          }
          if (error?.code === 11000) {
            // The same keys stored by a concurrent identical request are not a conflict.
            const raced = await alreadyRegistered();
            if (raced) return raced;
            throw new AppError(
              409,
              'DEVICE_KEYS_IN_USE',
              'These keys are already registered to another device.',
            );
          }
          throw error;
        }
      }
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Too many registrations at once. Try again.');
    },

    async listOwn(userId) {
      const devices = await E2eeDevice.find({ user: userId }).sort({ createdAt: 1 }).lean();
      return devices.map(toDeviceDto);
    },

    /**
     * Removes (revokes) one of your devices; others' devices look like missing ones. Its keys
     * go with it, so nobody can claim them or start a session with it any more.
     */
    async remove(userId, deviceId) {
      const result = await E2eeDevice.deleteOne({ user: userId, deviceId });
      if (result.deletedCount === 0) throw deviceNotFound();
      await E2eeOneTimeKey.deleteMany({ user: userId, deviceId });
      // Its queue, and every sign-in bound to it.
      await E2eeToDeviceEvent.deleteMany({ user: userId, deviceId });
      await Session.updateMany(
        { user: userId, e2eeDeviceId: deviceId },
        { $set: { e2eeDeviceId: null } },
      );
    },

    /**
     * The crypto library's KeysQuery: `{ device_keys: { "@id:connect": [deviceIds] } }` →
     * `{ device_keys: { "@id:connect": { DEVICEID: signedKeys } }, failures: {} }`. Users you may
     * not see (or that don't exist) are simply absent.
     */
    async query(userId, body) {
      const requested = Object.entries(body.device_keys)
        .map(([e2eeUserId, deviceIds]) => ({
          e2eeUserId,
          targetId: fromE2eeUserId(e2eeUserId),
          deviceIds,
        }))
        .filter((entry) => entry.targetId);
      const allowed = await visibleTargets(
        userId,
        requested.map((entry) => entry.targetId),
      );
      const visible = requested.filter((entry) => allowed.has(entry.targetId));
      const devices = visible.length
        ? await E2eeDevice.find({
            user: { $in: visible.map((entry) => new mongoose.Types.ObjectId(entry.targetId)) },
          }).lean()
        : [];
      const deviceKeys = {};
      for (const entry of visible) {
        const wanted = new Set(entry.deviceIds);
        deviceKeys[entry.e2eeUserId] = Object.fromEntries(
          devices
            .filter((device) => String(device.user) === entry.targetId)
            .filter((device) => wanted.size === 0 || wanted.has(device.deviceId))
            .map((device) => [device.deviceId, device.deviceKeys]),
        );
      }
      return { device_keys: deviceKeys, failures: {} };
    },

    /**
     * The library's KeysUpload for one of your registered devices: optional `device_keys` (must
     * equal the registered, immutable keys), `one_time_keys` and `fallback_keys`. Every key must
     * carry exactly one signature, by this device's registered Ed25519 key, that verifies. The
     * whole upload is checked before anything is stored (all or nothing). Retries are idempotent:
     * key ids already stored (including ones claimed since) are not stored again, so a claimed key
     * can never come back; the same key id with different content is refused.
     *
     * Responds only after MongoDB acknowledged the writes, with the library's
     * `{ one_time_key_counts }`; the client tells the library the upload succeeded only then.
     */
    async uploadKeys(userId, deviceId, body) {
      const device = await E2eeDevice.findOne({ user: userId, deviceId }).lean();
      if (!device) {
        throw new AppError(404, 'DEVICE_NOT_REGISTERED', 'Register this device first.');
      }
      if (body.device_keys && !sameKeys(device.deviceKeys, body.device_keys)) {
        throw new AppError(
          409,
          'DEVICE_KEYS_IMMUTABLE',
          "This device's keys can't be replaced. Remove it and register a new device.",
        );
      }

      const signer = toE2eeUserId(userId);
      const signingKeyId = `ed25519:${deviceId}`;
      const entries = [
        ...Object.entries(body.one_time_keys ?? {}).map(([keyId, signedKey]) => ({
          keyId,
          signedKey,
          fallback: false,
        })),
        ...Object.entries(body.fallback_keys ?? {}).map(([keyId, signedKey]) => ({
          keyId,
          signedKey,
          fallback: true,
        })),
      ];
      for (const entry of entries) {
        const signers = Object.keys(entry.signedKey.signatures);
        const signedByThisDevice =
          signers.length === 1 &&
          signers[0] === signer &&
          JSON.stringify(Object.keys(entry.signedKey.signatures[signer])) ===
            JSON.stringify([signingKeyId]) &&
          hasValidSignature(entry.signedKey, signer, signingKeyId, device.ed25519);
        if (!signedByThisDevice) {
          throw new AppError(
            400,
            'INVALID_KEY_SIGNATURE',
            'A key is not validly signed by this device.',
          );
        }
        if ((entry.signedKey.fallback === true) !== entry.fallback) {
          throw AppError.badRequest('Fallback and one-time keys are mixed up.');
        }
      }

      if (entries.length > 0) {
        // Fallback and one-time key ids are separate namespaces (see the model).
        const idOf = (fallback, keyId) => `${fallback ? 'fallback' : 'one-time'}|${keyId}`;
        const stored = await E2eeOneTimeKey.find(
          { user: userId, deviceId, keyId: { $in: entries.map((entry) => entry.keyId) } },
          { keyId: 1, signedKey: 1, fallback: 1 },
        ).lean();
        const storedById = new Map(stored.map((key) => [idOf(key.fallback, key.keyId), key]));
        for (const entry of entries) {
          const prior = storedById.get(idOf(entry.fallback, entry.keyId));
          if (prior && !sameKeys(prior.signedKey, entry.signedKey)) {
            throw new AppError(
              409,
              'KEY_ID_REUSED',
              'A key id was already used for a different key.',
            );
          }
        }
        const fresh = entries.filter((entry) => !storedById.has(idOf(entry.fallback, entry.keyId)));
        if (fresh.length > 0) {
          try {
            await E2eeOneTimeKey.insertMany(
              fresh.map((entry) => ({
                user: userId,
                deviceId,
                keyId: entry.keyId,
                signedKey: entry.signedKey,
                fallback: entry.fallback,
              })),
              { ordered: false },
            );
          } catch (error) {
            // A concurrent identical upload stored some of them first: fine.
            const writeErrors = error?.writeErrors ? [].concat(error.writeErrors) : null;
            const onlyDuplicates = writeErrors
              ? writeErrors.every(
                  (writeError) => (writeError.code ?? writeError.err?.code) === 11000,
                )
              : error?.code === 11000;
            if (!onlyDuplicates) throw error;
          }
        }
        const newFallback = entries.find((entry) => entry.fallback);
        if (newFallback) {
          // A new fallback key replaces the previous one.
          await E2eeOneTimeKey.deleteMany({
            user: userId,
            deviceId,
            fallback: true,
            keyId: { $ne: newFallback.keyId },
          });
        }
      }
      return { one_time_key_counts: (await keyCountsOf(userId, deviceId)).one_time_key_counts };
    },

    /** Unclaimed key counts of one of your devices (what the library learns on a sync). */
    async keyCounts(userId, deviceId) {
      if (!(await E2eeDevice.exists({ user: userId, deviceId }))) {
        throw new AppError(404, 'DEVICE_NOT_REGISTERED', 'Register this device first.');
      }
      return keyCountsOf(userId, deviceId);
    },

    /**
     * The library's KeysClaim: `{ one_time_keys: { "@id:connect": { DEVICEID: "signed_curve25519" } } }`
     * → `{ one_time_keys: { "@id:connect": { DEVICEID: { keyId: signedKey } } }, failures: {} }`.
     *
     * Each one-time key is taken with ONE atomic MongoDB update (`claimedAt: null` → now) on one
     * document, so concurrent claims can never receive the same key. With none left, the
     * device's fallback key is served (reusable by design). Only registered devices of people
     * you may message (or your own); everyone else, unknown ids and devices without keys are
     * simply absent, so nothing is revealed.
     */
    async claimKeys(userId, body) {
      const requested = Object.entries(body.one_time_keys)
        .map(([e2eeUserId, devices]) => ({
          e2eeUserId,
          targetId: fromE2eeUserId(e2eeUserId),
          deviceIds: Object.keys(devices),
        }))
        .filter((entry) => entry.targetId);
      const allowed = await visibleTargets(
        userId,
        requested.map((entry) => entry.targetId),
      );
      const oneTimeKeys = {};
      for (const entry of requested.filter((candidate) => allowed.has(candidate.targetId))) {
        const registered = await E2eeDevice.find(
          { user: entry.targetId, deviceId: { $in: entry.deviceIds } },
          { deviceId: 1 },
        ).lean();
        for (const { deviceId } of registered) {
          const target = { user: entry.targetId, deviceId };
          const key =
            (await E2eeOneTimeKey.findOneAndUpdate(
              { ...target, fallback: false, claimedAt: null },
              { $set: { claimedAt: new Date(), claimedBy: userId } },
              {
                sort: { _id: 1 },
                returnDocument: 'after',
                projection: { keyId: 1, signedKey: 1, fallback: 1 },
              },
            ).lean()) ??
            (await E2eeOneTimeKey.findOneAndUpdate(
              { ...target, fallback: true },
              { $set: { usedAt: new Date() } },
              { returnDocument: 'after', projection: { keyId: 1, signedKey: 1, fallback: 1 } },
            ).lean());
          if (!key) continue;
          // Hint the owner's device to upload more (no content; it checks its counts itself).
          const low =
            key.fallback ||
            (await E2eeOneTimeKey.countDocuments({ ...target, fallback: false, claimedAt: null })) <
              KEYS_LOW_THRESHOLD;
          if (low) events.emit('keysLow', { userId: entry.targetId, deviceId });
          oneTimeKeys[entry.e2eeUserId] ??= {};
          oneTimeKeys[entry.e2eeUserId][deviceId] = { [key.keyId]: key.signedKey };
        }
      }
      return { one_time_keys: oneTimeKeys, failures: {} };
    },

    // ── Checkpoint D ─────────────────────────────────────────────────────────

    /**
     * A challenge for binding this session to one of your registered devices. Stateless: it
     * names the session and the device and carries its issue time and a random nonce; the device
     * signs it with its key (see `bind`).
     */
    async bindingChallenge(userId, sessionId, deviceId) {
      if (!(await E2eeDevice.exists({ user: userId, deviceId }))) {
        throw new AppError(404, 'DEVICE_NOT_REGISTERED', 'Register this device first.');
      }
      const nonce = randomBytes(16).toString('base64url');
      return { challenge: `${E2EE_BINDING_PREFIX}${sessionId}:${deviceId}:${Date.now()}:${nonce}` };
    },

    /**
     * Binds the signed-in session to one of your devices once the device proved it holds the
     * registered Ed25519 key: the challenge must name this session and device and be recent, and
     * the signature must verify with that device's registered key. A session holds one device;
     * binding another replaces it.
     */
    async bind(userId, sessionId, deviceId, { challenge, signature }) {
      const [, challengeSession, challengeDevice, issuedAt] =
        E2EE_BINDING_CHALLENGE_PATTERN.exec(challenge) ?? [];
      const age = Date.now() - Number(issuedAt);
      if (
        challengeSession !== String(sessionId) ||
        challengeDevice !== deviceId ||
        !(age >= -30_000 && age <= E2EE_BINDING_CHALLENGE_TTL_MS)
      ) {
        throw new AppError(400, 'INVALID_BINDING', 'This challenge is not valid for this sign-in.');
      }
      const device = await E2eeDevice.findOne({ user: userId, deviceId }).lean();
      if (!device) throw new AppError(404, 'DEVICE_NOT_REGISTERED', 'Register this device first.');
      if (!hasValidRawSignature(challenge, signature, device.ed25519)) {
        throw new AppError(
          400,
          'INVALID_BINDING_SIGNATURE',
          "The challenge wasn't signed by this device.",
        );
      }
      const bound = await Session.updateOne(
        { _id: sessionId, user: userId, revokedAt: null },
        { $set: { e2eeDeviceId: deviceId } },
      );
      if (bound.matchedCount === 0) throw new AppError(401, 'UNAUTHORIZED', 'Sign in required');
    },

    /**
     * Sends the library's to-device request (Olm-encrypted payloads, one per recipient device)
     * from the session's bound device. All or nothing: every payload must come from that device's
     * Curve25519 key and be encrypted for the registered recipient device it is addressed to.
     * Recipients you may not message, and unknown devices, are skipped silently (as in key
     * queries). Retrying a transaction stores nothing twice; the same transaction id with
     * different content is refused.
     */
    async sendToDevice(userId, sessionId, txnId, body) {
      const sender = await loadBoundDevice(userId, sessionId);
      if (!sender) throw notBound();

      const requested = Object.entries(body.messages)
        .map(([e2eeUserId, devices]) => ({ targetId: fromE2eeUserId(e2eeUserId), devices }))
        .filter((entry) => entry.targetId);
      const allowed = await visibleTargets(
        userId,
        requested.map((entry) => entry.targetId),
      );
      const targets = requested.filter((entry) => allowed.has(entry.targetId));
      const registered = targets.length
        ? await E2eeDevice.find(
            {
              $or: targets.map((entry) => ({
                user: entry.targetId,
                deviceId: { $in: Object.keys(entry.devices) },
              })),
            },
            { user: 1, deviceId: 1, curve25519: 1 },
          ).lean()
        : [];
      const recipientKey = new Map(
        registered.map((device) => [`${device.user}|${device.deviceId}`, device.curve25519]),
      );

      const deliveries = [];
      // Olm payloads must come from this device's key, for the addressed device's key. SAS
      // verification messages are plaintext by design (no secrets); they still need the bound
      // sender device and a registered recipient device of someone you may message.
      const olm = body.type === E2EE_TO_DEVICE_EVENT_TYPE;
      for (const entry of targets) {
        for (const [deviceId, content] of Object.entries(entry.devices)) {
          if (olm && content.sender_key !== sender.curve25519) {
            throw new AppError(
              400,
              'SENDER_KEY_MISMATCH',
              "The payload wasn't encrypted by this sign-in's device.",
            );
          }
          const key = recipientKey.get(`${entry.targetId}|${deviceId}`);
          if (!key) continue; // removed or unknown device
          if (olm && Object.keys(content.ciphertext)[0] !== key) {
            throw new AppError(
              400,
              'RECIPIENT_KEY_MISMATCH',
              "A payload isn't encrypted for the device it is addressed to.",
            );
          }
          deliveries.push({ user: entry.targetId, deviceId, content });
        }
      }
      if (deliveries.length === 0) return {};

      // A retried transaction: the copies already stored must be identical.
      const earlier = await E2eeToDeviceEvent.find(
        { sender: userId, senderDevice: sender.deviceId, txnId },
        { user: 1, deviceId: 1, content: 1 },
      ).lean();
      const earlierByDevice = new Map(
        earlier.map((event) => [`${event.user}|${event.deviceId}`, event]),
      );
      for (const delivery of deliveries) {
        const prior = earlierByDevice.get(`${delivery.user}|${delivery.deviceId}`);
        if (prior && !sameKeys(prior.content, delivery.content)) {
          throw new AppError(
            409,
            'TRANSACTION_ID_REUSED',
            'This transaction id was already used for different content.',
          );
        }
      }
      const fresh = deliveries.filter(
        (delivery) => !earlierByDevice.has(`${delivery.user}|${delivery.deviceId}`),
      );

      // Queue caps, checked before anything is stored (soft under concurrency).
      for (const delivery of fresh) {
        const queue = { user: delivery.user, deviceId: delivery.deviceId };
        const [waiting, fromThisSender] = await Promise.all([
          E2eeToDeviceEvent.countDocuments(queue),
          E2eeToDeviceEvent.countDocuments({
            ...queue,
            senderDevice: sender.deviceId,
            sender: userId,
          }),
        ]);
        if (waiting >= config.e2ee.toDeviceQueueMax || fromThisSender >= PER_SENDER_QUEUE_MAX) {
          throw new AppError(
            409,
            'RECIPIENT_QUEUE_FULL',
            'A recipient device has too many undelivered messages. Try again later.',
          );
        }
      }

      const notify = new Set();
      for (const delivery of fresh) {
        const stored = await insertToDevice({
          user: delivery.user,
          deviceId: delivery.deviceId,
          sender: userId,
          senderDevice: sender.deviceId,
          txnId,
          type: body.type,
          content: delivery.content,
        });
        if (stored) notify.add(`${delivery.user}|${delivery.deviceId}`);
      }
      for (const key of notify) {
        const [recipient, deviceId] = key.split('|');
        events.emit('toDevice', { userId: recipient, deviceId });
      }
      return {};
    },

    /**
     * The bound device's queue: deletes what it has processed (everything up to `ackUpTo`),
     * then returns the next events in order, with its one-time key counts. Only the device this
     * session is bound to can read or acknowledge its queue.
     */
    async syncToDevice(userId, sessionId, deviceId, { ackUpTo, limit }) {
      const bound = await loadBoundDevice(userId, sessionId);
      if (!bound || bound.deviceId !== deviceId) throw notBound();
      const queue = { user: userId, deviceId };
      if (ackUpTo > 0) {
        // Floor first, then delete (see insertToDevice): numbering never goes back below it.
        await E2eeDevice.updateOne(queue, { $max: { toDeviceAckedSeq: ackUpTo } });
        await E2eeToDeviceEvent.deleteMany({ ...queue, seq: { $lte: ackUpTo } });
      }
      const [rows, counts] = await Promise.all([
        E2eeToDeviceEvent.find({ ...queue, seq: { $gt: ackUpTo } })
          .sort({ seq: 1 })
          .limit(limit + 1)
          .lean(),
        keyCountsOf(userId, deviceId),
      ]);
      return {
        events: rows.slice(0, limit).map((row) => ({
          seq: row.seq,
          sender: toE2eeUserId(String(row.sender)),
          type: row.type,
          content: row.content,
        })),
        hasMore: rows.length > limit,
        ...counts,
      };
    },

    /** Whether this server allows encrypting conversations (E2EE_ENABLED). */
    status() {
      return { enabled: config.e2ee.enabled };
    },

    /**
     * A conversation's encryption: on or off, and whether you could switch it on now (and why
     * not): the server allows it, it's a direct chat you may message in, this sign-in is bound
     * to a device of yours, and the other person has registered a device.
     */
    async conversationStatus(userId, sessionId, conversationId) {
      const conversation = await loadOwnConversation(userId, conversationId);
      const enabled = Boolean(conversation.e2ee);
      const reason = enabled ? null : await enableBlocker(userId, sessionId, conversation);
      return {
        enabled,
        enabledAt: conversation.e2ee?.enabledAt?.toISOString() ?? null,
        canEnable: !enabled && reason === null,
        reason,
      };
    },

    /**
     * Switches a direct chat to end-to-end encryption (opt-in, either person, never switched
     * back). Idempotent; concurrent requests switch it once. Adds a history line for both.
     */
    async enableConversation(userId, sessionId, conversationId) {
      const conversation = await loadOwnConversation(userId, conversationId);
      if (!conversation.e2ee) {
        const reason = await enableBlocker(userId, sessionId, conversation);
        if (reason) throw enableRefused(reason);
        const switched = await Conversation.updateOne(
          { _id: conversation._id, type: 'direct', e2ee: null },
          { $set: { e2ee: { enabledAt: new Date(), enabledBy: userId } } },
        );
        if (switched.modifiedCount === 1 && messaging) {
          await messaging.postSystemMessage(conversation._id, {
            actor: userId,
            kind: 'e2ee_enabled',
          });
          messaging.notifyChanged(conversation._id, conversation.participants);
        }
      }
      return this.conversationStatus(userId, sessionId, conversationId);
    },

    /** Account deletion: the account's devices and their keys go with it. */
    async removeAllFor(userId) {
      await E2eeDevice.deleteMany({ user: userId });
      await E2eeOneTimeKey.deleteMany({ user: userId });
      await E2eeToDeviceEvent.deleteMany({ $or: [{ user: userId }, { sender: userId }] });
    },
  };
}
