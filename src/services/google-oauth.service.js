import * as oidc from 'openid-client';

import { OAuthState } from '../models/oauth-state.model.js';
import { generateToken, hashToken, safeEqual } from '../security/tokens.js';

/** Google's published OpenID Provider metadata (https://accounts.google.com/.well-known/openid-configuration). */
const GOOGLE_METADATA = {
  issuer: 'https://accounts.google.com',
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
  jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
  userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
  id_token_signing_alg_values_supported: ['RS256'],
  code_challenge_methods_supported: ['S256'],
};

const STATE_TTL_MS = 10 * 60_000;
/** Re-authentication must have happened within this window at Google. */
const REAUTH_MAX_AGE_SECONDS = 300;

export class OAuthFlowError extends Error {
  reason;

  constructor(reason) {
    super(`Google sign-in failed: ${reason}`);
    this.reason = reason;
    this.name = 'OAuthFlowError';
  }
}

export function createGoogleOAuthService(google) {
  const configuration = new oidc.Configuration(
    GOOGLE_METADATA,
    google.clientId,
    google.clientSecret,
  );

  return {
    /**
     * Starts an Authorization Code + PKCE flow. Returns the Google URL and a binding token for an
     * HttpOnly cookie: the callback must present the same browser cookie as well as `state`, which
     * stops attackers from completing a flow in someone else's browser (login CSRF).
     */
    async start(params) {
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const bindingToken = generateToken();

      await OAuthState.create({
        stateHash: hashToken(state),
        bindingHash: hashToken(bindingToken),
        codeVerifier,
        nonce,
        intent: params.intent,
        user: params.userId,
        returnTo: params.returnTo,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      });

      const url = oidc.buildAuthorizationUrl(configuration, {
        redirect_uri: google.redirectUri,
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        ...(params.intent === 'reauth'
          ? { prompt: 'login', max_age: String(REAUTH_MAX_AGE_SECONDS) }
          : { prompt: 'select_account' }),
      });
      return { url, bindingToken };
    },

    /**
     * Validates the callback: single-use state bound to this browser, then the code exchange with
     * PKCE. openid-client verifies the ID token signature (Google JWKS), issuer, audience, expiry
     * and nonce; we additionally require a verified email.
     */
    async complete(query, bindingToken) {
      const state = query.get('state');
      if (!state) throw new OAuthFlowError('missing_state');

      const record = await OAuthState.findOneAndDelete({
        stateHash: hashToken(state),
        expiresAt: { $gt: new Date() },
      }).lean();
      if (!record) throw new OAuthFlowError('unknown_or_expired_state');
      if (!bindingToken || !safeEqual(record.bindingHash, hashToken(bindingToken))) {
        throw new OAuthFlowError('browser_binding_mismatch');
      }

      // Rebuild the callback URL from the registered redirect URI: behind a proxy the URL Express
      // sees differs, and Google requires an exact redirect_uri match.
      const callbackUrl = new URL(google.redirectUri);
      callbackUrl.search = query.toString();

      let tokens;
      try {
        tokens = await oidc.authorizationCodeGrant(configuration, callbackUrl, {
          pkceCodeVerifier: record.codeVerifier,
          expectedState: state,
          expectedNonce: record.nonce,
          idTokenExpected: true,
          ...(record.intent === 'reauth' ? { maxAge: REAUTH_MAX_AGE_SECONDS } : {}),
        });
      } catch (error) {
        throw new OAuthFlowError(
          error instanceof Error ? `token_exchange: ${error.name}` : 'token_exchange',
        );
      }

      const claims = tokens.claims();
      if (!claims || typeof claims.sub !== 'string' || claims.sub.length === 0) {
        throw new OAuthFlowError('missing_subject');
      }
      if (typeof claims.email !== 'string' || claims.email_verified !== true) {
        throw new OAuthFlowError('email_not_verified');
      }

      return {
        intent: record.intent,
        userId: record.user ? String(record.user) : null,
        returnTo: record.returnTo,
        identity: {
          sub: claims.sub,
          email: claims.email.toLowerCase(),
          name: typeof claims.name === 'string' ? claims.name : null,
        },
      };
    },
  };
}
