import { z } from 'zod';
import { LIMITS } from '../domain/limits.js';

/** 24-character hex MongoDB ObjectId, as it appears in URLs and JSON. */
export const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

/** Query parameters for cursor (keyset) pagination. */
export const cursorPaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(LIMITS.pageSizeMax).default(LIMITS.pageSizeDefault),
  cursor: z
    .string()
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/, 'Invalid cursor')
    .optional(),
});

export const paginationMetaSchema = z.object({
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
  /** Opaque cursor for the next page, or null when there are no more items. */
  nextCursor: z.string().nullable(),
});

/**
 * Every successful (2xx) JSON response is `{ data, meta? }`; errors use apiErrorResponseSchema.
 * Builds a schema for that envelope around the schema of `data`.
 *
 * @param {import('zod').ZodType} data
 */
export function apiSuccessResponseSchema(data) {
  return z.object({ data });
}

/**
 * Schema for a paginated list: `{ data: [...items], meta: { limit, hasMore, nextCursor } }`.
 *
 * @param {import('zod').ZodType} item
 */
export function paginatedResponseSchema(item) {
  return z.object({ data: z.array(item), meta: paginationMetaSchema });
}
