import {
  changePasswordRequestSchema,
  forgotPasswordRequestSchema,
  loginRequestSchema,
  reauthenticateRequestSchema,
  registerRequestSchema,
  resetPasswordRequestSchema,
  verifyEmailRequestSchema,
} from '#shared';

import { z } from 'zod';

import { readCookie } from '../middleware/cookies.js';
import { issueCsrfToken, isValidCsrfToken } from '../middleware/csrf.js';
import { requireAuth } from '../middleware/authenticate.js';
import { validated } from '../middleware/validate.js';

import { OAuthFlowError } from '../services/google-oauth.service.js';

import { AppError } from '../utils/app-error.js';
import {
  clearOAuthBindingCookie,
  clearSessionCookies,
  setCsrfCookie,
  setOAuthBindingCookie,
  setSessionCookies,
} from '../utils/auth-cookies.js';
import { sendData } from '../utils/http-response.js';

export function requestMeta(req) {
  return { userAgent: req.get('user-agent') ?? null, ipAddress: req.ip ?? null };
}

/** Same-site relative path only (prevents open redirects): "/chats", not "//evil.com" or "https://…". */
const returnToSchema = z
  .string()
  .max(512)
  .regex(/^\/(?![/\\])[^\s\\]*$/, 'Invalid return path')
  .default('/chats');

const googleStartQuerySchema = z.object({
  intent: z.enum(['login', 'reauth']).default('login'),
  returnTo: returnToSchema,
});

export function createAuthController(deps) {
  const { config, logger, auth, sessions, google } = deps;

  async function respondWithSession(res, status, issued) {
    setSessionCookies(res, config, issued);
    sendData(res, status, await auth.buildSession(issued));
  }

  const webUrl = (path, params = {}) => {
    const url = new URL(path, config.webAppUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  };

  return {
    csrf: (req, res) => {
      const existing = readCookie(req, config.cookies.names.csrf);
      const token = isValidCsrfToken(config.auth.csrfKey, existing)
        ? existing
        : issueCsrfToken(config.auth.csrfKey);
      setCsrfCookie(res, config, token);
      res.set('Cache-Control', 'no-store');
      sendData(res, 200, { csrfToken: token });
    },

    providers: (_req, res) => {
      sendData(res, 200, { google: google !== null });
    },

    register: validated({ body: registerRequestSchema }, async (req, res, { body }) => {
      await respondWithSession(res, 201, await auth.register(body, requestMeta(req)));
    }),

    login: validated({ body: loginRequestSchema }, async (req, res, { body }) => {
      await respondWithSession(res, 200, await auth.login(body, requestMeta(req)));
    }),

    refresh: async (req, res) => {
      const token = readCookie(req, config.cookies.names.refresh);
      if (!token) throw new AppError(401, 'UNAUTHORIZED', 'Please sign in to continue');
      try {
        await respondWithSession(res, 200, await sessions.refresh(token));
      } catch (error) {
        // A stale token is a harmless race between tabs; keep the newer cookies.
        if (!(error instanceof AppError && error.code === 'REFRESH_TOKEN_STALE')) {
          clearSessionCookies(res, config);
        }
        throw error;
      }
    },

    session: async (req, res) => {
      sendData(res, 200, await auth.describe(requireAuth(req)));
    },

    /** Signs out this device. Works with an expired access token, via the refresh cookie. */
    logout: async (req, res) => {
      const refreshToken = readCookie(req, config.cookies.names.refresh);
      const session = refreshToken ? await sessions.findByRefreshToken(refreshToken) : null;
      if (session && !session.revokedAt) {
        await sessions.revoke(String(session._id), String(session.user), 'logout');
      }
      clearSessionCookies(res, config);
      res.status(204).end();
    },

    logoutAll: async (req, res) => {
      const { userId } = requireAuth(req);
      await sessions.revokeAll(userId, 'logout_all');
      clearSessionCookies(res, config);
      res.status(204).end();
    },

    verifyEmail: validated({ body: verifyEmailRequestSchema }, async (_req, res, { body }) => {
      await auth.verifyEmail(body.token);
      sendData(res, 200, { verified: true });
    }),

    resendVerification: async (req, res) => {
      await auth.resendVerification(requireAuth(req));
      sendData(res, 202, { sent: true });
    },

    forgotPassword: validated(
      { body: forgotPasswordRequestSchema },
      async (_req, res, { body }) => {
        await auth.requestPasswordReset(body.email);
        sendData(res, 202, {
          message: 'If an account exists for that email, we sent a link to reset the password.',
        });
      },
    ),

    resetPassword: validated({ body: resetPasswordRequestSchema }, async (_req, res, { body }) => {
      await auth.resetPassword(body.token, body.password);
      clearSessionCookies(res, config);
      sendData(res, 200, { passwordReset: true });
    }),

    changePassword: validated({ body: changePasswordRequestSchema }, async (req, res, { body }) => {
      await respondWithSession(
        res,
        200,
        await auth.changePassword(requireAuth(req), body, requestMeta(req)),
      );
    }),

    reauthenticate: validated({ body: reauthenticateRequestSchema }, async (req, res, { body }) => {
      const context = requireAuth(req);
      await auth.reauthenticateWithPassword(context, body.password);
      sendData(res, 200, await auth.describe(context));
    }),

    googleStart: validated({ query: googleStartQuerySchema }, async (req, res, { query }) => {
      if (!google)
        throw new AppError(404, 'FEATURE_UNAVAILABLE', 'Google sign-in is not configured.');
      if (query.intent === 'reauth' && !req.auth) {
        throw new AppError(401, 'UNAUTHORIZED', 'Please sign in to continue');
      }
      const { url, bindingToken } = await google.start({
        intent: query.intent,
        userId: query.intent === 'reauth' ? (req.auth?.userId ?? null) : null,
        returnTo: query.returnTo,
      });
      setOAuthBindingCookie(res, config, bindingToken);
      res.redirect(302, url.toString());
    }),

    /** Always redirects back to the web app; failures never expose details in the URL. */
    googleCallback: async (req, res) => {
      const query = new URLSearchParams(req.originalUrl.split('?')[1] ?? '');
      const binding = readCookie(req, config.cookies.names.oauth);
      clearOAuthBindingCookie(res, config);
      if (!google) {
        res.redirect(302, webUrl('/login', { error: 'google_unavailable' }));
        return;
      }
      if (query.has('error')) {
        res.redirect(302, webUrl('/login', { error: 'google_cancelled' }));
        return;
      }
      try {
        const result = await google.complete(query, binding);
        if (result.intent === 'reauth') {
          const context = req.auth;
          // The Google account must be the one already linked to the signed-in user.
          if (context?.userId !== result.userId || context.user.googleId !== result.identity.sub) {
            throw new OAuthFlowError('reauth_identity_mismatch');
          }
          await sessions.markAuthenticated(context.sessionId);
          res.redirect(302, webUrl(result.returnTo, { reauth: 'success' }));
          return;
        }
        const issued = await auth.loginWithGoogle(result.identity, requestMeta(req));
        setSessionCookies(res, config, issued);
        res.redirect(302, webUrl(result.returnTo));
      } catch (error) {
        logger.warn('Google sign-in failed', {
          requestId: req.id,
          reason:
            error instanceof OAuthFlowError
              ? error.reason
              : error instanceof AppError
                ? error.code
                : 'unexpected',
        });
        const codes = {
          ACCOUNT_SUSPENDED: 'account_suspended',
          ACCOUNT_BANNED: 'account_banned',
          GOOGLE_ACCOUNT_CONFLICT: 'google_conflict',
          REGISTRATION_DISABLED: 'registration_disabled',
        };
        const code = (error instanceof AppError && codes[error.code]) || 'google_failed';
        res.redirect(302, webUrl('/login', { error: code }));
      }
    },

    deleteAccount: async (req, res) => {
      await auth.deleteAccount(requireAuth(req));
      clearSessionCookies(res, config);
      res.status(204).end();
    },
  };
}
