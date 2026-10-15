import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { apiErrorResponseSchema } from '#shared';
import sharp from 'sharp';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { User } from '../src/models/user.model.js';
import { buildTestApp, signedInUser, TestClient, useTestDatabase } from './helpers.js';

useTestDatabase();

const errorOf = (body) => apiErrorResponseSchema.parse(body).error;

const image = (format, { width = 64, height = 48 } = {}) =>
  sharp({ create: { width, height, channels: 3, background: '#7350e0' } })
    [format]()
    .toBuffer();

async function setup() {
  const built = buildTestApp();
  const { client, user } = await signedInUser(built.app);
  return { ...built, client, user };
}

const upload = (client, data, contentType, filename = 'avatar') =>
  client.upload('/me/avatar', 'avatar', data, { filename, contentType });

describe('avatar upload', () => {
  it.each([
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
  ])('accepts a real %s image and stores a 512×512 WebP outside MongoDB', async (format, type) => {
    const { app, client, user, uploadsDir } = await setup();

    const res = await upload(client, await image(format), type, `me.${format}`);
    expect(res.status).toBe(200);
    const { avatarUrl } = res.body.data;
    expect(avatarUrl).toMatch(/^\/api\/v1\/avatars\/[A-Za-z0-9_-]+\.webp$/);

    // MongoDB holds only the key; the bytes are a file on disk.
    const stored = await User.findById(user.id).lean();
    expect(Object.keys(stored.avatar).sort()).toEqual(['key', 'updatedAt']);
    expect(existsSync(join(uploadsDir, stored.avatar.key))).toBe(true);

    const served = await request(app).get(avatarUrl).buffer(true);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/webp');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    const metadata = await sharp(served.body).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: 512, height: 512 });
  });

  it('strips metadata such as EXIF from uploads', async () => {
    const { app, client } = await setup();
    const withExif = await sharp({
      create: { width: 40, height: 40, channels: 3, background: 'red' },
    })
      .jpeg()
      .withExif({ IFD0: { Copyright: 'secret-location-data' } })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const res = await upload(client, withExif, 'image/jpeg', 'photo.jpg');
    const served = await request(app).get(res.body.data.avatarUrl).buffer(true);
    const metadata = await sharp(served.body).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(served.body.includes(Buffer.from('secret-location-data'))).toBe(false);
  });

  it('rejects files over 5 MB', async () => {
    const { client, uploadsDir } = await setup();
    const big = Buffer.concat([await image('png'), Buffer.alloc(5 * 1024 * 1024 + 10)]);
    const res = await upload(client, big, 'image/png', 'big.png');
    expect(res.status).toBe(413);
    expect(errorOf(res.body).code).toBe('PAYLOAD_TOO_LARGE');
    expect(readdirSync(uploadsDir)).toEqual([]);
  });

  it('rejects types outside the allow-list', async () => {
    const { client } = await setup();
    const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'binary');
    const res = await upload(client, gif, 'image/gif', 'anim.gif');
    expect(res.status).toBe(415);
    expect(errorOf(res.body).code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('checks the actual content, not the declared type or file name', async () => {
    const { client, uploadsDir } = await setup();
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const jpeg = await image('jpeg');
    const png = await image('png');
    const corrupt = Buffer.concat([
      png.subarray(0, 33),
      Buffer.from('not really an image'.repeat(20)),
    ]);

    for (const [data, type, name] of [
      [html, 'image/png', 'evil.png'],
      [jpeg, 'image/png', 'mislabelled.png'],
      [corrupt, 'image/png', 'corrupt.png'],
    ]) {
      const res = await upload(client, data, type, name);
      expect(res.status, name).toBe(400);
      expect(errorOf(res.body).code).toBe('INVALID_FILE');
    }
    expect(readdirSync(uploadsDir)).toEqual([]);
  });

  it('replacing or removing the avatar deletes the old file', async () => {
    const { client, user, uploadsDir } = await setup();
    await upload(client, await image('png'), 'image/png');
    const first = (await User.findById(user.id).lean()).avatar.key;

    await upload(client, await image('jpeg'), 'image/jpeg');
    const second = (await User.findById(user.id).lean()).avatar.key;
    expect(second).not.toBe(first);
    expect(readdirSync(uploadsDir)).toEqual([second]);

    const removed = await client.delete('/me/avatar');
    expect(removed.status).toBe(200);
    expect(removed.body.data.avatarUrl).toBeNull();
    expect(readdirSync(uploadsDir)).toEqual([]);
  });

  it('requires a session and the CSRF token, and needs a file', async () => {
    const { app, client } = await setup();
    const anonymous = new TestClient(app);
    expect((await upload(anonymous, await image('png'), 'image/png')).status).toBe(401);
    const noCsrf = await client.agent
      .put('/api/v1/me/avatar')
      .set('Origin', 'http://localhost:5173')
      .attach('avatar', await image('png'), { filename: 'a.png', contentType: 'image/png' });
    expect(noCsrf.status).toBe(403);
    expect((await client.send('put', '/me/avatar')).status).toBe(400);
  });

  it('serves only valid avatar keys', async () => {
    const { app } = await setup();
    for (const path of [
      '../../package.json',
      '..%2F..%2Fpackage.json',
      'missing-key-aaaaaaaaaaaaaaa.webp',
    ]) {
      expect((await request(app).get(`/api/v1/avatars/${path}`)).status).toBe(404);
    }
  });

  it('shows the avatar on public profiles and the signed-in user', async () => {
    const { app, client, user } = await setup();
    const { client: viewer } = await signedInUser(app);
    const { avatarUrl } = (await upload(client, await image('png'), 'image/png')).body.data;

    expect((await viewer.get(`/users/${user.username}`)).body.data.avatarUrl).toBe(avatarUrl);
    expect((await client.get('/auth/session')).body.data.user.avatarUrl).toBe(avatarUrl);
  });

  it('deleting the account deletes the avatar file and cancels pending requests', async () => {
    const { app, client, user, uploadsDir } = await setup();
    const { client: other, user: otherUser } = await signedInUser(app);
    await upload(client, await image('png'), 'image/png');
    await other.post('/message-requests', { username: user.username });

    expect((await client.delete('/account')).status).toBe(204);
    expect(readdirSync(uploadsDir)).toEqual([]);
    const sent = await other.get('/message-requests?box=sent');
    expect(sent.body.data[0].status).toBe('cancelled');
    expect(otherUser.id).toBeTruthy();
  });
});
