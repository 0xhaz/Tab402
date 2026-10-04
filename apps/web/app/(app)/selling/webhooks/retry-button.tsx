"use client";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { retryDelivery } from "./actions";

export function RetryButton({ eventId }: { eventId: string }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        const r = await retryDelivery(eventId);
        if ("error" in r) toast.error(r.error);
        else toast.success("Queued — the next delivery attempt is within a minute.");
      }}
    >
      Retry now
    </Button>
  );
}
