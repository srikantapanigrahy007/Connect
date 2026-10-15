import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** backend, for resolving relative paths in settings. */
const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));
import { z } from 'zod';

const isOrigin = (value) => {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
};

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

/** "a, b" → ["a", "b"], each a STUN/TURN URL. */
const iceUrlList = (scheme) =>
  z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((url) => url.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().regex(scheme, 'must be a stun:/turn:/turns: URL')));

const EXAMPLE_SECRET_MARKER = 'replace-me';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
    TRUST_PROXY: z
      .string()
      .optional()
      .transform((value) => {
        if (value === undefined || value === 'false') return false;
        if (value === 'true') return true;
        if (/^\d+$/.test(value)) return Number(value);
        return value;
      }),

    // Database
    MONGODB_URI: z
      .string()
      .trim()
      .regex(/^mongodb(\+srv)?:\/\/.+/, 'must be a mongodb:// or mongodb+srv:// connection string'),
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(10_000),
    MONGODB_CONNECT_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

    // Browser clients
    CLIENT_ORIGINS: z
      .string()
      .default('http://localhost:5173')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      )
      .pipe(
        z
          .array(
            z.string().refine(isOrigin, 'must be an origin like https://app.example.com (no path)'),
          )
          .min(1, 'at least one origin is required'),
      ),
    WEB_APP_URL: z
      .string()
      .default('http://localhost:5173')
      .refine(isOrigin, 'must be an origin like https://app.example.com (no path)'),

    // Authentication
    AUTH_SECRET: z
      .string()
      .min(32, 'must be at least 32 characters (generate one with: openssl rand -base64 48)'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(600),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    REFRESH_TOKEN_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).max(120).default(30),
    RECENT_AUTH_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(3_600).default(300),
    COOKIE_SECURE: booleanString.optional(),
    RATE_LIMIT_ENABLED: booleanString.default(true),
    /** End-to-end encrypted direct messages can be turned on per conversation (off by default). */
    E2EE_ENABLED: booleanString.default(false),

    // Uploaded files (avatars). Relative paths are resolved from backend. Never inside MongoDB.
    UPLOADS_DIR: z
      .string()
      .trim()
      .min(1)
      .default('uploads')
      .transform((dir) => resolve(API_ROOT, dir)),

    // Storage driver for avatars and attachments: "local" (development) or "s3" (any
    // S3-compatible provider). Credentials stay on the server.
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    S3_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
    S3_REGION: z.string().trim().min(1).default('us-east-1'),
    S3_BUCKET: z.string().trim().min(3).optional(),
    S3_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().trim().min(1).optional(),
    S3_FORCE_PATH_STYLE: booleanString.default(true),

    // Messages and attachments
    /** How long after sending you may edit a text message (0 disables editing). */
    MESSAGE_EDIT_WINDOW_SECONDS: z.coerce.number().int().min(0).max(604_800).default(900),
    /** How long after sending you may delete a message for everyone (0 disables it). */
    MESSAGE_DELETE_WINDOW_SECONDS: z.coerce.number().int().min(0).max(604_800).default(3_600),
    ATTACHMENT_USER_QUOTA_MB: z.coerce.number().int().min(5).max(100_000).default(200),
    ATTACHMENT_TOTAL_QUOTA_MB: z.coerce.number().int().min(5).max(10_000_000).default(10_240),
    /** Uploaded attachments never used in a message are deleted after this long. */
    ATTACHMENT_ORPHAN_MINUTES: z.coerce.number().int().min(5).max(10_080).default(60),

    // Google OAuth (optional: Google sign-in is disabled unless both are set)
    GOOGLE_CLIENT_ID: z.string().trim().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().trim().min(1).optional(),
    GOOGLE_REDIRECT_URI: z.url({ protocol: /^https?$/ }).optional(),

    // Email (SMTP). Without SMTP_HOST, development logs emails instead of sending them.
    // Calls (WebRTC). STUN finds public addresses; TURN relays media when a direct path fails.
    STUN_URLS: iceUrlList(/^stuns?:\S+$/).default(['stun:stun.l.google.com:19302']),
    TURN_URLS: iceUrlList(/^turns?:\S+$/).default([]),
    /** coturn "use-auth-secret" / TURN REST API shared secret: credentials are minted per user. */
    TURN_SECRET: z.string().min(16).optional(),
    TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(3_600),
    CALL_RING_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(120).default(45),

    SMTP_HOST: z.string().trim().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_SECURE: booleanString.default(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    EMAIL_FROM: z.string().trim().min(3).default('Connect <no-reply@localhost>'),
  })
  .superRefine((env, ctx) => {
    if (Boolean(env.GOOGLE_CLIENT_ID) !== Boolean(env.GOOGLE_CLIENT_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_CLIENT_SECRET'],
        message: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together',
      });
    }
    if (env.TURN_URLS.length > 0 && !env.TURN_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['TURN_SECRET'],
        message: 'is required when TURN_URLS is set (credentials are short-lived, never static)',
      });
    }
    if (env.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'is required when STORAGE_DRIVER=s3',
          });
        }
      }
    }
    if (env.AUTH_SECRET.includes(EXAMPLE_SECRET_MARKER) && env.NODE_ENV !== 'test') {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_SECRET'],
        message: 'still contains the example placeholder; generate a real secret',
      });
    }
    if (env.NODE_ENV === 'production') {
      if (!env.SMTP_HOST) {
        ctx.addIssue({ code: 'custom', path: ['SMTP_HOST'], message: 'is required in production' });
      }
      if (env.COOKIE_SECURE === false) {
        ctx.addIssue({
          code: 'custom',
          path: ['COOKIE_SECURE'],
          message: 'cannot be false in production',
        });
      }
      if (env.GOOGLE_REDIRECT_URI && !env.GOOGLE_REDIRECT_URI.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['GOOGLE_REDIRECT_URI'],
          message: 'must use https in production',
        });
      }
      if (!env.WEB_APP_URL.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['WEB_APP_URL'],
          message: 'must use https in production',
        });
      }
    }
  });

/**
 * Validates a raw environment object. Empty strings are treated as unset so that
 * `KEY=` in a .env file falls back to the default (or fails if required).
 * Error messages name the variable but never echo its value.
 */
export function parseEnv(source) {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

/** Loads backend/.env if present (real env vars take precedence) and validates process.env. */
export function loadEnv() {
  const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  return parseEnv(process.env);
}
