import { sendJson } from './http-io.mjs';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Loopback only by default: the API can change favorites and channels. HOST=0.0.0.0 exposes it to the LAN.
export const DEFAULT_HOST = '127.0.0.1';

// The configured hosts plus loopback on the server's own port. Each entry is `host` or `host:port`, as the browser sends it in Host.
export function allowedHosts(configured, port) {
  const listed = (configured ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, ...listed]);
}

function originHost(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

const mediaType = (contentType) => contentType?.split(';')[0].trim().toLowerCase();

// Checking Host against a fixed list stops DNS rebinding: a rebound page sends its own hostname as Host.
// Origin and the JSON content type stop cross-site form and text/plain posts, which skip the CORS preflight.
function refusal(req, hosts) {
  if (!hosts.has(req.headers.host?.toLowerCase())) return { status: 403, error: 'host not allowed' };
  if (SAFE_METHODS.has(req.method)) return null;
  const { origin } = req.headers;
  if (origin !== undefined && !hosts.has(originHost(origin))) return { status: 403, error: 'origin not allowed' };
  if (mediaType(req.headers['content-type']) !== 'application/json') return { status: 415, error: 'Content-Type must be application/json' };
  return null;
}

// Every request, whatever its path, passes refusal() before `handler` sees it.
export function guarded(handler, { hosts }) {
  return (req, res) => {
    const refused = refusal(req, hosts);
    if (refused) return sendJson(res, refused.status, { error: refused.error });
    return handler(req, res);
  };
}
