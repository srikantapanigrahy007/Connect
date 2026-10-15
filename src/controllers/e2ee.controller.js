import {
  e2eeBindingSchema,
  e2eeDeviceIdParamsSchema,
  e2eeToDeviceSendSchema,
  e2eeToDeviceSyncSchema,
  e2eeTxnIdParamsSchema,
  objectIdSchema,
  e2eeKeysClaimSchema,
  e2eeKeysQuerySchema,
  e2eeKeysUploadSchema,
  registerE2eeDeviceSchema,
} from '#shared';
import { requireAuth } from '../middleware/authenticate.js';
import { validated } from '../middleware/validate.js';
import { sendData } from '../utils/http-response.js';
import { z } from 'zod';

const conversationParams = z.object({ id: objectIdSchema });

/**
 * HTTP handlers for end-to-end encryption devices (public keys only). The account is always the
 * session's.
 *
 * @param {{ e2ee: ReturnType<typeof import('../services/e2ee.service.js').createE2eeService> }} deps
 */
export function createE2eeController({ e2ee }) {
  return {
    register: validated(
      { params: e2eeDeviceIdParamsSchema, body: registerE2eeDeviceSchema },
      async (req, res, { params, body }) => {
        const auth = requireAuth(req);
        const { device, created } = await e2ee.register(
          auth.userId,
          auth.sessionId,
          params.deviceId,
          body.deviceKeys,
        );
        sendData(res, created ? 201 : 200, device);
      },
    ),
    listOwn: async (req, res) => {
      res.set('Cache-Control', 'no-store');
      sendData(res, 200, await e2ee.listOwn(requireAuth(req).userId));
    },
    remove: validated({ params: e2eeDeviceIdParamsSchema }, async (req, res, { params }) => {
      await e2ee.remove(requireAuth(req).userId, params.deviceId);
      res.status(204).end();
    }),
    // Key payloads are never logged (the request logger records the path only).
    uploadKeys: validated(
      { params: e2eeDeviceIdParamsSchema, body: e2eeKeysUploadSchema },
      async (req, res, { params, body }) => {
        res.set('Cache-Control', 'no-store');
        sendData(res, 200, await e2ee.uploadKeys(requireAuth(req).userId, params.deviceId, body));
      },
    ),
    keyCounts: validated({ params: e2eeDeviceIdParamsSchema }, async (req, res, { params }) => {
      res.set('Cache-Control', 'no-store');
      sendData(res, 200, await e2ee.keyCounts(requireAuth(req).userId, params.deviceId));
    }),
    claim: validated({ body: e2eeKeysClaimSchema }, async (req, res, { body }) => {
      res.set('Cache-Control', 'no-store');
      sendData(res, 200, await e2ee.claimKeys(requireAuth(req).userId, body));
    }),
    bindingChallenge: validated(
      { params: e2eeDeviceIdParamsSchema },
      async (req, res, { params }) => {
        const auth = requireAuth(req);
        res.set('Cache-Control', 'no-store');
        sendData(
          res,
          200,
          await e2ee.bindingChallenge(auth.userId, auth.sessionId, params.deviceId),
        );
      },
    ),
    bind: validated(
      { params: e2eeDeviceIdParamsSchema, body: e2eeBindingSchema },
      async (req, res, { params, body }) => {
        const auth = requireAuth(req);
        await e2ee.bind(auth.userId, auth.sessionId, params.deviceId, body);
        res.status(204).end();
      },
    ),
    // Payloads are Olm ciphertext and are never logged.
    sendToDevice: validated(
      { params: e2eeTxnIdParamsSchema, body: e2eeToDeviceSendSchema },
      async (req, res, { params, body }) => {
        const auth = requireAuth(req);
        sendData(
          res,
          200,
          await e2ee.sendToDevice(auth.userId, auth.sessionId, params.txnId, body),
        );
      },
    ),
    syncToDevice: validated(
      { params: e2eeDeviceIdParamsSchema, body: e2eeToDeviceSyncSchema },
      async (req, res, { params, body }) => {
        const auth = requireAuth(req);
        res.set('Cache-Control', 'no-store');
        sendData(
          res,
          200,
          await e2ee.syncToDevice(auth.userId, auth.sessionId, params.deviceId, body),
        );
      },
    ),
    status: (req, res) => {
      requireAuth(req);
      sendData(res, 200, e2ee.status());
    },
    conversationStatus: validated({ params: conversationParams }, async (req, res, { params }) => {
      const auth = requireAuth(req);
      res.set('Cache-Control', 'no-store');
      sendData(res, 200, await e2ee.conversationStatus(auth.userId, auth.sessionId, params.id));
    }),
    enableConversation: validated({ params: conversationParams }, async (req, res, { params }) => {
      const auth = requireAuth(req);
      sendData(res, 200, await e2ee.enableConversation(auth.userId, auth.sessionId, params.id));
    }),
    query: validated({ body: e2eeKeysQuerySchema }, async (req, res, { body }) => {
      res.set('Cache-Control', 'no-store');
      // The crypto library expects the bare KeysQuery response, inside the usual envelope.
      sendData(res, 200, await e2ee.query(requireAuth(req).userId, body));
    }),
  };
}
