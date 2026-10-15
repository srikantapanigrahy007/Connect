import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { createRateLimiter, keyByUser } from '../middleware/rate-limit.js';

/**
 * /api/v1/e2ee: end-to-end encryption devices, their public keys, device binding, to-device
 * delivery and encrypted conversations. Every route needs a signed-in session. Conversations can
 * only be switched to encryption when the server allows it (E2EE_ENABLED).
 *
 * @param {import('../config/app-config.js').AppConfig} config
 * @param {ReturnType<typeof import('../services/session.service.js').createSessionService>} sessions
 * @param {ReturnType<typeof import('../controllers/e2ee.controller.js').createE2eeController>} controller
 */
export function createE2eeRouter(config, sessions, controller) {
  const router = Router();
  const devices = createRateLimiter(config, 'e2eeDevicePerUser', keyByUser);
  const query = createRateLimiter(config, 'e2eeKeysQueryPerUser', keyByUser);
  const upload = createRateLimiter(config, 'e2eeKeysUploadPerUser', keyByUser);
  const claim = createRateLimiter(config, 'e2eeKeysClaimPerUser', keyByUser);
  const bind = createRateLimiter(config, 'e2eeBindPerUser', keyByUser);
  const toDeviceSend = createRateLimiter(config, 'e2eeToDeviceSendPerUser', keyByUser);
  const toDeviceSync = createRateLimiter(config, 'e2eeToDeviceSyncPerUser', keyByUser);
  const enable = createRateLimiter(config, 'e2eeEnablePerUser', keyByUser);

  router.use(authenticate(config, sessions));
  router.get('/devices', controller.listOwn);
  router.put('/devices/:deviceId', devices, controller.register);
  router.delete('/devices/:deviceId', devices, controller.remove);
  router.post('/devices/:deviceId/keys', upload, controller.uploadKeys);
  router.get('/devices/:deviceId/keys/count', query, controller.keyCounts);
  router.post('/keys/query', query, controller.query);
  router.post('/keys/claim', claim, controller.claim);
  // Checkpoint D: device binding, to-device delivery, encrypted conversations.
  router.get('/status', controller.status);
  router.post('/devices/:deviceId/binding-challenge', bind, controller.bindingChallenge);
  router.put('/devices/:deviceId/binding', bind, controller.bind);
  router.put('/to-device/:txnId', toDeviceSend, controller.sendToDevice);
  router.post('/devices/:deviceId/to-device', toDeviceSync, controller.syncToDevice);
  router.get('/conversations/:id', query, controller.conversationStatus);
  router.post('/conversations/:id/enable', enable, controller.enableConversation);
  return router;
}
