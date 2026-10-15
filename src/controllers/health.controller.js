import { AppError } from '../utils/app-error.js';
import { sendData } from '../utils/http-response.js';

export function createHealthController(service) {
  return {
    liveness: (_req, res) => {
      res.set('Cache-Control', 'no-store');
      sendData(res, 200, service.getHealth());
    },
    readiness: async (_req, res) => {
      res.set('Cache-Control', 'no-store');
      const readiness = await service.checkReadiness();
      // Deliberately generic: no host names, connection strings or driver errors.
      if (!readiness)
        throw new AppError(503, 'SERVICE_UNAVAILABLE', 'The database is not reachable.');
      sendData(res, 200, readiness);
    },
  };
}
