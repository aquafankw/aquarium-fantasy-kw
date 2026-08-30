const CACHE = "aquafan-admin-v4";
const FILES = ["/admin/", "/admin/index.html", "/admin/admin.css", "/admin/admin.js", "/admin/manifest.webmanifest", "/admin/icon-192.png", "/admin/icon-512.png"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));
self.addEventListener("activate", event => event.waitUntil(Promise.all([self.clients.claim(), caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))])));
self.addEventListener("fetch", event => { if (event.request.method !== "GET" || new URL(event.request.url).pathname.startsWith("/admin/api/")) return; event.respondWith(fetch(event.request).catch(() => caches.match(event.request))); });
