import { defineStateMachine } from './state-machine.js';

/*
 * Domain enums and lifecycle rules shared by the API and every client.
 * Each lifecycle is an explicit state machine: anything not listed is an invalid transition.
 */

// ── Accounts ────────────────────────────────────────────────────────────────

/**
 * "user" plus the admin roles (see domain/admin.js). "admin" is the legacy name of
 * "super_admin" from before Phase 10 and is treated exactly like it.
 */
export const USER_ROLES = ['user', 'support', 'moderator', 'super_admin', 'admin'];

export const accountStatusMachine = defineStateMachine({
  name: 'account status',
  initial: ['pending_verification', 'active'],
  transitions: {
    // Email/password sign-ups start unverified; verified OAuth sign-ups may start active.
    pending_verification: ['active', 'suspended', 'banned', 'deleted'],
    active: ['suspended', 'banned', 'deactivated', 'deleted'],
    // Suspended by an admin (temporary); only an admin restores it (to active, or back to
    // pending_verification if the email was never verified).
    suspended: ['active', 'pending_verification', 'banned', 'deleted'],
    // Banned by an admin (permanent until an admin unbans).
    banned: ['active', 'pending_verification', 'deleted'],
    // Deactivated by the user; signing in again reactivates.
    deactivated: ['active', 'deleted'],
    // Personal data is scrubbed; the record remains so references stay valid.
    deleted: [],
  },
});

export const ACCOUNT_STATUSES = accountStatusMachine.states;

export const AUTH_METHODS = ['password', 'google'];

export const CLIENT_TYPES = ['web', 'mobile'];

// ── Profiles and privacy ─────────────────────────────────────────────────────

/**
 * public: full profile (bio, join date) visible to every signed-in user; found by partial search.
 * private: non-connections see only name, username and avatar; found only by exact username.
 */
export const PROFILE_VISIBILITIES = ['public', 'private'];

/**
 * "Who can message me?"
 * everyone: anyone who isn't blocked can send a message request.
 * connections: only connections can message; others cannot send requests.
 * nobody: no new message requests from anyone.
 */
export const MESSAGE_PERMISSIONS = ['everyone', 'connections', 'nobody'];

/** Who can see your online status / last seen time. */
export const PRESENCE_AUDIENCES = ['everyone', 'connections', 'nobody'];

// ── Conversations and messages ──────────────────────────────────────────────

export const CONVERSATION_TYPES = ['direct', 'group'];

/** Membership of a conversation or group. Records are reused when someone rejoins. */
export const membershipStateMachine = defineStateMachine({
  name: 'membership state',
  initial: ['active'],
  transitions: {
    active: ['left', 'removed'],
    left: ['active'],
    removed: ['active'],
  },
});

export const MEMBERSHIP_STATES = membershipStateMachine.states;

export const MESSAGE_TYPES = ['text', 'attachment', 'poll', 'system'];

/**
 * Payload encryption. "none" stores `text`; "e2ee_v1" stores only `ciphertext` and a header the
 * server never needs to decrypt. New schemes can be added without changing existing documents.
 */
export const ENCRYPTION_SCHEMES = ['none', 'e2ee_v1'];

export const messageStatusMachine = defineStateMachine({
  name: 'message status',
  initial: ['sent'],
  transitions: {
    sent: ['edited', 'deleted', 'removed'],
    edited: ['edited', 'deleted', 'removed'],
    // Deleted by the sender: content is wiped, a tombstone remains.
    deleted: [],
    // Removed by a moderator: content is wiped, a tombstone remains.
    removed: [],
  },
});

export const MESSAGE_STATUSES = messageStatusMachine.states;

export const SYSTEM_EVENT_KINDS = [
  'conversation_created',
  'member_added',
  'member_removed',
  'member_left',
  'group_renamed',
  'poll_closed',
  /** A direct chat was switched to end-to-end encryption (never switched back). */
  'e2ee_enabled',
];

// ── Message requests ────────────────────────────────────────────────────────

export const messageRequestStatusMachine = defineStateMachine({
  name: 'message request status',
  initial: ['pending'],
  transitions: {
    // Only the recipient accepts or rejects; only the sender cancels. Blocking cancels too.
    pending: ['accepted', 'rejected', 'cancelled'],
    // Accepting creates a connection, which unlocks conversations between the two people.
    accepted: [],
    rejected: [],
    cancelled: [],
  },
});
export const MESSAGE_REQUEST_STATUSES = messageRequestStatusMachine.states;

// ── Groups ──────────────────────────────────────────────────────────────────

export const GROUP_ROLES = ['owner', 'admin', 'member'];

export const GROUP_PERMISSION_LEVELS = ['all_members', 'admins'];

export const groupInviteStatusMachine = defineStateMachine({
  name: 'group invite status',
  initial: ['pending'],
  transitions: {
    pending: ['accepted', 'declined', 'revoked', 'expired'],
    accepted: [],
    declined: [],
    revoked: [],
    expired: [],
  },
});

export const GROUP_INVITE_STATUSES = groupInviteStatusMachine.states;

export const pollStatusMachine = defineStateMachine({
  name: 'poll status',
  initial: ['open'],
  transitions: { open: ['closed'], closed: [] },
});

export const POLL_STATUSES = pollStatusMachine.states;

// ── Attachments ─────────────────────────────────────────────────────────────

/** Binary content lives in object storage; MongoDB stores only metadata and the storage key. */
export const attachmentStatusMachine = defineStateMachine({
  name: 'attachment status',
  initial: ['pending_upload'],
  transitions: {
    pending_upload: ['uploaded', 'deleted'],
    uploaded: ['attached', 'quarantined', 'deleted'],
    attached: ['quarantined', 'deleted'],
    quarantined: ['deleted'],
    deleted: [],
  },
});

export const ATTACHMENT_STATUSES = attachmentStatusMachine.states;

export const STORAGE_PROVIDERS = ['s3_compatible', 'local'];

// ── Calls ───────────────────────────────────────────────────────────────────

export const CALL_TYPES = ['audio', 'video'];

/**
 * One-to-one call lifecycle (decided by the server; clients only ask for transitions).
 * ringing → ongoing (answered) | declined | missed (no answer, busy) | cancelled (caller hung
 * up first) | failed; ongoing → completed | failed.
 */
export const callStatusMachine = defineStateMachine({
  name: 'call status',
  initial: ['ringing', 'missed'],
  transitions: {
    ringing: ['ongoing', 'declined', 'missed', 'cancelled', 'failed'],
    ongoing: ['completed', 'failed'],
    declined: [],
    missed: [],
    cancelled: [],
    completed: [],
    failed: [],
  },
});

export const CALL_STATUSES = callStatusMachine.states;
export const ACTIVE_CALL_STATUSES = ['ringing', 'ongoing'];

/** Why a call ended. */
export const CALL_END_REASONS = [
  'hangup',
  'declined',
  'cancelled',
  'no_answer',
  'busy',
  'connection_lost',
  'session_ended',
  'unavailable',
  'media_failed',
];

// ── Notifications ───────────────────────────────────────────────────────────

/**
 * Every notification the API creates.
 * - message_received: new messages in one conversation (one entry per chat, counted);
 * - message_request_*: a request to you; your request was accepted;
 * - group_member_added / group_member_removed / group_deleted: your membership (one entry per
 *   group, showing the latest change);
 * - group_role_changed: you were made admin or owner, or became a member again;
 * - group_invite_used: someone joined a group with an invitation you created;
 * - call_missed: a call to you that you didn't answer (no answer, busy, or the caller hung up).
 * An incoming call itself rings over Socket.IO and is not stored as a notification.
 */
export const NOTIFICATION_TYPES = [
  'message_received',
  'message_request_received',
  'message_request_accepted',
  'group_member_added',
  'group_member_removed',
  'group_deleted',
  'group_role_changed',
  'group_invite_used',
  'call_missed',
];

/** Preference switch that controls each type (see notificationPreferencesSchema). */
export const NOTIFICATION_CATEGORY_BY_TYPE = {
  message_received: 'messages',
  message_request_received: 'requests',
  message_request_accepted: 'requests',
  group_member_added: 'groups',
  group_member_removed: 'groups',
  group_deleted: 'groups',
  group_role_changed: 'groups',
  group_invite_used: 'groups',
  call_missed: 'calls',
};

// ── Moderation ──────────────────────────────────────────────────────────────

export const REPORT_TARGET_TYPES = ['user', 'message', 'group'];

export const REPORT_REASONS = [
  'spam',
  'harassment',
  'hate',
  'violence',
  'sexual_content',
  'self_harm',
  'impersonation',
  'other',
];

export const reportStatusMachine = defineStateMachine({
  name: 'report status',
  initial: ['open'],
  transitions: {
    open: ['under_review', 'resolved', 'dismissed'],
    under_review: ['open', 'resolved', 'dismissed'],
    // Closed reports can be reopened, e.g. on appeal.
    resolved: ['open'],
    dismissed: ['open'],
  },
});

export const REPORT_STATUSES = reportStatusMachine.states;

export const REPORT_RESOLUTION_ACTIONS = [
  'no_action',
  'warning',
  'content_removed',
  'user_suspended',
  'user_banned',
  'group_suspended',
  'group_removed',
];

/** Every audited administrative action (the audit log only accepts these). */
export const ADMIN_AUDIT_ACTIONS = [
  'admin.bootstrap',
  'user.suspend',
  'user.restore',
  'user.ban',
  'user.unban',
  'user.reactivate',
  'user.delete',
  'user.role_change',
  'session.revoke',
  'report.assign',
  'report.resolve',
  'report.dismiss',
  'report.reopen',
  'message.remove',
  'group.suspend',
  'group.unsuspend',
  'group.remove',
  'settings.update',
];

export const AUDIT_TARGET_TYPES = ['user', 'session', 'report', 'message', 'group'];

// ── Sessions ────────────────────────────────────────────────────────────────

export const SESSION_REVOCATION_REASONS = [
  'logout',
  'logout_all',
  /** A newer sign-in replaced this session (single active session per account). */
  'superseded',
  'password_changed',
  'password_reset',
  'account_deleted',
  'refresh_token_reuse',
  /** Unverified account taken over by a verified Google sign-in for the same email. */
  'account_secured',
  'admin_revoked',
];

export const AUTH_TOKEN_PURPOSES = ['email_verification', 'password_reset'];
