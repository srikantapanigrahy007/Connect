import { z } from 'zod';
import { ENCRYPTION_SCHEMES } from '../domain/enums.js';
import { LIMITS } from '../domain/limits.js';
import { ATTACHMENT_KINDS, REACTION_EMOJI, STICKER_IDS } from '../domain/message-actions.js';
import { cursorPaginationQuerySchema, objectIdSchema } from './api.js';
import { e2eeMegolmContentSchema } from './e2ee.js';
import { groupSchema, pollInputSchema, pollSchema } from './groups.js';
import { userCardSchema } from './profile.js';

/*
 * One-to-one messaging contracts (Phase 6), shared by the API, the web app and future clients.
 *
 * Ordering: every message has a per-conversation sequence number `seq` (1, 2, 3, …) assigned by
 * the server when the message is stored. A message with seq N only becomes visible after N - 1
 * is visible, so "everything after seq N" never skips a message (see the README).
 *
 * Receipts are positions, not per-message flags: each participant has `lastDeliveredSeq` and
 * `lastReadSeq`. A message sent to you is delivered once your lastDeliveredSeq >= its seq, and
 * read once your lastReadSeq >= its seq.
 */

/** Client-generated idempotency key: one per message, reused for every retry of that message. */
export const clientMessageIdSchema = z.uuid('Invalid message id');

/** Text only. Leading/trailing whitespace is removed; empty messages are rejected. */
export const messageTextSchema = z
  .string()
  .trim()
  .min(1, 'Messages cannot be empty')
  .max(
    LIMITS.messageTextMaxLength,
    `Messages are at most ${LIMITS.messageTextMaxLength} characters`,
  );

/** A position in a conversation (0 = before the first message). */
export const messageSeqSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

// ── Requests ────────────────────────────────────────────────────────────────

/** POST /conversations: open (or create) the one-to-one conversation with a person. */
export const openConversationSchema = z.object({ userId: objectIdSchema }).strict();

/**
 * POST /conversations/:id/messages. Strict: a `senderId` or any unknown field is rejected; the
 * sender is always the signed-in user. Exactly one kind of content:
 * - `text` (a text message);
 * - `attachmentId` (an attachment you uploaded to this conversation), with optional `text` caption;
 * - `sticker` (an id from STICKERS);
 * - `forwardOfId` (a message you can see, copied with its text/attachment/sticker).
 * `replyToId` (a message in the same conversation) may accompany text, attachment or sticker.
 *
 * End-to-end encrypted conversations take `encrypted` (a Megolm payload) instead of readable
 * text. Media there is sent as a plain `attachmentId` without text (media is not end-to-end
 * encrypted; captions go in a separate encrypted message).
 */
export const sendMessageSchema = z
  .object({
    clientMessageId: clientMessageIdSchema,
    text: messageTextSchema.optional(),
    attachmentId: objectIdSchema.optional(),
    sticker: z.enum(STICKER_IDS).optional(),
    replyToId: objectIdSchema.optional(),
    forwardOfId: objectIdSchema.optional(),
    /** A poll (groups only). */
    poll: pollInputSchema.optional(),
    /** End-to-end encrypted conversations: the encrypted message (text, file key, …). */
    encrypted: e2eeMegolmContentSchema.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const sources = [input.attachmentId, input.sticker, input.forwardOfId, input.poll].filter(
      Boolean,
    ).length;
    if (sources > 1) {
      ctx.addIssue({ code: 'custom', path: ['attachmentId'], message: 'Send one kind of content' });
    }
    if (input.encrypted) {
      if (
        input.text !== undefined ||
        input.attachmentId ||
        input.sticker ||
        input.forwardOfId ||
        input.poll
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['encrypted'],
          message: 'Encrypted messages carry no readable content',
        });
      }
      return;
    }
    if (sources === 0 && input.text === undefined) {
      ctx.addIssue({ code: 'custom', path: ['text'], message: 'Messages cannot be empty' });
    }
    if ((input.sticker || input.forwardOfId || input.poll) && input.text !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['text'], message: 'This message cannot have text' });
    }
    if (input.forwardOfId && input.replyToId) {
      ctx.addIssue({ code: 'custom', path: ['replyToId'], message: 'Forwards cannot be replies' });
    }
  });

/** PATCH /conversations/:id/messages/:messageId: new text for your own text message. */
export const editMessageSchema = z.union([
  z.object({ text: messageTextSchema }).strict(),
  /** End-to-end encrypted messages: the new encrypted content. */
  z.object({ encrypted: e2eeMegolmContentSchema }).strict(),
]);

/** PUT /conversations/:id/messages/:messageId/reaction */
export const reactionSchema = z.object({ emoji: z.enum(REACTION_EMOJI) }).strict();

/** DELETE /conversations/:id/messages/:messageId?scope=me|everyone */
export const deleteMessageQuerySchema = z.object({ scope: z.enum(['me', 'everyone']) });

/** POST /conversations/:id/attachments (multipart): file field `file`, optional field `kind`. */
export const attachmentUploadFieldsSchema = z
  .object({ kind: z.enum(['voice']).optional() })
  .strict();

/**
 * Chat-list views. "all" is your main list (not archived, pinned first); "unread" and
 * "favorites" narrow it; "archived" shows only archived chats.
 */
export const CONVERSATION_FILTERS = ['all', 'unread', 'favorites', 'archived'];

/** At most this many pinned conversations per person. */
export const CONVERSATION_PIN_LIMIT = 5;

/** Mute for 8 hours, a week, or until unmuted; "off" unmutes. */
export const MUTE_DURATIONS = ['8h', '1w', 'always', 'off'];

/** GET /conversations: newest activity first, optionally filtered and searched (`q`). */
export const conversationListQuerySchema = cursorPaginationQuerySchema.extend({
  filter: z.enum(CONVERSATION_FILTERS).default('all'),
  /** Username or display name of the other person ("@ada" works too). */
  q: z
    .string()
    .trim()
    .transform((value) => value.replace(/^@/, ''))
    .pipe(z.string().max(50, 'Search for at most 50 characters'))
    .optional()
    .transform((value) => value || undefined),
});

/**
 * PATCH /conversations/:id/preferences: your own chat settings (send only what changes). Strict,
 * so nobody can address the other participant's settings.
 */
export const conversationPreferencesSchema = z
  .object({
    pinned: z.boolean().optional(),
    favorite: z.boolean().optional(),
    archived: z.boolean().optional(),
    markedUnread: z.boolean().optional(),
    muted: z.enum(MUTE_DURATIONS).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

/**
 * GET /conversations/:id/messages. Without a cursor: the newest page. `cursor` (from
 * meta.nextCursor) loads older messages; `after` returns messages after a seq (synchronisation).
 */
export const messageHistoryQuerySchema = cursorPaginationQuerySchema
  .extend({
    cursor: z
      .string()
      .regex(/^[1-9]\d{0,15}$/, 'Invalid cursor')
      .optional(),
    after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .refine((query) => !(query.cursor && query.after !== undefined), {
    message: 'Use either cursor or after, not both',
    path: ['after'],
  });

// ── Socket.IO payloads (client → server) ────────────────────────────────────

const conversationRef = { conversationId: objectIdSchema };

/** message:send: the send payload plus `conversationId`. Parses to { conversationId, message }. */
export const socketSendMessageSchema = z
  .looseObject(conversationRef)
  .transform(({ conversationId, ...message }) => ({ conversationId, message }))
  .pipe(z.object({ conversationId: objectIdSchema, message: sendMessageSchema }));

/** message:delivered / message:read: "I have received (or read) everything up to `seq`". */
export const socketReceiptSchema = z.object({ ...conversationRef, seq: messageSeqSchema }).strict();

export const socketTypingSchema = z.object(conversationRef).strict();

export const socketSyncSchema = z
  .object({
    ...conversationRef,
    afterSeq: messageSeqSchema,
    limit: z.number().int().min(1).max(LIMITS.pageSizeMax).optional(),
    /** Also return known messages that changed since this server time (a previous serverTime). */
    changesSince: z.iso.datetime().optional(),
  })
  .strict();

// ── Responses ───────────────────────────────────────────────────────────────

/** An attachment as a participant sees it. `url` streams it after an access check. */
export const attachmentSchema = z.object({
  id: z.string(),
  kind: z.enum(ATTACHMENT_KINDS),
  contentType: z.string(),
  /** Display name only (sanitised); never used as a storage path. */
  name: z.string(),
  size: z.number().int().min(0),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  url: z.string(),
});

/**
 * What a reply shows of the message it answers. Kinds "deleted" (deleted for everyone) and
 * "unavailable" (hidden for you, or missing) carry no content.
 */
export const replyPreviewSchema = z.object({
  id: z.string(),
  senderId: z.string().nullable(),
  /** "encrypted": end-to-end encrypted; clients show it from their own decrypted copy. */
  kind: z.enum(['text', 'attachment', 'sticker', 'deleted', 'unavailable', 'encrypted']),
  preview: z.string(),
});

export const reactionEntrySchema = z.object({ userId: z.string(), emoji: z.string() });

/**
 * A stored message. `rev` increases with every shared change (edit, delete, reaction), so clients
 * keep the newest version whatever order updates arrive in. `starred` and `hidden` are the
 * viewer's private flags (absent from real-time updates, which go to both people). Hidden and
 * deleted messages carry no content.
 */
export const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  seq: z.number().int().positive(),
  clientMessageId: z.string(),
  senderId: z.string(),
  /** "system" lines record group events (created, member added, …); "poll" carries a poll. */
  type: z.enum(['text', 'attachment', 'sticker', 'poll', 'system']),
  text: z.string(),
  /** "e2ee_v1": the content is `encrypted` (Megolm); `text` is empty and the server can't read it. */
  encryption: z.enum(ENCRYPTION_SCHEMES).default('none'),
  encrypted: e2eeMegolmContentSchema.nullable().default(null),
  attachment: attachmentSchema.nullable(),
  sticker: z.string().nullable(),
  poll: pollSchema.nullable().optional(),
  system: z
    .object({
      kind: z.string(),
      actorId: z.string(),
      targetId: z.string().nullable(),
      name: z.string().nullable(),
      /** kind "call": the call this line records (no media, no content). */
      call: z
        .object({
          id: z.string(),
          type: z.enum(['audio', 'video']),
          status: z.string(),
          durationSeconds: z.number().int().min(0).nullable(),
          endReason: z.string().nullable(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  replyTo: replyPreviewSchema.nullable(),
  forwarded: z.boolean(),
  editedAt: z.iso.datetime().nullable(),
  deletedAt: z.iso.datetime().nullable(),
  reactions: z.array(reactionEntrySchema),
  rev: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  starred: z.boolean().optional(),
  hidden: z.boolean().optional(),
});

export const conversationPreferencesDtoSchema = z.object({
  pinned: z.boolean(),
  favorite: z.boolean(),
  archived: z.boolean(),
  markedUnread: z.boolean(),
  /** Null when not muted. */
  mutedUntil: z.iso.datetime().nullable(),
});

export const pinnedMessageSchema = z.object({
  messageId: z.string(),
  seq: z.number().int().positive(),
  senderId: z.string(),
  preview: z.string(),
  pinnedBy: z.string(),
  pinnedAt: z.iso.datetime(),
});

/** Your private flags on a message (message:state event, star / delete-for-me responses). */
export const messageStateSchema = z.object({
  conversationId: z.string(),
  messageId: z.string(),
  starred: z.boolean(),
  hidden: z.boolean(),
});

export const presenceSchema = z.object({
  /** Null when the person's privacy settings hide it from you. */
  online: z.boolean().nullable(),
  lastSeenAt: z.iso.datetime().nullable(),
});

/**
 * Why you can't send messages in a conversation right now (null when you can):
 * - blocked_by_you: unblock them first;
 * - not_connected: you are no longer connected (accept or send a message request);
 * - unavailable: the other person can't receive messages (never says why, so blocks stay hidden).
 */
export const MESSAGING_UNAVAILABLE_REASONS = ['blocked_by_you', 'not_connected', 'unavailable'];

export const conversationSchema = z.object({
  id: z.string(),
  type: z.enum(['direct', 'group']),
  /** The other participant. */
  peer: userCardSchema.extend({ presence: presenceSchema }).nullable(),
  /** Groups: name, photo, member count and your role (null for one-to-one chats). */
  group: groupSchema
    .pick({
      name: true,
      description: true,
      avatarUrl: true,
      memberCount: true,
      myRole: true,
      suspended: true,
    })
    .nullable(),
  lastMessage: z
    .object({
      id: z.string(),
      seq: z.number().int().positive(),
      senderId: z.string(),
      /** The start of the text (at most 200 characters). */
      preview: z.string(),
      createdAt: z.iso.datetime(),
    })
    .nullable(),
  lastActivityAt: z.iso.datetime(),
  /** Messages from the other person after your read position. */
  unreadCount: z.number().int().min(0),
  /** Your own positions. */
  receipts: z.object({ lastDeliveredSeq: messageSeqSchema, lastReadSeq: messageSeqSchema }),
  /**
   * The other person's positions for your messages. lastReadSeq is null when either of you has
   * read receipts turned off.
   */
  peerReceipts: z.object({
    lastDeliveredSeq: messageSeqSchema,
    lastReadSeq: messageSeqSchema.nullable(),
  }),
  /** Your own chat settings; the other person's are never included. */
  preferences: conversationPreferencesDtoSchema,
  /** Pinned messages, oldest pin first (at most PINNED_MESSAGES_LIMIT). */
  pins: z.array(pinnedMessageSchema),
  /** Server-enforced action rules, so clients only offer what will succeed (0 = disabled). */
  rules: z.object({
    editWindowSeconds: z.number().int().min(0),
    deleteWindowSeconds: z.number().int().min(0),
    pinLimit: z.number().int().positive(),
  }),
  canMessage: z.boolean(),
  messagingUnavailableReason: z.enum(MESSAGING_UNAVAILABLE_REASONS).nullable(),
  /**
   * Direct chats switched to end-to-end encryption (never switched back): only encrypted
   * messages are accepted from then on. Null otherwise.
   */
  e2ee: z.object({ enabledAt: z.iso.datetime() }).nullable().default(null),
  createdAt: z.iso.datetime(),
});

/** POST /conversations/:id/messages and the message:send acknowledgment. */
export const sentMessageSchema = z.object({
  message: messageSchema,
  /** True when this was a retry of a message that had already been stored. */
  duplicate: z.boolean(),
});

/** conversation:sync acknowledgment. */
export const syncResultSchema = z.object({
  messages: z.array(messageSchema),
  /** More messages exist after the last one returned: call again with its seq. */
  hasMore: z.boolean(),
  conversation: conversationSchema,
  /** With changesSince: already-stored messages that changed since then. */
  changes: z.array(messageSchema),
  /** Pass as changesSince next time. */
  serverTime: z.iso.datetime(),
});

// ── Socket.IO event names ───────────────────────────────────────────────────

/**
 * Every messaging event. All client → server events take an acknowledgment callback that
 * receives `{ ok: true, data }` or `{ ok: false, error: { code, message, details? } }`.
 */
export const MESSAGING_SOCKET_EVENTS = {
  /** C→S: send a text message. The acknowledgment is the "message:ack" result. */
  send: 'message:send',
  /** S→C: a stored message, to both participants. */
  created: 'message:created',
  /** Name of the acknowledgment for message:send (delivered through the Socket.IO callback). */
  ack: 'message:ack',
  /** C→S: record delivery up to a seq. S→C: someone's delivery position changed. */
  delivered: 'message:delivered',
  /** C→S: record reading up to a seq. S→C: someone's read position changed. */
  read: 'message:read',
  /** C→S and S→C: typing started (ephemeral, never stored). */
  typingStart: 'typing:start',
  /** C→S and S→C: typing stopped. */
  typingStop: 'typing:stop',
  /** S→C: a conversation peer came online or went offline (as their privacy allows). */
  presence: 'presence:update',
  /** C→S: fetch messages after a seq (after reconnecting). */
  sync: 'conversation:sync',
  /** S→C: a message was edited, deleted for everyone or reacted to: { message }. */
  updated: 'message:updated',
  /** S→C (your own tabs only): your star / delete-for-me flags changed. */
  state: 'message:state',
  /** S→C: the pinned messages of a conversation changed: { conversationId, pins }. */
  pins: 'conversation:pins',
  /** S→C (your own tabs only): your chat settings changed: { conversationId, preferences, removed }. */
  preferences: 'conversation:preferences',
  /**
   * S→C: who may do what in a conversation changed (block, unblock): { conversationId }. Fetch
   * the conversation again; the reason is never included.
   */
  changed: 'conversation:changed',
  /** S→C: a poll's results changed: { conversationId, messageId, poll } (no personal votes). */
  pollUpdated: 'poll:updated',
};

/** Typing indicators expire after this long without a new typing:start. */
export const TYPING_TIMEOUT_MS = 8_000;
