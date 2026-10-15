import { blockedUserSchema } from '#shared';
import { describe, expect, it } from 'vitest';
import { MessageRequest } from '../src/models/message-request.model.js';
import { buildTestApp, sendRequest, signedInUser, useTestDatabase } from './helpers.js';

useTestDatabase();

async function pair() {
  const { app } = buildTestApp();
  return { alice: await signedInUser(app), bob: await signedInUser(app) };
}

describe('blocking', () => {
  it('lists blocked users and is idempotent', async () => {
    const { alice, bob } = await pair();
    expect((await alice.client.post('/blocks', { username: bob.user.username })).status).toBe(201);
    expect((await alice.client.post('/blocks', { username: bob.user.username })).status).toBe(201);

    const list = await alice.client.get('/blocks');
    expect(list.body.data).toHaveLength(1);
    expect(blockedUserSchema.parse(list.body.data[0]).user.username).toBe(bob.user.username);
    expect(JSON.stringify(list.body)).not.toContain(bob.user.email);
  });

  it('cancels pending requests between the two people', async () => {
    const { alice, bob } = await pair();
    const { id } = (await sendRequest(bob, alice)).body.data;
    await alice.client.post('/blocks', { username: bob.user.username });
    expect((await MessageRequest.findById(id).lean()).status).toBe('cancelled');
  });

  it('hides the blocker from the blocked person (profile and search) but not vice versa', async () => {
    const { alice, bob } = await pair();
    await alice.client.post('/blocks', { username: bob.user.username });

    expect((await bob.client.get(`/users/${alice.user.username}`)).status).toBe(404);
    expect((await bob.client.get(`/users/search?q=${alice.user.username}`)).body.data).toEqual([]);

    const view = await alice.client.get(`/users/${bob.user.username}`);
    expect(view.status).toBe(200);
    expect(view.body.data.relationship).toMatchObject({
      blockedByYou: true,
      canSendRequest: false,
    });
    expect((await alice.client.get(`/users/search?q=${bob.user.username}`)).body.data).toEqual([]);
  });

  it('unblocking restores visibility and requests', async () => {
    const { alice, bob } = await pair();
    await alice.client.post('/blocks', { username: bob.user.username });

    expect((await alice.client.delete(`/blocks/${bob.user.id}`)).status).toBe(204);
    expect((await alice.client.delete(`/blocks/${bob.user.id}`)).status).toBe(404);
    expect((await bob.client.get(`/users/${alice.user.username}`)).status).toBe(200);
    expect((await sendRequest(bob, alice)).status).toBe(201);
  });

  it('refuses to block yourself or unknown users', async () => {
    const { alice } = await pair();
    expect((await alice.client.post('/blocks', { username: alice.user.username })).status).toBe(
      400,
    );
    expect((await alice.client.post('/blocks', { username: 'no_such_user' })).status).toBe(404);
  });
});
