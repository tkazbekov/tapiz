import { getAllowedOrigins } from '../network.js';

export interface AuthConfig {
  cookieName: string;
  cookieSecure: boolean;
  // origins allowed to send cookie-authenticated, state-changing requests
  allowedOrigins: Set<string>;
  frontendUrl: string;
}

let warnedSchemes = false;

// Not memoised: it is cheap and tests switch API_URL to check the cookie.
export function getAuthConfig(): AuthConfig {
  const apiUrl = process.env['API_URL'];
  const frontendUrl = process.env['FRONTEND_URL'];

  if (!apiUrl || !frontendUrl) {
    throw new Error('API_URL and FRONTEND_URL are required for auth');
  }

  const apiProtocol = new URL(apiUrl).protocol;

  if (!warnedSchemes && apiProtocol !== new URL(frontendUrl).protocol) {
    warnedSchemes = true;
    console.warn(
      'API_URL and FRONTEND_URL use different schemes; session cookies need both on the same site.',
    );
  }

  // Never derived from NODE_ENV: compose runs production over plain http.
  const secureOverride = process.env['SESSION_COOKIE_SECURE'];

  return {
    cookieName: 'tapiz_session',
    cookieSecure:
      secureOverride === 'true' || secureOverride === 'false'
        ? secureOverride === 'true'
        : apiProtocol === 'https:',
    allowedOrigins: getAllowedOrigins(),
    frontendUrl,
  };
}
