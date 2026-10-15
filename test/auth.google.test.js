import * as oidc from 'openid-client';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthState } from '../src/models/oauth-state.model.js';
import { Session } from '../src/models/session.model.js';
import { User } from '../src/models/user.model.js';
import {
  buildTestApp,
  registerUser,
  TEST_ORIGIN,
  TestClient,
  uniqueUser,
  useTestDatabase,
} from './helpers.js';

// Only the network exchange with Google is replaced. State, browser binding, PKCE, nonce and
// claim checks in our code run for real; openid-client's own ID-token validation is covered
// by that library's test suite.
vi.mock('openid-client', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, authorizationCodeGrant: vi.fn() };
});
const grant = vi.mocked(oidc.authorizationCodeGrant);

useTestDatabase();

const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
};

function googleClaims(claims) {
  grant.mockResolvedValue({ claims: () => claims });
}

async function startFlow(client, query = '') {
  const res = await client.get(`/auth/google${query}`);
  expect(res.status).toBe(302);
  return new URL(String(res.headers.location));
}

beforeEach(() => {
  grant.mockReset();
});

describe('Google OAuth start', () => {
  it('redirects to Google with PKCE, state and nonce, binding the flow to this browser', async () => {
    const { app, ctx } = buildTestApp({ env: GOOGLE_ENV });
    const client = new TestClient(app);
    const res = await client.get('/auth/google');
    const url = new URL(String(res.headers.location));

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(GOOGLE_ENV.GOOGLE_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(`${TEST_ORIGIN}/api/v1/auth/google/callback`);
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    const state = url.searchParams.get('state') ?? '';
    expect(state.length).toBeGreaterThan(20);

    expect(TestClient.setCookieHeader(res, ctx.config.cookies.names.oauth)).toMatch(/HttpOnly/i);
    // The raw state is not stored, only its hash.
    expect(JSON.stringify(await OAuthState.find().lean())).not.toContain(state);
  });

  it('refuses open redirects in returnTo', async () => {
    const { app } = buildTestApp({ env: GOOGLE_ENV });
    for (const returnTo of [
      '//evil.example.com',
      'https://evil.example.com',
      '/\\evil.example.com',
    ]) {
      const res = await new TestClient(app).get(
        `/auth/google?returnTo=${encodeURIComponent(returnTo)}`,
      );
      expect(res.status).toBe(400);
    }
  });

  it('reports Google as unavailable when not configured', async () => {
    const { app } = buildTestApp();
    expect((await request(app).get('/api/v1/auth/providers')).body).toEqual({
      data: { google: false },
    });
    expect((await request(app).get('/api/v1/auth/google')).status).toBe(404);
  });
});

describe('Google OAuth callback', () => {
  it('creates a verified account, signs it in, and redirects to the app', async () => {
    const { app, ctx } = buildTestApp({ env: GOOGLE_ENV });
    const client = new TestClient(app);
    const state = (await startFlow(client)).searchParams.get('state');
    googleClaims({
      sub: 'google-sub-1',
      email: 'Grace@Example.com',
      email_verified: true,
      name: 'Grace Hopper',
    });

    const res = await client.get(`/auth/google/callback?code=auth-code&state=${state}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${TEST_ORIGIN}/chats`);
    expect(client.cookies.get(ctx.config.cookies.names.access)).toBeTruthy();
    const user = await User.findOne({ googleId: 'google-sub-1' }).lean();
    expect(user).toMatchObject({
      email: 'grace@example.com',
      status: 'active',
      displayName: 'Grace Hopper',
    });
    expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
    expect((await client.get('/auth/session')).status).toBe(200);

    // PKCE verifier, state and nonce from the stored flow were enforced in the exchange.
    const checks = grant.mock.calls[0]?.[2];
    expect(checks).toMatchObject({ expectedState: state, idTokenExpected: true });
    expect(checks?.pkceCodeVerifier).toBeTruthy();
    expect(checks?.expectedNonce).toBeTruthy();
  });

  it('state is single-use', async () => {
    const { app } = buildTestApp({ env: GOOGLE_ENV });
    const client = new TestClient(app);
    const state = (await startFlow(client)).searchParams.get('state');
    googleClaims({ sub: 'google-sub-2', email: 'x@example.com', email_verified: true });

    await client.get(`/auth/google/callback?code=c&state=${state}`);
    const replay = await client.get(`/auth/google/callback?code=c&state=${state}`);
    expect(replay.headers.location).toBe(`${TEST_ORIGIN}/login?error=google_failed`);
  });

  it('rejects a callback completed in a different browser (login CSRF)', async () => {
    const { app } = buildTestApp({ env: GOOGLE_ENV });
    const attacker = new TestClient(app);
    const state = (await startFlow(attacker)).searchParams.get('state');
    googleClaims({ sub: 'attacker', email: 'attacker@example.com', email_verified: true });

    const victim = new TestClient(app);
    const res = await victim.get(`/auth/google/callback?code=c&state=${state}`);

    expect(res.headers.location).toBe(`${TEST_ORIGIN}/login?error=google_failed`);
    expect(grant).not.toHaveBeenCalled();
    expect((await victim.get('/auth/session')).status).toBe(401);
  });

  it('rejects unknown state and unverified Google emails', async () => {
    const { app } = buildTestApp({ env: GOOGLE_ENV });
    const client = new TestClient(app);
    const unknown = await client.get('/auth/google/callback?code=c&state=not-a-real-state');
    expect(unknown.headers.location).toBe(`${TEST_ORIGIN}/login?error=google_failed`);

    const state = (await startFlow(client)).searchParams.get('state');
    googleClaims({ sub: 'google-sub-3', email: 'u@example.com', email_verified: false });
    const unverified = await client.get(`/auth/google/callback?code=c&state=${state}`);
    expect(unverified.headers.location).toBe(`${TEST_ORIGIN}/login?error=google_failed`);
    expect(await User.exists({ googleId: 'google-sub-3' })).toBeNull();
  });

  it('handles the user cancelling at Google', async () => {
    const { app } = buildTestApp({ env: GOOGLE_ENV });
    const res = await new TestClient(app).get('/auth/google/callback?error=access_denied&state=x');
    expect(res.headers.location).toBe(`${TEST_ORIGIN}/login?error=google_cancelled`);
  });

  it('secures an unverified password account registered with the same email', async () => {
    const { app } = buildTestApp({ env: GOOGLE_ENV });
    // Someone registered the victim's email but never verified it.
    const squatter = new TestClient(app);
    const registered = await registerUser(squatter, uniqueUser());

    const owner = new TestClient(app);
    const state = (await startFlow(owner)).searchParams.get('state');
    googleClaims({ sub: 'real-owner', email: registered.email, email_verified: true });
    await owner.get(`/auth/google/callback?code=c&state=${state}`);

    const user = await User.findById(registered.id).select('+passwordHash').lean();
    expect(user).toMatchObject({ googleId: 'real-owner', passwordHash: null, status: 'active' });
    expect((await squatter.get('/auth/session')).status).toBe(401);
    expect(
      await Session.countDocuments({ user: registered.id, revokedReason: 'account_secured' }),
    ).toBe(1);
    const login = await new TestClient(app).post('/auth/login', {
      email: registered.email,
      password: registered.password,
    });
    expect(login.status).toBe(401);
  });
});

describe('Google OAuth account linking and edge cases', () => {
  /** Runs a full sign-in with `claims` in `client`'s browser; returns the callback response. */
  async function signInWithGoogle(client, claims, query = '') {
    const state = (await startFlow(client, query)).searchParams.get('state');
    googleClaims(claims);
    return client.get(`/auth/google/callback?code=c&state=${state}`);
  }
  const verifiedEmailUser = async (app) => {
    const client = new TestClient(app);
    const registered = await registerUser(client, uniqueUser());
    await User.updateOne({ _id: registered.id }, { $set: { emailVerifiedAt: new Date() } });
    return { client, registered };
  };

  it('a returning Google user signs in to the same account; the old session ends', async () => {
    const { app } = buildTestApp({ env: GOOGLE_ENV });
    const claims = { sub: 'returning', email: 'ret@example.com', email_verified: true };
    const first = new TestClient(app);
    await signInWithGoogle(first, claims);
    const second = new TestClient(app);
    const res = await signInWithGoogle(second, claims);

    expect(res.headers.location).toBe(`${TEST_ORIGIN}/chats`);
    expect(await User.countDocuments({ email: 'ret@example.com' })).toBe(1);
    expect((await second.get('/auth/session')).status).toBe(200);
    // Single active session: the first browser was signed out.
    expect((await first.get('/auth/session')).status).toBe(401);
  });

  it('links a verified password account with the same email and keeps its password', async () => {
    const { app } = buildTestApp({ env: GOOGLE_ENV });
    const { registered } = await verifiedEmailUser(app);
    await signInWithGoogle(new TestClient(app), {
      sub: 'linked-sub',
      email: registered.email,
      email_verified: true,
    });

    expect(await User.countDocuments({ email: registered.email })).toBe(1);
    expect((await User.findById(registered.id).lean()).googleId).toBe('linked-sub');
    const password = await new TestClient(app).post('/auth/login', {
      email: registered.email,
      password: registered.password,
    });
    expect(password.status).toBe(200);
  });

  it('never re-links an account that belongs to a different Google account', async () => {
    const { app } = buildTestApp({ env: GOOGLE_ENV });
    const { registered } = await verifiedEmailUser(app);
    await User.updateOne({ _id: registered.id }, { $set: { googleId: 'original-sub' } });
    const intruder = new TestClient(app);
    const res = await signInWithGoogle(intruder, {
      sub: 'other-sub',
      email: registered.email,
      email_verified: true,
    });

    expect(res.headers.location).toBe(`${TEST_ORIGIN}/login?error=google_conflict`);
    expect((await User.findById(registered.id).lean()).googleId).toBe('original-sub');
    expect((await intruder.get('/auth/session')).status).toBe(401);
  });

  it('two first sign-ins at the same moment create one account', async () => {
    const { app } = buildTestApp({ env: GOOGLE_ENV });
    const claims = { sub: 'racing-sub', email: 'race@example.com', email_verified: true };
    const [a, b] = [new TestClient(app), new TestClient(app)];
    const stateA = (await startFlow(a)).searchParams.get('state');
    const stateB = (await startFlow(b)).searchParams.get('state');
    googleClaims(claims);
    const results = await Promise.all([
      a.get(`/auth/google/callback?code=c&state=${stateA}`),
      b.get(`/auth/google/callback?code=c&state=${stateB}`),
    ]);
    // Both browsers get through (the later sign-in then replaces the earlier session).
    expect(results.map((res) => res.headers.location)).toEqual([
      `${TEST_ORIGIN}/chats`,
      `${TEST_ORIGIN}/chats`,
    ]);
    expect(await User.countDocuments({ googleId: 'racing-sub' })).toBe(1);
  });

  it('suspended and banned accounts are refused before anything is changed', async () => {
    const { app } = buildTestApp({ env: GOOGLE_ENV });
    for (const [status, error] of [
      ['suspended', 'account_suspended'],
      ['banned', 'account_banned'],
    ]) {
      const registered = await registerUser(new TestClient(app), uniqueUser());
      await User.updateOne(
        { _id: registered.id, status: 'pending_verification' },
        { $set: { status } },
      );
      const res = await signInWithGoogle(new TestClient(app), {
        sub: `moderated-${status}`,
        email: registered.email,
        email_verified: true,
      });
      expect(res.headers.location).toBe(`${TEST_ORIGIN}/login?error=${error}`);
      const user = await User.findById(registered.id).select('+passwordHash').lean();
      expect(user.googleId).toBeNull();
      expect(user.passwordHash).not.toBeNull();
    }
  });

  it('a deleted account is never revived; the Google account gets a fresh one', async () => {
    const { app } = buildTestApp({ env: GOOGLE_ENV });
    const claims = { sub: 'deleted-sub', email: 'gone@example.com', email_verified: true };
    const client = new TestClient(app);
    await signInWithGoogle(client, claims);
    const original = await User.findOne({ googleId: 'deleted-sub' }).lean();
    expect((await client.delete('/account')).status).toBe(204);

    const again = new TestClient(app);
    expect((await signInWithGoogle(again, claims)).headers.location).toBe(`${TEST_ORIGIN}/chats`);
    const current = await User.findOne({ googleId: 'deleted-sub' }).lean();
    expect(String(current._id)).not.toBe(String(original._id));
    expect((await User.findById(original._id).lean()).status).toBe('deleted');
  });

  it('a failed code exchange signs nobody in and reveals nothing', async () => {
    const { app } = buildTestApp({ env: GOOGLE_ENV });
    const client = new TestClient(app);
    const state = (await startFlow(client)).searchParams.get('state');
    grant.mockRejectedValue(
      Object.assign(new Error('invalid_grant: code expired'), { name: 'ResponseBodyError' }),
    );
    const res = await client.get(`/auth/google/callback?code=expired&state=${state}`);
    expect(res.headers.location).toBe(`${TEST_ORIGIN}/login?error=google_failed`);
    expect(res.headers.location).not.toContain('invalid_grant');
    expect((await client.get('/auth/session')).status).toBe(401);
  });

  it('returns to the page the user started from (same-site paths only)', async () => {
    const { app } = buildTestApp({ env: GOOGLE_ENV });
    const res = await signInWithGoogle(
      new TestClient(app),
      { sub: 'returning-path', email: 'path@example.com', email_verified: true },
      '?returnTo=%2Fgroups',
    );
    expect(res.headers.location).toBe(`${TEST_ORIGIN}/groups`);
  });
});

describe('Google OAuth configuration', () => {
  it('requires the client id and secret together, and an https callback in production', async () => {
    const { parseEnv } = await import('../src/config/env.js');
    const base = {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://127.0.0.1:1/x',
      AUTH_SECRET: 'test-secret-that-is-long-enough-for-hkdf-0123456789',
    };
    expect(() => parseEnv({ ...base, GOOGLE_CLIENT_ID: 'only-the-id' })).toThrow(
      /GOOGLE_CLIENT_SECRET/,
    );
    expect(() =>
      parseEnv({
        ...base,
        NODE_ENV: 'production',
        WEB_APP_URL: 'https://app.example.com',
        CLIENT_ORIGINS: 'https://app.example.com',
        SMTP_HOST: 'smtp.example.com',
        ...GOOGLE_ENV,
        GOOGLE_REDIRECT_URI: 'http://app.example.com/api/v1/auth/google/callback',
      }),
    ).toThrow(/GOOGLE_REDIRECT_URI/);
    // Without Google settings the app still starts (Google sign-in is simply off).
    expect(parseEnv(base).GOOGLE_CLIENT_ID).toBeUndefined();
  });
});
