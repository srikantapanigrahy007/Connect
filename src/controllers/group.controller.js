import {
  addGroupMembersSchema,
  changeGroupRoleSchema,
  createGroupSchema,
  createInviteSchema,
  inviteSecretSchema,
  pollVoteSchema,
  transferOwnershipSchema,
  updateGroupSchema,
} from '#shared';
import { z } from 'zod';
import { requireAuth } from '../middleware/authenticate.js';
import { validated } from '../middleware/validate.js';
import { sendData } from '../utils/http-response.js';

// Malformed ids are reported as "not found" by the service, like ids of other people's groups.
const idParams = z.object({ id: z.string() });
const memberParams = z.object({ id: z.string(), userId: z.string() });
const inviteParams = z.object({ id: z.string(), inviteId: z.string() });
const pollParams = z.object({ id: z.string(), pollId: z.string() });

/**
 * HTTP handlers for groups, invitations and polls. The actor is always the signed-in user; the
 * group service checks membership and roles on every call.
 *
 * @param {{ groups: ReturnType<typeof import('../services/group.service.js').createGroupService> }} deps
 */
export function createGroupController({ groups }) {
  const me = (req) => requireAuth(req).userId;
  return {
    list: async (req, res) => {
      res.set('Cache-Control', 'no-store');
      sendData(res, 200, await groups.list(me(req)));
    },
    create: validated({ body: createGroupSchema }, async (req, res, { body }) => {
      sendData(res, 201, await groups.create(me(req), body));
    }),
    get: validated({ params: idParams }, async (req, res, { params }) => {
      res.set('Cache-Control', 'no-store');
      sendData(res, 200, await groups.details(me(req), params.id));
    }),
    update: validated({ params: idParams, body: updateGroupSchema }, async (req, res, input) => {
      sendData(res, 200, await groups.update(me(req), input.params.id, input.body));
    }),
    remove: validated({ params: idParams }, async (req, res, { params }) => {
      await groups.remove(me(req), params.id);
      res.status(204).end();
    }),
    uploadAvatar: validated({ params: idParams }, async (req, res, { params }) => {
      sendData(res, 200, await groups.setAvatar(me(req), params.id, req.file));
    }),
    removeAvatar: validated({ params: idParams }, async (req, res, { params }) => {
      sendData(res, 200, await groups.removeAvatar(me(req), params.id));
    }),

    addMembers: validated(
      { params: idParams, body: addGroupMembersSchema },
      async (req, res, { params, body }) => {
        sendData(res, 200, await groups.addMembers(me(req), params.id, body.userIds));
      },
    ),
    /** Remove someone, or leave when :userId is yourself. */
    removeMember: validated({ params: memberParams }, async (req, res, { params }) => {
      sendData(res, 200, await groups.removeMember(me(req), params.id, params.userId));
    }),
    changeRole: validated(
      { params: memberParams, body: changeGroupRoleSchema },
      async (req, res, { params, body }) => {
        sendData(res, 200, await groups.changeRole(me(req), params.id, params.userId, body.role));
      },
    ),
    transfer: validated(
      { params: idParams, body: transferOwnershipSchema },
      async (req, res, { params, body }) => {
        sendData(res, 200, await groups.transferOwnership(me(req), params.id, body.userId));
      },
    ),

    createInvite: validated(
      { params: idParams, body: createInviteSchema },
      async (req, res, { params, body }) => {
        // Contains the secrets: never cached anywhere.
        res.set('Cache-Control', 'no-store');
        sendData(res, 201, await groups.createInvite(me(req), params.id, body));
      },
    ),
    listInvites: validated({ params: idParams }, async (req, res, { params }) => {
      res.set('Cache-Control', 'no-store');
      sendData(res, 200, await groups.listInvites(me(req), params.id));
    }),
    revokeInvite: validated({ params: inviteParams }, async (req, res, { params }) => {
      sendData(res, 200, await groups.revokeInvite(me(req), params.id, params.inviteId));
    }),
    previewInvite: validated({ body: inviteSecretSchema }, async (req, res, { body }) => {
      res.set('Cache-Control', 'no-store');
      sendData(res, 200, await groups.previewInvite(me(req), body));
    }),
    joinWithInvite: validated({ body: inviteSecretSchema }, async (req, res, { body }) => {
      const result = await groups.joinWithInvite(me(req), body);
      sendData(res, result.alreadyMember ? 200 : 201, result);
    }),

    vote: validated({ params: pollParams, body: pollVoteSchema }, async (req, res, input) => {
      const { params, body } = input;
      sendData(res, 200, await groups.vote(me(req), params.id, params.pollId, body.optionIds));
    }),
    retractVote: validated({ params: pollParams }, async (req, res, { params }) => {
      sendData(res, 200, await groups.retractVote(me(req), params.id, params.pollId));
    }),
    closePoll: validated({ params: pollParams }, async (req, res, { params }) => {
      sendData(res, 200, await groups.closePoll(me(req), params.id, params.pollId));
    }),
  };
}
