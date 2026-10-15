import { API_PREFIX } from '#shared';
import { isValidObjectId } from 'mongoose';
import { Attachment, ATTACHMENT_LIFECYCLE as STATUS } from '../models/attachment.model.js';
import { BlockedUser } from '../models/blocked-user.model.js';
import { Conversation } from '../models/conversation.model.js';
import { MessageFlag } from '../models/message-flag.model.js';
import { Message } from '../models/message.model.js';
import { StorageUsage } from '../models/storage-usage.model.js';
import { generateToken } from '../security/tokens.js';
import { AppError } from '../utils/app-error.js';
import { inspectUpload } from './attachment-files.js';

/** Kinds shown inline (img/video/audio); documents are always downloaded. */
const INLINE_KINDS = new Set(['image', 'video', 'audio', 'voice']);
/** How long a stuck deletion or cleanup request waits before the reaper retries it. */
const RETRY_AFTER_MS = 5 * 60_000;
const REAP_BATCH = 100;

const notFound = () => new AppError(404, 'NOT_FOUND', 'Attachment not found.');
const quotaExceeded = (scope) =>
  new AppError(
    413,
    'STORAGE_QUOTA_EXCEEDED',
    scope === 'total'
      ? 'Attachment storage is full right now. Please try again later.'
      : "You've reached your attachment storage limit. Delete some attachments to free space.",
  );

/** @returns {import('zod').infer<typeof import('#shared').attachmentSchema>} */
export function toAttachmentDto(attachment) {
  return {
    id: String(attachment._id),
    kind: attachment.kind,
    contentType: attachment.contentType,
    name: attachment.originalName,
    size: attachment.size,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
    url: `${API_PREFIX}/attachments/${String(attachment._id)}/content`,
  };
}

/** "attachment; filename=..." with an ASCII fallback and the UTF-8 name (RFC 6266 / 5987). */
function contentDisposition(type, name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Parses a single "bytes=start-end" range. Null = whole file; false = unsatisfiable. */
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return false;
  let start;
  let end;
  if (match[1] === '') {
    start = Math.max(size - Number(match[2]), 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start > end || start >= size) return false;
  return { start, end };
}

/**
 * Attachments: validation, quota reservation, storage, access checks, streaming and cleanup.
 *
 * Lifecycle: uploaded → attached (a message uses it) → deleting → deleted. Messages are the
 * source of truth for references: an object is only removed when no undeleted message uses it,
 * checked after the attachment is moved to "deleting" (so a concurrent forward either sees
 * "deleting" and gives up, or is seen by the check). Unused uploads and interrupted deletions
 * are finished by reap().
 *
 * @param {{ storage: import('./storage.js').FileStorage, config: import('../config/app-config.js').AppConfig, logger: import('../utils/logger.js').Logger }} deps
 */
export function createAttachmentService({ storage, config, logger, settings }) {
  const { userQuotaBytes, totalQuotaBytes, orphanAfterMs } = config.attachments;

  async function reserveScope(scope, bytes, limit) {
    try {
      await StorageUsage.updateOne({ scope }, { $setOnInsert: { bytes: 0 } }, { upsert: true });
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
    const result = await StorageUsage.updateOne(
      { scope, bytes: { $lte: limit - bytes } },
      { $inc: { bytes } },
    );
    return result.modifiedCount === 1;
  }

  async function releaseScope(scope, bytes) {
    const result = await StorageUsage.updateOne(
      { scope, bytes: { $gte: bytes } },
      { $inc: { bytes: -bytes } },
    );
    if (result.modifiedCount === 0) await StorageUsage.updateOne({ scope }, { $set: { bytes: 0 } });
  }

  /** Reserves space for the uploader and the service, or throws STORAGE_QUOTA_EXCEEDED. */
  async function reserve(userId, bytes) {
    const userScope = `user:${userId}`;
    if (!(await reserveScope(userScope, bytes, userQuotaBytes))) throw quotaExceeded('user');
    if (!(await reserveScope('total', bytes, totalQuotaBytes))) {
      await releaseScope(userScope, bytes);
      throw quotaExceeded('total');
    }
  }

  async function release(userId, bytes) {
    await Promise.all([releaseScope(`user:${userId}`, bytes), releaseScope('total', bytes)]);
  }

  /** Removes the object of an attachment already in "deleting" and frees its space (once). */
  async function finishDeletion(attachment) {
    await storage.remove(attachment.storageKey);
    const done = await Attachment.updateOne(
      { _id: attachment._id, status: STATUS.deleting },
      { $set: { status: STATUS.deleted, deletedAt: new Date(), cleanupRequestedAt: null } },
    );
    if (done.modifiedCount === 1) await release(attachment.uploader, attachment.size);
  }

  /**
   * Deletes the stored object if no undeleted message uses the attachment any more. Safe to
   * call repeatedly and concurrently.
   */
  async function releaseIfUnused(attachmentId) {
    const claimed = await Attachment.findOneAndUpdate(
      { _id: attachmentId, status: { $in: [STATUS.attached, STATUS.uploaded] } },
      { $set: { status: STATUS.deleting } },
      { returnDocument: 'after' },
    ).lean();
    if (!claimed) return;
    if (await Message.exists({ attachment: attachmentId, deletedAt: null })) {
      await Attachment.updateOne(
        { _id: attachmentId, status: STATUS.deleting },
        { $set: { status: STATUS.attached, cleanupRequestedAt: null } },
      );
      return;
    }
    try {
      await finishDeletion(claimed);
    } catch (error) {
      // Stays "deleting"; the reaper retries.
      logger.warn('Could not delete an attachment object', { error });
    }
  }

  /** Can `userId` see this attachment right now? Returns the attachment or throws 404. */
  async function authorize(userId, attachmentId) {
    if (!isValidObjectId(attachmentId)) throw notFound();
    const attachment = await Attachment.findById(attachmentId).lean();
    if (!attachment || ![STATUS.uploaded, STATUS.attached].includes(attachment.status)) {
      throw notFound();
    }
    // Not sent yet: only the uploader (to preview it) while still in that conversation.
    if (attachment.status === STATUS.uploaded) {
      const member =
        attachment.uploader.equals(userId) &&
        (await Conversation.exists({ _id: attachment.conversation, participants: userId }));
      if (member) return attachment;
      // It may already be referenced (a send that did not finish marking it): check messages.
    }
    const uses = await Message.find(
      { attachment: attachmentId, deletedAt: null },
      { _id: 1, conversation: 1 },
    ).lean();
    if (uses.length === 0) throw notFound();
    const conversations = await Conversation.find(
      { _id: { $in: uses.map((use) => use.conversation) }, participants: userId },
      { participants: 1, type: 1 },
    ).lean();
    // Someone the other participant blocked can't open that conversation's files any more
    // (the blocker keeps access to their own history).
    const blockedBy = new Set(
      (
        await BlockedUser.find(
          {
            blocked: userId,
            blocker: {
              $in: conversations.flatMap((c) => c.participants.filter((p) => !p.equals(userId))),
            },
          },
          { blocker: 1 },
        ).lean()
      ).map((block) => String(block.blocker)),
    );
    // (One-to-one chats only: in a group, files stay visible to all current members.)
    const memberOf = new Set(
      conversations
        .filter((c) => c.type === 'group' || !c.participants.some((p) => blockedBy.has(String(p))))
        .map((c) => String(c._id)),
    );
    const visible = uses.filter((use) => memberOf.has(String(use.conversation)));
    if (visible.length === 0) throw notFound();
    // Deleted for me everywhere I can see it: treat as inaccessible.
    const hidden = await MessageFlag.countDocuments({
      user: userId,
      message: { $in: visible.map((use) => use._id) },
      hiddenAt: { $ne: null },
    });
    if (hidden === visible.length) throw notFound();
    return attachment;
  }

  return {
    /**
     * Validates and stores a file for `conversationId` (membership and messaging permission
     * are checked by the caller). Never leaves an object without metadata or quota.
     */
    async upload(userId, conversationId, file, fields = {}) {
      // The platform setting may lower the limit below the hard 5 MB maximum.
      const limit = settings ? (await settings.get()).uploadMaxBytes : Infinity;
      if (file?.buffer?.length > limit) {
        const mb = Math.round((limit / (1024 * 1024)) * 10) / 10;
        throw new AppError(413, 'PAYLOAD_TOO_LARGE', `Files must be ${mb} MB or smaller.`);
      }
      const inspected = await inspectUpload(file, fields);
      await reserve(userId, inspected.size);
      const storageKey = `attachments/${generateToken(32)}`;
      try {
        await storage.put(storageKey, inspected.buffer, { contentType: inspected.contentType });
      } catch (error) {
        await release(userId, inspected.size);
        logger.error('Attachment upload to storage failed', { error });
        throw new AppError(503, 'SERVICE_UNAVAILABLE', "The file couldn't be stored. Try again.");
      }
      try {
        const attachment = await Attachment.create({
          uploader: userId,
          conversation: conversationId,
          storageKey,
          kind: inspected.kind,
          contentType: inspected.contentType,
          originalName: inspected.originalName,
          size: inspected.size,
          width: inspected.width,
          height: inspected.height,
        });
        return toAttachmentDto(attachment.toObject());
      } catch (error) {
        await storage.remove(storageKey).catch(() => undefined);
        await release(userId, inspected.size);
        throw error;
      }
    },

    /**
     * An attachment `userId` may use in a new message in `conversationId`: their own unused
     * upload for that conversation.
     */
    async loadForSending(userId, conversationId, attachmentId) {
      const attachment = await Attachment.findOne({
        _id: attachmentId,
        uploader: userId,
        conversation: conversationId,
        status: STATUS.uploaded,
      }).lean();
      if (!attachment) {
        throw new AppError(
          400,
          'BAD_REQUEST',
          'That attachment is not available. Upload the file again.',
        );
      }
      return attachment;
    },

    /** Marks an upload as used by a message (idempotent). */
    async markAttached(attachmentId) {
      await Attachment.updateOne(
        { _id: attachmentId, status: STATUS.uploaded },
        { $set: { status: STATUS.attached, attachedAt: new Date() } },
      );
    },

    /** True while the object can still be referenced by a new message (forwarding). */
    async isUsable(attachmentId) {
      return Boolean(
        await Attachment.exists({
          _id: attachmentId,
          status: { $in: [STATUS.uploaded, STATUS.attached] },
        }),
      );
    },

    /** Records that a message stopped using it, so the reaper finishes an interrupted cleanup. */
    async requestCleanup(attachmentId) {
      await Attachment.updateOne(
        { _id: attachmentId, status: { $in: [STATUS.uploaded, STATUS.attached] } },
        { $set: { cleanupRequestedAt: new Date() } },
      );
    },

    releaseIfUnused,
    authorize,

    async findDtos(ids) {
      if (ids.length === 0) return new Map();
      const rows = await Attachment.find({ _id: { $in: ids } }).lean();
      return new Map(rows.map((row) => [String(row._id), row]));
    },

    /** Streams an authorized attachment, honouring a single Range header (seeking media). */
    async stream(attachment, req, res) {
      const range = parseRange(req.headers.range, attachment.size);
      if (range === false) {
        res.status(416).set('Content-Range', `bytes */${attachment.size}`).end();
        return;
      }
      const download = req.query.download === '1' || !INLINE_KINDS.has(attachment.kind);
      let body;
      try {
        body = await storage.read(attachment.storageKey, range ?? undefined);
      } catch (error) {
        logger.error('Attachment read failed', { error });
        throw new AppError(503, 'SERVICE_UNAVAILABLE', "The file couldn't be loaded. Try again.");
      }
      const isText = attachment.contentType.startsWith('text/');
      res.status(range ? 206 : 200).set({
        'Content-Type': isText
          ? `${attachment.contentType}; charset=utf-8`
          : attachment.contentType,
        'Content-Length': String(range ? range.end - range.start + 1 : attachment.size),
        'Accept-Ranges': 'bytes',
        'Content-Disposition': contentDisposition(
          download ? 'attachment' : 'inline',
          attachment.originalName,
        ),
        // Private to this signed-in user; never stored by shared caches.
        'Cache-Control': 'private, max-age=300',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        // same-site, not same-origin: the web app may live on a sibling subdomain of the API
        // (app.example.com + api.example.com) and embeds these in <img>/<video>.
        'Cross-Origin-Resource-Policy': 'same-site',
        ...(range
          ? { 'Content-Range': `bytes ${range.start}-${range.end}/${attachment.size}` }
          : {}),
      });
      body.on('error', () => res.destroy());
      body.pipe(res);
    },

    /**
     * Housekeeping, safe to run on every instance:
     * - unused uploads older than ATTACHMENT_ORPHAN_MINUTES are deleted (unless a message turned
     *   out to use them, in which case they are marked attached);
     * - interrupted deletions and cleanups are finished.
     *
     * @returns {Promise<{ deleted: number }>}
     */
    async reap(now = new Date()) {
      let deleted = 0;
      const orphanCutoff = new Date(now.getTime() - orphanAfterMs);
      const retryCutoff = new Date(now.getTime() - RETRY_AFTER_MS);
      const candidates = await Attachment.find(
        {
          $or: [
            { status: STATUS.uploaded, updatedAt: { $lt: orphanCutoff } },
            { status: STATUS.deleting, updatedAt: { $lt: retryCutoff } },
            { status: STATUS.attached, cleanupRequestedAt: { $lt: retryCutoff } },
          ],
        },
        { _id: 1, status: 1 },
      )
        .limit(REAP_BATCH)
        .lean();
      for (const candidate of candidates) {
        try {
          if (candidate.status === STATUS.deleting) {
            if (await Message.exists({ attachment: candidate._id, deletedAt: null })) {
              await Attachment.updateOne(
                { _id: candidate._id, status: STATUS.deleting },
                { $set: { status: STATUS.attached, cleanupRequestedAt: null } },
              );
              continue;
            }
            const attachment = await Attachment.findById(candidate._id).lean();
            await finishDeletion(attachment);
          } else {
            await releaseIfUnused(candidate._id);
          }
          const after = await Attachment.findById(candidate._id, { status: 1 }).lean();
          if (after?.status === STATUS.deleted) deleted += 1;
        } catch (error) {
          logger.warn('Attachment cleanup failed; will retry', { error });
        }
      }
      return { deleted };
    },
  };
}
