import { callListQuerySchema, objectIdSchema } from '#shared';
import { z } from 'zod';
import { requireAuth } from '../middleware/authenticate.js';
import { validated } from '../middleware/validate.js';
import { sendData } from '../utils/http-response.js';

const idParams = z.object({ id: objectIdSchema });

/**
 * HTTP handlers for your own calls and the ICE servers your browser needs. Starting, answering
 * and signaling happen over Socket.IO (see realtime/call-handlers.js).
 *
 * @param {{ calls: ReturnType<typeof import('../services/call.service.js').createCallService> }} deps
 */
export function createCallController({ calls }) {
  return {
    list: validated({ query: callListQuerySchema }, async (req, res, { query }) => {
      res.set('Cache-Control', 'no-store');
      const { data, meta } = await calls.list(requireAuth(req).userId, query);
      sendData(res, 200, data, meta);
    }),
    get: validated({ params: idParams }, async (req, res, { params }) => {
      res.set('Cache-Control', 'no-store');
      sendData(res, 200, await calls.get(requireAuth(req).userId, params.id));
    }),
    // TURN credentials are short-lived and personal: never cached.
    iceServers: async (req, res) => {
      res.set('Cache-Control', 'no-store');
      sendData(res, 200, await calls.iceServers(requireAuth(req).userId));
    },
  };
}
