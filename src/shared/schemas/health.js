import { z } from 'zod';

export const databaseStatusSchema = z.enum([
  'connected',
  'connecting',
  'disconnecting',
  'disconnected',
]);

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.literal('connect-api'),
  version: z.string(),
  environment: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.iso.datetime(),
  checks: z.object({
    database: databaseStatusSchema,
  }),
});

/** Readiness payload (200 only). When not ready the API returns a 503 error envelope instead. */
export const readinessResponseSchema = z.object({
  status: z.literal('ready'),
  checks: z.object({
    database: z.object({
      status: z.literal('up'),
      latencyMs: z.number().nonnegative(),
    }),
  }),
});
