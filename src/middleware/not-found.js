import { AppError } from '../utils/app-error.js';

export const notFound = (req, _res, next) => {
  next(AppError.notFound(`Route ${req.method} ${req.path} not found`));
};
