import { Attachment } from './attachment.model.js';
import { AuditLog } from './audit-log.model.js';
import { Call } from './call.model.js';
import { AuthToken } from './auth-token.model.js';
import { BlockedUser } from './blocked-user.model.js';
import { Connection } from './connection.model.js';
import { Conversation } from './conversation.model.js';
import { E2eeDevice } from './e2ee-device.model.js';
import { E2eeOneTimeKey } from './e2ee-one-time-key.model.js';
import { E2eeToDeviceEvent } from './e2ee-to-device-event.model.js';
import { GroupInvite } from './group-invite.model.js';
import { Message } from './message.model.js';
import { MessageFlag } from './message-flag.model.js';
import { MessageRequest } from './message-request.model.js';
import { Notification } from './notification.model.js';
import { OAuthState } from './oauth-state.model.js';
import { PlatformSettings } from './platform-settings.model.js';
import { Poll, PollVote } from './poll.model.js';
import { Report } from './report.model.js';
import { RateLimitCounter } from './rate-limit-counter.model.js';
import { Session } from './session.model.js';
import { StorageUsage } from './storage-usage.model.js';
import { User } from './user.model.js';

export {
  Attachment,
  AuditLog,
  AuthToken,
  Call,
  BlockedUser,
  Connection,
  Conversation,
  E2eeDevice,
  E2eeOneTimeKey,
  E2eeToDeviceEvent,
  GroupInvite,
  Message,
  MessageFlag,
  MessageRequest,
  Notification,
  OAuthState,
  PlatformSettings,
  Poll,
  PollVote,
  RateLimitCounter,
  Report,
  Session,
  StorageUsage,
  User,
};

/** Every registered model, for index management and tests. */
export const allModels = [
  Attachment,
  User,
  Session,
  StorageUsage,
  AuthToken,
  OAuthState,
  RateLimitCounter,
  MessageRequest,
  Connection,
  BlockedUser,
  Conversation,
  Message,
  MessageFlag,
  Poll,
  PollVote,
  GroupInvite,
  AuditLog,
  Report,
  PlatformSettings,
  Notification,
  Call,
  E2eeDevice,
  E2eeOneTimeKey,
  E2eeToDeviceEvent,
];
