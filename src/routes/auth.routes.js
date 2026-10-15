import { Router } from 'express';

import {
  authenticate,
  optionalAuthenticate,
  requireRecentAuth,
} from '../middleware/authenticate.js';
import { createRateLimiter, keyByEmail, keyByIp, keyByUser } from '../middleware/rate-limit.js';

/** Mounted at /api/v1/auth. */
export function createAuthRouter(config, sessions, controller) {
  const router = Router();
  const requireSession = authenticate(config, sessions);
  const limit = {
    loginIp: createRateLimiter(config, 'loginPerIp', keyByIp),
    loginAccount: createRateLimiter(config, 'loginPerAccount', keyByEmail),
    register: createRateLimiter(config, 'registerPerIp', keyByIp),
    forgotIp: createRateLimiter(config, 'forgotPasswordPerIp', keyByIp),
    forgotAccount: createRateLimiter(config, 'forgotPasswordPerAccount', keyByEmail),
    reset: createRateLimiter(config, 'resetPasswordPerIp', keyByIp),
    verify: createRateLimiter(config, 'verifyEmailPerIp', keyByIp),
    resend: createRateLimiter(config, 'resendVerificationPerUser', keyByUser),
    sensitive: createRateLimiter(config, 'sensitivePerUser', keyByUser),
    refresh: createRateLimiter(config, 'refreshPerIp', keyByIp),
    oauth: createRateLimiter(config, 'oauthPerIp', keyByIp),
  };

  router.get('/csrf', controller.csrf);
  router.get('/providers', controller.providers);
  router.get('/session', requireSession, controller.session);

  router.post('/register', limit.register, controller.register);
  router.post('/login', limit.loginIp, limit.loginAccount, controller.login);
  router.post('/refresh', limit.refresh, controller.refresh);
  router.post('/logout', controller.logout);
  router.post('/logout-all', requireSession, controller.logoutAll);

  router.post('/email/verify', limit.verify, controller.verifyEmail);
  router.post('/email/resend', requireSession, limit.resend, controller.resendVerification);

  router.post('/password/forgot', limit.forgotIp, limit.forgotAccount, controller.forgotPassword);
  router.post('/password/reset', limit.reset, controller.resetPassword);
  router.post('/password/change', requireSession, limit.sensitive, controller.changePassword);
  router.post('/reauthenticate', requireSession, limit.sensitive, controller.reauthenticate);

  const maybeSession = optionalAuthenticate(config, sessions);
  router.get('/google', limit.oauth, maybeSession, controller.googleStart);
  router.get('/google/callback', limit.oauth, maybeSession, controller.googleCallback);

  return router;
}

/** Mounted at /api/v1/account. */
export function createAccountRouter(config, sessions, controller) {
  const router = Router();
  router.delete(
    '/',
    authenticate(config, sessions),
    createRateLimiter(config, 'sensitivePerUser', keyByUser),
    requireRecentAuth(config),
    controller.deleteAccount,
  );
  return router;
}
