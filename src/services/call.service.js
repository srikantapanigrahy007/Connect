import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ACTIVE_CALL_STATUSES, callStatusMachine } from '#shared';
import mongoose, { isValidObjectId } from 'mongoose';
import { Call } from '../models/call.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { PUBLIC_USER_FIELDS, toUserCard } from './user-dto.js';

const SWEEP_INTERVAL_MS = 15_000;
const SWEEP_BATCH = 200;

const asId = (id) => new mongoose.Types.ObjectId(String(id));
const same = (a, b) => a !== null && a !== undefined && String(a) === String(b);
const isActive = (call) => ACTIVE_CALL_STATUSES.includes(call.status);
const callNotFound = () => new AppError(404, 'NOT_FOUND', 'Call not found.');
const notActive = () =>
  new AppError(409, 'CALL_NOT_ACTIVE', "This call isn't connected on this device.");

/** MongoDB E11000 on an index containing `field`. */
function isDuplicateKeyOn(error, field) {
  return error?.code === 11000 && Object.hasOwn(error.keyPattern ?? {}, field);
}

/** Missed-call notifications: unanswered calls, except ones ended because of a block. */
const notifiesCallee = (call) =>
  (call.status === 'missed' || call.status === 'cancelled') && call.endReason !== 'unavailable';

/**
 * One-to-one calls: the server-authoritative lifecycle and the signaling relay. Media never
 * passes through the server (WebRTC is peer to peer, or relayed by TURN).
 *
 * Who may call whom is exactly who may message whom (messaging.requireSendAccess: conversation
 * membership, a connection, no block either way, reachable accounts); it is checked when the
 * call starts and again when it's answered. Every identity comes from the socket's session.
 *
 * Signaling (offers, answers, ICE candidates, media state) goes only between the two devices
 * bound to an ongoing call: the caller's starting socket and the socket that answered.
 *
 * Domain events (the real-time layer delivers them):
 * - "incoming" { userId, call }  — ring the callee's devices
 * - "updated"  { userId, call }  — the call changed (to each participant's devices)
 * - "signal"   { socketId, payload: { callId, signal } }
 * - "media"    { socketId, payload: { callId, audio, video } }
 * - "resumed"  { socketId, payload: { callId } }
 *
 * @param {{ config: import('../config/app-config.js').AppConfig, messaging: ReturnType<typeof import('./messaging.service.js').createMessagingService>, notifications?: ReturnType<typeof import('./notification.service.js').createNotificationService>, logger: import('../utils/logger.js').Logger }} deps
 */
export function createCallService({ config, messaging, notifications, logger }) {
  const events = new EventEmitter();
  const settings = config.calls;
  /** callId → ring timeout. */
  const ringTimers = new Map();
  /** `${callId}:${socketId}` → reconnection grace timer. */
  const graceTimers = new Map();

  const hasGraceTimer = (callId) =>
    [...graceTimers.keys()].some((key) => key.startsWith(`${callId}:`));

  function clearTimers(callId) {
    const id = String(callId);
    clearTimeout(ringTimers.get(id));
    ringTimers.delete(id);
    for (const [key, timer] of graceTimers) {
      if (key.startsWith(`${id}:`)) {
        clearTimeout(timer);
        graceTimers.delete(key);
      }
    }
  }

  async function toDtos(calls, viewerId) {
    const peerIds = calls.map((call) => (same(call.caller, viewerId) ? call.callee : call.caller));
    const users = await User.find({ _id: { $in: peerIds } }, PUBLIC_USER_FIELDS).lean();
    const byId = new Map(users.map((user) => [String(user._id), user]));
    return calls.map((call, index) => {
      const peerId = String(peerIds[index]);
      return {
        id: String(call._id),
        conversationId: String(call.conversation),
        type: call.type,
        status: call.status,
        direction: same(call.caller, viewerId) ? 'outgoing' : 'incoming',
        callerId: String(call.caller),
        calleeId: String(call.callee),
        peer: toUserCard(byId.get(peerId) ?? { _id: peerId, displayName: 'Deleted user' }),
        createdAt: call.createdAt.toISOString(),
        ringsUntil:
          call.status === 'ringing' && call.ringsUntil ? call.ringsUntil.toISOString() : null,
        answeredAt: call.answeredAt ? call.answeredAt.toISOString() : null,
        endedAt: call.endedAt ? call.endedAt.toISOString() : null,
        durationSeconds: call.durationSeconds ?? null,
        endReason: call.endReason ?? null,
      };
    });
  }

  const toDto = async (call, viewerId) => (await toDtos([call], viewerId))[0];

  /** Sends the call's new state to both participants' devices. */
  async function announce(call) {
    for (const userId of [call.caller, call.callee]) {
      events.emit('updated', { userId: String(userId), call: await toDto(call, userId) });
    }
  }

  /** The call, if `userId` takes part in it; anyone else gets 404 (it doesn't exist for them). */
  async function loadOwn(userId, callId) {
    if (!isValidObjectId(callId)) throw callNotFound();
    const call = await Call.findOne({
      _id: callId,
      $or: [{ caller: asId(userId) }, { callee: asId(userId) }],
    }).lean();
    if (!call) throw callNotFound();
    return call;
  }

  /** History line, notification and live update for a finished call (each failure logged). */
  async function afterFinish(call) {
    await announce(call);
    try {
      await messaging.postSystemMessage(call.conversation, {
        actor: call.caller,
        kind: 'call',
        target: call.callee,
        call: {
          id: call._id,
          type: call.type,
          status: call.status,
          durationSeconds: call.durationSeconds ?? null,
          endReason: call.endReason ?? null,
        },
      });
    } catch (error) {
      logger.warn('Could not record a call in the conversation', { error });
    }
    if (notifiesCallee(call)) await notifications?.callMissed(call);
  }

  /**
   * Moves an active call to a final `status` (compare-and-set: only from a state that may
   * transition there). Returns the call as it is afterwards; if someone else finished or
   * changed it first, that version is returned unchanged.
   */
  async function finish(call, status, reason, endedBy = null) {
    const now = new Date();
    const durationSeconds =
      call.answeredAt && (status === 'completed' || status === 'failed')
        ? Math.max(0, Math.round((now.getTime() - call.answeredAt.getTime()) / 1_000))
        : null;
    const updated = await Call.findOneAndUpdate(
      { _id: call._id, status: { $in: callStatusMachine.sourcesFor(status) } },
      {
        $set: {
          status,
          endedAt: now,
          durationSeconds,
          endReason: reason,
          endedBy: endedBy ? asId(endedBy) : null,
          ringsUntil: null,
          callerSession: null,
          callerSocket: null,
          calleeSession: null,
          calleeSocket: null,
        },
        $unset: { lock: '' },
      },
      { returnDocument: 'after' },
    ).lean();
    if (!updated) return Call.findById(call._id).lean();
    clearTimers(updated._id);
    await afterFinish(updated);
    return updated;
  }

  /** Ends whatever an active call needs ending as: ongoing → completed, ringing → cancelled. */
  const endActive = (call, reason) =>
    finish(call, call.status === 'ongoing' ? 'completed' : 'cancelled', reason);

  function scheduleRingTimeout(call) {
    const id = String(call._id);
    const timer = setTimeout(
      () => {
        ringTimers.delete(id);
        void finish(call, 'missed', 'no_answer').catch((error) => {
          logger.warn('Could not end an unanswered call', { error });
        });
      },
      Math.max(0, call.ringsUntil.getTime() - Date.now()),
    );
    timer.unref?.();
    ringTimers.set(id, timer);
  }

  /** A retried start (same clientCallId): the same call again, or a conflict. */
  async function replay(existing, conversationId, userId) {
    if (!same(existing.conversation, conversationId)) {
      throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This call id was already used.');
    }
    return { call: await toDto(existing, userId), duplicate: true };
  }

  /** The bound device's side of an ongoing call, or a 404 / 409. */
  async function requireBoundDevice(userId, socketId, callId) {
    if (!isValidObjectId(callId)) throw callNotFound();
    const call = await Call.findOne({
      _id: callId,
      status: 'ongoing',
      $or: [
        { caller: asId(userId), callerSocket: socketId },
        { callee: asId(userId), calleeSocket: socketId },
      ],
    }).lean();
    if (call) return call;
    await loadOwn(userId, callId); // 404 for non-participants
    throw notActive();
  }

  const otherSocket = (call, userId) =>
    same(call.caller, userId) ? call.calleeSocket : call.callerSocket;

  return {
    events,

    /**
     * Starts a call in a one-to-one conversation (`device`: the caller's session and socket).
     * - the callee is already in a call: recorded as missed (busy) at once;
     * - the caller is already in a call: 409 ALREADY_IN_CALL;
     * - otherwise it rings the callee's devices until answered, declined, cancelled or the ring
     *   timeout. A callee who is offline isn't told apart from one who doesn't answer.
     */
    async start(userId, device, { conversationId, type, clientCallId }) {
      const existing = await Call.findOne({ caller: asId(userId), clientCallId }).lean();
      if (existing) return replay(existing, conversationId, userId);

      const conversation = await messaging.requireSendAccess(userId, conversationId);
      if (conversation.type === 'group') {
        throw new AppError(400, 'GROUP_CALLS_UNAVAILABLE', "Group calls aren't available.");
      }
      const calleeId = conversation.participants.find((id) => !same(id, userId));
      const now = new Date();
      const fields = {
        conversation: conversation._id,
        caller: asId(userId),
        callee: calleeId,
        type,
        clientCallId,
      };

      let call;
      try {
        call = (
          await Call.create({
            ...fields,
            status: 'ringing',
            lock: [asId(userId), calleeId],
            ringsUntil: new Date(now.getTime() + settings.ringTimeoutMs),
            callerSession: device.sessionId,
            callerSocket: device.socketId,
          })
        ).toObject();
      } catch (error) {
        if (isDuplicateKeyOn(error, 'clientCallId')) {
          const winner = await Call.findOne({ caller: asId(userId), clientCallId }).lean();
          if (winner) return replay(winner, conversationId, userId);
        }
        if (!isDuplicateKeyOn(error, 'lock')) throw error;
        if (await Call.exists({ lock: asId(userId) })) {
          throw new AppError(409, 'ALREADY_IN_CALL', 'You already have a call in progress.');
        }
        call = (
          await Call.create({ ...fields, status: 'missed', endedAt: now, endReason: 'busy' })
        ).toObject();
        await afterFinish(call);
        return { call: await toDto(call, userId), duplicate: false };
      }

      scheduleRingTimeout(call);
      events.emit('incoming', { userId: String(calleeId), call: await toDto(call, calleeId) });
      const own = await toDto(call, userId);
      events.emit('updated', { userId: String(userId), call: own });
      return { call: own, duplicate: false };
    },

    /** The callee answers on this device (permissions are checked again first). */
    async accept(userId, device, callId) {
      const call = await loadOwn(userId, callId);
      if (!same(call.callee, userId)) {
        throw new AppError(403, 'FORBIDDEN', 'Only the person being called can answer.');
      }
      if (call.status !== 'ringing') {
        throw new AppError(409, 'CALL_NOT_RINGING', 'This call is no longer ringing.');
      }
      try {
        await messaging.requireSendAccess(userId, call.conversation);
      } catch (error) {
        await finish(call, 'failed', 'unavailable', userId);
        throw error;
      }
      const updated = await Call.findOneAndUpdate(
        { _id: call._id, callee: asId(userId), status: 'ringing' },
        {
          $set: {
            status: 'ongoing',
            answeredAt: new Date(),
            ringsUntil: null,
            calleeSession: asId(device.sessionId),
            calleeSocket: device.socketId,
          },
        },
        { returnDocument: 'after' },
      ).lean();
      if (!updated) {
        throw new AppError(409, 'CALL_NOT_RINGING', 'This call is no longer ringing.');
      }
      clearTimers(updated._id);
      await announce(updated);
      return { call: await toDto(updated, userId) };
    },

    /** The callee declines a ringing call. Declining again returns the same result. */
    async decline(userId, callId) {
      const call = await loadOwn(userId, callId);
      if (!same(call.callee, userId)) {
        throw new AppError(403, 'FORBIDDEN', 'Only the person being called can decline.');
      }
      const done =
        call.status === 'ringing' ? await finish(call, 'declined', 'declined', userId) : call;
      if (done.status !== 'declined') {
        throw new AppError(409, 'CALL_NOT_RINGING', 'This call is no longer ringing.');
      }
      return { call: await toDto(done, userId) };
    },

    /**
     * Hangs up: an ongoing call is completed (or failed, when the client reports that the media
     * connection failed); a ringing one is cancelled (by the caller) or declined (by the callee).
     * Ending a finished call returns it unchanged.
     */
    async end(userId, callId, reason) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const call = await loadOwn(userId, callId);
        if (!isActive(call)) return { call: await toDto(call, userId) };
        const [status, endReason] =
          call.status === 'ongoing'
            ? reason === 'media_failed'
              ? ['failed', 'media_failed']
              : ['completed', 'hangup']
            : same(call.caller, userId)
              ? ['cancelled', 'cancelled']
              : ['declined', 'declined'];
        const done = await finish(call, status, endReason, userId);
        if (!isActive(done)) return { call: await toDto(done, userId) };
        // It was answered at the same moment: try again with its new state.
      }
      throw new AppError(409, 'CONFLICT', 'The call changed. Please try again.');
    },

    /** Your active call, if any (to restore the call screen after a reload or reconnect). */
    async active(userId) {
      const call = await Call.findOne({ lock: asId(userId) }).lean();
      return { call: call ? await toDto(call, userId) : null };
    },

    /**
     * This device (same session as the one that started or answered the call) reconnected with
     * a new socket and takes the call over; the other device is told to restart ICE.
     */
    async resume(userId, device, callId) {
      const call = await loadOwn(userId, callId);
      if (!isActive(call)) throw notActive();
      const side = same(call.caller, userId) ? 'caller' : 'callee';
      const bound = call[`${side}Session`];
      if (!bound || !same(bound, device.sessionId)) throw notActive();
      const updated = await Call.findOneAndUpdate(
        {
          _id: call._id,
          status: { $in: ACTIVE_CALL_STATUSES },
          [`${side}Session`]: asId(device.sessionId),
        },
        { $set: { [`${side}Socket`]: device.socketId } },
        { returnDocument: 'after' },
      ).lean();
      if (!updated) throw notActive();
      for (const [key, timer] of graceTimers) {
        if (key.startsWith(`${updated._id}:`)) {
          clearTimeout(timer);
          graceTimers.delete(key);
        }
      }
      const other = otherSocket(updated, userId);
      if (updated.status === 'ongoing' && other) {
        events.emit('resumed', { socketId: other, payload: { callId: String(updated._id) } });
      }
      return { call: await toDto(updated, userId) };
    },

    /** Relays an offer, answer or ICE candidate to the other device of an ongoing call. */
    async signal(userId, socketId, callId, signal) {
      const call = await requireBoundDevice(userId, socketId, callId);
      const target = otherSocket(call, userId);
      if (!target) throw notActive();
      events.emit('signal', { socketId: target, payload: { callId: String(call._id), signal } });
      return null;
    },

    /** Relays microphone / camera state; turning a camera on makes it a video call. */
    async media(userId, socketId, callId, { audio, video }) {
      const call = await requireBoundDevice(userId, socketId, callId);
      if (video && call.type === 'audio') {
        await Call.updateOne({ _id: call._id, status: 'ongoing' }, { $set: { type: 'video' } });
      }
      const target = otherSocket(call, userId);
      if (target) {
        events.emit('media', {
          socketId: target,
          payload: { callId: String(call._id), audio, video },
        });
      }
      return null;
    },

    /**
     * A socket closed. Calls bound to it get a grace period to resume (network change, reload);
     * after that an ongoing call ends (connection lost) and a ringing one is cancelled.
     */
    async socketDisconnected(socketId) {
      const calls = await Call.find(
        {
          status: { $in: ACTIVE_CALL_STATUSES },
          $or: [{ callerSocket: socketId }, { calleeSocket: socketId }],
        },
        { _id: 1 },
      ).lean();
      for (const { _id } of calls) {
        const key = `${_id}:${socketId}`;
        clearTimeout(graceTimers.get(key));
        const timer = setTimeout(() => {
          graceTimers.delete(key);
          void (async () => {
            const call = await Call.findOne({
              _id,
              status: { $in: ACTIVE_CALL_STATUSES },
              $or: [{ callerSocket: socketId }, { calleeSocket: socketId }],
            }).lean();
            if (call) await endActive(call, 'connection_lost');
          })().catch((error) => logger.warn('Could not end a disconnected call', { error }));
        }, settings.reconnectGraceMs);
        timer.unref?.();
        graceTimers.set(key, timer);
      }
    },

    /** Sessions were revoked (sign-out, password change, suspension): their calls end now. */
    async sessionsRevoked(sessionIds) {
      const ids = sessionIds.filter(isValidObjectId).map(asId);
      if (ids.length === 0) return;
      const calls = await Call.find({
        status: { $in: ACTIVE_CALL_STATUSES },
        $or: [{ callerSession: { $in: ids } }, { calleeSession: { $in: ids } }],
      }).lean();
      for (const call of calls) await endActive(call, 'session_ended');
    },

    /** A block between two people ends any call between them (without a missed-call alert). */
    async pairBlocked(a, b) {
      const calls = await Call.find({
        status: { $in: ACTIVE_CALL_STATUSES },
        lock: { $all: [asId(a), asId(b)] },
      }).lean();
      for (const call of calls) await endActive(call, 'unavailable');
    },

    /**
     * Ends abandoned calls: unanswered past their ring time (also after a restart, when timers
     * were lost), ringing or ongoing calls whose device is gone (past the grace period), and
     * calls longer than the maximum duration.
     *
     * @param {(socketId: string) => boolean} isSocketConnected
     */
    async sweep(isSocketConnected) {
      const now = Date.now();
      const unanswered = await Call.find({ status: 'ringing', ringsUntil: { $lte: new Date(now) } })
        .limit(SWEEP_BATCH)
        .lean();
      for (const call of unanswered) await finish(call, 'missed', 'no_answer');

      const active = await Call.find({ status: { $in: ACTIVE_CALL_STATUSES } })
        .limit(SWEEP_BATCH)
        .lean();
      for (const call of active) {
        const since = (call.answeredAt ?? call.createdAt).getTime();
        const stale = now - call.updatedAt.getTime() > settings.reconnectGraceMs;
        const gone = [call.callerSocket, call.calleeSocket].some(
          (socketId) => socketId && !isSocketConnected(socketId),
        );
        if (now - since > settings.maxDurationMs) await endActive(call, 'connection_lost');
        else if (gone && stale && !hasGraceTimer(call._id)) {
          await endActive(call, 'connection_lost');
        }
      }
    },

    /** Runs the sweep periodically. @returns {() => void} Stops it (and every timer). */
    startSweeper(isSocketConnected) {
      const interval = setInterval(() => {
        this.sweep(isSocketConnected).catch((error) => {
          logger.warn('Call sweep failed', { error });
        });
      }, SWEEP_INTERVAL_MS);
      interval.unref?.();
      return () => {
        clearInterval(interval);
        for (const timer of [...ringTimers.values(), ...graceTimers.values()]) clearTimeout(timer);
        ringTimers.clear();
        graceTimers.clear();
      };
    },

    // ── HTTP ──────────────────────────────────────────────────────────────

    /** Your calls (either side), newest first. */
    async list(userId, { cursor, limit }) {
      if (cursor && !isValidObjectId(cursor)) throw AppError.badRequest('Invalid cursor');
      const rows = await Call.find({
        $or: [{ caller: asId(userId) }, { callee: asId(userId) }],
        ...(cursor ? { _id: { $lt: asId(cursor) } } : {}),
      })
        .sort({ _id: -1 })
        .limit(limit + 1)
        .lean();
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return {
        data: await toDtos(page, userId),
        meta: { limit, hasMore, nextCursor: hasMore ? String(page.at(-1)._id) : null },
      };
    },

    async get(userId, callId) {
      return toDto(await loadOwn(userId, callId), userId);
    },

    /**
     * STUN/TURN servers for this user. TURN credentials follow the TURN REST API scheme
     * (coturn "use-auth-secret"): username "<expiry>:<userId>", password HMAC-SHA1 of it with
     * the shared secret, valid until the expiry. The secret itself never leaves the server.
     *
     * TURN is only handed out while you have a call ringing or in progress, so an account can't
     * use the relay (and its bandwidth) for anything else. STUN is always included.
     */
    async iceServers(userId) {
      const iceServers = [];
      if (settings.stunUrls.length > 0) iceServers.push({ urls: settings.stunUrls });
      const turn =
        settings.turnUrls.length > 0 &&
        settings.turnSecret &&
        Boolean(await Call.exists({ lock: asId(userId) }));
      if (turn) {
        const expires = Math.floor(Date.now() / 1_000) + settings.turnCredentialTtlSeconds;
        const username = `${expires}:${userId}`;
        const credential = createHmac('sha1', settings.turnSecret)
          .update(username)
          .digest('base64');
        iceServers.push({ urls: settings.turnUrls, username, credential });
      }
      return { iceServers, ttlSeconds: turn ? settings.turnCredentialTtlSeconds : null };
    },
  };
}
