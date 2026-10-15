import { SESSION_SOCKET_EVENTS } from '#shared';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  registerUser,
  startTestServer,
  TEST_ORIGIN,
  TestClient,
  useTestDatabase,
} from './helpers.js';

useTestDatabase();

let server;
const sockets = [];

beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  await server.close();
});

function open(headers) {
  const socket = connect(server.baseUrl, {
    transports: ['websocket'],
    extraHeaders: headers,
    reconnection: false,
    forceNew: true,
  });
  sockets.push(socket);
  return socket;
}

function outcome(socket) {
  return new Promise((resolve) => {
    socket.once('connect', () => resolve('connected'));
    socket.once('connect_error', (error) => resolve(error.message));
  });
}

async function signedInClient() {
  const client = new TestClient(server.baseUrl);
  const user = await registerUser(client);
  const cookie = client.cookieHeader(server.ctx.config.cookies.names.access);
  return { client, user, cookie };
}

describe('Socket.IO authentication', () => {
  it('accepts an authenticated socket from an allowed origin', async () => {
    const { cookie } = await signedInClient();
    expect(await outcome(open({ Cookie: cookie, Origin: TEST_ORIGIN }))).toBe('connected');
  });

  it('rejects sockets without a session', async () => {
    expect(await outcome(open({ Origin: TEST_ORIGIN }))).toBe('UNAUTHORIZED');
  });

  it('rejects cookie-carrying sockets from other origins (cross-site WebSocket hijacking)', async () => {
    const { cookie } = await signedInClient();
    expect(await outcome(open({ Cookie: cookie, Origin: 'https://evil.example.com' }))).not.toBe(
      'connected',
    );
  });

  it('rejects cookie-carrying sockets that send no Origin', async () => {
    const { cookie } = await signedInClient();
    expect(await outcome(open({ Cookie: cookie }))).not.toBe('connected');
  });
});

describe('Socket.IO session revocation', () => {
  it('a second login disconnects the first session’s sockets with a reason', async () => {
    const { user, cookie } = await signedInClient();
    const socket = open({ Cookie: cookie, Origin: TEST_ORIGIN });
    expect(await outcome(socket)).toBe('connected');

    const revoked = new Promise((resolve) => {
      socket.once(SESSION_SOCKET_EVENTS.revoked, resolve);
    });
    const disconnected = new Promise((resolve) => {
      socket.once('disconnect', resolve);
    });

    const login = await new TestClient(server.baseUrl).post('/auth/login', {
      email: user.email,
      password: user.password,
    });
    expect(login.status).toBe(200);

    expect(await revoked).toEqual({ reason: 'superseded' });
    expect(await disconnected).toBe('io server disconnect');
    expect(socket.connected).toBe(false);

    // Reconnecting with the old cookie is refused.
    expect(await outcome(open({ Cookie: cookie, Origin: TEST_ORIGIN }))).toBe('SESSION_SUPERSEDED');
  });

  it('logout disconnects the session’s sockets', async () => {
    const { client, cookie } = await signedInClient();
    const socket = open({ Cookie: cookie, Origin: TEST_ORIGIN });
    expect(await outcome(socket)).toBe('connected');
    const disconnected = new Promise((resolve) => socket.once('disconnect', resolve));

    expect((await client.post('/auth/logout')).status).toBe(204);
    await disconnected;
    expect(socket.connected).toBe(false);
  });

  it('changing the password disconnects this device’s old socket without a sign-out notice', async () => {
    const { client, user, cookie } = await signedInClient();
    const socket = open({ Cookie: cookie, Origin: TEST_ORIGIN });
    expect(await outcome(socket)).toBe('connected');
    const notices = [];
    socket.on(SESSION_SOCKET_EVENTS.revoked, (payload) => notices.push(payload));
    const disconnected = new Promise((resolve) => socket.once('disconnect', resolve));

    const res = await client.post('/auth/password/change', {
      currentPassword: user.password,
      newPassword: 'a brand new passphrase',
    });
    expect(res.status).toBe(200);

    // The old session is still revoked and its socket closed immediately...
    expect(await disconnected).toBe('io server disconnect');
    // ...but this device keeps its new session, so it must not be told it was signed out.
    expect(notices).toEqual([]);
    const fresh = open({
      Cookie: client.cookieHeader(server.ctx.config.cookies.names.access),
      Origin: TEST_ORIGIN,
    });
    expect(await outcome(fresh)).toBe('connected');
  });
});
