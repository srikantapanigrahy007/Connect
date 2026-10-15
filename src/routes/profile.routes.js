import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { createRateLimiter, keyByUser } from '../middleware/rate-limit.js';
import { singleImageUpload } from '../middleware/upload.js';

/**
 * Profile, people, message-request and block routes. Every route except avatar files needs a
 * signed-in session; permissions are checked again inside each service.
 *
 * @param {import('../config/app-config.js').AppConfig} config
 * @param {ReturnType<typeof import('../services/session.service.js').createSessionService>} sessions
 * @param {ReturnType<typeof import('../controllers/profile.controller.js').createProfileController>} controller
 */
export function createProfileRouters(config, sessions, controller) {
  const requireSession = authenticate(config, sessions);
  const limit = {
    profile: createRateLimiter(config, 'profileUpdatePerUser', keyByUser),
    avatar: createRateLimiter(config, 'avatarUploadPerUser', keyByUser),
    search: createRateLimiter(config, 'searchPerUser', keyByUser),
    request: createRateLimiter(config, 'messageRequestPerUser', keyByUser),
    block: createRateLimiter(config, 'blockPerUser', keyByUser),
  };

  // /api/v1/me
  const me = Router();
  me.use(requireSession);
  me.get('/profile', controller.getMe);
  me.patch('/profile', limit.profile, controller.updateMe);
  me.patch('/privacy', limit.profile, controller.updatePrivacy);
  // Authenticate and rate-limit before reading the upload body.
  me.put('/avatar', limit.avatar, singleImageUpload('avatar'), controller.uploadAvatar);
  me.delete('/avatar', limit.profile, controller.removeAvatar);

  // /api/v1/users
  const users = Router();
  users.use(requireSession);
  users.get('/search', limit.search, controller.search);
  users.get('/:username', limit.search, controller.getProfile);

  // /api/v1/message-requests
  const requests = Router();
  requests.use(requireSession);
  requests.get('/', controller.listRequests);
  requests.post('/', limit.request, controller.createRequest);
  requests.post('/:id/accept', controller.acceptRequest);
  requests.post('/:id/reject', controller.rejectRequest);
  requests.post('/:id/cancel', controller.cancelRequest);

  // /api/v1/blocks
  const blocks = Router();
  blocks.use(requireSession);
  blocks.get('/', controller.listBlocks);
  blocks.post('/', limit.block, controller.block);
  blocks.delete('/:userId', limit.block, controller.unblock);

  // /api/v1/avatars/:key (unguessable keys; see controller.serveAvatar)
  const avatars = Router();
  avatars.get('/:key', controller.serveAvatar);

  return { me, users, requests, blocks, avatars };
}
