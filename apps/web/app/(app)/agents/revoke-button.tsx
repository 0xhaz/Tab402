"use client";

import { Button } from "@/components/ui/button";
import { revokeKey } from "./actions";

export function RevokeButton({ keyId }: { keyId: string }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        if (confirm("Revoke this key? The agent (and its sub-budgets) can't pay with it any more."))
          await revokeKey(keyId);
      }}
    >
      Revoke
    </Button>
  );
}
