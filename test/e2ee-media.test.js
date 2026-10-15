import { randomUUID } from 'node:crypto';
import { initAsync } from '@matrix-org/matrix-sdk-crypto-wasm';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { Message } from '../src/models/message.model.js';
import { ApiDevice } from './e2ee-helpers.js';
import { buildTestApp, useTestDatabase } from './helpers.js';
import { connectedPair } from './messaging-helpers.js';

// Media in end-to-end encrypted chats (product decision: only text is end-to-end encrypted).
// Photos, videos, audio, voice notes and files keep working as before (server checks, metadata
// removal, limits, access rules), without any readable text attached.

useTestDatabase();

let app;
beforeAll(async () => {
  await initAsync();
  ({ app } = buildTestApp({ e2ee: { enabled: true } }));
});

const png = () =>
  sharp({ create: { width: 8, height: 6, channels: 3, background: '#7350e0' } })
    .png()
    .toBuffer();

function upload(account, conversationId, data, filename, contentType) {
  return account.client.send(
    'post',
    `/conversations/${conversationId}/attachments`,
    undefined,
    (t) => t.attach('file', data, { filename, contentType }),
  );
}

async function encryptedPair() {
  const pair = await connectedPair(app);
  pair.alice = await ApiDevice.create(pair.a);
  pair.bob = await ApiDevice.create(pair.b);
  await pair.a.client.post(`/e2ee/conversations/${pair.conversation.id}/enable`);
  return pair;
}

const send = (pair, body) =>
  pair.a.client.post(`/conversations/${pair.conversation.id}/messages`, {
    clientMessageId: randomUUID(),
    ...body,
  });

describe('media in an end-to-end encrypted chat', () => {
  it('is sent and shown as before (not end-to-end encrypted)', async () => {
    const pair = await encryptedPair();
    const uploaded = await upload(
      pair.a,
      pair.conversation.id,
      await png(),
      'photo.png',
      'image/png',
    );
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.data).toMatchObject({ kind: 'image', contentType: 'image/png' });
    const sent = await send(pair, { attachmentId: uploaded.body.data.id });
    expect(sent.status).toBe(201);
    expect(sent.body.data.message).toMatchObject({
      type: 'attachment',
      encryption: 'none',
      encrypted: null,
      text: '',
      attachment: { kind: 'image', name: 'photo.png' },
    });
    // The other person opens it with the usual access check.
    const file = await pair.b.client.get(
      sent.body.data.message.attachment.url.replace('/api/v1', ''),
    );
    expect(file.status).toBe(200);
  });

  it('never carries readable text: a caption is refused (clients send it encrypted, separately)', async () => {
    const pair = await encryptedPair();
    const uploaded = await upload(
      pair.a,
      pair.conversation.id,
      await png(),
      'photo.png',
      'image/png',
    );
    const captioned = await send(pair, {
      attachmentId: uploaded.body.data.id,
      text: 'at the beach',
    });
    expect(captioned.body.error.code).toBe('E2EE_REQUIRED');
    expect(
      await Message.countDocuments({ conversation: pair.conversation.id, text: 'at the beach' }),
    ).toBe(0);
  });

  it('files are not put inside encrypted messages', async () => {
    const pair = await encryptedPair();
    const uploaded = await upload(
      pair.a,
      pair.conversation.id,
      await png(),
      'photo.png',
      'image/png',
    );
    const content = {
      msgtype: 'm.text',
      body: 'caption',
      'connect.message': { clientMessageId: randomUUID() },
    };
    const encrypted = await pair.alice.encrypt(
      pair.conversation.id,
      [pair.a.user.id, pair.b.user.id],
      content,
    );
    const mixed = await send(pair, { attachmentId: uploaded.body.data.id, encrypted });
    expect(mixed.status).toBe(400);
  });

  it('chats without encryption are unchanged (files with captions)', async () => {
    const { a, conversation } = await connectedPair(app);
    const uploaded = await upload(a, conversation.id, await png(), 'photo.png', 'image/png');
    const sent = await a.client.post(`/conversations/${conversation.id}/messages`, {
      clientMessageId: randomUUID(),
      attachmentId: uploaded.body.data.id,
      text: 'at the beach',
    });
    expect(sent.status).toBe(201);
    expect(sent.body.data.message).toMatchObject({ text: 'at the beach', encryption: 'none' });
  });
});
