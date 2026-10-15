import { apiErrorResponseSchema } from '#shared';
import { describe, expect, it } from 'vitest';
import { buildTestApp, TestClient, useTestDatabase } from './helpers.js';

useTestDatabase();

const minute = 60_000;

describe('rate limits', () => {
  it('limits login attempts per IP and returns RateLimit headers', async () => {
    const { app } = buildTestApp({
      rateLimitsEnabled: true,
      rateLimits: { loginPerIp: { windowMs: minute, limit: 3 } },
    });
    const client = new TestClient(app);
    const attempt = () =>
      client.post('/auth/login', { email: 'someone@example.com', password: 'wrong' });

    for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(401);
    const limited = await attempt();

    expect(limited.status).toBe(429);
    expect(apiErrorResponseSchema.parse(limited.body).error.code).toBe('RATE_LIMITED');
    expect(limited.headers.ratelimit).toBeDefined();
  });

  it('limits login attempts per account across different clients', async () => {
    const { app } = buildTestApp({
      rateLimitsEnabled: true,
      rateLimits: { loginPerAccount: { windowMs: minute, limit: 2 } },
    });
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      const res = await new TestClient(app).post('/auth/login', {
        email: 'Target@Example.com',
        password: 'guess',
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([401, 401, 429]);
  });

  it('limits password reset requests without revealing whether the account exists', async () => {
    const { app } = buildTestApp({
      rateLimitsEnabled: true,
      rateLimits: { forgotPasswordPerAccount: { windowMs: minute, limit: 1 } },
    });
    const client = new TestClient(app);
    expect(
      (await client.post('/auth/password/forgot', { email: 'ghost@example.com' })).status,
    ).toBe(202);
    expect(
      (await client.post('/auth/password/forgot', { email: 'ghost@example.com' })).status,
    ).toBe(429);
  });

  it('limits registrations per IP', async () => {
    const { app } = buildTestApp({
      rateLimitsEnabled: true,
      rateLimits: { registerPerIp: { windowMs: minute, limit: 1 } },
    });
    const client = new TestClient(app);
    await client.post('/auth/register', {});
    expect((await client.post('/auth/register', {})).status).toBe(429);
  });
});
