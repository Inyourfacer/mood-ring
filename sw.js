// Service worker: shows the daily reminder and opens the check-in when it's tapped.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch {}
  // iOS requires a visible notification for every push, or it revokes permission.
  e.waitUntil(self.registration.showNotification(d.title || "Daily health check-in", {
    body: d.body || "How was today? Tap to log it.",
    icon: "icon.png",
    tag: "checkin",
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
