const CACHE = "aquafan-admin-v1";
const FILES = ["/admin/", "/admin/index.html", "/admin/admin.css", "/admin/admin.js", "/admin/manifest.webmanifest", "/admin/icon.svg"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => { if (event.request.method !== "GET" || new URL(event.request.url).pathname.startsWith("/admin/api/")) return; event.respondWith(fetch(event.request).catch(() => caches.match(event.request))); });
