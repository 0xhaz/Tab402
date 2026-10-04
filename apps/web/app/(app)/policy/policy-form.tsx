"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { savePolicy } from "./actions";

type Values = {
  dailyBudget: string;
  perCallMax: string;
  approvalThreshold: string;
  blocklist: string;
  allowlist: string;
};

export function PolicyForm({ values }: { values: Values }) {
  const [state, action, pending] = useActionState(savePolicy, null);
  useEffect(() => {
    if (state && "error" in state) toast.error(state.error);
    if (state && "ok" in state)
      toast.success("Policy saved. Agents follow it from their next purchase.");
  }, [state]);
  const field = (name: keyof Values, label: string, hint: string) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} defaultValue={values[name]} inputMode="decimal" />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
  return (
    <form action={action} className="grid gap-6 sm:grid-cols-3">
      {field("dailyBudget", "Daily budget (USD)", "Across all agents, per UTC day.")}
      {field("perCallMax", "Per-call max (USD)", "Anything above is refused outright.")}
      {field("approvalThreshold", "Ask me above (USD)", "Purchases above this need your passkey.")}
      <div className="flex flex-col gap-1.5 sm:col-span-3">
        <Label htmlFor="blocklist">Never pay these sellers</Label>
        <Textarea
          id="blocklist"
          name="blocklist"
          defaultValue={values.blocklist}
          placeholder="seller ids, comma or space separated"
        />
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-3">
        <Label htmlFor="allowlist">Only pay these sellers (optional)</Label>
        <Textarea
          id="allowlist"
          name="allowlist"
          defaultValue={values.allowlist}
          placeholder="leave empty to allow any seller"
        />
      </div>
      <Button type="submit" disabled={pending} className="w-fit">
        Save policy
      </Button>
    </form>
  );
}
