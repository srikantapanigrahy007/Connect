import { z } from 'zod';
import { GROUP_ROLES } from '../domain/enums.js';
import { LIMITS } from '../domain/limits.js';
import { objectIdSchema } from './api.js';
import { userCardSchema } from './profile.js';

/*
 * Groups, invitations and polls (Phase 9). A group is a conversation of type "group"; its
 * messages use the same message contracts as one-to-one chats.
 *
 * Roles: exactly one owner; admins; members. Permissions (enforced by the API):
 * | Action                                   | Owner | Admin | Member |
 * | ---------------------------------------- | ----- | ----- | ------ |
 * | Send messages, react, create polls       | ✓     | ✓     | ✓      |
 * | Edit name / description / photo          | ✓     | ✓     |        |
 * | Add members, create / revoke invitations | ✓     | ✓     |        |
 * | Remove members                           | ✓ any | members only |  |
 * | Pin messages, close any poll             | ✓     | ✓     | own polls |
 * | Promote / demote admins                  | ✓     |       |        |
 * | Transfer ownership, delete the group     | ✓     |       |        |
 * | Leave                                    | after transferring | ✓ | ✓ |
 */

export const GROUP_ASSIGNABLE_ROLES = ['admin', 'member'];

export const groupNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a group name')
  .max(
    LIMITS.groupNameMaxLength,
    `Group names are at most ${LIMITS.groupNameMaxLength} characters`,
  );

export const groupDescriptionSchema = z
  .string()
  .trim()
  .max(
    LIMITS.groupDescriptionMaxLength,
    `Descriptions are at most ${LIMITS.groupDescriptionMaxLength} characters`,
  );

const userIdsSchema = z
  .array(objectIdSchema)
  .max(50, 'Add at most 50 people at a time')
  .refine((ids) => new Set(ids).size === ids.length, 'Each person can be added once');

/** POST /groups */
export const createGroupSchema = z
  .object({
    name: groupNameSchema,
    description: groupDescriptionSchema.optional(),
    memberIds: userIdsSchema.optional(),
  })
  .strict();

/** PATCH /groups/:id (send only what changes) */
export const updateGroupSchema = z
  .object({ name: groupNameSchema.optional(), description: groupDescriptionSchema.optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

/** POST /groups/:id/members */
export const addGroupMembersSchema = z
  .object({ userIds: userIdsSchema.refine((ids) => ids.length > 0, 'Choose someone to add') })
  .strict();

/** PATCH /groups/:id/members/:userId (owner only; "owner" is only reachable by transfer). */
export const changeGroupRoleSchema = z.object({ role: z.enum(GROUP_ASSIGNABLE_ROLES) }).strict();

/** POST /groups/:id/transfer */
export const transferOwnershipSchema = z.object({ userId: objectIdSchema }).strict();

// ── Invitations ─────────────────────────────────────────────────────────────

/** Short codes avoid look-alike characters (no 0/O, 1/I/L). */
export const INVITE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const codePattern = new RegExp(`^[${INVITE_CODE_ALPHABET}]{4}-?[${INVITE_CODE_ALPHABET}]{4}$`);

/** POST /groups/:id/invites */
export const createInviteSchema = z
  .object({
    /** 1 hour to 30 days. */
    expiresInHours: z.number().int().min(1).max(720).default(168),
    /** Null = unlimited until it expires. */
    maxUses: z.number().int().min(1).max(1_000).nullable().default(null),
  })
  .strict();

/** POST /group-invites/preview and /join: the link token or the short code, not both. */
export const inviteSecretSchema = z
  .object({
    token: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid invitation link')
      .optional(),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(codePattern, 'Invitation codes look like ABCD-EFGH')
      .transform((value) => value.replace('-', ''))
      .optional(),
  })
  .strict()
  .refine((value) => Boolean(value.token) !== Boolean(value.code), 'Enter an invitation code');

// ── Polls ───────────────────────────────────────────────────────────────────

/** A poll sent as a message (`poll` field of the send payload). Groups only. */
export const pollInputSchema = z
  .object({
    question: z
      .string()
      .trim()
      .min(1, 'Ask a question')
      .max(
        LIMITS.pollQuestionMaxLength,
        `Questions are at most ${LIMITS.pollQuestionMaxLength} characters`,
      ),
    options: z
      .array(
        z
          .string()
          .trim()
          .min(1, 'Options cannot be empty')
          .max(
            LIMITS.pollOptionTextMaxLength,
            `Options are at most ${LIMITS.pollOptionTextMaxLength} characters`,
          ),
      )
      .min(LIMITS.pollMinOptions, `Add at least ${LIMITS.pollMinOptions} options`)
      .max(LIMITS.pollMaxOptions, `Add at most ${LIMITS.pollMaxOptions} options`)
      .refine(
        (options) => new Set(options.map((option) => option.toLowerCase())).size === options.length,
        'Options must be different',
      ),
    /** false: one choice; true: several choices. */
    multiple: z.boolean().default(false),
  })
  .strict();

/** PUT /conversations/:id/polls/:pollId/vote — replaces your whole vote. */
export const pollVoteSchema = z
  .object({
    optionIds: z
      .array(z.string().regex(/^[a-z0-9]{1,16}$/, 'Invalid option'))
      .min(1, 'Choose an option')
      .max(LIMITS.pollMaxOptions)
      .refine((ids) => new Set(ids).size === ids.length, 'Each option once'),
  })
  .strict();

/**
 * Poll rules: anyone in the group may create a poll; the creator, admins and the owner may close
 * it. Votes are anonymous (only counts are shown; nobody sees who chose what, except their own
 * vote). Results are visible while the poll is open. You may change or withdraw your vote until
 * it is closed; a closed poll accepts no votes.
 */
export const pollSchema = z.object({
  id: z.string(),
  question: z.string(),
  options: z.array(z.object({ id: z.string(), text: z.string(), votes: z.number().int().min(0) })),
  multiple: z.boolean(),
  closed: z.boolean(),
  closedAt: z.iso.datetime().nullable(),
  creatorId: z.string(),
  totalVoters: z.number().int().min(0),
  /** Your own choices (absent from updates sent to everyone). */
  myVotes: z.array(z.string()).optional(),
});

// ── Responses ───────────────────────────────────────────────────────────────

export const groupMemberSchema = z.object({
  user: userCardSchema,
  role: z.enum(GROUP_ROLES),
  joinedAt: z.iso.datetime(),
});

export const groupSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  avatarUrl: z.string().nullable(),
  memberCount: z.number().int().min(0),
  myRole: z.enum(GROUP_ROLES),
  /** Suspended by a moderator: read-only until unsuspended. */
  suspended: z.boolean(),
  createdAt: z.iso.datetime(),
  members: z.array(groupMemberSchema),
});

export const groupInviteSchema = z.object({
  id: z.string(),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  maxUses: z.number().int().nullable(),
  uses: z.number().int().min(0),
  revoked: z.boolean(),
  /** "active" | "expired" | "exhausted" | "revoked". */
  state: z.enum(['active', 'expired', 'exhausted', 'revoked']),
});

/** Returned once, when the invitation is created: the secrets are never shown again. */
export const createdInviteSchema = groupInviteSchema.extend({
  token: z.string(),
  /** Formatted "ABCD-EFGH". */
  code: z.string(),
});

export const invitePreviewSchema = z.object({
  groupId: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  memberCount: z.number().int().min(0),
  alreadyMember: z.boolean(),
});
