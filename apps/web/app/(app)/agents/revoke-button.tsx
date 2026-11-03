"use client";

import { Button } from "@/components/ui/button";
import { allowAgain, revokeKey } from "./actions";

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

/** For agents connected through the Tab402 MCP server: issue them a fresh key on their next call. */
export function AllowAgainButton({ keyId }: { keyId: string }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        if (
          confirm(
            "Allow this agent again? It gets a new key on its next request; the old one stays revoked.",
          )
        )
          await allowAgain(keyId);
      }}
    >
      Allow again
    </Button>
  );
}
