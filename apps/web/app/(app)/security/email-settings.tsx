"use client";

import { Mail } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { saveApprovalEmail } from "./actions";

export function EmailSettings({
  current,
  accountEmail,
}: {
  current: string | null;
  accountEmail: string;
}) {
  const [on, setOn] = useState(current !== null);
  const [address, setAddress] = useState(current ?? accountEmail);
  const [pending, start] = useTransition();

  const save = (enabled: boolean, to: string) =>
    start(async () => {
      const r = await saveApprovalEmail(enabled ? to : null);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(
        enabled ? `Approval requests will be emailed to ${to}.` : "Approval emails are off.",
      );
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="approval-email-on" className="flex items-center gap-2">
          <Mail className="size-4" />
          Email me approval requests
        </Label>
        <Switch
          id="approval-email-on"
          checked={on}
          disabled={pending}
          onCheckedChange={(v) => {
            setOn(v);
            save(v, address);
          }}
        />
      </div>
      {on && (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            save(true, address.trim());
          }}
        >
          <div className="flex flex-1 flex-col gap-2">
            <Label htmlFor="approval-email">Send them to</Label>
            <Input
              id="approval-email"
              type="email"
              required
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>
          <Button type="submit" variant="outline" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </form>
      )}
      <p className="text-xs text-muted-foreground">
        Each email has a link to review the request, where you approve with your passkey, and a
        Decline link that works without signing in.
      </p>
    </div>
  );
}
