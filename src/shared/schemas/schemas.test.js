import { describe, expect, it } from 'vitest';
import { API_PREFIX } from '../constants.js';
import { apiErrorResponseSchema } from './error.js';
import { healthResponseSchema } from './health.js';

describe('shared contracts', () => {
  it('exposes the versioned API prefix', () => {
    expect(API_PREFIX).toBe('/api/v1');
  });

  it('accepts a well-formed health response', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      service: 'connect-api',
      version: '0.1.0',
      environment: 'test',
      uptimeSeconds: 12.5,
      timestamp: new Date().toISOString(),
      checks: { database: 'connected' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown database status', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      service: 'connect-api',
      version: '0.1.0',
      environment: 'test',
      uptimeSeconds: 1,
      timestamp: new Date().toISOString(),
      checks: { database: 'maybe' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects error envelopes with unknown codes', () => {
    expect(
      apiErrorResponseSchema.safeParse({ error: { code: 'NOT_FOUND', message: 'x' } }).success,
    ).toBe(true);
    expect(
      apiErrorResponseSchema.safeParse({ error: { code: 'TEAPOT', message: 'x' } }).success,
    ).toBe(false);
  });
});
