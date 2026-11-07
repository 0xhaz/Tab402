"use client";

import { Bell, BellOff, Smartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { LocalDate } from "@/components/local-date";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

type Device = { id: string; label: string; createdAt: string; lastSuccessAt: string | null };
type State = "loading" | "unsupported" | "ios-install" | "denied" | "off" | "on";

/** Base64url VAPID public key → the Uint8Array `applicationServerKey` wants. */
function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = (b64url + "=".repeat((4 - (b64url.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function isIos() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1)
  );
}
function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

async function registration() {
  // The provider registers /serwist/sw.js; wait for it (with a fallback register for safety).
  return (
    (await navigator.serviceWorker.getRegistration("/")) ??
    (await navigator.serviceWorker.register("/serwist/sw.js", { scope: "/" }))
  );
}

export function PushSettings({
  vapidPublicKey,
  devices,
}: {
  vapidPublicKey: string | null;
  devices: Device[];
}) {
  const router = useRouter();
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      if (
        !("serviceWorker" in navigator) ||
        !("PushManager" in window) ||
        !("Notification" in window)
      ) {
        // iOS Safari only exposes Web Push to home-screen apps (iOS 16.4+).
        setState(isIos() && !isStandalone() ? "ios-install" : "unsupported");
        return;
      }
      if (Notification.permission === "denied") return setState("denied");
      const sub = await (await registration()).pushManager.getSubscription();
      setState(sub ? "on" : "off");
    })().catch(() => setState("unsupported"));
  }, []);

  async function enable() {
    if (!vapidPublicKey) return;
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }
      const reg = await registration();
      await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(vapidPublicKey),
        }));
      const res = await fetch("/api/push/subscriptions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!res.ok)
        throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error);
      setState("on");
      toast.success("Notifications are on for this device.");
      router.refresh();
    } catch (err) {
      toast.error(
        `Couldn't turn on notifications${err instanceof Error && err.message ? `: ${err.message}` : "."}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const sub = await (await registration()).pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/subscriptions", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setState("off");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    const res = await fetch("/api/push/test", { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as { devices?: number; error?: string };
    if (!res.ok) toast.error(body.error ?? "Test failed.");
    else if (!body.devices)
      toast.warning("No device accepted it — try turning notifications off and on.");
    else toast.success(`Sent to ${body.devices} ${body.devices === 1 ? "device" : "devices"}.`);
  }

  async function forget(id: string) {
    await fetch("/api/push/subscriptions", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      {!vapidPublicKey && (
        <Alert>
          <AlertDescription>
            Push isn't configured on this server (VAPID keys missing).
          </AlertDescription>
        </Alert>
      )}
      {state === "ios-install" && (
        <Alert>
          <Smartphone />
          <AlertDescription>
            On iPhone and iPad, notifications work once Tab402 is on your Home Screen (iOS 16.4 or
            later): tap Share → Add to Home Screen, open Tab402 from there, and come back to this
            page.
          </AlertDescription>
        </Alert>
      )}
      {state === "unsupported" && (
        <p className="text-sm text-muted-foreground">
          This browser doesn't support web push notifications.
        </p>
      )}
      {state === "denied" && (
        <p className="text-sm text-muted-foreground">
          Notifications are blocked for this site. Allow them in your browser's site settings, then
          reload.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {state === "off" && (
          <Button onClick={enable} disabled={busy || !vapidPublicKey}>
            <Bell /> Turn on notifications on this device
          </Button>
        )}
        {state === "on" && (
          <>
            <Button variant="secondary" onClick={test}>
              Send a test
            </Button>
            <Button variant="ghost" onClick={disable} disabled={busy}>
              <BellOff /> Turn off on this device
            </Button>
          </>
        )}
      </div>
      {devices.length > 0 && (
        <ul className="divide-y rounded-md border text-sm" aria-label="Devices with notifications">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-3 py-2">
              <Smartphone className="size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate">{d.label}</div>
                <div className="text-xs text-muted-foreground">
                  added <LocalDate iso={d.createdAt} />
                  {d.lastSuccessAt && (
                    <>
                      {" · last delivered "}
                      <LocalDate iso={d.lastSuccessAt} time />
                    </>
                  )}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => forget(d.id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
