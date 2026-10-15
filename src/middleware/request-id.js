import { randomUUID } from 'node:crypto';

/** Gives every request a correlation id (`req.id`), also returned in the X-Request-Id header. */
export const requestId = (req, res, next) => {
  req.id = randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
};
