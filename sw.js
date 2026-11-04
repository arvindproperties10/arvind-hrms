// Service worker: lets the HRMS install as an app and open quickly.
// Always asks GitHub for the latest files first (bypassing the browser's 10-minute cache), and falls back to the
// saved copy only when the phone is offline.
const CACHE = "ap-hrms-v5";
const SHELL = ["./", "./index.html", "./fb.js", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, {cache: "reload"})))).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;   // Firebase and other sites go straight to the network
  if (u.pathname.endsWith("version.json")) return;                            // version check always goes to the network
  // pages and app code: add a one-off query so GitHub's edge cache can't hand back an old copy
  const page = e.request.mode === "navigate" || /\/(index\.html|fb\.js)?$/.test(u.pathname);
  const req = page ? new Request(u.origin + u.pathname + "?v=" + Date.now(), {cache: "no-store", credentials: "same-origin"}) : e.request;
  e.respondWith(fetch(req, page ? undefined : {cache: "no-cache"}).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match("./index.html"))));
});

// ---- notifications sent by the scheduled job (data-only messages, shown here) ----
self.addEventListener("push", e => {
  let p = {}; try { p = e.data ? e.data.json() : {}; } catch (_) { p = {}; }
  const d = p.data || p, n = p.notification || {};
  const title = d.title || n.title || "Srigandha Properties HRMS";
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || n.body || "", icon: "icons/icon-192.png", badge: "icons/icon-192.png",
    tag: d.tag || undefined, renotify: !!d.tag, data: { url: d.url || "./" }
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(ws => {
    for (const w of ws) if (w.url.startsWith(self.registration.scope)) { w.focus(); return w.navigate(url).catch(() => {}); }
    return clients.openWindow(url);
  }));
});
