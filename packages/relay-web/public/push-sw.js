// Injected into the generated workbox SW via importScripts (see pwa-options.ts).
// Self-contained by design: no bundler pass, plain classic script.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_e) {
    data = { title: "XACPX", body: event.data ? event.data.text() : "" };
  }
  const instanceId = typeof data.instanceId === "string" ? data.instanceId : "unknown";
  event.waitUntil(
    self.registration.showNotification(data.title || "XACPX", {
      body: data.body || "",
      tag: "xacpx-task:" + instanceId,
      icon: "/pwa-192x192.png",
      data: { url: typeof data.url === "string" ? data.url : "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(url).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
