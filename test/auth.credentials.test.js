import { apiErrorResponseSchema, authSessionSchema } from '#shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { User } from '../src/models/user.model.js';
import {
  buildTestApp,
  registerUser,
  TEST_ORIGIN,
  TestClient,
  uniqueUser,
  useTestDatabase,
} from './helpers.js';

useTestDatabase();

const errorOf = (body) => apiErrorResponseSchema.parse(body).error;

describe('registration', () => {
  it('creates an unverified account, signs it in and emails a verification link', async () => {
    const { app, mailer } = buildTestApp();
    const client = new TestClient(app);
    const input = uniqueUser();

    const res = await client.post('/auth/register', input);

    expect(res.status).toBe(201);
    const { user, session } = authSessionSchema.parse(res.body.data);
    expect(user).toMatchObject({
      email: input.email,
      username: input.username,
      emailVerified: false,
      status: 'pending_verification',
      hasPassword: true,
    });
    expect(session.authMethod).toBe('password');
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2|refreshToken/i);
    expect(mailer.outbox.at(-1)?.text).toMatch(/\/verify-email\?token=/);
  });

  it('stores an Argon2id hash, never the password', async () => {
    const { app } = buildTestApp();
    const created = await registerUser(new TestClient(app));

    const stored = await User.findById(created.id).select('+passwordHash').lean();
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(stored)).not.toContain(created.password);
  });

  it('refuses to store anything but an Argon2id hash at the model level', async () => {
    await expect(
      User.create({ ...uniqueUser(), passwordHash: 'plaintext-password' }),
    ).rejects.toThrow(/Argon2id/);
  });

  it('rejects duplicate email and username with field-level details', async () => {
    const { app } = buildTestApp();
    const existing = await registerUser(new TestClient(app));

    const res = await new TestClient(app).post('/auth/register', {
      ...uniqueUser(),
      email: existing.email.toUpperCase(),
      username: existing.username,
    });

    expect(res.status).toBe(409);
    expect(
      errorOf(res.body)
        .details?.map((detail) => detail.path)
        .sort(),
    ).toEqual(['email', 'username']);
  });

  it('validates input with the shared schemas', async () => {
    const { app } = buildTestApp();
    const res = await new TestClient(app).post('/auth/register', {
      displayName: '',
      username: 'Bad Name',
      email: 'nope',
      password: 'short',
    });

    expect(res.status).toBe(400);
    const error = errorOf(res.body);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details?.map((detail) => detail.path).sort()).toEqual([
      'displayName',
      'email',
      'password',
      'username',
    ]);
    expect(JSON.stringify(res.body)).not.toContain('short');
  });
});

describe('login', () => {
  it('signs in with email and password (case-insensitive email)', async () => {
    const { app } = buildTestApp();
    const user = await registerUser(new TestClient(app));

    const res = await new TestClient(app).post('/auth/login', {
      email: user.email.toUpperCase(),
      password: user.password,
    });
    expect(res.status).toBe(200);
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    const { app } = buildTestApp();
    const user = await registerUser(new TestClient(app));

    const wrongPassword = await new TestClient(app).post('/auth/login', {
      email: user.email,
      password: 'not the password',
    });
    const unknownEmail = await new TestClient(app).post('/auth/login', {
      email: 'nobody@example.com',
      password: 'not the password',
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(errorOf(wrongPassword.body).message).toBe(errorOf(unknownEmail.body).message);
    expect(errorOf(wrongPassword.body).code).toBe('INVALID_CREDENTIALS');
  });

  it('blocks suspended accounts', async () => {
    const { app } = buildTestApp();
    const user = await registerUser(new TestClient(app));
    await User.updateOne(
      { _id: user.id, status: 'pending_verification' },
      { $set: { status: 'active' } },
    );
    await User.updateOne({ _id: user.id, status: 'active' }, { $set: { status: 'suspended' } });

    const res = await new TestClient(app).post('/auth/login', {
      email: user.email,
      password: user.password,
    });
    expect(res.status).toBe(403);
    expect(errorOf(res.body).code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('CSRF and origin protection', () => {
  it('rejects state-changing requests without the CSRF token', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', TEST_ORIGIN)
      .send({ email: 'a@example.com', password: 'x' });

    expect(res.status).toBe(403);
    expect(errorOf(res.body).code).toBe('CSRF_TOKEN_INVALID');
  });

  it('rejects requests from other origins even with a valid token', async () => {
    const { app } = buildTestApp();
    const client = new TestClient(app);
    const token = await client.ensureCsrf();

    const res = await client.agent
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.example.com')
      .set('X-CSRF-Token', token)
      .send({ email: 'a@example.com', password: 'x' });

    expect(res.status).toBe(403);
    expect(errorOf(res.body).code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('rejects a header token that does not match the cookie', async () => {
    const { app } = buildTestApp();
    const client = new TestClient(app);
    await client.ensureCsrf();
    const other = await new TestClient(app).ensureCsrf();

    const res = await client.agent
      .post('/api/v1/auth/login')
      .set('Origin', TEST_ORIGIN)
      .set('X-CSRF-Token', other)
      .send({ email: 'a@example.com', password: 'x' });

    expect(res.status).toBe(403);
    expect(errorOf(res.body).code).toBe('CSRF_TOKEN_INVALID');
  });

  it('keeps the CSRF cookie HttpOnly', async () => {
    const { app, ctx } = buildTestApp();
    const res = await request(app).get('/api/v1/auth/csrf');
    expect(TestClient.setCookieHeader(res, ctx.config.cookies.names.csrf)).toMatch(/HttpOnly/i);
  });
});
