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
  const sessionAlias = typeof data.sessionAlias === "string" ? data.sessionAlias : "";
  const tag = sessionAlias ? "xacpx-turn:" + instanceId + ":" + sessionAlias : "xacpx-task:" + instanceId;
  event.waitUntil(
    self.registration.showNotification(data.title || "XACPX", {
      body: data.body || "",
      tag: tag,
      icon: "/pwa-192x192.png",
      data: {
        url: typeof data.url === "string" ? data.url : "/",
        instanceId: instanceId,
        sessionAlias: sessionAlias,
      },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = (event.notification && event.notification.data) || {};
  const instanceId = typeof data.instanceId === "string" ? data.instanceId : "";
  const sessionAlias = typeof data.sessionAlias === "string" ? data.sessionAlias : "";
  const baseTarget = typeof data.url === "string" ? data.url : "/";
  const targetUrl = instanceId && sessionAlias
    ? (baseTarget.includes("?") ? baseTarget + "&" : baseTarget + "?") + "instanceId=" + encodeURIComponent(instanceId) + "&sessionAlias=" + encodeURIComponent(sessionAlias)
    : baseTarget;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      if (instanceId && sessionAlias) {
        for (const client of clientList) {
          if ("postMessage" in client) {
            client.postMessage({ type: "SELECT_SESSION", instanceId: instanceId, sessionAlias: sessionAlias });
          }
        }
      }
      let chosenClient = null;
      for (const client of clientList) {
        try {
          const u = new URL(client.url, self.location.origin);
          if (u.pathname === "/" || u.pathname === "") {
            chosenClient = client;
            break;
          }
        } catch (_e) {}
      }
      if (!chosenClient && clientList.length > 0) {
        chosenClient = clientList[0];
        if ("navigate" in chosenClient) {
          chosenClient.navigate(targetUrl).catch(() => {});
        }
      }
      if (chosenClient && (!instanceId || !sessionAlias) && "navigate" in chosenClient) {
        chosenClient.navigate(targetUrl).catch(() => {});
      }
      if (chosenClient && "focus" in chosenClient) {
        return chosenClient.focus();
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});
