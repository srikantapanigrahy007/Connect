import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

import { RateLimitCounter } from '../models/rate-limit-counter.model.js';
import { hashToken } from '../security/tokens.js';
import { AppError } from '../utils/app-error.js';

const isDuplicateKeyError = (error) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;

/**
 * Fixed-window counters in MongoDB so limits hold across API instances without Redis.
 * The increment is one atomic pipeline update that also starts a new window when the old one ended.
 */
export class MongoRateLimitStore {
  windowMs = 60_000;
  localKeys = false;

  prefix;

  constructor(prefix) {
    this.prefix = prefix;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async increment(key) {
    const now = new Date();
    const expired = { $or: [{ $not: ['$resetAt'] }, { $lte: ['$resetAt', now] }] };
    const update = [
      {
        $set: {
          hits: { $cond: [expired, 1, { $add: ['$hits', 1] }] },
          resetAt: { $cond: [expired, new Date(now.getTime() + this.windowMs), '$resetAt'] },
        },
      },
    ];
    const run = () =>
      RateLimitCounter.findOneAndUpdate({ key: `${this.prefix}:${key}` }, update, {
        upsert: true,
        returnDocument: 'after',
        updatePipeline: true,
      }).lean();
    let counter;
    try {
      counter = await run();
    } catch (error) {
      // Two first requests raced to create the counter; the second one now exists.
      if (!isDuplicateKeyError(error)) throw error;
      counter = await run();
    }
    return { totalHits: counter.hits, resetTime: counter.resetAt };
  }

  async decrement(key) {
    await RateLimitCounter.updateOne(
      { key: `${this.prefix}:${key}`, hits: { $gt: 0 } },
      { $inc: { hits: -1 } },
    );
  }

  async resetKey(key) {
    await RateLimitCounter.deleteOne({ key: `${this.prefix}:${key}` });
  }
}

export const keyByIp = (req) => ipKeyGenerator(req.ip ?? 'unknown');

/** Keys by the email in the request body, hashed so raw addresses are never stored. */
export const keyByEmail = (req) => {
  const body = req.body;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  return `email:${hashToken(email)}`;
};

export const keyByUser = (req) => `user:${req.auth?.userId ?? keyByIp(req)}`;

const directStores = new Map();

/**
 * Counts one hit against rule `name` outside Express (e.g. a Socket.IO event) and throws
 * 429 RATE_LIMITED when over the limit. Uses the same MongoDB counters as createRateLimiter, so
 * a key such as `user:<id>` shares one budget between HTTP and Socket.IO.
 */
export async function consumeRateLimit(config, name, key) {
  if (!config.rateLimits.enabled) return;
  const rule = config.rateLimits.rules[name];
  let store = directStores.get(`${name}:${rule.windowMs}`);
  if (!store) {
    store = new MongoRateLimitStore(name);
    store.init({ windowMs: rule.windowMs });
    directStores.set(`${name}:${rule.windowMs}`, store);
  }
  const { totalHits } = await store.increment(key);
  if (totalHits > rule.limit) {
    throw new AppError(429, 'RATE_LIMITED', 'Too many messages. Please slow down.');
  }
}

export function createRateLimiter(config, name, keyGenerator) {
  const rule = config.rateLimits.rules[name];
  return rateLimit({
    windowMs: rule.windowMs,
    limit: rule.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: new MongoRateLimitStore(name),
    keyGenerator,
    skip: () => !config.rateLimits.enabled,
    handler: (_req, _res, next) => {
      next(
        new AppError(
          429,
          'RATE_LIMITED',
          'Too many attempts. Please wait a few minutes and try again.',
        ),
      );
    },
  });
}
