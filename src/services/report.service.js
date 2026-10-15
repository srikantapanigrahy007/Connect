import { reportStatusMachine } from '#shared';
import { isValidObjectId } from 'mongoose';
import { Attachment } from '../models/attachment.model.js';
import { Conversation } from '../models/conversation.model.js';
import { MessageFlag } from '../models/message-flag.model.js';
import { Message } from '../models/message.model.js';
import { Report } from '../models/report.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { PUBLIC_USER_FIELDS, toUserCard } from './user-dto.js';

const notFound = () => new AppError(404, 'NOT_FOUND', "That can't be reported.");

/** The audit action for each status a moderator moves a report to. */
const AUDIT_ACTION = {
  under_review: 'report.assign',
  resolved: 'report.resolve',
  dismissed: 'report.dismiss',
  open: 'report.reopen',
};

/**
 * Reports about users, messages and groups.
 *
 * Privacy: moderators never browse conversations. A message report stores a snapshot of the
 * reported message (and up to 5 more the reporter chose) taken from what the reporter could see;
 * that snapshot is the only message content moderators get. Future end-to-end encryption keeps
 * this model: evidence comes from the reporter's device, not from the server reading messages.
 *
 * @param {{ audit: ReturnType<typeof import('./audit.service.js').createAuditService> }} deps
 */
export function createReportService({ audit }) {
  async function snapshot(messages) {
    const attachmentIds = messages.map((m) => m.attachment).filter(Boolean);
    const attachments = attachmentIds.length
      ? await Attachment.find(
          { _id: { $in: attachmentIds } },
          { originalName: 1, kind: 1, contentType: 1 },
        ).lean()
      : [];
    const byId = new Map(attachments.map((a) => [String(a._id), a]));
    return messages.map((message) => {
      const attachment = message.attachment ? byId.get(String(message.attachment)) : null;
      return {
        message: message._id,
        sender: message.sender,
        sentAt: message.createdAt,
        type: message.type ?? 'text',
        text: message.text ?? '',
        attachment: attachment
          ? {
              name: attachment.originalName,
              kind: attachment.kind,
              contentType: attachment.contentType,
            }
          : null,
      };
    });
  }

  /** Messages the reporter can see in a conversation (not deleted, not deleted for them). */
  async function visibleMessages(userId, conversationId, ids) {
    const messages = await Message.find({
      _id: { $in: ids },
      conversation: conversationId,
      deletedAt: null,
      type: { $ne: 'system' },
    }).lean();
    const hidden = new Set(
      (
        await MessageFlag.find(
          { user: userId, message: { $in: ids }, hiddenAt: { $ne: null } },
          { message: 1 },
        ).lean()
      ).map((flag) => String(flag.message)),
    );
    return messages.filter((message) => !hidden.has(String(message._id)));
  }

  async function cardsFor(ids) {
    const unique = [...new Set(ids.filter(Boolean).map(String))];
    const users = unique.length
      ? await User.find({ _id: { $in: unique } }, PUBLIC_USER_FIELDS).lean()
      : [];
    return new Map(users.map((user) => [String(user._id), toUserCard(user)]));
  }

  async function toDtos(reports, { withEvidence = false } = {}) {
    const cards = await cardsFor(
      reports.flatMap((r) => [
        r.reporter,
        r.targetUser,
        r.assignedTo,
        r.resolution?.decidedBy,
        ...(withEvidence ? r.evidence.map((e) => e.sender) : []),
      ]),
    );
    const groupIds = reports.filter((r) => r.targetType === 'group').map((r) => r.targetId);
    const groups = groupIds.length
      ? await Conversation.find({ _id: { $in: groupIds } }, { 'group.name': 1 }).lean()
      : [];
    const groupNames = new Map(groups.map((g) => [String(g._id), g.group?.name ?? null]));
    const card = (id) => (id ? (cards.get(String(id)) ?? null) : null);
    return reports.map((report) => ({
      id: String(report._id),
      targetType: report.targetType,
      targetId: String(report.targetId),
      targetUser: card(report.targetUser),
      targetGroupName:
        report.targetType === 'group' ? (groupNames.get(String(report.targetId)) ?? null) : null,
      reporter: card(report.reporter),
      reason: report.reason,
      details: report.details,
      status: report.status,
      assignedTo: card(report.assignedTo),
      resolution: report.resolution
        ? {
            action: report.resolution.action,
            note: report.resolution.note,
            decidedBy: card(report.resolution.decidedBy),
            decidedAt: report.resolution.decidedAt.toISOString(),
          }
        : null,
      evidenceCount: report.evidence.length,
      ...(withEvidence
        ? {
            evidence: report.evidence.map((e) => ({
              messageId: String(e.message),
              sender: card(e.sender),
              sentAt: e.sentAt.toISOString(),
              type: e.type,
              text: e.text,
              attachment: e.attachment ?? null,
            })),
          }
        : {}),
      createdAt: report.createdAt.toISOString(),
      updatedAt: report.updatedAt.toISOString(),
    }));
  }

  return {
    /** Any signed-in user reports something they can see. One open report per target. */
    async create(userId, input) {
      const { targetType, targetId, reason, details = '', evidenceMessageIds = [] } = input;
      const report = { reporter: userId, targetType, targetId, reason, details };
      if (targetType === 'user') {
        if (String(targetId) === String(userId))
          throw AppError.badRequest("You can't report yourself.");
        const user = await User.exists({ _id: targetId, status: { $ne: 'deleted' } });
        if (!user) throw notFound();
        report.targetUser = targetId;
      } else if (targetType === 'message') {
        const message = await Message.findById(targetId).lean();
        const member =
          message &&
          (await Conversation.exists({ _id: message.conversation, participants: userId }));
        const [visible] = member
          ? await visibleMessages(userId, message.conversation, [message._id])
          : [];
        if (!visible) throw notFound();
        if (message.sender.equals(userId))
          throw AppError.badRequest("You can't report your own message.");
        const extra = await visibleMessages(
          userId,
          message.conversation,
          evidenceMessageIds.filter((id) => id !== String(message._id)),
        );
        report.targetUser = message.sender;
        report.conversation = message.conversation;
        report.evidence = await snapshot([message, ...extra.sort((a, b) => a.seq - b.seq)]);
      } else if (targetType === 'group') {
        const group = await Conversation.exists({
          _id: targetId,
          type: 'group',
          participants: userId,
          'group.deletedAt': null,
        });
        if (!group) throw notFound();
        report.conversation = targetId;
      } else {
        throw notFound();
      }
      try {
        const created = await Report.create(report);
        return { id: String(created._id), status: created.status };
      } catch (error) {
        if (error?.code === 11000) {
          throw new AppError(
            409,
            'CONFLICT',
            'You already reported this. A moderator will review it.',
          );
        }
        throw error;
      }
    },

    async list({ cursor, limit, status, targetType }) {
      if (cursor && !isValidObjectId(cursor)) throw AppError.badRequest('Invalid cursor');
      const rows = await Report.find({
        ...(status ? { status } : {}),
        ...(targetType ? { targetType } : {}),
        ...(cursor ? { _id: { $lt: cursor } } : {}),
      })
        .sort({ _id: -1 })
        .limit(limit + 1)
        .lean();
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return {
        data: await toDtos(page),
        meta: { limit, hasMore, nextCursor: hasMore ? String(page.at(-1)._id) : null },
      };
    },

    /** One report with the evidence its reporter submitted. */
    async get(reportId) {
      if (!isValidObjectId(reportId)) throw new AppError(404, 'NOT_FOUND', 'Report not found.');
      const report = await Report.findById(reportId).lean();
      if (!report) throw new AppError(404, 'NOT_FOUND', 'Report not found.');
      return (await toDtos([report], { withEvidence: true }))[0];
    },

    /**
     * Moves a report to `status` (a compare-and-set following reportStatusMachine): taking it
     * assigns it to you; resolving/dismissing records the decision; reopening clears assignment.
     */
    async decide(context, reportId, { status, action, note }) {
      if (!isValidObjectId(reportId)) throw new AppError(404, 'NOT_FOUND', 'Report not found.');
      const set = { status };
      if (status === 'under_review') set.assignedTo = context.actor;
      if (status === 'open') set.assignedTo = null;
      if (status === 'resolved' || status === 'dismissed') {
        set.resolution = {
          action: status === 'resolved' ? action : 'no_action',
          note: note ?? '',
          decidedBy: context.actor,
          decidedAt: new Date(),
        };
      }
      const updated = await Report.findOneAndUpdate(
        { _id: reportId, status: { $in: reportStatusMachine.sourcesFor(status) } },
        { $set: set },
        { returnDocument: 'after' },
      ).lean();
      if (!updated) {
        if (await Report.exists({ _id: reportId })) {
          throw new AppError(
            409,
            'INVALID_STATE_TRANSITION',
            `This report can't be moved to "${status}".`,
          );
        }
        throw new AppError(404, 'NOT_FOUND', 'Report not found.');
      }
      await audit.record(context, {
        action: AUDIT_ACTION[status],
        targetType: 'report',
        targetId: reportId,
        reason: note ?? null,
        details: { status, ...(set.resolution ? { action: set.resolution.action } : {}) },
      });
      return this.get(reportId);
    },
  };
}
