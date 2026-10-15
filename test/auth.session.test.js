import { apiErrorResponseSchema } from '#shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { Session } from '../src/models/session.model.js';
import { User } from '../src/models/user.model.js';
import { hashToken } from '../src/security/tokens.js';
import { buildTestApp, registerUser, TestClient, useTestDatabase } from './helpers.js';

useTestDatabase();

const errorCode = (body) => apiErrorResponseSchema.parse(body).error.code;

describe('single active session', () => {
  it('a second login invalidates the first session immediately', async () => {
    const { app, ctx } = buildTestApp();
    const { names } = ctx.config.cookies;
    const first = new TestClient(app);
    const user = await registerUser(first);

    expect((await first.get('/auth/session')).status).toBe(200);

    const second = new TestClient(app);
    const login = await second.post('/auth/login', { email: user.email, password: user.password });
    expect(login.status).toBe(200);

    // The first device's still-unexpired access token is rejected...
    const stale = await first.get('/auth/session');
    expect(stale.status).toBe(401);
    expect(errorCode(stale.body)).toBe('SESSION_SUPERSEDED');

    // ...and its refresh token can no longer mint new access tokens.
    const refresh = await first.post('/auth/refresh');
    expect(refresh.status).toBe(401);
    expect(errorCode(refresh.body)).toBe('SESSION_SUPERSEDED');

    // The new device keeps working.
    expect((await second.get('/auth/session')).status).toBe(200);
    expect(second.cookies.get(names.access)).toBeTruthy();

    const sessions = await Session.find({ user: user.id }).lean();
    expect(sessions.filter((session) => session.revokedAt === null)).toHaveLength(1);
    expect(sessions.find((session) => session.revokedReason === 'superseded')).toBeDefined();
  });

  it('concurrent logins leave exactly one valid session', async () => {
    const { app } = buildTestApp();
    const user = await registerUser(new TestClient(app));

    const clients = Array.from({ length: 5 }, () => new TestClient(app));
    const results = await Promise.all(
      clients.map((client) =>
        client.post('/auth/login', { email: user.email, password: user.password }),
      ),
    );
    // Every attempt either succeeded or was told to retry; none crashed.
    expect(results.every((res) => res.status === 200 || res.status === 409)).toBe(true);

    const checks = await Promise.all(clients.map((client) => client.get('/auth/session')));
    expect(checks.filter((res) => res.status === 200)).toHaveLength(1);

    const stored = await User.findById(user.id).lean();
    const active = await Session.find({ user: user.id, revokedAt: null }).lean();
    expect(active).toHaveLength(1);
    expect(String(stored?.activeSessionId)).toBe(String(active[0]?._id));
  });
});

describe('access and refresh tokens', () => {
  it('issues HttpOnly SameSite=Lax cookies and keeps the refresh cookie on the auth path', async () => {
    const { app, ctx } = buildTestApp();
    const client = new TestClient(app);
    const user = await registerUser(client);
    const res = await client.post('/auth/login', { email: user.email, password: user.password });

    const access = TestClient.setCookieHeader(res, ctx.config.cookies.names.access) ?? '';
    const refresh = TestClient.setCookieHeader(res, ctx.config.cookies.names.refresh) ?? '';
    expect(access).toMatch(/HttpOnly/i);
    expect(access).toMatch(/SameSite=Lax/i);
    expect(access).toMatch(/Path=\//);
    expect(refresh).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/Path=\/api\/v1\/auth/);
  });

  it('stores only a hash of the refresh token', async () => {
    const { app, ctx } = buildTestApp();
    const client = new TestClient(app);
    const user = await registerUser(client);
    const refreshToken = client.cookies.get(ctx.config.cookies.names.refresh) ?? '';

    const session = await Session.findOne({ user: user.id }).select('+refreshTokenHash').lean();
    expect(session?.refreshTokenHash).toBe(hashToken(refreshToken));
    expect(JSON.stringify(session)).not.toContain(refreshToken);
  });

  it('rotates the refresh token on every refresh', async () => {
    const { app, ctx } = buildTestApp();
    const { names } = ctx.config.cookies;
    const client = new TestClient(app);
    await registerUser(client);
    const before = client.cookies.get(names.refresh);

    const res = await client.post('/auth/refresh');
    expect(res.status).toBe(200);
    expect(client.cookies.get(names.refresh)).not.toBe(before);
    expect((await client.get('/auth/session')).status).toBe(200);
  });

  it('revokes the session when a rotated refresh token is replayed', async () => {
    const { app, ctx } = buildTestApp();
    const { names } = ctx.config.cookies;
    const victim = new TestClient(app);
    const user = await registerUser(victim);
    const stolen = victim.cookies.get(names.refresh) ?? '';

    expect((await victim.post('/auth/refresh')).status).toBe(200);

    // An attacker replays the old token (grace period is 0 in tests).
    const attacker = new TestClient(app);
    const replay = await attacker.send('post', '/auth/refresh', undefined, (test) =>
      test.set('Cookie', `${names.refresh}=${stolen}`),
    );
    expect(replay.status).toBe(401);
    expect(errorCode(replay.body)).toBe('REFRESH_TOKEN_REUSED');

    // The legitimate session is revoked too, forcing a fresh sign-in.
    const after = await victim.get('/auth/session');
    expect(after.status).toBe(401);
    expect((await Session.findOne({ user: user.id }).lean())?.revokedReason).toBe(
      'refresh_token_reuse',
    );
  });

  it('reports an expired access token distinctly so clients know to refresh', async () => {
    const { app, ctx } = buildTestApp();
    const client = new TestClient(app);
    await registerUser(client);
    const { SignJWT } = await import('jose');
    const expired = await new SignJWT({ sid: '0'.repeat(24) })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('0'.repeat(24))
      .setIssuer('connect-api')
      .setAudience('connect')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 700)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(ctx.config.auth.accessTokenKey);

    // A fresh request, so the client's own valid cookie isn't sent alongside.
    const res = await request(app)
      .get('/api/v1/auth/session')
      .set('Cookie', `${ctx.config.cookies.names.access}=${expired}`);
    expect(res.status).toBe(401);
    expect(errorCode(res.body)).toBe('ACCESS_TOKEN_EXPIRED');
  });

  it('rejects tokens signed with another key', async () => {
    const { app, ctx } = buildTestApp();
    const { SignJWT } = await import('jose');
    const forged = await new SignJWT({ sid: '0'.repeat(24) })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('0'.repeat(24))
      .setIssuer('connect-api')
      .setAudience('connect')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('attacker-key-attacker-key-attacker-key'));

    const res = await request(app)
      .get('/api/v1/auth/session')
      .set('Cookie', `${ctx.config.cookies.names.access}=${forged}`);
    expect(res.status).toBe(401);
    expect(errorCode(res.body)).toBe('UNAUTHORIZED');
  });
});

describe('logout', () => {
  it('logout revokes the current session and clears cookies', async () => {
    const { app, ctx } = buildTestApp();
    const client = new TestClient(app);
    const user = await registerUser(client);

    const res = await client.post('/auth/logout');
    expect(res.status).toBe(204);
    expect(client.cookies.get(ctx.config.cookies.names.access)).toBe('');
    expect((await client.get('/auth/session')).status).toBe(401);
    expect((await Session.findOne({ user: user.id }).lean())?.revokedReason).toBe('logout');
  });

  it('logout-all revokes every session of the account', async () => {
    const { app } = buildTestApp();
    const client = new TestClient(app);
    const user = await registerUser(client);

    expect((await client.post('/auth/logout-all')).status).toBe(204);
    expect(await Session.countDocuments({ user: user.id, revokedAt: null })).toBe(0);
    expect((await User.findById(user.id).lean())?.activeSessionId).toBeNull();
    expect((await client.post('/auth/refresh')).status).toBe(401);
  });
});
