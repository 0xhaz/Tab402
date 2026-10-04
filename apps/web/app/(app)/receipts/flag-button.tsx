"use client";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { flag } from "./actions";

export function FlagButton({ chargeId }: { chargeId: string }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        const reason = prompt("What went wrong? (the seller sees this)");
        if (reason === null) return;
        const r = await flag(chargeId, reason);
        if ("error" in r) toast.error(r.error);
        else toast.success("Held out of your next payment until the seller responds.");
      }}
    >
      Flag
    </Button>
  );
}
