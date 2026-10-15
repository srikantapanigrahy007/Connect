import { describe, expect, it } from 'vitest';
import {
  audienceIncludes,
  privacyOf,
  profileAccess,
  readReceiptsAllowed,
  requestUnavailableReason,
  typingIndicatorsAllowed,
} from '../src/services/policy.js';

const relation = (overrides = {}) => ({
  isSelf: false,
  blockedByViewer: false,
  blockedByTarget: false,
  connected: false,
  outgoingRequest: null,
  incomingRequest: null,
  ...overrides,
});
const user = (privacy = {}, extra = {}) => ({ status: 'active', privacy, ...extra });

describe('privacy policy', () => {
  it('fills in defaults for users without settings', () => {
    expect(privacyOf({})).toMatchObject({ messagePermission: 'everyone', readReceipts: true });
  });

  it('read receipts and typing indicators work both ways', () => {
    expect(readReceiptsAllowed(user(), user())).toBe(true);
    expect(readReceiptsAllowed(user({ readReceipts: false }), user())).toBe(false);
    expect(readReceiptsAllowed(user(), user({ readReceipts: false }))).toBe(false);
    expect(typingIndicatorsAllowed(user({ typingIndicators: false }), user())).toBe(false);
    expect(typingIndicatorsAllowed(user(), user({ typingIndicators: false }))).toBe(false);
  });

  it('audiences: everyone, connections, nobody; blocks hide everything', () => {
    expect(audienceIncludes('everyone', relation())).toBe(true);
    expect(audienceIncludes('connections', relation())).toBe(false);
    expect(audienceIncludes('connections', relation({ connected: true }))).toBe(true);
    expect(audienceIncludes('nobody', relation({ connected: true }))).toBe(false);
    expect(audienceIncludes('everyone', relation({ blockedByTarget: true }))).toBe(false);
    expect(audienceIncludes('nobody', relation({ isSelf: true }))).toBe(true);
  });

  it('profile access', () => {
    expect(profileAccess(user({}, { profileVisibility: 'private' }), relation())).toBe('limited');
    expect(
      profileAccess(user({}, { profileVisibility: 'private' }), relation({ connected: true })),
    ).toBe('full');
    expect(profileAccess(user(), relation({ blockedByTarget: true }))).toBe('none');
    expect(profileAccess(user({}, { status: 'suspended' }), relation())).toBe('none');
  });

  it('never reveals a block by the recipient', () => {
    expect(requestUnavailableReason(user(), relation({ blockedByTarget: true }))).toBe(
      'not_accepting',
    );
    expect(requestUnavailableReason(user(), relation({ blockedByViewer: true }))).toBe(
      'blocked_by_you',
    );
  });
});
