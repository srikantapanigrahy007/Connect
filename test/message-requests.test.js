import { apiErrorResponseSchema, messageRequestSchema } from '#shared';
import { describe, expect, it } from 'vitest';
import { Connection } from '../src/models/connection.model.js';
import { MessageRequest } from '../src/models/message-request.model.js';
import { pairKey } from '../src/utils/pair-key.js';
import { buildTestApp, connect, sendRequest, signedInUser, useTestDatabase } from './helpers.js';

useTestDatabase();

const errorOf = (body) => apiErrorResponseSchema.parse(body).error;

async function pair() {
  const { app } = buildTestApp();
  const alice = await signedInUser(app);
  const bob = await signedInUser(app);
  return { app, alice, bob };
}

describe('sending message requests', () => {
  it('creates a pending request with an optional note', async () => {
    const { alice, bob } = await pair();
    const res = await sendRequest(alice, bob, 'Hi Bob!');

    expect(res.status).toBe(201);
    const request = messageRequestSchema.parse(res.body.data);
    expect(request).toMatchObject({ status: 'pending', direction: 'sent', note: 'Hi Bob!' });
    expect(request.otherUser.username).toBe(bob.user.username);
    expect(JSON.stringify(res.body)).not.toContain(bob.user.email);
  });

  it('prevents duplicate pending requests in either direction', async () => {
    const { alice, bob } = await pair();
    expect((await sendRequest(alice, bob)).status).toBe(201);

    const again = await sendRequest(alice, bob);
    expect(again.status).toBe(409);
    expect(errorOf(again.body).code).toBe('REQUEST_ALREADY_PENDING');

    const reverse = await sendRequest(bob, alice);
    expect(reverse.status).toBe(409);
    expect(errorOf(reverse.body).code).toBe('REQUEST_ALREADY_PENDING');
  });

  it('allows only one pending request when two are sent at the same time', async () => {
    const { alice, bob } = await pair();
    const results = await Promise.all([
      sendRequest(alice, bob),
      sendRequest(bob, alice),
      sendRequest(alice, bob),
    ]);
    expect(results.filter((res) => res.status === 201)).toHaveLength(1);
    expect(
      await MessageRequest.countDocuments({
        pairKey: pairKey(alice.user.id, bob.user.id),
        status: 'pending',
      }),
    ).toBe(1);
  });

  it.each([
    ['everyone', 201],
    ['connections', 403],
    ['nobody', 403],
  ])('respects "who can message me" = %s for non-connections', async (setting, status) => {
    const { alice, bob } = await pair();
    await bob.client.patch('/me/privacy', { messagePermission: setting });

    const res = await sendRequest(alice, bob);
    expect(res.status).toBe(status);
    if (status === 403) expect(errorOf(res.body).code).toBe('MESSAGING_NOT_ALLOWED');
  });

  it('works the same for private profiles: a request is required and allowed by default', async () => {
    const { alice, bob } = await pair();
    await bob.client.patch('/me/profile', { profileVisibility: 'private' });
    expect((await sendRequest(alice, bob)).status).toBe(201);
  });

  it('refuses requests to yourself, to unknown people, and once connected', async () => {
    const { alice, bob } = await pair();
    expect((await sendRequest(alice, alice)).status).toBe(400);
    expect(
      (await alice.client.post('/message-requests', { username: 'no_such_user' })).status,
    ).toBe(404);

    await connect(alice, bob);
    const res = await sendRequest(alice, bob);
    expect(res.status).toBe(409);
    expect(errorOf(res.body).code).toBe('ALREADY_CONNECTED');
  });

  it('blocks requests in both directions without revealing the block to the blocked person', async () => {
    const { alice, bob } = await pair();
    await bob.client.post('/blocks', { username: alice.user.username });

    // Alice (blocked) is told Bob doesn't exist.
    const fromBlocked = await sendRequest(alice, bob);
    expect(fromBlocked.status).toBe(404);
    expect(errorOf(fromBlocked.body).message).toBe("We couldn't find that person.");

    // Bob (blocker) is told to unblock first.
    const fromBlocker = await sendRequest(bob, alice);
    expect(fromBlocker.status).toBe(409);
    expect(errorOf(fromBlocker.body).message).toMatch(/Unblock/);
  });

  it('validates the note length', async () => {
    const { alice, bob } = await pair();
    expect((await sendRequest(alice, bob, 'x'.repeat(301))).status).toBe(400);
  });
});

describe('answering message requests', () => {
  it('accepting connects both people and unlocks their profiles', async () => {
    const { alice, bob } = await pair();
    const { id } = (await sendRequest(alice, bob)).body.data;

    const res = await bob.client.post(`/message-requests/${id}/accept`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'accepted', direction: 'received' });
    expect(
      await Connection.exists({ pairKey: pairKey(alice.user.id, bob.user.id) }),
    ).not.toBeNull();
    expect(
      (await alice.client.get(`/users/${bob.user.username}`)).body.data.relationship.connected,
    ).toBe(true);
  });

  it('only the recipient can accept or reject, and only the sender can cancel', async () => {
    const { app, alice, bob } = await pair();
    const carol = await signedInUser(app);
    const { id } = (await sendRequest(alice, bob)).body.data;

    // Wrong side or a stranger: the request is "not found" to them.
    for (const [who, action] of [
      [alice, 'accept'],
      [alice, 'reject'],
      [bob, 'cancel'],
      [carol, 'accept'],
      [carol, 'cancel'],
    ]) {
      const res = await who.client.post(`/message-requests/${id}/${action}`);
      expect(res.status, `${action}`).toBe(404);
    }
    expect((await MessageRequest.findById(id).lean()).status).toBe('pending');
  });

  it.each([
    ['reject', 'rejected'],
    ['cancel', 'cancelled'],
  ])('%s moves the request to %s, and it cannot be answered again', async (action, status) => {
    const { alice, bob } = await pair();
    const { id } = (await sendRequest(alice, bob)).body.data;
    const actor = action === 'cancel' ? alice : bob;

    const res = await actor.client.post(`/message-requests/${id}/${action}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe(status);

    const accept = await bob.client.post(`/message-requests/${id}/accept`);
    expect(accept.status).toBe(409);
    expect(errorOf(accept.body).code).toBe('INVALID_STATE_TRANSITION');
    expect(await Connection.countDocuments({ pairKey: pairKey(alice.user.id, bob.user.id) })).toBe(
      0,
    );
    // A new request may be sent afterwards.
    expect((await sendRequest(alice, bob)).status).toBe(201);
  });

  it('re-checks blocks when accepting', async () => {
    const { alice, bob } = await pair();
    const { id } = (await sendRequest(alice, bob)).body.data;
    // Insert the block directly so the pending request is not auto-cancelled.
    const { BlockedUser } = await import('../src/models/blocked-user.model.js');
    await BlockedUser.create({ blocker: alice.user.id, blocked: bob.user.id });

    const res = await bob.client.post(`/message-requests/${id}/accept`);
    expect(res.status).toBe(403);
    expect(await Connection.countDocuments({ pairKey: pairKey(alice.user.id, bob.user.id) })).toBe(
      0,
    );
  });

  it('lists received and sent requests, filterable by status', async () => {
    const { app, alice, bob } = await pair();
    const carol = await signedInUser(app);
    await sendRequest(alice, bob);
    const { id } = (await sendRequest(carol, bob)).body.data;
    await bob.client.post(`/message-requests/${id}/reject`);

    const received = await bob.client.get('/message-requests?box=received');
    expect(received.body.data.map((request) => request.otherUser.username)).toEqual([
      carol.user.username,
      alice.user.username,
    ]);
    const pending = await bob.client.get('/message-requests?box=received&status=pending');
    expect(pending.body.data).toHaveLength(1);
    const sent = await alice.client.get('/message-requests?box=sent');
    expect(sent.body.data[0]).toMatchObject({ direction: 'sent', status: 'pending' });
    expect((await alice.client.get('/message-requests?box=everything')).status).toBe(400);
  });
});
