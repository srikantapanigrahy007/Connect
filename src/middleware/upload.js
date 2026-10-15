import { LIMITS } from '#shared';
import multer from 'multer';
import { AppError } from '../utils/app-error.js';

/**
 * Accepts one attachment in the form field `field` (plus at most a few short text fields), kept
 * in memory and validated before anything is stored. Uploading stops as soon as the file exceeds
 * the 5 MB limit, so oversized bodies are never fully read.
 */
export function singleFileUpload(field, maxBytes = LIMITS.attachmentMaxBytes) {
  const parse = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 4, fieldSize: 64, parts: 5 },
  }).single(field);

  return (req, res, next) => {
    parse(req, res, (error) => {
      if (!error) {
        next();
        return;
      }
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        next(new AppError(413, 'PAYLOAD_TOO_LARGE', 'Files must be 5 MB or smaller.'));
        return;
      }
      next(AppError.badRequest(`Upload one file in the "${field}" field.`));
    });
  };
}

/**
 * Accepts one image file in the form field `field`, kept in memory (never written to disk
 * unvalidated). Uploading stops as soon as the file exceeds the size limit.
 *
 * @param {string} field
 */
export function singleImageUpload(field, maxBytes = LIMITS.avatarMaxBytes) {
  const parse = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 0, parts: 1 },
  }).single(field);

  return (req, res, next) => {
    parse(req, res, (error) => {
      if (!error) {
        next();
        return;
      }
      if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          next(
            new AppError(
              413,
              'PAYLOAD_TOO_LARGE',
              `Images must be ${maxBytes / (1024 * 1024)} MB or smaller.`,
            ),
          );
          return;
        }
        next(AppError.badRequest(`Upload one image in the "${field}" field.`));
        return;
      }
      next(AppError.badRequest('The upload could not be read.'));
    });
  };
}
