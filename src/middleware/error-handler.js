import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { StateTransitionError } from '../models/plugins/state-machine.js';
import { AppError } from '../utils/app-error.js';

/** Errors raised by body-parser carry an HTTP status and a `type` discriminator. */
function isBodyParserError(err) {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    typeof err.type === 'string' &&
    'status' in err &&
    typeof err.status === 'number'
  );
}

/** MongoDB E11000. Field names come from the index key pattern; values are never included. */
function duplicateKeyFields(err) {
  if (typeof err !== 'object' || err === null || !('code' in err) || err.code !== 11000)
    return null;
  const keyPattern = 'keyPattern' in err ? err.keyPattern : undefined;
  return keyPattern && typeof keyPattern === 'object' ? Object.keys(keyPattern) : [];
}

/** Converts any error into a client-safe AppError (also used for Socket.IO acknowledgments). */
export function normalize(err) {
  if (err instanceof AppError) return err;
  if (err instanceof StateTransitionError) {
    return new AppError(
      409,
      'INVALID_STATE_TRANSITION',
      'This action is not allowed in the current state.',
    );
  }
  if (err instanceof mongoose.Error.ValidationError) {
    // Mongoose messages can embed submitted values, so only the path and failure kind are exposed.
    return AppError.validation(
      Object.entries(err.errors).map(([path, issue]) => ({
        path,
        message: issue.kind === 'required' ? 'is required' : 'is invalid',
      })),
    );
  }
  if (err instanceof mongoose.Error.CastError) {
    return AppError.badRequest('Invalid identifier or value');
  }
  const duplicateFields = duplicateKeyFields(err);
  if (duplicateFields) {
    return new AppError(
      409,
      'CONFLICT',
      'A record with these details already exists.',
      duplicateFields.map((path) => ({ path, message: 'is already in use' })),
    );
  }
  if (err instanceof ZodError) {
    return AppError.validation(
      err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  if (isBodyParserError(err)) {
    if (err.type === 'entity.too.large') {
      return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    }
    if (err.status >= 400 && err.status < 500) {
      return AppError.badRequest('Malformed request body');
    }
  }
  return new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}

/** Converts any thrown error into the shared ApiErrorResponse envelope. Never leaks internals. */
export function errorHandler(logger) {
  return (err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const appError = normalize(err);
    if (appError.statusCode >= 500) {
      logger.error('Unhandled error', { requestId: req.id, error: err });
    }
    const body = {
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details ? { details: appError.details } : {}),
        requestId: req.id,
      },
    };
    res.status(appError.statusCode).json(body);
  };
}
