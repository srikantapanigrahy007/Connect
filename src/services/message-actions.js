import { PINNED_MESSAGES_LIMIT } from '#shared';
import { isValidObjectId } from 'mongoose';
import { Conversation } from '../models/conversation.model.js';
import { MessageFlag } from '../models/message-flag.model.js';
import { Message } from '../models/message.model.js';
import { AppError } from '../utils/app-error.js';
import { buildMessageDtos, previewOf, toPinDtos } from './message-dto.js';

const messageNotFound = () => new AppError(404, 'NOT_FOUND', 'Message not found.');
const messageDeleted = () => new AppError(409, 'CONFLICT', 'This message was deleted.');
const notForSystem = (message) => {
  if (message.type === 'system') throw AppError.badRequest("Group events can't be changed.");
};

/**
 * Message actions. Every action checks conversation membership (non-members get 404, exactly
 * like a missing message); actions that communicate with the other person (edit, react, pin)
 * also re-check the Phase 5 messaging rules, so a block stops them immediately.
 *
 * | Action              | Who                         | Rules                                              |
 * | ------------------- | --------------------------- | -------------------------------------------------- |
 * | Edit                | sender                      | text messages, within the edit window, not deleted |
 * | Delete for me       | either participant          | private flag; the shared message is untouched      |
 * | Delete for everyone | sender                      | within the delete window; leaves a tombstone       |
 * | React / unreact     | either participant          | one reaction per person (a new one replaces it)    |
 * | Pin / unpin         | either (groups: admins)     | at most PINNED_MESSAGES_LIMIT, not deleted         |
 * | Star / unstar       | either participant          | private flag                                       |
 *
 * Shared changes bump `rev` and emit "updated"; private flags emit "state" to the owner only.
 */
export function createMessageActions({
  events,
  config,
  attachments,
  loadMembership,
  requireCanPost,
  requireEncryptionRules,
}) {
  const participantsOf = (conversation) => conversation.participants.map(String);

  /** In groups only the owner and admins pin and unpin; in one-to-one chats either person. */
  function requirePinRights(conversation, userId) {
    if (conversation.type !== 'group') return;
    const member = conversation.members.find((m) => String(m.user) === String(userId));
    if (member?.role !== 'owner' && member?.role !== 'admin') {
      throw new AppError(403, 'FORBIDDEN', 'Only group admins can pin messages.');
    }
  }

  async function loadMessage(userId, conversationId, messageId) {
    const conversation = await loadMembership(userId, conversationId);
    if (!isValidObjectId(messageId)) throw messageNotFound();
    const message = await Message.findOne({
      _id: messageId,
      conversation: conversation._id,
    }).lean();
    if (!message) throw messageNotFound();
    return { conversation, message };
  }

  /** Emits the shared new version to both people; returns the viewer's DTO. */
  async function publishUpdate(conversation, messageDoc, viewerId) {
    const [shared] = await buildMessageDtos([messageDoc]);
    events.emit('updated', { message: shared, participants: participantsOf(conversation) });
    const [own] = await buildMessageDtos([messageDoc], viewerId);
    return own;
  }

  async function publishPins(conversationId) {
    const conversation = await Conversation.findById(conversationId, {
      pins: 1,
      participants: 1,
    }).lean();
    const pins = toPinDtos(conversation.pins);
    events.emit('pins', {
      conversationId: String(conversationId),
      pins,
      participants: participantsOf(conversation),
    });
    return pins;
  }

  /** Keeps the conversation list preview and pin previews in step with an edit or deletion. */
  async function refreshPreviews(conversationId, messageDoc) {
    const attachment = messageDoc.attachment
      ? (await attachments.findDtos([messageDoc.attachment])).get(String(messageDoc.attachment))
      : null;
    const preview = previewOf(messageDoc, attachment) || 'Message';
    await Conversation.updateOne(
      { _id: conversationId, 'lastMessage.message': messageDoc._id },
      { $set: { 'lastMessage.preview': preview } },
    );
    const pinned = await Conversation.updateOne(
      { _id: conversationId, 'pins.message': messageDoc._id },
      { $set: { 'pins.$.preview': preview } },
    );
    if (pinned.modifiedCount > 0) await publishPins(conversationId);
  }

  /** Sets a private flag; emits "state" only when something changed. */
  async function setFlag(userId, conversation, message, field, on) {
    const current = await MessageFlag.findOne({ user: userId, message: message._id }).lean();
    const state = (flag) => ({
      conversationId: String(conversation._id),
      messageId: String(message._id),
      starred: Boolean(flag?.starredAt),
      hidden: Boolean(flag?.hiddenAt),
    });
    if (Boolean(current?.[field]) === on) return state(current);
    const update = {
      $set: { [field]: on ? new Date() : null },
      $setOnInsert: { conversation: conversation._id },
    };
    let flag;
    try {
      flag = await MessageFlag.findOneAndUpdate({ user: userId, message: message._id }, update, {
        upsert: true,
        returnDocument: 'after',
      }).lean();
    } catch (error) {
      // Two tabs created the flag at the same moment; the record exists now.
      if (error?.code !== 11000) throw error;
      flag = await MessageFlag.findOneAndUpdate({ user: userId, message: message._id }, update, {
        returnDocument: 'after',
      }).lean();
    }
    const result = state(flag);
    events.emit('state', { userId: String(userId), state: result });
    return result;
  }

  return {
    /**
     * Replaces the text of your own text message within the edit window. End-to-end encrypted
     * messages are replaced by new encrypted content (`{ encrypted }`) from this sign-in's bound
     * device; in an encrypted chat, messages from before encryption can't be edited (that would
     * add readable text).
     */
    async editMessage(userId, conversationId, messageId, input, { sessionId } = {}) {
      const { text, encrypted } = typeof input === 'string' ? { text: input } : input;
      const { conversation, message } = await loadMessage(userId, conversationId, messageId);
      if (!message.sender.equals(userId)) {
        throw new AppError(403, 'FORBIDDEN', 'You can only edit your own messages.');
      }
      if (message.deletedAt) throw messageDeleted();
      if ((message.type ?? 'text') !== 'text') {
        throw AppError.badRequest('Only text messages can be edited.');
      }
      const { editWindowMs } = config.messages;
      const cutoff = new Date(Date.now() - editWindowMs);
      if (editWindowMs === 0 || message.createdAt < cutoff) {
        throw new AppError(403, 'ACTION_WINDOW_EXPIRED', 'This message can no longer be edited.');
      }
      await requireCanPost(userId, conversation);
      const isEncrypted = message.encryption === 'e2ee_v1';
      if (isEncrypted !== Boolean(encrypted)) {
        throw AppError.badRequest(
          isEncrypted
            ? 'Encrypted messages are edited with new encrypted content.'
            : "This message isn't encrypted.",
        );
      }
      await requireEncryptionRules(
        userId,
        sessionId,
        conversation,
        isEncrypted ? { encrypted } : { text },
      );
      if (
        isEncrypted ? message.encrypted?.ciphertext === encrypted.ciphertext : message.text === text
      ) {
        return (await buildMessageDtos([message], userId))[0];
      }

      const updated = await Message.findOneAndUpdate(
        {
          _id: message._id,
          sender: userId,
          type: 'text',
          encryption: isEncrypted ? 'e2ee_v1' : { $ne: 'e2ee_v1' },
          deletedAt: null,
          createdAt: { $gte: cutoff },
        },
        {
          $set: isEncrypted ? { encrypted, editedAt: new Date() } : { text, editedAt: new Date() },
          $inc: { editCount: 1, rev: 1 },
        },
        { returnDocument: 'after' },
      ).lean();
      // Deleted or out of the window in the meantime.
      if (!updated) throw messageDeleted();
      await refreshPreviews(conversation._id, updated);
      return publishUpdate(conversation, updated, userId);
    },

    /**
     * scope "me": hides it for you only. scope "everyone": the sender deletes it within the
     * window; text, attachment, sticker, reply and reactions are wiped (a tombstone stays so the
     * sequence has no gap), it is unpinned, and its file is removed once no other message (for
     * example a forward) still uses it. Repeating either delete is harmless.
     */
    async deleteMessage(userId, conversationId, messageId, scope) {
      const { conversation, message } = await loadMessage(userId, conversationId, messageId);
      if (scope === 'me') {
        return { state: await setFlag(userId, conversation, message, 'hiddenAt', true) };
      }
      notForSystem(message);
      if (!message.sender.equals(userId)) {
        throw new AppError(403, 'FORBIDDEN', 'You can only delete your own messages for everyone.');
      }
      if (message.deletedAt) return { message: (await buildMessageDtos([message], userId))[0] };
      const { deleteWindowMs } = config.messages;
      const cutoff = new Date(Date.now() - deleteWindowMs);
      if (deleteWindowMs === 0 || message.createdAt < cutoff) {
        throw new AppError(
          403,
          'ACTION_WINDOW_EXPIRED',
          'This message can no longer be deleted for everyone.',
        );
      }

      if (message.attachment) await attachments.requestCleanup(message.attachment);
      const updated = await Message.findOneAndUpdate(
        { _id: message._id, sender: userId, deletedAt: null },
        {
          $set: {
            deletedAt: new Date(),
            text: '',
            attachment: null,
            sticker: null,
            poll: null,
            replyTo: null,
            encrypted: null,
            reactions: [],
          },
          $inc: { rev: 1 },
        },
        { returnDocument: 'after' },
      ).lean();
      if (!updated) {
        const now = await Message.findById(message._id).lean();
        return { message: (await buildMessageDtos([now], userId))[0] };
      }
      if (message.attachment) await attachments.releaseIfUnused(message.attachment);
      const unpinned = await Conversation.updateOne(
        { _id: conversation._id },
        { $pull: { pins: { message: message._id } } },
      );
      if (unpinned.modifiedCount > 0) await publishPins(conversation._id);
      await refreshPreviews(conversation._id, updated);
      return { message: await publishUpdate(conversation, updated, userId) };
    },

    /** Sets your reaction (one per person; a different emoji replaces it). */
    async react(userId, conversationId, messageId, emoji) {
      const { conversation, message } = await loadMessage(userId, conversationId, messageId);
      notForSystem(message);
      if (message.deletedAt) throw messageDeleted();
      await requireCanPost(userId, conversation);
      const now = new Date();
      for (let attempt = 0; attempt < 3; attempt++) {
        // Change an existing reaction of yours…
        const changed = await Message.findOneAndUpdate(
          {
            _id: message._id,
            deletedAt: null,
            reactions: { $elemMatch: { user: userId, emoji: { $ne: emoji } } },
          },
          { $set: { 'reactions.$.emoji': emoji, 'reactions.$.reactedAt': now }, $inc: { rev: 1 } },
          { returnDocument: 'after' },
        ).lean();
        if (changed) return publishUpdate(conversation, changed, userId);
        // …or add one if you have none (the filter makes a duplicate impossible).
        const added = await Message.findOneAndUpdate(
          { _id: message._id, deletedAt: null, 'reactions.user': { $ne: userId } },
          { $push: { reactions: { user: userId, emoji, reactedAt: now } }, $inc: { rev: 1 } },
          { returnDocument: 'after' },
        ).lean();
        if (added) return publishUpdate(conversation, added, userId);
        const current = await Message.findById(message._id).lean();
        if (current.deletedAt) throw messageDeleted();
        const mine = current.reactions.find((reaction) => reaction.user.equals(userId));
        // Already this emoji: nothing to do (no new revision, no event).
        if (mine?.emoji === emoji) return (await buildMessageDtos([current], userId))[0];
      }
      throw new AppError(409, 'CONFLICT', 'The reaction changed at the same time. Try again.');
    },

    async unreact(userId, conversationId, messageId) {
      const { conversation, message } = await loadMessage(userId, conversationId, messageId);
      const updated = await Message.findOneAndUpdate(
        { _id: message._id, 'reactions.user': userId },
        { $pull: { reactions: { user: userId } }, $inc: { rev: 1 } },
        { returnDocument: 'after' },
      ).lean();
      if (!updated) return (await buildMessageDtos([message], userId))[0];
      return publishUpdate(conversation, updated, userId);
    },

    /** Pins a message for both people. The limit is part of the atomic update's filter. */
    async pin(userId, conversationId, messageId) {
      const { conversation, message } = await loadMessage(userId, conversationId, messageId);
      requirePinRights(conversation, userId);
      notForSystem(message);
      if (message.deletedAt) throw messageDeleted();
      await requireCanPost(userId, conversation);
      if ((conversation.pins ?? []).some((pin) => pin.message.equals(message._id))) {
        return toPinDtos(conversation.pins);
      }
      const attachment = message.attachment
        ? (await attachments.findDtos([message.attachment])).get(String(message.attachment))
        : null;
      const pinned = await Conversation.updateOne(
        {
          _id: conversation._id,
          'pins.message': { $ne: message._id },
          [`pins.${PINNED_MESSAGES_LIMIT - 1}`]: { $exists: false },
        },
        {
          $push: {
            pins: {
              message: message._id,
              seq: message.seq,
              sender: message.sender,
              preview: previewOf(message, attachment) || 'Message',
              pinnedBy: userId,
              pinnedAt: new Date(),
            },
          },
        },
      );
      if (pinned.modifiedCount === 0) {
        const fresh = await Conversation.findById(conversation._id, { pins: 1 }).lean();
        if (fresh.pins.some((pin) => pin.message.equals(message._id))) return toPinDtos(fresh.pins);
        throw new AppError(
          409,
          'PIN_LIMIT_REACHED',
          `You can pin up to ${PINNED_MESSAGES_LIMIT} messages. Unpin one first.`,
        );
      }
      return publishPins(conversation._id);
    },

    async unpin(userId, conversationId, messageId) {
      const { conversation, message } = await loadMessage(userId, conversationId, messageId);
      requirePinRights(conversation, userId);
      const result = await Conversation.updateOne(
        { _id: conversation._id },
        { $pull: { pins: { message: message._id } } },
      );
      if (result.modifiedCount === 0) return toPinDtos(conversation.pins);
      return publishPins(conversation._id);
    },

    /** Stars or unstars a message for you only. Deleted messages can't be starred. */
    async star(userId, conversationId, messageId, starred) {
      const { conversation, message } = await loadMessage(userId, conversationId, messageId);
      if (starred && message.deletedAt) throw messageDeleted();
      return setFlag(userId, conversation, message, 'starredAt', starred);
    },

    /** Your starred messages in a conversation, most recently starred first. */
    async listStarred(userId, conversationId) {
      const conversation = await loadMembership(userId, conversationId);
      const flags = await MessageFlag.find({
        user: userId,
        conversation: conversation._id,
        starredAt: { $ne: null },
        hiddenAt: null,
      })
        .sort({ starredAt: -1 })
        .limit(100)
        .lean();
      const messages = await Message.find({
        _id: { $in: flags.map((flag) => flag.message) },
        deletedAt: null,
      }).lean();
      const byId = new Map(messages.map((message) => [String(message._id), message]));
      const ordered = flags.map((flag) => byId.get(String(flag.message))).filter(Boolean);
      return buildMessageDtos(ordered, userId);
    },
  };
}
