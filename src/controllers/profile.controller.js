import {
  blockUserSchema,
  createMessageRequestSchema,
  messageRequestListQuerySchema,
  objectIdSchema,
  privacySettingsUpdateSchema,
  profileUpdateSchema,
  userSearchQuerySchema,
  usernameSchema,
} from '#shared';
import { z } from 'zod';
import { AVATAR_KEY_PATTERN } from '../models/user.model.js';
import { requireAuth } from '../middleware/authenticate.js';
import { validated } from '../middleware/validate.js';
import { AppError } from '../utils/app-error.js';
import { sendData } from '../utils/http-response.js';

const usernameParams = z.object({ username: z.string().trim().toLowerCase().pipe(usernameSchema) });
const idParams = z.object({ id: objectIdSchema });
const userIdParams = z.object({ userId: objectIdSchema });

/**
 * HTTP handlers for profiles, search, message requests, blocks and avatar files. Each one reads
 * the request, calls a service (which re-checks every permission) and sends the response.
 *
 * @param {{ profiles: ReturnType<typeof import('../services/profile.service.js').createProfileService>, requests: ReturnType<typeof import('../services/message-request.service.js').createMessageRequestService>, blocks: ReturnType<typeof import('../services/block.service.js').createBlockService>, storage: import('../services/storage.js').FileStorage }} deps
 */
export function createProfileController({ profiles, requests, blocks, storage }) {
  return {
    // ── Your own profile ────────────────────────────────────────────────────
    getMe: async (req, res) => {
      sendData(res, 200, await profiles.getOwnProfile(requireAuth(req).userId));
    },
    updateMe: validated({ body: profileUpdateSchema }, async (req, res, { body }) => {
      sendData(res, 200, await profiles.updateProfile(requireAuth(req).userId, body));
    }),
    updatePrivacy: validated({ body: privacySettingsUpdateSchema }, async (req, res, { body }) => {
      sendData(res, 200, await profiles.updatePrivacy(requireAuth(req).userId, body));
    }),
    uploadAvatar: async (req, res) => {
      sendData(res, 200, await profiles.setAvatar(requireAuth(req).userId, req.file));
    },
    removeAvatar: async (req, res) => {
      sendData(res, 200, await profiles.removeAvatar(requireAuth(req).userId));
    },

    // ── Other people ────────────────────────────────────────────────────────
    search: validated({ query: userSearchQuerySchema }, async (req, res, { query }) => {
      const { data, meta } = await profiles.search(requireAuth(req).userId, query);
      sendData(res, 200, data, meta);
    }),
    getProfile: validated({ params: usernameParams }, async (req, res, { params }) => {
      res.set('Cache-Control', 'no-store');
      sendData(res, 200, await profiles.getPublicProfile(requireAuth(req).userId, params.username));
    }),

    // ── Message requests ────────────────────────────────────────────────────
    listRequests: validated(
      { query: messageRequestListQuerySchema },
      async (req, res, { query }) => {
        const { data, meta } = await requests.list(requireAuth(req).userId, query);
        sendData(res, 200, data, meta);
      },
    ),
    createRequest: validated({ body: createMessageRequestSchema }, async (req, res, { body }) => {
      sendData(res, 201, await requests.create(requireAuth(req).userId, body));
    }),
    acceptRequest: validated({ params: idParams }, async (req, res, { params }) => {
      sendData(res, 200, await requests.accept(requireAuth(req).userId, params.id));
    }),
    rejectRequest: validated({ params: idParams }, async (req, res, { params }) => {
      sendData(res, 200, await requests.reject(requireAuth(req).userId, params.id));
    }),
    cancelRequest: validated({ params: idParams }, async (req, res, { params }) => {
      sendData(res, 200, await requests.cancel(requireAuth(req).userId, params.id));
    }),

    // ── Blocks ──────────────────────────────────────────────────────────────
    listBlocks: async (req, res) => {
      sendData(res, 200, await blocks.list(requireAuth(req).userId));
    },
    block: validated({ body: blockUserSchema }, async (req, res, { body }) => {
      sendData(res, 201, await blocks.block(requireAuth(req).userId, body.username));
    }),
    unblock: validated({ params: userIdParams }, async (req, res, { params }) => {
      await blocks.unblock(requireAuth(req).userId, params.userId);
      res.status(204).end();
    }),

    // ── Avatar files ────────────────────────────────────────────────────────
    /**
     * Serves a stored avatar. Keys are random and unguessable; only re-encoded WebP files exist,
     * and the key format check prevents reading anything else from disk.
     */
    serveAvatar: async (req, res) => {
      const { key } = req.params;
      if (!AVATAR_KEY_PATTERN.test(key)) throw new AppError(404, 'NOT_FOUND', 'Image not found.');
      let stream;
      try {
        stream = await storage.read(key);
      } catch {
        throw new AppError(404, 'NOT_FOUND', 'Image not found.');
      }
      res.set({
        'Content-Type': 'image/webp',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Security-Policy': "default-src 'none'",
        'Cross-Origin-Resource-Policy': 'same-site',
      });
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    },
  };
}
