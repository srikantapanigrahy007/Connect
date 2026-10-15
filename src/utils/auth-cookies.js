function baseOptions(config) {
  return { httpOnly: true, secure: config.cookies.secure, sameSite: 'lax' };
}

/**
 * Access token: whole site (API + Socket.IO), lifetime of the token.
 * Refresh token: only sent to /api/v1/auth, lifetime of the session.
 * Both are HttpOnly so page scripts can never read them.
 */
export function setSessionCookies(res, config, issued) {
  const { names, refreshPath } = config.cookies;
  res.cookie(names.access, issued.accessToken, {
    ...baseOptions(config),
    path: '/',
    expires: issued.accessTokenExpiresAt,
  });
  res.cookie(names.refresh, issued.refreshToken, {
    ...baseOptions(config),
    path: refreshPath,
    expires: issued.expiresAt,
  });
}

export function clearSessionCookies(res, config) {
  const { names, refreshPath } = config.cookies;
  res.clearCookie(names.access, { ...baseOptions(config), path: '/' });
  res.clearCookie(names.refresh, { ...baseOptions(config), path: refreshPath });
}

export function setCsrfCookie(res, config, token) {
  res.cookie(config.cookies.names.csrf, token, {
    ...baseOptions(config),
    path: '/',
    maxAge: config.auth.refreshTokenTtlMs,
  });
}

export function setOAuthBindingCookie(res, config, token) {
  res.cookie(config.cookies.names.oauth, token, {
    ...baseOptions(config),
    path: config.cookies.oauthPath,
    maxAge: 10 * 60_000,
  });
}

export function clearOAuthBindingCookie(res, config) {
  res.clearCookie(config.cookies.names.oauth, {
    ...baseOptions(config),
    path: config.cookies.oauthPath,
  });
}
