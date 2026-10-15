import { parseCookie } from 'cookie';

/** Reads one parsed cookie as a string. */
export function readCookie(req, name) {
  const value = req.cookies[name];
  return typeof value === 'string' ? value : undefined;
}

/** Parses the Cookie header into `req.cookies`. */
export const parseCookies = (req, _res, next) => {
  const header = req.headers.cookie;
  req.cookies = header ? parseCookie(header) : {};
  next();
};
