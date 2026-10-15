import { STICKERS } from '#shared';
import { Attachment } from '../models/attachment.model.js';
import { MessageFlag } from '../models/message-flag.model.js';
import { Poll, PollVote } from '../models/poll.model.js';
import { Message } from '../models/message.model.js';
import { toAttachmentDto } from './attachment.service.js';

const PREVIEW_LENGTH = 200;
const REPLY_PREVIEW_LENGTH = 120;
const KIND_LABELS = {
  image: 'Photo',
  video: 'Video',
  audio: 'Audio',
  voice: 'Voice message',
  document: 'Document',
};

const stickerLabel = (id) => STICKERS.find((sticker) => sticker.id === id)?.label ?? 'Sticker';

const SYSTEM_TEXT = {
  conversation_created: (name) => `Group "${name}" created`,
  group_renamed: (name) => `Group renamed to "${name}"`,
  member_added: () => 'New member added',
  member_joined: () => 'A member joined with an invitation',
  member_removed: () => 'A member was removed',
  member_left: () => 'A member left',
  owner_changed: () => 'The group has a new owner',
  e2ee_enabled: () => 'Messages are now end-to-end encrypted',
};

const CALL_STATUS_TEXT = {
  missed: 'Missed',
  cancelled: 'Missed',
  declined: 'Declined',
  failed: 'Failed',
};

/** "Video call · 2:05", "Missed audio call" (neutral: both people see the same preview). */
function callPreview(call) {
  const kind = call?.type === 'video' ? 'video call' : 'audio call';
  const label = CALL_STATUS_TEXT[call?.status];
  if (label) return `${label} ${kind}`;
  const seconds = call?.durationSeconds ?? 0;
  const length = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return `${kind[0].toUpperCase()}${kind.slice(1)} · ${length}`;
}

/** A neutral description of a group event (names are resolved by clients). */
export function systemPreview(system) {
  if (system?.kind === 'call') return callPreview(system.call);
  return (SYSTEM_TEXT[system?.kind] ?? (() => 'Group updated'))(system?.name ?? '');
}

/** Short text describing a message (conversation list, pins, replies). Never HTML. */
export function previewOf(message, attachment, length = PREVIEW_LENGTH) {
  if (message.deletedAt) return 'This message was deleted';
  if (message.type === 'system') return systemPreview(message.system);
  // The server can't read it: never a preview of its content.
  if (message.encryption === 'e2ee_v1') return 'Encrypted message';
  if (message.type === 'poll') return `Poll: ${message.text}`.slice(0, length);
  if (message.type === 'sticker') return `Sticker: ${stickerLabel(message.sticker)}`;
  if (message.type === 'attachment') {
    const label = attachment
      ? `${KIND_LABELS[attachment.kind] ?? 'Attachment'}${
          attachment.kind === 'document' ? `: ${attachment.originalName}` : ''
        }`
      : 'Attachment';
    return (message.text ? `${label} · ${message.text}` : label).slice(0, length);
  }
  return message.text.slice(0, length);
}

/**
 * Converts stored messages into DTOs (messageSchema). With `viewerId`, adds that person's
 * private flags and strips the content of messages they deleted for themselves. Deleted
 * messages never carry content. Uses a fixed number of queries for any number of messages.
 *
 * @param {object[]} messages Lean message documents.
 * @param {string | null} [viewerId]
 */
export async function buildMessageDtos(messages, viewerId = null) {
  if (messages.length === 0) return [];
  const replyIds = messages.map((message) => message.replyTo).filter(Boolean);
  const replies = replyIds.length ? await Message.find({ _id: { $in: replyIds } }).lean() : [];
  const attachmentIds = [...messages, ...replies]
    .map((message) => message.attachment)
    .filter(Boolean);
  const pollIds = messages.filter((m) => m.type === 'poll' && m.poll).map((m) => m.poll);
  const [attachments, flags, polls] = await Promise.all([
    attachmentIds.length ? Attachment.find({ _id: { $in: attachmentIds } }).lean() : [],
    viewerId
      ? MessageFlag.find({
          user: viewerId,
          message: { $in: [...messages.map((m) => m._id), ...replyIds] },
        }).lean()
      : [],
    loadPolls(pollIds, viewerId),
  ]);
  const attachmentById = new Map(attachments.map((a) => [String(a._id), a]));
  const replyById = new Map(replies.map((reply) => [String(reply._id), reply]));
  const flagByMessage = new Map(flags.map((flag) => [String(flag.message), flag]));

  const replyPreview = (message) => {
    if (!message.replyTo) return null;
    const id = String(message.replyTo);
    const target = replyById.get(id);
    if (!target || flagByMessage.get(id)?.hiddenAt) {
      return { id, senderId: null, kind: 'unavailable', preview: 'Message unavailable' };
    }
    if (target.deletedAt) {
      return {
        id,
        senderId: String(target.sender),
        kind: 'deleted',
        preview: 'This message was deleted',
      };
    }
    return {
      id,
      senderId: String(target.sender),
      kind: target.encryption === 'e2ee_v1' ? 'encrypted' : target.type,
      preview: previewOf(
        target,
        target.attachment ? attachmentById.get(String(target.attachment)) : null,
        REPLY_PREVIEW_LENGTH,
      ),
    };
  };

  return messages.map((message) => {
    const flag = flagByMessage.get(String(message._id));
    const hidden = Boolean(flag?.hiddenAt);
    const withContent = !message.deletedAt && !hidden;
    const attachment =
      withContent && message.attachment ? attachmentById.get(String(message.attachment)) : null;
    return {
      id: String(message._id),
      conversationId: String(message.conversation),
      seq: message.seq,
      clientMessageId: message.clientMessageId,
      senderId: String(message.sender),
      type: message.type ?? 'text',
      text: withContent ? (message.text ?? '') : '',
      encryption: message.encryption ?? 'none',
      encrypted: withContent && message.encrypted ? { ...message.encrypted } : null,
      attachment: attachment ? toAttachmentDto(attachment) : null,
      sticker: withContent ? (message.sticker ?? null) : null,
      poll: withContent && message.poll ? (polls.get(String(message.poll)) ?? null) : null,
      system: message.system
        ? {
            kind: message.system.kind,
            actorId: String(message.system.actor),
            targetId: message.system.target ? String(message.system.target) : null,
            name: message.system.name ?? null,
            ...(message.system.call
              ? {
                  call: {
                    id: String(message.system.call.id),
                    type: message.system.call.type,
                    status: message.system.call.status,
                    durationSeconds: message.system.call.durationSeconds ?? null,
                    endReason: message.system.call.endReason ?? null,
                  },
                }
              : {}),
          }
        : null,
      replyTo: withContent ? replyPreview(message) : null,
      forwarded: Boolean(message.forwardedFrom),
      editedAt: message.editedAt ? message.editedAt.toISOString() : null,
      deletedAt: message.deletedAt ? message.deletedAt.toISOString() : null,
      reactions: withContent
        ? (message.reactions ?? []).map((reaction) => ({
            userId: String(reaction.user),
            emoji: reaction.emoji,
          }))
        : [],
      rev: message.rev ?? 0,
      createdAt: message.createdAt.toISOString(),
      ...(viewerId ? { starred: Boolean(flag?.starredAt), hidden } : {}),
    };
  });
}

/** Pinned messages as clients see them (pinnedMessageSchema). */
export function toPinDtos(pins) {
  return (pins ?? []).map((pin) => ({
    messageId: String(pin.message),
    seq: pin.seq,
    senderId: String(pin.sender),
    preview: pin.preview,
    pinnedBy: String(pin.pinnedBy),
    pinnedAt: pin.pinnedAt.toISOString(),
  }));
}

/**
 * Poll DTOs with live counts (anonymous: only totals), plus the viewer's own choices when
 * `viewerId` is given. Two aggregations for any number of polls.
 *
 * @returns {Promise<Map<string, object>>}
 */
export async function loadPolls(pollIds, viewerId = null) {
  if (pollIds.length === 0) return new Map();
  const [polls, counts, totals, mine] = await Promise.all([
    Poll.find({ _id: { $in: pollIds } }).lean(),
    PollVote.aggregate([
      { $match: { poll: { $in: pollIds } } },
      { $unwind: '$optionIds' },
      { $group: { _id: { poll: '$poll', option: '$optionIds' }, votes: { $sum: 1 } } },
    ]),
    PollVote.aggregate([
      { $match: { poll: { $in: pollIds } } },
      { $group: { _id: '$poll', voters: { $sum: 1 } } },
    ]),
    viewerId ? PollVote.find({ poll: { $in: pollIds }, user: viewerId }).lean() : [],
  ]);
  const votes = new Map(counts.map((row) => [`${row._id.poll}:${row._id.option}`, row.votes]));
  const voters = new Map(totals.map((row) => [String(row._id), row.voters]));
  const myVotes = new Map(mine.map((vote) => [String(vote.poll), vote.optionIds]));
  return new Map(
    polls.map((poll) => [
      String(poll._id),
      {
        id: String(poll._id),
        question: poll.question,
        options: poll.options.map((option) => ({
          id: option.id,
          text: option.text,
          votes: votes.get(`${poll._id}:${option.id}`) ?? 0,
        })),
        multiple: poll.multiple,
        closed: Boolean(poll.closedAt),
        closedAt: poll.closedAt ? poll.closedAt.toISOString() : null,
        creatorId: String(poll.creator),
        totalVoters: voters.get(String(poll._id)) ?? 0,
        ...(viewerId ? { myVotes: myVotes.get(String(poll._id)) ?? [] } : {}),
      },
    ]),
  );
}
