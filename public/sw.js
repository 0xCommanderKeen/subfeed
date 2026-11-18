// Keeps the app shell so the installed app opens without the network. The network comes first, so a deploy shows
// at once; the cache answers only when the network fails. The API is never cached.
import { SHELL } from './shell.js';

const CACHE = 'subfeed-shell';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') return;
  event.respondWith(fromNetwork(event.request));
});

async function fromNetwork(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(new URL(request.url).pathname, response.clone());
    return response;
  } catch (err) {
    // The share page is opened with the shared link in its query, so the cache is keyed by path alone.
    const cached = await cache.match(new URL(request.url).pathname);
    if (cached) return cached;
    throw err;
  }
}
