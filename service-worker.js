const CACHE_NAME = 'et-app-v1';
const ASSETS = [
    './',
    './index.html',
    './style.css',
    './script.js',
    './manifest.json'
];

// Install Event - cache core assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(ASSETS))
            .then(() => self.skipWaiting())
    );
});

// Activate Event - take control of clients immediately
self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// Fetch Event - network-first, fallback to cache
self.addEventListener('fetch', (event) => {
    // Only handle GET requests
    if (event.request.method !== 'GET') return;

    event.respondWith(
        fetch(event.request)
            .then((networkResponse) => {
                // Update cache in background
                caches.open(CACHE_NAME).then(cache => {
                    try { cache.put(event.request, networkResponse.clone()); } catch (e) { /* ignore */ }
                });
                return networkResponse;
            })
            .catch(() => caches.match(event.request).then((cached) => cached))
    );
});
