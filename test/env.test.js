import { describe, expect, it } from 'vitest';
import { createAppConfig } from '../src/config/app-config.js';
import { parseEnv } from '../src/config/env.js';

const base = {
  MONGODB_URI: 'mongodb://127.0.0.1:27017/connect-test',
  AUTH_SECRET: 'a-development-secret-that-is-long-enough-0123',
};

describe('parseEnv', () => {
  it('applies defaults for optional variables', () => {
    const env = parseEnv(base);

    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 4000,
      CLIENT_ORIGINS: ['http://localhost:5173'],
      WEB_APP_URL: 'http://localhost:5173',
      TRUST_PROXY: false,
      ACCESS_TOKEN_TTL_SECONDS: 600,
      REFRESH_TOKEN_TTL_DAYS: 30,
      RATE_LIMIT_ENABLED: true,
      MONGODB_CONNECT_ATTEMPTS: 3,
    });
  });

  it('parses comma-separated origins and numeric values', () => {
    const env = parseEnv({
      ...base,
      PORT: '8080',
      CLIENT_ORIGINS: 'https://app.example.com, http://localhost:5173',
      TRUST_PROXY: '1',
    });

    expect(env.PORT).toBe(8080);
    expect(env.CLIENT_ORIGINS).toEqual(['https://app.example.com', 'http://localhost:5173']);
    expect(env.TRUST_PROXY).toBe(1);
  });

  it('treats empty strings as unset', () => {
    expect(parseEnv({ ...base, PORT: '', TRUST_PROXY: '' })).toMatchObject({
      PORT: 4000,
      TRUST_PROXY: false,
    });
  });

  it('requires a MongoDB URI and a long AUTH_SECRET', () => {
    expect(() => parseEnv({ AUTH_SECRET: base.AUTH_SECRET })).toThrow(/MONGODB_URI/);
    expect(() => parseEnv({ MONGODB_URI: base.MONGODB_URI })).toThrow(/AUTH_SECRET/);
    expect(() => parseEnv({ ...base, AUTH_SECRET: 'short' })).toThrow(/AUTH_SECRET/);
  });

  it('rejects the example placeholder secret outside tests', () => {
    expect(() =>
      parseEnv({ ...base, AUTH_SECRET: 'replace-me-with-a-long-random-secret-value' }),
    ).toThrow(/placeholder/);
  });

  it('requires Google credentials to be set together', () => {
    expect(() => parseEnv({ ...base, GOOGLE_CLIENT_ID: 'id-only' })).toThrow(
      /GOOGLE_CLIENT_SECRET/,
    );
  });

  it('enforces production safety rules', () => {
    expect(() =>
      parseEnv({ ...base, NODE_ENV: 'production', WEB_APP_URL: 'http://app.example.com' }),
    ).toThrow(/SMTP_HOST[\s\S]*WEB_APP_URL/);
    expect(() =>
      parseEnv({
        ...base,
        NODE_ENV: 'production',
        WEB_APP_URL: 'https://app.example.com',
        SMTP_HOST: 'smtp.example.com',
        COOKIE_SECURE: 'false',
      }),
    ).toThrow(/COOKIE_SECURE/);
  });

  it('never echoes secret values in validation errors', () => {
    const secret = 'super-secret-password';
    try {
      parseEnv({ MONGODB_URI: `http://user:${secret}@host`, AUTH_SECRET: secret });
      expect.unreachable('parseEnv should have thrown');
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe('createAppConfig', () => {
  it('uses secure, prefixed cookies in production and plain names in development', () => {
    const production = createAppConfig(
      parseEnv({
        ...base,
        NODE_ENV: 'production',
        WEB_APP_URL: 'https://app.example.com',
        CLIENT_ORIGINS: 'https://app.example.com',
        SMTP_HOST: 'smtp.example.com',
      }),
      '1.0.0',
    );
    expect(production.cookies.secure).toBe(true);
    expect(production.cookies.names.access).toBe('__Host-connect_at');

    const development = createAppConfig(parseEnv(base), '1.0.0');
    expect(development.cookies.secure).toBe(false);
    expect(development.cookies.names.access).toBe('connect_at');
  });

  it('derives distinct keys for access tokens and CSRF tokens', () => {
    const config = createAppConfig(parseEnv(base), '1.0.0');
    expect(Buffer.from(config.auth.accessTokenKey).equals(config.auth.csrfKey)).toBe(false);
  });
});
