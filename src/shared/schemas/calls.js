import { z } from 'zod';
import { CALL_END_REASONS, CALL_STATUSES, CALL_TYPES } from '../domain/enums.js';
import { cursorPaginationQuerySchema, objectIdSchema } from './api.js';
import { userCardSchema } from './profile.js';

/** An unanswered call stops ringing (and counts as missed) after this long by default. */
export const CALL_RING_TIMEOUT_MS = 45_000;

/** Largest SDP accepted from a client (an audio + video offer is a few kilobytes). */
const SDP_MAX_LENGTH = 30_000;

const callRef = { callId: objectIdSchema };

/** C→S call:start. `clientCallId` makes a retried start return the same call. */
export const socketCallStartSchema = z
  .object({
    conversationId: objectIdSchema,
    type: z.enum(CALL_TYPES),
    clientCallId: z.uuid('Invalid call id'),
  })
  .strict();

/** C→S call:accept, call:decline, call:resume. */
export const socketCallRefSchema = z.object(callRef).strict();

/**
 * C→S call:end. `reason: "media_failed"` reports that the connection between the two devices
 * couldn't be established or recovered (the call is recorded as failed, not completed).
 */
export const socketCallEndSchema = z
  .object({ ...callRef, reason: z.enum(['media_failed']).optional() })
  .strict();

const sessionDescriptionSchema = z
  .object({ type: z.enum(['offer', 'answer']), sdp: z.string().min(1).max(SDP_MAX_LENGTH) })
  .strict();

const iceCandidateSchema = z
  .object({
    candidate: z.string().max(2_000),
    sdpMid: z.string().max(64).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional(),
  })
  .strict();

/**
 * WebRTC signaling, relayed only between the two bound devices of an ongoing call:
 * a session description (offer or answer; either side may renegotiate), or an ICE candidate
 * (null = no more candidates).
 */
export const callSignalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('description'), description: sessionDescriptionSchema }).strict(),
  z.object({ kind: z.literal('candidate'), candidate: iceCandidateSchema.nullable() }).strict(),
]);

export const socketCallSignalSchema = z.object({ ...callRef, signal: callSignalSchema }).strict();

/** C→S call:media: your microphone / camera state, shown to the other person. */
export const socketCallMediaSchema = z
  .object({ ...callRef, audio: z.boolean(), video: z.boolean() })
  .strict();

/** C→S call:active: no payload. */
export const socketCallActiveSchema = z.object({}).strict();

/** A call as one of its two participants sees it. */
export const callSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  type: z.enum(CALL_TYPES),
  status: z.enum(CALL_STATUSES),
  /** From the viewer's side. */
  direction: z.enum(['outgoing', 'incoming']),
  callerId: z.string(),
  calleeId: z.string(),
  /** The other participant. */
  peer: userCardSchema,
  createdAt: z.iso.datetime(),
  /** Until when an unanswered call rings. */
  ringsUntil: z.iso.datetime().nullable(),
  answeredAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
  durationSeconds: z.number().int().min(0).nullable(),
  endReason: z.enum(CALL_END_REASONS).nullable(),
});

/** GET /calls: your own calls, newest first. */
export const callListQuerySchema = cursorPaginationQuerySchema;

/** GET /calls/ice-servers: STUN/TURN servers for RTCPeerConnection (TURN credentials expire). */
export const iceServersSchema = z.object({
  iceServers: z.array(
    z.object({
      urls: z.array(z.string()),
      username: z.string().optional(),
      credential: z.string().optional(),
    }),
  ),
  /** Seconds the TURN credentials stay valid (null without TURN). */
  ttlSeconds: z.number().int().positive().nullable(),
});

/**
 * Call events. Client → server events take an acknowledgment ({ ok, data } / { ok, error }).
 * The server decides every recipient: participants only, signaling only between the two
 * devices taking part.
 */
export const CALL_SOCKET_EVENTS = {
  /** C→S: start a call: { conversationId, type, clientCallId } → { call }. */
  start: 'call:start',
  /** C→S (callee): answer on this device → { call }. */
  accept: 'call:accept',
  /** C→S (callee): decline → { call }. */
  decline: 'call:decline',
  /** C→S (either): hang up, cancel or decline, whichever applies → { call }. */
  end: 'call:end',
  /** C→S: your current call, if any (after a reload or reconnect) → { call | null }. */
  active: 'call:active',
  /** C→S: this device took over the call after reconnecting → { call }. */
  resume: 'call:resume',
  /** C→S and S→C: offer, answer or ICE candidate: { callId, signal }. */
  signal: 'call:signal',
  /** C→S and S→C: microphone / camera state: { callId, audio, video }. */
  media: 'call:media',
  /** S→C (callee's devices): a call is ringing: { call }. */
  incoming: 'call:incoming',
  /** S→C (both people's devices): the call changed (answered, ended, …): { call }. */
  updated: 'call:updated',
  /** S→C (the other device): the peer reconnected; restart ICE: { callId }. */
  resumed: 'call:resumed',
};
