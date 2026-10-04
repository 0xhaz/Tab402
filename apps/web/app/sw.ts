/// <reference lib="webworker" />
import {
  ExpirationPlugin,
  NetworkOnly,
  type PrecacheEntry,
  Serwist,
  type SerwistGlobalConfig,
  StaleWhileRevalidate,
} from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}
declare const self: ServiceWorkerGlobalScope;

/**
 * Tab402 service worker. Caching is deliberately narrow: build assets are precached and static
 * files revalidate in the background, but pages, RSC payloads and APIs always hit the network —
 * balances and approvals must never be stale, and nothing private stays on a shared device.
 */
const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      matcher: ({ request, sameOrigin }) =>
        sameOrigin && ["style", "script", "font", "image"].includes(request.destination),
      handler: new StaleWhileRevalidate({
        cacheName: "static",
        plugins: [new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 30 * 86_400 })],
      }),
    },
    { matcher: ({ request }) => request.mode === "navigate", handler: new NetworkOnly() },
  ],
  fallbacks: {
    entries: [{ url: "/~offline", matcher: ({ request }) => request.destination === "document" }],
  },
});
serwist.addEventListeners();

type Payload = {
  id?: string;
  kind?: string;
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
};

self.addEventListener("push", (event) => {
  let data: Payload = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { body: event.data?.text() };
  }
  const approval = data.kind === "approval.requested";
  event.waitUntil(
    self.registration.showNotification(data.title ?? "Tab402", {
      body: data.body ?? "",
      tag: data.tag ?? data.id,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      data: { url: data.url ?? "/" },
      // An agent is waiting on approvals: keep them on screen until acted on.
      requireInteraction: approval,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Only ever open our own pages, whatever the payload says.
  const target = new URL(String(event.notification.data?.url ?? "/"), self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === target.origin);
      if (open) {
        await open.focus();
        await open.navigate(target.href);
      } else await self.clients.openWindow(target.href);
    })(),
  );
});

// Browsers may rotate a subscription; re-subscribe with the same key and tell the server.
self.addEventListener("pushsubscriptionchange", (event) => {
  const e = event as Event & {
    oldSubscription?: PushSubscription | null;
    newSubscription?: PushSubscription | null;
    waitUntil(p: Promise<unknown>): void;
  };
  e.waitUntil(
    (async () => {
      const key = e.oldSubscription?.options.applicationServerKey;
      const sub =
        e.newSubscription ??
        (key
          ? await self.registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: key,
            })
          : null);
      if (!sub) return;
      await fetch("/api/push/subscriptions", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON(), replaces: e.oldSubscription?.endpoint }),
      });
    })(),
  );
});
