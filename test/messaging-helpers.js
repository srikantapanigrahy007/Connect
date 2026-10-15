import { randomUUID } from 'node:crypto';
import { io as connectSocket } from 'socket.io-client';
import { connect, signedInUser, TEST_ORIGIN } from './helpers.js';

/** Two signed-in users who are connected (accepted message request), plus their conversation. */
export async function connectedPair(target) {
  const a = await signedInUser(target);
  const b = await signedInUser(target);
  await connect(a, b);
  const opened = await a.client.post('/conversations', { userId: b.user.id });
  if (opened.status !== 201 && opened.status !== 200) {
    throw new Error(`open failed: ${opened.status} ${JSON.stringify(opened.body)}`);
  }
  return { a, b, conversation: opened.body.data };
}

export function newMessage(text = 'Hello there') {
  return { clientMessageId: randomUUID(), text };
}

/** Sends over HTTP and returns the response. */
export function httpSend(user, conversationId, message = newMessage()) {
  return user.client.post(`/conversations/${conversationId}/messages`, message);
}

/** Opens an authenticated socket for a signed-in user (cookie + allowed Origin, like a browser). */
export function openSocket(server, user, sockets) {
  const cookie = user.client.cookieHeader(server.ctx.config.cookies.names.access);
  const socket = connectSocket(server.baseUrl, {
    transports: ['websocket'],
    extraHeaders: { Cookie: cookie, Origin: TEST_ORIGIN },
    reconnection: false,
    forceNew: true,
  });
  sockets?.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) => reject(error));
  });
}

/** Emits with an acknowledgment and resolves with `{ ok, data | error }`. */
export function request(socket, event, payload, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

/** Resolves with the next `event` payload matching `predicate`, or rejects after a timeout. */
export function nextEvent(socket, event, predicate = () => true, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`No ${event} within ${timeoutMs} ms`));
    }, timeoutMs);
    function handler(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

/** Collects every `event` payload received from now on. */
export function collect(socket, event) {
  const received = [];
  socket.on(event, (payload) => received.push(payload));
  return received;
}

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function waitForDisconnect(socket) {
  return new Promise((resolve) => {
    if (socket.disconnected) resolve('already disconnected');
    else socket.once('disconnect', resolve);
  });
}
