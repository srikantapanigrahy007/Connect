import {
  apiErrorResponseSchema,
  ownProfileSchema,
  paginationMetaSchema,
  publicProfileSchema,
  userCardSchema,
} from '#shared';
import { describe, expect, it } from 'vitest';
import { User } from '../src/models/user.model.js';
import { buildTestApp, connect, signedInUser, useTestDatabase } from './helpers.js';

useTestDatabase();

const errorOf = (body) => apiErrorResponseSchema.parse(body).error;

/** Fields that must never appear in anything another person can read. */
const PRIVATE_FIELDS = [
  'email',
  'emailVerified',
  'emailVerifiedAt',
  'passwordHash',
  'hasPassword',
  'googleId',
  'googleLinked',
  'role',
  'status',
  'activeSessionId',
  'lastLoginAt',
  'privacy',
  'sessions',
  'refreshTokenHash',
];

function expectNoPrivateFields(value) {
  const json = JSON.stringify(value);
  for (const field of PRIVATE_FIELDS) expect(json).not.toContain(`"${field}"`);
}

describe('your own profile', () => {
  it('returns your profile and privacy settings with safe defaults', async () => {
    const { app } = buildTestApp();
    const { client, user } = await signedInUser(app);

    const res = await client.get('/me/profile');
    expect(res.status).toBe(200);
    const profile = ownProfileSchema.parse(res.body.data);
    expect(profile).toMatchObject({
      username: user.username,
      bio: '',
      profileVisibility: 'public',
    });
    expect(profile.privacy).toEqual({
      messagePermission: 'everyone',
      onlineStatusVisibility: 'connections',
      lastSeenVisibility: 'connections',
      readReceipts: true,
      typingIndicators: true,
    });
  });

  it('updates name, username, bio and visibility', async () => {
    const { app } = buildTestApp();
    const { client } = await signedInUser(app);

    const res = await client.patch('/me/profile', {
      displayName: 'Ada L.',
      username: 'ada_new_name',
      bio: '  Mathematician  ',
      profileVisibility: 'private',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      displayName: 'Ada L.',
      username: 'ada_new_name',
      bio: 'Mathematician',
      profileVisibility: 'private',
    });
    expect((await client.get('/auth/session')).body.data.user.username).toBe('ada_new_name');
  });

  it('validates input: format, reserved and taken usernames, bio length, unknown fields', async () => {
    const { app } = buildTestApp();
    const { client } = await signedInUser(app);
    const { user: other } = await signedInUser(app);

    const cases = [
      [{ username: 'Bad Name' }, 400, 'VALIDATION_ERROR'],
      [{ username: 'admin' }, 400, 'VALIDATION_ERROR'],
      [{ username: other.username }, 409, 'CONFLICT'],
      [{ bio: 'x'.repeat(161) }, 400, 'VALIDATION_ERROR'],
      [{ email: 'new@example.com' }, 400, 'VALIDATION_ERROR'],
      [{ role: 'admin' }, 400, 'VALIDATION_ERROR'],
      [{}, 400, 'VALIDATION_ERROR'],
    ];
    for (const [body, status, code] of cases) {
      const res = await client.patch('/me/profile', body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(errorOf(res.body).code).toBe(code);
    }
    expect((await User.findById((await client.get('/me/profile')).body.data.id).lean()).role).toBe(
      'user',
    );
  });

  it('updates privacy settings and rejects invalid values', async () => {
    const { app } = buildTestApp();
    const { client } = await signedInUser(app);

    const res = await client.patch('/me/privacy', {
      messagePermission: 'connections',
      readReceipts: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.privacy).toMatchObject({
      messagePermission: 'connections',
      readReceipts: false,
      typingIndicators: true,
    });
    expect((await client.patch('/me/privacy', { messagePermission: 'friends' })).status).toBe(400);
  });

  it('requires a session and the CSRF token', async () => {
    const { app } = buildTestApp();
    const { client } = await signedInUser(app);
    const noCsrf = await client.agent
      .patch('/api/v1/me/profile')
      .set('Origin', 'http://localhost:5173')
      .send({ bio: 'x' });
    expect(noCsrf.status).toBe(403);

    const { TestClient } = await import('./helpers.js');
    expect((await new TestClient(app).get('/me/profile')).status).toBe(401);
  });
});

describe('viewing other profiles', () => {
  it('shows public profiles in full but never private account data', async () => {
    const { app } = buildTestApp();
    const viewer = await signedInUser(app);
    const owner = await signedInUser(app);
    await owner.client.patch('/me/profile', { bio: 'Hello there' });

    const res = await viewer.client.get(`/users/${owner.user.username}`);
    expect(res.status).toBe(200);
    const profile = publicProfileSchema.parse(res.body.data);
    expect(profile).toMatchObject({ access: 'full', bio: 'Hello there' });
    expect(profile.joinedAt).not.toBeNull();
    expect(profile.relationship).toMatchObject({
      isSelf: false,
      connected: false,
      canSendRequest: true,
    });
    expectNoPrivateFields(res.body);
    expect(JSON.stringify(res.body)).not.toContain(owner.user.email);
  });

  it('limits private profiles to name, username and avatar for non-connections', async () => {
    const { app } = buildTestApp();
    const viewer = await signedInUser(app);
    const owner = await signedInUser(app);
    await owner.client.patch('/me/profile', { bio: 'Secret bio', profileVisibility: 'private' });

    const limited = publicProfileSchema.parse(
      (await viewer.client.get(`/users/${owner.user.username}`)).body.data,
    );
    expect(limited).toMatchObject({ access: 'limited', bio: null, joinedAt: null });

    await connect(viewer, owner);
    const full = publicProfileSchema.parse(
      (await viewer.client.get(`/users/${owner.user.username}`)).body.data,
    );
    expect(full).toMatchObject({ access: 'full', bio: 'Secret bio' });
    expect(full.relationship.connected).toBe(true);
  });

  it('returns 404 for unknown, deleted and suspended accounts alike', async () => {
    const { app } = buildTestApp();
    const viewer = await signedInUser(app);
    const suspended = await signedInUser(app);
    await User.updateOne(
      { _id: suspended.user.id, status: 'pending_verification' },
      { $set: { status: 'active' } },
    );
    await User.updateOne(
      { _id: suspended.user.id, status: 'active' },
      { $set: { status: 'suspended' } },
    );

    for (const username of ['nobody_here', suspended.user.username]) {
      const res = await viewer.client.get(`/users/${username}`);
      expect(res.status).toBe(404);
      expect(errorOf(res.body).message).toBe("We couldn't find that person.");
    }
  });

  it('shows presence only to the audience the owner chose', async () => {
    const { app, ctx } = buildTestApp();
    const stranger = await signedInUser(app);
    const friend = await signedInUser(app);
    const owner = await signedInUser(app);
    await connect(friend, owner);
    ctx.presence.connected(owner.user.id);
    await User.updateOne({ _id: owner.user.id }, { $set: { lastSeenAt: new Date() } });

    const presenceFor = async (viewer) =>
      (await viewer.client.get(`/users/${owner.user.username}`)).body.data.presence;

    // Default: connections only.
    expect(await presenceFor(stranger)).toEqual({ online: null, lastSeenAt: null });
    expect((await presenceFor(friend)).online).toBe(true);
    expect((await presenceFor(friend)).lastSeenAt).not.toBeNull();

    await owner.client.patch('/me/privacy', {
      onlineStatusVisibility: 'everyone',
      lastSeenVisibility: 'nobody',
    });
    expect(await presenceFor(stranger)).toEqual({ online: true, lastSeenAt: null });
    expect((await presenceFor(friend)).lastSeenAt).toBeNull();

    await owner.client.patch('/me/privacy', { onlineStatusVisibility: 'nobody' });
    expect((await presenceFor(friend)).online).toBeNull();
  });
});

describe('user search', () => {
  async function setup() {
    const { app } = buildTestApp();
    const viewer = await signedInUser(app);
    const stamp = Date.now().toString(36);
    const make = async (suffix, visibility = 'public') => {
      const result = await signedInUser(app, { username: `zed_${stamp}_${suffix}` });
      if (visibility === 'private')
        await result.client.patch('/me/profile', { profileVisibility: 'private' });
      return result;
    };
    return { app, viewer, stamp, make };
  }

  it('finds public profiles by partial username, and private ones only by exact username', async () => {
    const { viewer, stamp, make } = await setup();
    const alpha = await make('alpha');
    const beta = await make('beta');
    const hidden = await make('hidden', 'private');

    const partial = await viewer.client.get(`/users/search?q=@ZED_${stamp}`);
    expect(partial.status).toBe(200);
    const usernames = partial.body.data.map((card) => userCardSchema.parse(card).username);
    expect(usernames).toEqual([alpha.user.username, beta.user.username]);
    expectNoPrivateFields(partial.body);

    const exact = await viewer.client.get(`/users/search?q=${hidden.user.username}`);
    expect(exact.body.data.map((card) => card.username)).toEqual([hidden.user.username]);
  });

  it('paginates with a cursor', async () => {
    const { viewer, stamp, make } = await setup();
    for (const suffix of ['a', 'b', 'c']) await make(suffix);

    const first = await viewer.client.get(`/users/search?q=zed_${stamp}&limit=2`);
    const meta = paginationMetaSchema.parse(first.body.meta);
    expect(first.body.data).toHaveLength(2);
    expect(meta.hasMore).toBe(true);
    const second = await viewer.client.get(
      `/users/search?q=zed_${stamp}&limit=2&cursor=${meta.nextCursor}`,
    );
    expect(second.body.data.map((card) => card.username)).toEqual([`zed_${stamp}_c`]);
    expect(second.body.meta.hasMore).toBe(false);
  });

  it('rejects invalid queries', async () => {
    const { viewer } = await setup();
    expect((await viewer.client.get('/users/search?q=ada%20lovelace')).status).toBe(400);
    expect((await viewer.client.get('/users/search')).status).toBe(400);
  });
});
