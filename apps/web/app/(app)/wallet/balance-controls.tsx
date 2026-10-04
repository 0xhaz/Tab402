"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { setAutoTopUp, topUp } from "./actions";

export function BalanceControls({
  autoTopUp,
  topUpLabel,
}: {
  autoTopUp: boolean;
  topUpLabel: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-6">
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const r = await topUp();
          setBusy(false);
          if ("error" in r) toast.error(r.error);
          else toast.success("Balance topped up");
          router.refresh();
        }}
      >
        {busy && <Loader2 className="animate-spin" />} Top up {topUpLabel}
      </Button>
      <div className="flex items-center gap-2">
        <Switch id="auto" defaultChecked={autoTopUp} onCheckedChange={(on) => setAutoTopUp(on)} />
        <Label htmlFor="auto">Auto top-up when low</Label>
      </div>
    </div>
  );
}
