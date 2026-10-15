import { randomInt, randomUUID } from 'node:crypto';
import {
  DecryptionSettings,
  DeviceId,
  DeviceLists,
  EncryptionSettings,
  OlmMachine,
  RequestType,
  RoomId,
  TrustRequirement,
  UserId,
} from '@matrix-org/matrix-sdk-crypto-wasm';
import { toE2eeUserId } from '#shared';

/**
 * A real Matrix crypto device (the library's Node build) that talks to the real API like the web
 * client does: registers, binds its sign-in session by signing the server's challenge, uploads
 * keys, fetches and acknowledges its to-device queue, encrypts and decrypts messages. Tests only.
 */
export class ApiDevice {
  /** @param {{ client: import('./helpers.js').TestClient, user: { id: string } }} account */
  constructor(account, deviceId, machine) {
    this.account = account;
    this.deviceId = deviceId;
    this.machine = machine;
    /** Highest queue seq processed (acknowledged on the next sync). */
    this.processedSeq = 0;
  }

  get client() {
    return this.account.client;
  }

  get userId() {
    return this.account.user.id;
  }

  static async create(account, { bind = true, upload = true } = {}) {
    const deviceId = Array.from({ length: 10 }, () => String.fromCharCode(65 + randomInt(26))).join(
      '',
    );
    const machine = await OlmMachine.initialize(
      new UserId(toE2eeUserId(account.user.id)),
      new DeviceId(deviceId),
    );
    const device = new ApiDevice(account, deviceId, machine);
    const pending = (await machine.outgoingRequests()).find(
      (request) => request.type === RequestType.KeysUpload,
    );
    const registered = await account.client.send('put', `/e2ee/devices/${deviceId}`, {
      deviceKeys: JSON.parse(pending.body).device_keys,
    });
    if (registered.status !== 201) throw new Error(`register: ${registered.status}`);
    if (bind) await device.bind();
    if (upload) await device.flush();
    return device;
  }

  /** Proves to the server (for this sign-in) that this device holds its key. */
  async bind() {
    const challenge = await this.client.post(`/e2ee/devices/${this.deviceId}/binding-challenge`);
    if (challenge.status !== 200) throw new Error(`challenge: ${challenge.status}`);
    const res = await this.client.send('put', `/e2ee/devices/${this.deviceId}/binding`, {
      challenge: challenge.body.data.challenge,
      signature: await this.sign(challenge.body.data.challenge),
    });
    if (res.status !== 204) throw new Error(`bind: ${res.status} ${JSON.stringify(res.body)}`);
  }

  async sign(message) {
    const signatures = await this.machine.sign(message);
    return JSON.parse(signatures.asJSON())[toE2eeUserId(this.userId)][`ed25519:${this.deviceId}`];
  }

  /** Sends one library request through the API and reports the response to the library. */
  async send(request) {
    const body = JSON.parse(request.body);
    let res;
    switch (request.type) {
      case RequestType.KeysUpload:
        res = await this.client.post(`/e2ee/devices/${this.deviceId}/keys`, body);
        break;
      case RequestType.KeysQuery:
        res = await this.client.post('/e2ee/keys/query', body);
        break;
      case RequestType.KeysClaim:
        res = await this.client.post('/e2ee/keys/claim', body);
        break;
      case RequestType.ToDevice:
        res = await this.client.send('put', `/e2ee/to-device/${request.txn_id}`, {
          type: request.event_type,
          messages: body.messages,
        });
        break;
      default:
        return null;
    }
    if (res.status !== 200) {
      throw Object.assign(new Error(`request ${request.type}: ${res.status}`), { res });
    }
    await this.machine.markRequestAsSent(request.id, request.type, JSON.stringify(res.body.data));
    return res;
  }

  async flush() {
    for (let round = 0; round < 5; round++) {
      const requests = await this.machine.outgoingRequests();
      const handled = requests.filter((request) =>
        [RequestType.KeysUpload, RequestType.KeysQuery, RequestType.ToDevice].includes(
          request.type,
        ),
      );
      if (handled.length === 0) return;
      for (const request of handled) await this.send(request);
    }
  }

  /** Fetches the queue (acknowledging what was processed before) and hands it to the library. */
  async sync({ ack = true } = {}) {
    const res = await this.client.post(`/e2ee/devices/${this.deviceId}/to-device`, {
      ackUpTo: ack ? this.processedSeq : 0,
    });
    if (res.status !== 200) throw Object.assign(new Error(`sync: ${res.status}`), { res });
    const {
      events,
      one_time_key_counts: counts,
      unused_fallback_key_types: fallback,
    } = res.body.data;
    const processed = await this.machine.receiveSyncChanges(
      JSON.stringify(events.map(({ sender, type, content }) => ({ sender, type, content }))),
      new DeviceLists(),
      new Map(Object.entries(counts)),
      new Set(fallback),
    );
    if (events.length) this.processedSeq = Math.max(this.processedSeq, events.at(-1).seq);
    await this.flush();
    return { events, processed, data: res.body.data };
  }

  /** Sender side: keys for everyone in the conversation, then the Megolm payload. */
  async encrypt(conversationId, memberIds, content) {
    const users = () => memberIds.map((id) => new UserId(toE2eeUserId(id)));
    const room = () => new RoomId(`!${conversationId}:connect`);
    await this.machine.updateTrackedUsers(users());
    await this.flush();
    const claim = await this.machine.getMissingSessions(users());
    if (claim) await this.send(claim);
    const shares = await this.machine.shareRoomKey(room(), users(), new EncryptionSettings());
    for (const share of shares) await this.send(share);
    return JSON.parse(
      await this.machine.encryptRoomEvent(room(), 'm.room.message', JSON.stringify(content)),
    );
  }

  /** Recipient side: decrypts a stored message DTO and checks who really sent it. */
  async decrypt(message) {
    const room = new RoomId(`!${message.conversationId}:connect`);
    const event = {
      event_id: `$${message.id}`,
      sender: toE2eeUserId(message.senderId),
      origin_server_ts: Date.parse(message.createdAt),
      room_id: `!${message.conversationId}:connect`,
      type: 'm.room.encrypted',
      content: message.encrypted,
    };
    const decrypted = await this.machine.decryptRoomEvent(
      JSON.stringify(event),
      room,
      new DecryptionSettings(TrustRequirement.Untrusted),
    );
    return { content: JSON.parse(decrypted.event).content, decrypted };
  }
}

/** A message body for `encrypt` (Connect's inner format). */
export const encryptedText = (text, clientMessageId = randomUUID()) => ({
  clientMessageId,
  content: { msgtype: 'm.text', body: text, 'connect.message': { clientMessageId } },
});
