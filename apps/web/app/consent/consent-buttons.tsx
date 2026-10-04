"use client";

import { authClient } from "@tab402/auth/client";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function ConsentButtons() {
  const [busy, setBusy] = useState(false);
  async function answer(accept: boolean) {
    setBusy(true);
    // The client plugin attaches the signed OAuth query from this page's URL.
    const res = await authClient.oauth2.consent({ accept });
    const to =
      (res.data as { redirect_uri?: string; url?: string } | null)?.redirect_uri ??
      (res.data as { url?: string } | null)?.url;
    if (res.error || !to) {
      setBusy(false);
      return void toast.error(res.error?.message ?? "Couldn't complete the connection");
    }
    window.location.href = to;
  }
  return (
    <div className="flex gap-3">
      <Button className="flex-1" disabled={busy} onClick={() => answer(true)}>
        Allow
      </Button>
      <Button variant="outline" disabled={busy} onClick={() => answer(false)}>
        Deny
      </Button>
    </div>
  );
}
