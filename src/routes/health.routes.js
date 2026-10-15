import { Router } from 'express';

export function createHealthRouter(controller) {
  const router = Router();
  router.get('/', controller.liveness);
  router.get('/ready', controller.readiness);
  return router;
}
