import { describe, expect, it } from 'vitest';
import {
  privacySettingsUpdateSchema,
  profileUpdateSchema,
  publicProfileSchema,
  userSearchQuerySchema,
} from './profile.js';

describe('profile schemas', () => {
  it('validates profile updates and rejects reserved usernames and unknown fields', () => {
    expect(profileUpdateSchema.safeParse({ bio: '  hello  ' }).data).toEqual({ bio: 'hello' });
    expect(profileUpdateSchema.safeParse({ username: 'admin' }).success).toBe(false);
    expect(profileUpdateSchema.safeParse({ email: 'x@y.z' }).success).toBe(false);
    expect(profileUpdateSchema.safeParse({}).success).toBe(false);
    expect(profileUpdateSchema.safeParse({ bio: 'x'.repeat(161) }).success).toBe(false);
  });

  it('validates privacy updates', () => {
    expect(
      privacySettingsUpdateSchema.safeParse({ messagePermission: 'connections' }).success,
    ).toBe(true);
    expect(privacySettingsUpdateSchema.safeParse({ messagePermission: 'friends' }).success).toBe(
      false,
    );
    expect(privacySettingsUpdateSchema.safeParse({ readReceipts: 'yes' }).success).toBe(false);
  });

  it('normalises search queries', () => {
    expect(userSearchQuerySchema.parse({ q: ' @Ada_L ' }).q).toBe('ada_l');
    expect(userSearchQuerySchema.safeParse({ q: 'ada lovelace' }).success).toBe(false);
  });

  it('public profiles cannot carry an email address', () => {
    const shape = Object.keys(publicProfileSchema.shape);
    expect(shape).not.toContain('email');
    expect(shape).not.toContain('role');
    expect(shape).not.toContain('status');
  });
});
