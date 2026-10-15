import { apiErrorResponseSchema } from '#shared';
import { describe, expect, it } from 'vitest';
import { AuthToken } from '../src/models/auth-token.model.js';
import { Session } from '../src/models/session.model.js';
import { User } from '../src/models/user.model.js';
import {
  buildTestApp,
  eventually,
  linkToken,
  registerUser,
  TestClient,
  useTestDatabase,
} from './helpers.js';

useTestDatabase();

const errorCode = (body) => apiErrorResponseSchema.parse(body).error.code;
const NEW_PASSWORD = 'a brand new passphrase';

describe('email verification', () => {
  it('verifies the email once and activates the account', async () => {
    const { app, mailer } = buildTestApp();
    const client = new TestClient(app);
    const user = await registerUser(client);
    const token = linkToken(mailer.outbox.at(-1)?.text ?? '', '/verify-email');

    expect((await client.post('/auth/email/verify', { token })).status).toBe(200);
    const stored = await User.findById(user.id).lean();
    expect(stored?.status).toBe('active');
    expect(stored?.emailVerifiedAt).toBeInstanceOf(Date);

    const reuse = await client.post('/auth/email/verify', { token });
    expect(reuse.status).toBe(400);
    expect(errorCode(reuse.body)).toBe('INVALID_TOKEN');
  });

  it('stores only the hash of email-link tokens', async () => {
    const { app, mailer } = buildTestApp();
    const user = await registerUser(new TestClient(app));
    const token = linkToken(mailer.outbox.at(-1)?.text ?? '', '/verify-email');

    const stored = await AuthToken.find({ user: user.id }).lean();
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it('resend invalidates the previous link', async () => {
    const { app, mailer } = buildTestApp();
    const client = new TestClient(app);
    await registerUser(client);
    const first = linkToken(mailer.outbox.at(-1)?.text ?? '', '/verify-email');

    expect((await client.post('/auth/email/resend')).status).toBe(202);
    const second = linkToken(mailer.outbox.at(-1)?.text ?? '', '/verify-email');

    expect((await client.post('/auth/email/verify', { token: first })).status).toBe(400);
    expect((await client.post('/auth/email/verify', { token: second })).status).toBe(200);
  });
});

describe('forgot and reset password', () => {
  it('responds identically for registered and unknown emails', async () => {
    const { app, mailer } = buildTestApp();
    const user = await registerUser(new TestClient(app));
    const sentBefore = mailer.outbox.length;

    const known = await new TestClient(app).post('/auth/password/forgot', { email: user.email });
    const unknown = await new TestClient(app).post('/auth/password/forgot', {
      email: 'ghost@example.com',
    });

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    // Only the real account receives an email (sent in the background).
    await eventually(() => mailer.outbox.length > sentBefore);
    expect(mailer.outbox.filter((mail) => mail.to === 'ghost@example.com')).toHaveLength(0);
  });

  it('resets the password once, signs out every session, and the old password stops working', async () => {
    const { app, mailer } = buildTestApp();
    const signedIn = new TestClient(app);
    const user = await registerUser(signedIn);

    await new TestClient(app).post('/auth/password/forgot', { email: user.email });
    const resetMail = await eventually(() =>
      mailer.outbox.find((mail) => mail.text.includes('/reset-password')),
    );
    const token = linkToken(resetMail.text, '/reset-password');

    const reset = await new TestClient(app).post('/auth/password/reset', {
      token,
      password: NEW_PASSWORD,
    });
    expect(reset.status).toBe(200);

    expect((await signedIn.get('/auth/session')).status).toBe(401);
    expect(await Session.countDocuments({ user: user.id, revokedAt: null })).toBe(0);
    expect(
      (
        await new TestClient(app).post('/auth/login', {
          email: user.email,
          password: user.password,
        })
      ).status,
    ).toBe(401);
    expect(
      (await new TestClient(app).post('/auth/login', { email: user.email, password: NEW_PASSWORD }))
        .status,
    ).toBe(200);

    const reuse = await new TestClient(app).post('/auth/password/reset', {
      token,
      password: 'yet another passphrase',
    });
    expect(reuse.status).toBe(400);
    expect(errorCode(reuse.body)).toBe('INVALID_TOKEN');
  });

  it('rejects expired reset links', async () => {
    const { app, mailer } = buildTestApp();
    const user = await registerUser(new TestClient(app));
    await new TestClient(app).post('/auth/password/forgot', { email: user.email });
    const resetMail = await eventually(() =>
      mailer.outbox.find((mail) => mail.text.includes('/reset-password')),
    );
    const token = linkToken(resetMail.text, '/reset-password');
    await AuthToken.updateMany(
      { user: user.id },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    );

    const res = await new TestClient(app).post('/auth/password/reset', {
      token,
      password: NEW_PASSWORD,
    });
    expect(res.status).toBe(400);
  });
});

describe('change password', () => {
  it('requires the current password', async () => {
    const { app } = buildTestApp();
    const client = new TestClient(app);
    await registerUser(client);

    const res = await client.post('/auth/password/change', {
      currentPassword: 'wrong',
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(401);
    expect(errorCode(res.body)).toBe('INVALID_CREDENTIALS');
  });

  it('changes the password, revokes old sessions and keeps this device signed in', async () => {
    const { app, ctx } = buildTestApp();
    const client = new TestClient(app);
    const user = await registerUser(client);
    const oldRefresh = client.cookies.get(ctx.config.cookies.names.refresh);

    const res = await client.post('/auth/password/change', {
      currentPassword: user.password,
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(client.cookies.get(ctx.config.cookies.names.refresh)).not.toBe(oldRefresh);
    expect((await client.get('/auth/session')).status).toBe(200);
    expect(await Session.countDocuments({ user: user.id, revokedReason: 'password_changed' })).toBe(
      1,
    );
    expect(
      (await new TestClient(app).post('/auth/login', { email: user.email, password: NEW_PASSWORD }))
        .status,
    ).toBe(200);
  });
});

describe('recent authentication and account deletion', () => {
  async function ageAuthentication(userId) {
    await Session.updateMany(
      { user: userId },
      { $set: { authenticatedAt: new Date(Date.now() - 60 * 60_000) } },
    );
  }

  it('requires re-authentication when the last sign-in is old', async () => {
    const { app } = buildTestApp();
    const client = new TestClient(app);
    const user = await registerUser(client);
    await ageAuthentication(user.id);

    const res = await client.delete('/account');
    expect(res.status).toBe(403);
    expect(errorCode(res.body)).toBe('REAUTHENTICATION_REQUIRED');
    expect((await User.findById(user.id).lean())?.status).not.toBe('deleted');
  });

  it('re-authentication with the wrong password does not unlock sensitive actions', async () => {
    const { app } = buildTestApp();
    const client = new TestClient(app);
    const user = await registerUser(client);
    await ageAuthentication(user.id);

    expect((await client.post('/auth/reauthenticate', { password: 'wrong' })).status).toBe(401);
    expect((await client.delete('/account')).status).toBe(403);
  });

  it('deletes the account after re-authentication: data scrubbed, sessions revoked, login impossible', async () => {
    const { app } = buildTestApp();
    const client = new TestClient(app);
    const user = await registerUser(client);
    await ageAuthentication(user.id);

    expect((await client.post('/auth/reauthenticate', { password: user.password })).status).toBe(
      200,
    );
    expect((await client.delete('/account')).status).toBe(204);

    const stored = await User.findById(user.id).select('+passwordHash').lean();
    expect(stored).toMatchObject({
      status: 'deleted',
      email: null,
      username: null,
      passwordHash: null,
      displayName: 'Deleted user',
    });
    expect(await Session.countDocuments({ user: user.id, revokedAt: null })).toBe(0);
    expect((await client.get('/auth/session')).status).toBe(401);
    expect(
      (
        await new TestClient(app).post('/auth/login', {
          email: user.email,
          password: user.password,
        })
      ).status,
    ).toBe(401);

    // The email and username can be used again.
    await registerUser(new TestClient(app), { email: user.email, username: user.username });
  });
});
