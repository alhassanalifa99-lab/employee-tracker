const CACHE_NAME = 'et-app-v3';

const PRECACHE_URLS = [
    './',
    './index.html',
    './offline.html',
    './style.css',
    './script.js',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/icon-512-maskable.png',
    './icons/workwatch-logo.png',
    './icons/screenshot-wide.png',
    './icons/screenshot-narrow.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            for (const url of PRECACHE_URLS) {
                try {
                    await cache.add(new Request(url, { cache: 'reload' }));
                } catch (e) {
                    console.warn('[SW] precache skipped:', url, e?.message || e);
                }
            }
        }).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                if (response && response.status === 200 && response.type === 'basic') {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        try {
                            cache.put(event.request, copy);
                        } catch (_) { /* ignore opaque / range */ }
                    });
                }
                return response;
            })
            .catch(async () => {
                const cached = await caches.match(event.request, { ignoreSearch: true });
                if (cached) return cached;

                const isNavigation = event.request.mode === 'navigate'
                    || (event.request.headers.get('accept') || '').includes('text/html');

                if (isNavigation) {
                    const shell = await caches.match('./index.html')
                        || await caches.match('index.html')
                        || await caches.match('/');
                    if (shell) return shell;
                    const offline = await caches.match('./offline.html');
                    if (offline) return offline;
                }

                return caches.match(event.request);
            })
    );
});
