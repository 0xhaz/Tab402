"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { authClient } from "@tab402/auth/client";
import { CheckCircle2, Fingerprint, Loader2, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { beginApprove, decline, finishApprove } from "./actions";

export function ApprovePanel({ approvalId }: { approvalId: string }) {
  const [state, setState] = useState<"idle" | "busy" | "approved" | "declined" | "needs_passkey">(
    "idle",
  );

  async function approve() {
    setState("busy");
    const begin = await beginApprove(approvalId);
    if ("error" in begin) return setState("needs_passkey");
    try {
      const response = await startAuthentication({ optionsJSON: begin.options });
      const done = await finishApprove(approvalId, response);
      if ("error" in done) {
        toast.error(done.error);
        return setState("idle");
      }
      setState("approved");
    } catch {
      toast.error("Passkey check was cancelled.");
      setState("idle");
    }
  }

  async function addPasskey() {
    setState("busy");
    const res = await authClient.passkey.addPasskey({ name: "Tab402 approvals" });
    if (res?.error) {
      toast.error(res.error.message ?? "Couldn't add a passkey");
      return setState("needs_passkey");
    }
    toast.success("Passkey added");
    await approve();
  }

  if (state === "approved") {
    return (
      <p className="flex items-center gap-2 font-medium text-paid-out">
        <CheckCircle2 className="size-5" /> Approved. Your agent can complete the purchase now — you
        can close this tab.
      </p>
    );
  }
  if (state === "declined") {
    return (
      <p className="flex items-center gap-2 font-medium text-muted-foreground">
        <XCircle className="size-5" /> Declined. Nothing was charged.
      </p>
    );
  }
  if (state === "needs_passkey") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Approvals are confirmed with a passkey (Face ID, Touch ID or your device PIN). Add one to
          continue.
        </p>
        <Button onClick={addPasskey}>
          <Fingerprint /> Add a passkey and approve
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <Button
        size="lg"
        className="h-12 sm:h-10 sm:flex-1"
        onClick={approve}
        disabled={state === "busy"}
      >
        {state === "busy" ? <Loader2 className="animate-spin" /> : <Fingerprint />} Approve with
        passkey
      </Button>
      <Button
        size="lg"
        variant="outline"
        className="h-12 sm:h-10"
        disabled={state === "busy"}
        onClick={async () => {
          const r = await decline(approvalId);
          if ("error" in r) toast.error(r.error);
          else setState("declined");
        }}
      >
        Decline
      </Button>
    </div>
  );
}
