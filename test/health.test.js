import {
  API_PREFIX,
  apiErrorResponseSchema,
  apiSuccessResponseSchema,
  healthResponseSchema,
  readinessResponseSchema,
} from '#shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

import { createTestContext, TEST_ORIGIN, useTestDatabase } from './helpers.js';

useTestDatabase();

function buildApp(database) {
  const { ctx } = createTestContext();
  if (database) {
    ctx.database = { getStatus: () => database.status, ping: () => Promise.resolve(database.ping) };
  }
  return createApp(ctx).app;
}

const healthEnvelope = apiSuccessResponseSchema(healthResponseSchema);

describe(`GET ${API_PREFIX}/health (liveness)`, () => {
  it('reports the real connection state in the { data } envelope', async () => {
    const res = await request(buildApp()).get(`${API_PREFIX}/health`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { data } = healthEnvelope.parse(res.body);
    expect(data.status).toBe('ok');
    expect(data.checks.database).toBe('connected');
  });

  it('stays 200 but degraded when the database is down', async () => {
    const res = await request(buildApp({ status: 'disconnected', ping: { ok: false } })).get(
      `${API_PREFIX}/health`,
    );

    expect(res.status).toBe(200);
    expect(healthEnvelope.parse(res.body).data.status).toBe('degraded');
  });
});

describe(`GET ${API_PREFIX}/health/ready (readiness)`, () => {
  it('pings the real database and reports latency', async () => {
    const res = await request(buildApp()).get(`${API_PREFIX}/health/ready`);

    expect(res.status).toBe(200);
    const { data } = apiSuccessResponseSchema(readinessResponseSchema).parse(res.body);
    expect(data.checks.database.status).toBe('up');
    expect(data.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns a generic 503 error envelope when the ping fails, without connection details', async () => {
    const res = await request(buildApp({ status: 'connected', ping: { ok: false } })).get(
      `${API_PREFIX}/health/ready`,
    );

    expect(res.status).toBe(503);
    const body = apiErrorResponseSchema.parse(res.body);
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/mongodb|127\.0\.0\.1|password/i);
  });
});

describe('cross-cutting HTTP behaviour', () => {
  it('returns the standard error envelope for unknown routes', async () => {
    const res = await request(buildApp()).get(`${API_PREFIX}/does-not-exist`);

    expect(res.status).toBe(404);
    const body = apiErrorResponseSchema.parse(res.body);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('rejects malformed JSON with a 400 envelope and no stack trace', async () => {
    const res = await request(buildApp())
      .post(`${API_PREFIX}/auth/login`)
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(res.status).toBe(400);
    expect(apiErrorResponseSchema.parse(res.body).error.code).toBe('BAD_REQUEST');
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.(js|ts)/);
  });

  it('rejects oversized bodies with 413', async () => {
    const res = await request(buildApp())
      .post(`${API_PREFIX}/auth/login`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ data: 'x'.repeat(200 * 1024) }));

    expect(res.status).toBe(413);
    expect(apiErrorResponseSchema.parse(res.body).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('allows credentialed CORS only for configured origins', async () => {
    const app = buildApp();
    const allowed = await request(app).get(`${API_PREFIX}/health`).set('Origin', TEST_ORIGIN);
    expect(allowed.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const denied = await request(app)
      .get(`${API_PREFIX}/health`)
      .set('Origin', 'https://evil.example.com');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(buildApp()).get(`${API_PREFIX}/health`);

    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
  });
});
