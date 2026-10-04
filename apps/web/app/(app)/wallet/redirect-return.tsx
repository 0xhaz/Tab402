"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { finishRedirectedSetup } from "./actions";

/** Set by ConnectPayPal's onApprove, so the fallback below stays out of the SDK's way. */
export const sdkApproved = { current: false };

/**
 * Back from PayPal's redirect flow (phones). The JS SDK normally resumes and calls onApprove; if it
 * hasn't within a few seconds (approval finished in another browser, home-screen app, reload),
 * finish the pending wallet setup on the server instead. Then drop the query string.
 */
export function RedirectReturn() {
  const params = useSearchParams();
  const router = useRouter();
  const ran = useRef(false);
  const outcome = params.get("paypal");

  useEffect(() => {
    if (ran.current || !outcome) return;
    ran.current = true;
    if (outcome === "cancelled") {
      toast.message("PayPal was closed — nothing was saved.");
      router.replace("/wallet");
      return;
    }
    if (outcome !== "approved") return;
    const timer = setTimeout(async () => {
      if (!sdkApproved.current) {
        const r = await finishRedirectedSetup();
        if ("error" in r) toast.error(r.error);
        else if ("ok" in r)
          toast.success(`PayPal wallet saved${r.payerEmail ? ` (${r.payerEmail})` : ""}`);
      }
      router.replace("/wallet");
      router.refresh();
    }, 4000);
    return () => clearTimeout(timer);
  }, [outcome, router]);
  return null;
}
