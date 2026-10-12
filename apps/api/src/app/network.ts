import type { IncomingMessage } from 'node:http';

function toOrigin(url: string | undefined) {
  if (!url) {
    return null;
  }

  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function getFrontendOrigin() {
  return toOrigin(process.env['FRONTEND_URL']);
}

// Browser origins allowed to open a websocket with the user's cookie.
export function getAllowedOrigins() {
  return new Set(
    [getFrontendOrigin(), toOrigin(process.env['API_URL'])].filter(
      (it): it is string => !!it,
    ),
  );
}

// Browsers always send Origin on the handshake and CORS does not cover the
// websocket transport. Clients without Origin (tests, scripts) can't ride a
// victim's cookie, so they are allowed.
export function createWsAllowRequest(allowedOrigins = getAllowedOrigins()) {
  return (
    req: IncomingMessage,
    callback: (err: string | null | undefined, success: boolean) => void,
  ) => {
    const origin = req.headers.origin;

    callback(null, !origin || allowedOrigins.has(origin));
  };
}

type TrustProxyFunction = (address: string, hop: number) => boolean;

// Trusts the nearest `hops` proxies; req.ip is the address the outermost of
// them saw. Only safe when clients can't reach the API port directly.
function trustHops(hops: number): TrustProxyFunction {
  return (_address, hop) => hop < hops;
}

// unset/false -> false; digits -> hop count; 'true' -> 1 hop; anything else is
// an address, CIDR or keyword list (e.g. 'uniquelocal') for fastify.
export function parseTrustProxy(
  value: string | undefined,
): string | boolean | TrustProxyFunction {
  const trimmed = value?.trim();

  if (!trimmed || trimmed === 'false') {
    return false;
  }

  // Passed as a function: fastify ignores a plain numeric trustProxy.
  if (/^\d+$/.test(trimmed)) {
    const hops = Number(trimmed);

    return hops ? trustHops(hops) : false;
  }

  if (trimmed === 'true') {
    console.warn(
      'TRUST_PROXY=true is treated as 1 hop; prefer a hop count or the proxy IP/CIDR.',
    );

    return trustHops(1);
  }

  return trimmed;
}
