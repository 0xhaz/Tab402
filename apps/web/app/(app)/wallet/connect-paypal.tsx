"use client";

import { PayPalProvider, PayPalSavePaymentButton } from "@paypal/react-paypal-js/sdk-v6";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { completeWalletSetup, startWalletSetup } from "./actions";
import { sdkApproved } from "./redirect-return";

/**
 * Save a PayPal wallet without a purchase (JS SDK v6). Popup on
 * desktop, redirect on mobile ("auto"); the SDK resumes after a redirect and calls onApprove.
 */
export function ConnectPayPal({
  clientId,
  environment,
  canPostpay,
}: {
  clientId: string;
  environment: "sandbox" | "production";
  canPostpay: boolean;
}) {
  const router = useRouter();
  const [postpaid, setPostpaid] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Switch
          id="postpaid"
          checked={postpaid}
          onCheckedChange={setPostpaid}
          disabled={!canPostpay}
        />
        <Label htmlFor="postpaid" className="flex flex-col items-start gap-0.5">
          Pay after use (tab)
          <span className="text-xs font-normal text-muted-foreground">
            {canPostpay
              ? "Settle the tab at $10 or every 24 h instead of topping up a balance."
              : "Available after 3 successful PayPal charges. New wallets start prepaid."}
          </span>
        </Label>
      </div>
      <PayPalProvider
        clientId={clientId}
        environment={environment}
        components={["paypal-payments"]}
        pageType="checkout"
      >
        <PayPalSavePaymentButton
          presentationMode="auto"
          createVaultToken={() => startWalletSetup(postpaid ? "postpaid" : "prepaid")}
          onApprove={async ({ vaultSetupToken }) => {
            sdkApproved.current = true;
            const r = await completeWalletSetup(vaultSetupToken);
            if ("error" in r) return void toast.error(r.error);
            toast.success(
              `PayPal wallet saved${r.payerEmail ? ` (${r.payerEmail})` : ""}${r.topUp === "captured" ? " — balance topped up with $10" : ""}`,
            );
            router.refresh();
          }}
          onCancel={() => toast.message("PayPal was closed — nothing was saved.")}
          onError={(err) => toast.error(err instanceof Error ? err.message : "PayPal error")}
        />
      </PayPalProvider>
    </div>
  );
}
