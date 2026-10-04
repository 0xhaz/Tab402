import { Brand } from "@/components/brand";

export const metadata = { title: "Offline" };

/** Precached by the service worker; shown when a page can't load. Money pages are never cached. */
export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <Brand className="text-lg" />
      <h1 className="text-xl font-semibold tracking-tight">You're offline</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Balances, receipts and approvals need a connection — Tab402 never shows you stale money.
        Reconnect and pull to refresh.
      </p>
    </main>
  );
}
