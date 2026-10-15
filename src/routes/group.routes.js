import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { createRateLimiter, keyByIp, keyByUser } from '../middleware/rate-limit.js';
import { singleImageUpload } from '../middleware/upload.js';

/**
 * /api/v1/groups, /api/v1/group-invites and poll votes under /api/v1/conversations/:id/polls.
 * Every route needs a signed-in session; membership and roles are checked in the group service.
 *
 * @param {import('../config/app-config.js').AppConfig} config
 * @param {ReturnType<typeof import('../services/session.service.js').createSessionService>} sessions
 * @param {ReturnType<typeof import('../controllers/group.controller.js').createGroupController>} controller
 */
export function createGroupRouters(config, sessions, controller) {
  const requireSession = authenticate(config, sessions);
  const limit = {
    action: createRateLimiter(config, 'groupActionPerUser', keyByUser),
    avatar: createRateLimiter(config, 'avatarUploadPerUser', keyByUser),
    joinUser: createRateLimiter(config, 'inviteJoinPerUser', keyByUser),
    joinIp: createRateLimiter(config, 'inviteJoinPerIp', keyByIp),
  };

  const groups = Router();
  groups.use(requireSession);
  groups.get('/', controller.list);
  groups.post('/', limit.action, controller.create);
  groups.get('/:id', controller.get);
  groups.patch('/:id', limit.action, controller.update);
  groups.delete('/:id', limit.action, controller.remove);
  // Authenticate and rate-limit before reading the upload body.
  groups.put('/:id/avatar', limit.avatar, singleImageUpload('avatar'), controller.uploadAvatar);
  groups.delete('/:id/avatar', limit.action, controller.removeAvatar);
  groups.post('/:id/members', limit.action, controller.addMembers);
  groups.delete('/:id/members/:userId', limit.action, controller.removeMember);
  groups.patch('/:id/members/:userId', limit.action, controller.changeRole);
  groups.post('/:id/transfer', limit.action, controller.transfer);
  groups.get('/:id/invites', controller.listInvites);
  groups.post('/:id/invites', limit.action, controller.createInvite);
  groups.delete('/:id/invites/:inviteId', limit.action, controller.revokeInvite);

  const invites = Router();
  invites.use(requireSession);
  invites.post('/preview', limit.joinIp, limit.joinUser, controller.previewInvite);
  invites.post('/join', limit.joinIp, limit.joinUser, controller.joinWithInvite);

  const polls = Router({ mergeParams: true });
  polls.use(requireSession);
  polls.put('/:pollId/vote', limit.action, controller.vote);
  polls.delete('/:pollId/vote', limit.action, controller.retractVote);
  polls.post('/:pollId/close', limit.action, controller.closePoll);

  return { groups, invites, polls };
}
