// Service worker: keeps the app usable without a connection, shows reminders, and opens the
// right page when one is tapped. GitHub API calls are never cached here; app.js handles those.
const CACHE = "app-v1";
const CHART = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js";
const FILES = ["./", "index.html", "dashboard.html", "review.html", "setup.html", "app.js", "stats.js",
               "common.css", "config.json", "manifest.json", "icon.png"];
const CACHED = new Set([...FILES.map((f) => new URL(f, self.registration.scope).href), CHART]);

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.allSettled([...FILES, CHART].map((f) => cache.add(f)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Opens instantly from the cache and refreshes it in the background, so updates appear on the next open.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  url.search = "";
  if (e.request.method !== "GET" || !CACHED.has(url.href)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(url.href);
    const fresh = fetch(e.request).then(async (res) => {
      if (res.ok || res.type === "opaque") await cache.put(url.href, res.clone());
      return res;
    });
    if (!cached) return fresh;
    e.waitUntil(fresh.catch(() => {}));
    return cached;
  })());
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch {}
  // iOS requires a visible notification for every push, or it revokes permission.
  e.waitUntil(self.registration.showNotification(d.title || "Daily health check-in", {
    body: d.body || "How was today? Tap to log it.",
    icon: "icon.png",
    tag: d.tag || "checkin",
    data: { url: d.url || "./" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if ("focus" in w) { await w.navigate(url).catch(() => {}); return w.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});
