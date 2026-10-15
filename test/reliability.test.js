import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findMissingIndexes } from '../src/db/indexes.js';
import { Call } from '../src/models/call.model.js';
import { Conversation } from '../src/models/conversation.model.js';
import { allModels } from '../src/models/index.js';
import { createGroup, ownerWithFriends } from './group-helpers.js';
import { startTestServer, useTestDatabase } from './helpers.js';
import { httpSend, newMessage } from './messaging-helpers.js';

useTestDatabase();

let server;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server.close();
});

async function readAll(user, conversationId, seq) {
  await server.services.messaging.markDelivered(user.user.id, conversationId, seq);
  await server.services.messaging.markRead(user.user.id, conversationId, seq);
}

describe('account deletion and groups', () => {
  it("a deleted member doesn't freeze the group's read receipts", async () => {
    const { owner, friends } = await ownerWithFriends(server.baseUrl, 2);
    const [reader, leaving] = friends;
    const group = await createGroup(owner, friends);
    expect((await leaving.client.delete('/account')).status).toBe(204);

    const sent = await httpSend(owner, group.id, newMessage('Anyone there?'));
    const { seq } = sent.body.data.message;
    await readAll(reader, group.id, seq);

    const view = await owner.client.get(`/conversations/${group.id}`);
    expect(view.body.data.peerReceipts.lastReadSeq).toBe(seq);
    const stored = await Conversation.findById(group.id).lean();
    expect(stored.participants.map(String)).not.toContain(leaving.user.id);
  });

  it('a deleted owner hands the group to another member; a sole owner deletes it', async () => {
    const { owner, friends } = await ownerWithFriends(server.baseUrl, 2);
    const [admin, member] = friends;
    const group = await createGroup(owner, friends, 'Inherited');
    await owner.client.patch(`/groups/${group.id}/members/${admin.user.id}`, { role: 'admin' });
    expect((await owner.client.delete('/account')).status).toBe(204);

    const details = (await admin.client.get(`/groups/${group.id}`)).body.data;
    expect(details.myRole).toBe('owner');
    expect(details.members.map((m) => m.user.id).sort()).toEqual(
      [admin.user.id, member.user.id].sort(),
    );
    // The new owner can administer it.
    expect((await admin.client.patch(`/groups/${group.id}`, { name: 'Still here' })).status).toBe(
      200,
    );

    const { owner: alone } = await ownerWithFriends(server.baseUrl, 0);
    const solo = await createGroup(alone, [], 'Just me');
    expect((await alone.client.delete('/account')).status).toBe(204);
    const gone = await Conversation.findById(solo.id).lean();
    expect(gone.group.deletedAt).not.toBeNull();
  });
});

describe('database indexes', () => {
  it('reports missing indexes (production refuses to start without them)', async () => {
    expect(await findMissingIndexes(allModels)).toEqual([]);
    await Call.collection.dropIndex('lock_1');
    const missing = await findMissingIndexes(allModels);
    expect(missing).toEqual(
      [{ collection: 'calls', index: { lock: 1 } }].map((entry) => expect.objectContaining(entry)),
    );
    await Call.createIndexes();
    expect(await findMissingIndexes(allModels)).toEqual([]);
  });
});
