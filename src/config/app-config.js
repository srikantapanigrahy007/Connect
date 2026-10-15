import { API_PREFIX } from '#shared';
import { deriveKey } from '../security/keys.js';

export const RATE_LIMIT_DEFAULTS = {
  loginPerIp: { windowMs: 15 * 60_000, limit: 20 },
  loginPerAccount: { windowMs: 15 * 60_000, limit: 10 },
  registerPerIp: { windowMs: 60 * 60_000, limit: 10 },
  forgotPasswordPerIp: { windowMs: 60 * 60_000, limit: 10 },
  forgotPasswordPerAccount: { windowMs: 60 * 60_000, limit: 5 },
  resetPasswordPerIp: { windowMs: 15 * 60_000, limit: 20 },
  verifyEmailPerIp: { windowMs: 15 * 60_000, limit: 30 },
  resendVerificationPerUser: { windowMs: 60 * 60_000, limit: 5 },
  sensitivePerUser: { windowMs: 15 * 60_000, limit: 10 },
  refreshPerIp: { windowMs: 5 * 60_000, limit: 120 },
  oauthPerIp: { windowMs: 15 * 60_000, limit: 30 },
  profileUpdatePerUser: { windowMs: 15 * 60_000, limit: 30 },
  avatarUploadPerUser: { windowMs: 60 * 60_000, limit: 10 },
  searchPerUser: { windowMs: 60_000, limit: 60 },
  messageRequestPerUser: { windowMs: 60 * 60_000, limit: 30 },
  blockPerUser: { windowMs: 15 * 60_000, limit: 30 },
  /** HTTP and Socket.IO sends share this budget. */
  messageSendPerUser: { windowMs: 60_000, limit: 60 },
  conversationOpenPerUser: { windowMs: 15 * 60_000, limit: 60 },
  /** Edits, deletes, reactions, pins and stars. */
  messageActionPerUser: { windowMs: 60_000, limit: 120 },
  attachmentUploadPerUser: { windowMs: 10 * 60_000, limit: 40 },
  /** Group changes (create, edit, members, roles, invitations) and poll votes. */
  groupActionPerUser: { windowMs: 60_000, limit: 60 },
  /** Invitation previews and joins: limits guessing short codes. */
  inviteJoinPerUser: { windowMs: 10 * 60_000, limit: 30 },
  inviteJoinPerIp: { windowMs: 10 * 60_000, limit: 60 },
  /** Admin changes (moderation, roles, settings, report decisions). */
  adminActionPerUser: { windowMs: 60_000, limit: 120 },
  /** Reports submitted by one person. */
  reportPerUser: { windowMs: 60 * 60_000, limit: 20 },
  /** Calls started by one person (each one rings someone). */
  callStartPerUser: { windowMs: 60_000, limit: 10 },
  /** E2EE device registration and removal. */
  e2eeDevicePerUser: { windowMs: 15 * 60_000, limit: 30 },
  /** E2EE public-key queries (the crypto library asks when device lists change). */
  e2eeKeysQueryPerUser: { windowMs: 60_000, limit: 60 },
  /** E2EE key uploads (initial keys, retries, top-ups). */
  e2eeKeysUploadPerUser: { windowMs: 15 * 60_000, limit: 60 },
  /** E2EE one-time-key claims (one per new session, per device). */
  e2eeKeysClaimPerUser: { windowMs: 60_000, limit: 60 },
  /** E2EE session binding (a device proving it holds its key; once per sign-in or reload). */
  e2eeBindPerUser: { windowMs: 15 * 60_000, limit: 30 },
  /** E2EE to-device sends (room keys for a conversation; rare: only when keys rotate). */
  e2eeToDeviceSendPerUser: { windowMs: 60_000, limit: 60 },
  /** E2EE to-device fetches (on hints, reconnects and device start). */
  e2eeToDeviceSyncPerUser: { windowMs: 60_000, limit: 120 },
  /** Turning on end-to-end encryption for a conversation. */
  e2eeEnablePerUser: { windowMs: 60 * 60_000, limit: 20 },
  /** ICE server (TURN credential) requests: a few per call. */
  iceServersPerUser: { windowMs: 60_000, limit: 30 },
  /** Marking notifications read and dismissing them. */
  notificationActionPerUser: { windowMs: 60_000, limit: 120 },
};

/** Cookie names use __Host-/__Secure- prefixes when Secure, so subdomains cannot overwrite them. */
export function cookieNames(secure) {
  return secure
    ? {
        access: '__Host-connect_at',
        refresh: '__Secure-connect_rt',
        csrf: '__Host-connect_csrf',
        oauth: '__Secure-connect_oauth',
      }
    : { access: 'connect_at', refresh: 'connect_rt', csrf: 'connect_csrf', oauth: 'connect_oauth' };
}

/**
 * Runtime configuration derived from the validated environment (see config/env.js).
 * Secrets are turned into keys here so the rest of the code never handles AUTH_SECRET itself.
 *
 * @typedef {ReturnType<typeof createAppConfig>} AppConfig
 */

/**
 * @param {ReturnType<typeof import('./env.js').parseEnv>} env
 * @param {string} version
 * @param {{ rateLimits?: Partial<typeof RATE_LIMIT_DEFAULTS>, messages?: object, attachments?: object, calls?: object, realtime?: object, e2ee?: object }} [overrides] Used by tests.
 */
export function createAppConfig(env, version, overrides = {}) {
  const secure = env.COOKIE_SECURE ?? env.NODE_ENV === 'production';
  const allowedOrigins = [...new Set([...env.CLIENT_ORIGINS, env.WEB_APP_URL])];
  return {
    nodeEnv: env.NODE_ENV,
    version,
    trustProxy: env.TRUST_PROXY,
    webAppUrl: env.WEB_APP_URL,
    allowedOrigins,
    cookies: {
      secure,
      names: cookieNames(secure),
      refreshPath: `${API_PREFIX}/auth`,
      oauthPath: `${API_PREFIX}/auth/google`,
    },
    uploads: { dir: env.UPLOADS_DIR },
    storage: {
      driver: env.STORAGE_DRIVER,
      dir: env.UPLOADS_DIR,
      s3:
        env.STORAGE_DRIVER === 's3'
          ? {
              endpoint: env.S3_ENDPOINT,
              region: env.S3_REGION,
              bucket: env.S3_BUCKET,
              accessKeyId: env.S3_ACCESS_KEY_ID,
              secretAccessKey: env.S3_SECRET_ACCESS_KEY,
              forcePathStyle: env.S3_FORCE_PATH_STYLE,
            }
          : null,
    },
    messages: {
      editWindowMs: env.MESSAGE_EDIT_WINDOW_SECONDS * 1_000,
      deleteWindowMs: env.MESSAGE_DELETE_WINDOW_SECONDS * 1_000,
      ...overrides.messages,
    },
    attachments: {
      userQuotaBytes: env.ATTACHMENT_USER_QUOTA_MB * 1024 * 1024,
      totalQuotaBytes: env.ATTACHMENT_TOTAL_QUOTA_MB * 1024 * 1024,
      orphanAfterMs: env.ATTACHMENT_ORPHAN_MINUTES * 60_000,
      ...overrides.attachments,
    },
    auth: {
      accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlMs: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
      refreshReuseGraceMs: env.REFRESH_TOKEN_REUSE_GRACE_SECONDS * 1_000,
      recentAuthMaxAgeMs: env.RECENT_AUTH_MAX_AGE_SECONDS * 1_000,
      accessTokenKey: deriveKey(env.AUTH_SECRET, 'access-token'),
      csrfKey: deriveKey(env.AUTH_SECRET, 'csrf-token'),
    },
    google:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            // Default assumes the API is served under the web origin (Vite proxy / reverse proxy).
            redirectUri:
              env.GOOGLE_REDIRECT_URI ?? `${env.WEB_APP_URL}${API_PREFIX}/auth/google/callback`,
          }
        : null,
    realtime: {
      /** Open sockets per account (tabs and devices); more are refused, so one account can't
       * exhaust the server or multiply its per-socket rate limits. */
      maxSocketsPerUser: 20,
      ...overrides.realtime,
    },
    calls: {
      stunUrls: env.STUN_URLS,
      turnUrls: env.TURN_URLS,
      turnSecret: env.TURN_SECRET ?? null,
      turnCredentialTtlSeconds: env.TURN_CREDENTIAL_TTL_SECONDS,
      ringTimeoutMs: env.CALL_RING_TIMEOUT_SECONDS * 1_000,
      /** A participant whose device dropped has this long to reconnect before the call ends. */
      reconnectGraceMs: 20_000,
      /** Calls never run longer than this (abandoned calls are ended by the sweep). */
      maxDurationMs: 12 * 3_600_000,
      ...overrides.calls,
    },
    e2ee: {
      /** Whether conversations may be switched to end-to-end encryption. Conversations already
       * encrypted stay encrypted whatever this says (no downgrade). */
      enabled: env.E2EE_ENABLED,
      /** Undelivered to-device events per device; more are refused (RECIPIENT_QUEUE_FULL). */
      toDeviceQueueMax: 1_000,
      ...overrides.e2ee,
    },
    rateLimits: {
      enabled: env.RATE_LIMIT_ENABLED,
      rules: { ...RATE_LIMIT_DEFAULTS, ...overrides.rateLimits },
    },
  };
}
