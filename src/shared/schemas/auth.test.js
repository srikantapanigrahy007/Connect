import { describe, expect, it } from 'vitest';
import { emailSchema, loginRequestSchema, registerRequestSchema, usernameSchema } from './auth.js';

describe('auth schemas', () => {
  it('normalises email addresses', () => {
    expect(emailSchema.parse('  Ada@Example.COM ')).toBe('ada@example.com');
    expect(emailSchema.safeParse('not-an-email').success).toBe(false);
  });

  it.each(['ada', 'ada_lovelace', 'a1b2c3'])('accepts username %s', (username) => {
    expect(usernameSchema.safeParse(username).success).toBe(true);
  });

  it.each(['ab', 'Ada', '1ada', 'ada-l', 'ada lovelace', 'a'.repeat(31)])(
    'rejects username %s',
    (username) => {
      expect(usernameSchema.safeParse(username).success).toBe(false);
    },
  );

  it('requires a strong-enough password only at registration', () => {
    expect(loginRequestSchema.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true);
    expect(
      registerRequestSchema.safeParse({
        displayName: 'Ada',
        username: 'ada',
        email: 'a@b.co',
        password: 'short',
      }).success,
    ).toBe(false);
  });
});
