import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MESSAGING_SOCKET_EVENTS as EVENTS } from '#shared';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Attachment } from '../src/models/attachment.model.js';
import { Message } from '../src/models/message.model.js';
import { StorageUsage } from '../src/models/storage-usage.model.js';
import { connect, signedInUser, startTestServer, useTestDatabase } from './helpers.js';
import { connectedPair, httpSend, newMessage, nextEvent, openSocket } from './messaging-helpers.js';

useTestDatabase();

let server;
const sockets = [];
beforeAll(async () => {
  server = await startTestServer({ attachments: { userQuotaBytes: 20 * 1024 * 1024 } });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.disconnect();
});
afterAll(async () => {
  await server.close();
});

const png = (width = 8, height = 6) =>
  sharp({ create: { width, height, channels: 3, background: '#7350e0' } })
    .png()
    .toBuffer();
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer <<>>\n%%EOF\n');
const WEBM_AUDIO = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]),
  Buffer.from('webm'),
  Buffer.alloc(64, 1),
]);

function upload(user, conversationId, data, { filename, contentType, kind } = {}) {
  return user.client.send(
    'post',
    `/conversations/${conversationId}/attachments`,
    undefined,
    (t) => {
      let test = t.attach('file', data, { filename, contentType });
      if (kind) test = test.field('kind', kind);
      return test;
    },
  );
}

const objectPath = async (attachmentId) => {
  const attachment = await Attachment.findById(attachmentId).lean();
  return join(server.uploadsDir, attachment.storageKey);
};

async function sendAttachment(user, conversationId, data, options) {
  const uploaded = await upload(user, conversationId, data, options);
  expect(uploaded.status).toBe(201);
  const sent = await httpSend(user, conversationId, {
    ...newMessage(),
    text: undefined,
    attachmentId: uploaded.body.data.id,
  });
  expect(sent.status).toBe(201);
  return { attachment: uploaded.body.data, message: sent.body.data.message };
}

describe('uploading', () => {
  it('stores a valid image under a server key, strips it and returns metadata only', async () => {
    const { a, conversation } = await connectedPair(server.baseUrl);
    const res = await upload(a, conversation.id, await png(8, 6), {
      filename: '../../etc/holiday photo.PNG',
      contentType: 'image/png',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      kind: 'image',
      contentType: 'image/png',
      name: 'holiday photo.PNG',
      width: 8,
      height: 6,
      url: `/api/v1/attachments/${res.body.data.id}/content`,
    });
    const stored = await Attachment.findById(res.body.data.id).lean();
    expect(stored.storageKey).toMatch(/^attachments\/[A-Za-z0-9_-]{43}$/);
    expect(stored.storageKey).not.toContain('holiday');
    expect(stored.status).toBe('uploaded');
    expect(existsSync(await objectPath(res.body.data.id))).toBe(true);
  });

  it('rejects files over 5 MB', async () => {
    const { a, conversation } = await connectedPair(server.baseUrl);
    const big = Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]);
    const res = await upload(a, conversation.id, big, {
      filename: 'big.pdf',
      contentType: 'application/pdf',
    });
    expect(res.status).toBe(413);
    expect(await Attachment.countDocuments({ uploader: a.user.id })).toBe(0);
  });

  it.each([
    ['PNG bytes claiming to be a PDF', async () => png(), 'x.png', 'application/pdf'],
    ['a PDF renamed .png', async () => PDF, 'x.png', 'image/png'],
    [
      'HTML claiming to be an image',
      async () => Buffer.from('<script>alert(1)</script>'),
      'x.png',
      'image/png',
    ],
    [
      'an executable named .pdf',
      async () => Buffer.from('MZ\x90\x00\x03\x00\x00\x00'),
      'x.pdf',
      'application/pdf',
    ],
    [
      'an SVG image (not allowed)',
      async () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      'x.svg',
      'image/svg+xml',
    ],
    [
      'a corrupt PNG',
      async () => Buffer.concat([(await png()).subarray(0, 20), Buffer.alloc(30)]),
      'x.png',
      'image/png',
    ],
  ])('rejects %s', async (_label, data, filename, contentType) => {
    const { a, conversation } = await connectedPair(server.baseUrl);
    const res = await upload(a, conversation.id, await data(), { filename, contentType });
    expect([400, 415]).toContain(res.status);
    expect(['UNSUPPORTED_MEDIA_TYPE', 'INVALID_FILE']).toContain(res.body.error.code);
    expect(await Attachment.countDocuments({ uploader: a.user.id })).toBe(0);
  });

  it('accepts documents, audio and recorded voice messages by their real content', async () => {
    const { a, conversation } = await connectedPair(server.baseUrl);
    const pdf = await upload(a, conversation.id, PDF, { filename: 'notes.pdf', contentType: '' });
    expect(pdf.body.data).toMatchObject({ kind: 'document', contentType: 'application/pdf' });
    const voice = await upload(a, conversation.id, WEBM_AUDIO, {
      filename: 'voice.webm',
      contentType: 'audio/webm;codecs=opus',
      kind: 'voice',
    });
    expect(voice.status).toBe(201);
    expect(voice.body.data).toMatchObject({ kind: 'voice', contentType: 'audio/webm' });
    const text = await upload(a, conversation.id, Buffer.from('a,b\n1,2\n'), {
      filename: 'table.csv',
      contentType: 'text/csv',
    });
    expect(text.body.data).toMatchObject({ kind: 'document', contentType: 'text/csv' });
  });

  it('enforces the per-user quota atomically', async () => {
    const limited = await startTestServer({ attachments: { userQuotaBytes: 150 } });
    try {
      const { a, conversation } = await connectedPair(limited.baseUrl);
      const file = Buffer.from('x'.repeat(100));
      const first = await upload(a, conversation.id, file, {
        filename: 'a.txt',
        contentType: 'text/plain',
      });
      expect(first.status).toBe(201);
      const second = await upload(a, conversation.id, file, {
        filename: 'b.txt',
        contentType: 'text/plain',
      });
      expect(second.status).toBe(413);
      expect(second.body.error.code).toBe('STORAGE_QUOTA_EXCEEDED');
      expect((await StorageUsage.findOne({ scope: `user:${a.user.id}` }).lean()).bytes).toBe(100);
    } finally {
      await limited.close();
    }
  });

  it('a storage failure creates nothing and releases the reserved space', async () => {
    const { a, conversation } = await connectedPair(server.baseUrl);
    vi.spyOn(server.ctx.storage, 'put').mockRejectedValueOnce(new Error('bucket unreachable'));
    const res = await upload(a, conversation.id, PDF, {
      filename: 'x.pdf',
      contentType: 'application/pdf',
    });
    expect(res.status).toBe(503);
    expect(await Attachment.countDocuments({ uploader: a.user.id })).toBe(0);
    expect((await StorageUsage.findOne({ scope: `user:${a.user.id}` }).lean()).bytes).toBe(0);
  });

  it('a blocked or non-member user cannot upload', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    await b.client.post('/blocks', { username: a.user.username });
    expect((await upload(a, conversation.id, PDF, { filename: 'x.pdf' })).status).toBe(403);
    const outsider = await signedInUser(server.baseUrl);
    expect((await upload(outsider, conversation.id, PDF, { filename: 'x.pdf' })).status).toBe(404);
  });
});

describe('access to attachments', () => {
  it('only participants can open a sent attachment; nobody else, and never before it is sent', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const uploaded = await upload(a, conversation.id, await png(), {
      filename: 'p.png',
      contentType: 'image/png',
    });
    const url = `/attachments/${uploaded.body.data.id}/content`;
    expect((await a.client.get(url)).status).toBe(200); // uploader preview
    expect((await b.client.get(url)).status).toBe(404); // not sent yet

    await httpSend(a, conversation.id, {
      ...newMessage(),
      text: undefined,
      attachmentId: uploaded.body.data.id,
    });
    const asB = await b.client.get(url);
    expect(asB.status).toBe(200);
    expect(asB.headers['content-type']).toBe('image/png');
    expect(asB.headers['x-content-type-options']).toBe('nosniff');
    expect(asB.headers['cache-control']).toBe('private, max-age=300');
    expect(asB.headers['content-disposition']).toMatch(/^inline;/);
    expect((await b.client.get(`${url}?download=1`)).headers['content-disposition']).toMatch(
      /^attachment;/,
    );

    const outsider = await signedInUser(server.baseUrl);
    expect((await outsider.client.get(url)).status).toBe(404);
    const { TestClient } = await import('./helpers.js');
    expect((await new TestClient(server.baseUrl).get(url)).status).toBe(401);
    expect((await a.client.get('/attachments/..%2F..%2Fpackage.json/content')).status).toBe(404);
  });

  it('documents are always downloaded, and ranges are served for media', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const { attachment } = await sendAttachment(a, conversation.id, PDF, {
      filename: 'report.pdf',
      contentType: 'application/pdf',
    });
    const full = await b.client.get(`/attachments/${attachment.id}/content`);
    expect(full.headers['content-disposition']).toMatch(/^attachment; filename="report.pdf"/);
    const partial = await b.client.agent
      .get(`/api/v1/attachments/${attachment.id}/content`)
      .set('Range', 'bytes=0-3');
    expect(partial.status).toBe(206);
    expect(partial.headers['content-range']).toBe(`bytes 0-3/${PDF.length}`);
    expect(Buffer.from(partial.body).toString('latin1')).toBe('%PDF');
  });

  it('an uploaded file can only be used once, by its uploader, in its conversation', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const uploaded = await upload(a, conversation.id, PDF, {
      filename: 'x.pdf',
      contentType: 'application/pdf',
    });
    const stolen = await httpSend(b, conversation.id, {
      ...newMessage(),
      text: undefined,
      attachmentId: uploaded.body.data.id,
    });
    expect(stolen.status).toBe(400);
    await httpSend(a, conversation.id, {
      ...newMessage(),
      text: undefined,
      attachmentId: uploaded.body.data.id,
    });
    const again = await httpSend(a, conversation.id, {
      ...newMessage(),
      text: undefined,
      attachmentId: uploaded.body.data.id,
    });
    expect(again.status).toBe(400);
  });

  it('delete for me keeps the file for the other person', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const { attachment, message } = await sendAttachment(a, conversation.id, PDF, {
      filename: 'x.pdf',
    });
    expect(
      (await b.client.delete(`/conversations/${conversation.id}/messages/${message.id}?scope=me`))
        .status,
    ).toBe(200);
    expect((await b.client.get(`/attachments/${attachment.id}/content`)).status).toBe(404);
    expect((await a.client.get(`/attachments/${attachment.id}/content`)).status).toBe(200);
    expect(existsSync(await objectPath(attachment.id))).toBe(true);
  });
});

describe('lifecycle and cleanup', () => {
  it('a failed message leaves the upload unused, and the reaper removes it later', async () => {
    const { a, conversation } = await connectedPair(server.baseUrl);
    const uploaded = await upload(a, conversation.id, PDF, {
      filename: 'x.pdf',
      contentType: 'application/pdf',
    });
    vi.spyOn(Message, 'create').mockRejectedValueOnce(new Error('write failed'));
    const failed = await httpSend(a, conversation.id, {
      ...newMessage(),
      text: undefined,
      attachmentId: uploaded.body.data.id,
    });
    expect(failed.status).toBe(500);
    expect((await Attachment.findById(uploaded.body.data.id).lean()).status).toBe('uploaded');

    const path = await objectPath(uploaded.body.data.id);
    // Not yet old enough: kept so a retry can still use it.
    await server.services.attachments.reap(new Date());
    expect(existsSync(path)).toBe(true);
    const later = new Date(Date.now() + 2 * 60 * 60_000);
    await server.services.attachments.reap(later);
    expect(existsSync(path)).toBe(false);
    expect((await Attachment.findById(uploaded.body.data.id).lean()).status).toBe('deleted');
    expect((await StorageUsage.findOne({ scope: `user:${a.user.id}` }).lean()).bytes).toBe(0);
  });

  it('the reaper never deletes an upload that a message uses', async () => {
    const { a, conversation } = await connectedPair(server.baseUrl);
    const uploaded = await upload(a, conversation.id, PDF, {
      filename: 'x.pdf',
      contentType: 'application/pdf',
    });
    // Simulates a send that stored the message but crashed before marking the attachment used.
    vi.spyOn(server.services.attachments, 'markAttached').mockResolvedValueOnce(undefined);
    await httpSend(a, conversation.id, {
      ...newMessage(),
      text: undefined,
      attachmentId: uploaded.body.data.id,
    });
    await server.services.attachments.reap(new Date(Date.now() + 2 * 60 * 60_000));
    expect((await Attachment.findById(uploaded.body.data.id).lean()).status).toBe('attached');
    expect(existsSync(await objectPath(uploaded.body.data.id))).toBe(true);
  });

  it('forwarded files are shared: removed only when no message uses them any more', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const c = await signedInUser(server.baseUrl);
    await connect(a, c);
    const ac = (await a.client.post('/conversations', { userId: c.user.id })).body.data;

    const { attachment, message } = await sendAttachment(b, conversation.id, PDF, {
      filename: 'shared.pdf',
    });
    const forward = await httpSend(a, ac.id, {
      clientMessageId: newMessage().clientMessageId,
      forwardOfId: message.id,
    });
    expect(forward.status).toBe(201);
    expect(forward.body.data.message).toMatchObject({ forwarded: true, type: 'attachment' });
    expect(forward.body.data.message.attachment.id).toBe(attachment.id);
    // The new recipient can open it through the forward.
    expect((await c.client.get(`/attachments/${attachment.id}/content`)).status).toBe(200);

    // The original is deleted for everyone: the file stays for the forward.
    expect(
      (
        await b.client.delete(
          `/conversations/${conversation.id}/messages/${message.id}?scope=everyone`,
        )
      ).status,
    ).toBe(200);
    expect(existsSync(await objectPath(attachment.id))).toBe(true);
    expect((await b.client.get(`/attachments/${attachment.id}/content`)).status).toBe(404);
    expect((await c.client.get(`/attachments/${attachment.id}/content`)).status).toBe(200);

    // The forward is deleted too: now nothing uses it and the object is removed.
    const forwarded = forward.body.data.message;
    expect(
      (await a.client.delete(`/conversations/${ac.id}/messages/${forwarded.id}?scope=everyone`))
        .status,
    ).toBe(200);
    expect(existsSync(await objectPath(attachment.id))).toBe(false);
    expect((await Attachment.findById(attachment.id).lean()).status).toBe('deleted');
    expect((await c.client.get(`/attachments/${attachment.id}/content`)).status).toBe(404);
  });

  it('notifies the other participant in real time with the attachment metadata', async () => {
    const { a, b, conversation } = await connectedPair(server.baseUrl);
    const socket = await openSocket(server, b, sockets);
    const incoming = nextEvent(socket, EVENTS.created);
    const { attachment } = await sendAttachment(a, conversation.id, await png(), {
      filename: 'p.png',
      contentType: 'image/png',
    });
    const { message } = await incoming;
    expect(message).toMatchObject({
      type: 'attachment',
      attachment: { id: attachment.id, kind: 'image' },
    });
  });
});

describe('stickers', () => {
  it('sends stickers from the catalog only', async () => {
    const { a, conversation } = await connectedPair(server.baseUrl);
    const ok = await httpSend(a, conversation.id, {
      clientMessageId: newMessage().clientMessageId,
      sticker: 'wave',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data.message).toMatchObject({ type: 'sticker', sticker: 'wave', text: '' });
    const bad = await httpSend(a, conversation.id, {
      clientMessageId: newMessage().clientMessageId,
      sticker: 'http://evil',
    });
    expect(bad.status).toBe(400);
    const summary = await a.client.get(`/conversations/${conversation.id}`);
    expect(summary.body.data.lastMessage.preview).toBe('Sticker: Waving hand');
  });
});
