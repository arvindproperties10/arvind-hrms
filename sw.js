// Service worker: lets the HRMS install as an app and open quickly.
// Always asks GitHub for the latest files first (bypassing the browser's 10-minute cache), and falls back to the
// saved copy only when the phone is offline.
const CACHE = "ap-hrms-v3";
const SHELL = ["./", "./index.html", "./fb.js", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, {cache: "reload"})))).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;   // Firebase and other sites go straight to the network
  e.respondWith(fetch(e.request, {cache: "no-cache"}).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match("./index.html"))));
});
