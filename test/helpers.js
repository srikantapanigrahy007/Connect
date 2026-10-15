import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { API_PREFIX } from '#shared';

import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, inject } from 'vitest';
import { createApp } from '../src/app.js';
import { createAppConfig } from '../src/config/app-config.js';
import { parseEnv } from '../src/config/env.js';
import { getDatabaseStatus, pingDatabase } from '../src/db/mongoose.js';
import { allModels } from '../src/models/index.js';
import { createRealtimeServer } from '../src/realtime/socket-server.js';

import { createMemoryMailer } from '../src/services/mailer.js';
import { SessionEvents } from '../src/services/session-events.js';
import { silentLogger } from '../src/utils/logger.js';
import { createPresenceTracker } from '../src/realtime/presence.js';
import { createMetrics } from '../src/utils/metrics.js';
import { createLocalStorage } from '../src/services/storage.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_ORIGIN = 'http://localhost:5173';
export const TEST_PASSWORD = 'correct horse battery staple';

/** Connects this test file to its own database on the shared mongod and builds all indexes. */
export function useTestDatabase() {
  beforeAll(async () => {
    await mongoose.connect(inject('mongoUri'), { dbName: `test_${randomUUID().slice(0, 8)}` });
    await Promise.all(allModels.map((model) => model.init()));
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
}

export function createTestContext(options = {}) {
  const env = parseEnv({
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://127.0.0.1:1/unused-tests-connect-via-useTestDatabase',
    AUTH_SECRET: 'test-secret-that-is-long-enough-for-hkdf-0123456789',
    CLIENT_ORIGINS: TEST_ORIGIN,
    WEB_APP_URL: TEST_ORIGIN,
    RATE_LIMIT_ENABLED: String(options.rateLimitsEnabled ?? false),
    REFRESH_TOKEN_REUSE_GRACE_SECONDS: '0',
    ...options.env,
  });
  const mailer = createMemoryMailer();
  const sessionEvents = new SessionEvents();
  // Each test app gets its own empty uploads folder.
  const uploadsDir = mkdtempSync(join(tmpdir(), 'connect-uploads-'));
  const storage = createLocalStorage(uploadsDir);
  const presence = createPresenceTracker();
  const ctx = {
    config: createAppConfig(env, '0.0.0-test', {
      rateLimits: options.rateLimits,
      messages: options.messages,
      attachments: options.attachments,
      calls: options.calls,
      realtime: options.realtime,
      e2ee: options.e2ee,
    }),
    logger: silentLogger,
    mailer,
    sessionEvents,
    storage,
    presence,
    metrics: createMetrics(),
    database: { getStatus: getDatabaseStatus, ping: pingDatabase },
    ...(options.google !== undefined ? { google: options.google } : {}),
  };
  return { ctx, mailer, sessionEvents, uploadsDir };
}

export function buildTestApp(options = {}) {
  const { ctx, mailer, sessionEvents, uploadsDir } = createTestContext(options);
  const { app, services } = createApp(ctx);
  return { app, services, ctx, mailer, sessionEvents, uploadsDir };
}

/**
 * Browser-like API client: keeps cookies, and sends Origin + X-CSRF-Token on state-changing
 * requests exactly like the web app does.
 */
export class TestClient {
  agent;
  csrfToken = null;
  /** Latest value of every cookie the server set (name -> value, "" when cleared). */
  cookies = new Map();

  constructor(target) {
    this.agent = request.agent(target);
  }

  track(response) {
    const setCookie = response.headers['set-cookie'];
    const headers = Array.isArray(setCookie) ? setCookie : [];
    for (const header of headers) {
      const [pair = ''] = header.split(';');
      const index = pair.indexOf('=');
      this.cookies.set(pair.slice(0, index), decodeURIComponent(pair.slice(index + 1)));
    }
    return response;
  }

  /** Raw Set-Cookie header for one cookie in the last response (for attribute assertions). */
  static setCookieHeader(response, name) {
    const headers = response.headers['set-cookie'] ?? [];
    return headers.find((header) => header.startsWith(`${name}=`));
  }

  async ensureCsrf() {
    if (!this.csrfToken) {
      const response = this.track(await this.agent.get(`${API_PREFIX}/auth/csrf`));
      this.csrfToken = response.body.data.csrfToken;
    }
    return this.csrfToken;
  }

  async get(path) {
    return this.track(await this.agent.get(`${API_PREFIX}${path}`));
  }

  async send(method, path, body, extra) {
    const token = await this.ensureCsrf();
    let test = this.agent[method](`${API_PREFIX}${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('X-CSRF-Token', token);
    if (extra) test = extra(test);
    return this.track(await (body === undefined ? test : test.send(body)));
  }

  post(path, body) {
    return this.send('post', path, body);
  }

  delete(path) {
    return this.send('delete', path);
  }

  patch(path, body) {
    return this.send('patch', path, body);
  }

  /** Multipart upload of one file, like a browser form. */
  upload(path, field, data, { filename = 'upload.bin', contentType } = {}) {
    return this.send('put', path, undefined, (test) =>
      test.attach(field, data, { filename, contentType }),
    );
  }

  /** "name=value; ..." for the access cookie, e.g. for a Socket.IO handshake. */
  cookieHeader(...names) {
    return names.map((name) => `${name}=${this.cookies.get(name) ?? ''}`).join('; ');
  }
}

let counter = 0;
export function uniqueUser(overrides = {}) {
  counter += 1;
  const id = `${Date.now().toString(36)}${counter}`;
  return {
    displayName: 'Ada Lovelace',
    username: `ada_${id}`.slice(0, 30),
    email: `ada.${id}@example.com`,
    password: TEST_PASSWORD,
    ...overrides,
  };
}

export async function registerUser(client, overrides = {}) {
  const user = uniqueUser(overrides);
  const response = await client.post('/auth/register', user);
  if (response.status !== 201) {
    throw new Error(`register failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return { ...user, id: response.body.data.user.id };
}

export async function startTestServer(options = {}) {
  const built = buildTestApp(options);
  const server = createServer(built.app);
  const io = createRealtimeServer(server, {
    config: built.ctx.config,
    sessions: built.services.sessions,
    sessionEvents: built.sessionEvents,
    logger: silentLogger,
    presence: built.ctx.presence,
    messaging: built.services.messaging,
    notifications: built.services.notifications,
    calls: built.services.calls,
    e2ee: built.services.e2ee,
    metrics: built.ctx.metrics,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    ...built,
    server,
    io,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        void io.close(() => resolve());
      }),
  };
}

/** Waits until `predicate` returns a value (for background work such as emails). */
export async function eventually(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function linkToken(text, path) {
  const match = new RegExp(`${path}\\?token=([A-Za-z0-9_-]+)`).exec(text);
  if (!match?.[1]) throw new Error(`No ${path} link in email`);
  return match[1];
}

/** Registers a user and returns a signed-in client for them. */
export async function signedInUser(app, overrides = {}) {
  const client = new TestClient(app);
  const user = await registerUser(client, overrides);
  return { client, user };
}

/** Sends a request from `from` to `to` (a signedInUser result) and returns the response. */
export function sendRequest(from, to, note) {
  return from.client.post('/message-requests', {
    username: to.user.username,
    ...(note ? { note } : {}),
  });
}

/** Makes `a` and `b` connected by sending and accepting a request. */
export async function connect(a, b) {
  const sent = await sendRequest(a, b);
  if (sent.status !== 201) throw new Error(`request failed: ${JSON.stringify(sent.body)}`);
  const accepted = await b.client.post(`/message-requests/${sent.body.data.id}/accept`);
  if (accepted.status !== 200) throw new Error(`accept failed: ${JSON.stringify(accepted.body)}`);
}
