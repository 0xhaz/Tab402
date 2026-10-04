"use client";

import { authClient } from "@tab402/auth/client";
import { Fingerprint, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { removePasskey } from "./actions";

export function PasskeyList({
  keys,
}: {
  keys: { id: string; name: string; createdAt: string | null; deviceType: string }[];
}) {
  const router = useRouter();
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col divide-y">
        {keys.length === 0 && (
          <li className="py-3 text-sm text-muted-foreground">No passkeys yet.</li>
        )}
        {keys.map((k) => (
          <li key={k.id} className="flex items-center gap-3 py-3">
            <Fingerprint className="size-4 text-muted-foreground" />
            <span className="flex-1">
              {k.name}
              <span className="ml-2 text-xs text-muted-foreground">
                {k.deviceType === "multiDevice" ? "synced" : "this device"}
                {k.createdAt && ` · added ${new Date(k.createdAt).toLocaleDateString()}`}
              </span>
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Remove passkey"
              onClick={async () => {
                await removePasskey(k.id);
                router.refresh();
              }}
            >
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
      <Button
        className="w-fit"
        onClick={async () => {
          const res = await authClient.passkey.addPasskey({ name: "Tab402" });
          if (res?.error) return toast.error(res.error.message ?? "Couldn't add a passkey");
          toast.success("Passkey added");
          router.refresh();
        }}
      >
        <Fingerprint /> Add a passkey
      </Button>
    </div>
  );
}
