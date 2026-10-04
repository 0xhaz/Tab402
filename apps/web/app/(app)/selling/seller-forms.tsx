"use client";

import { Copy } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { becomeSeller, saveSellerSettings } from "./actions";

function OneTimeSecret({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-primary/40 bg-primary/5 p-3">
      <p className="text-sm font-medium">{label} — copy it now, it won't be shown again.</p>
      <div className="flex gap-2">
        <Input readOnly value={value} className="font-mono text-xs" />
        <Button
          variant="outline"
          size="icon"
          aria-label="Copy"
          onClick={() => navigator.clipboard.writeText(value).then(() => toast.success("Copied"))}
        >
          <Copy />
        </Button>
      </div>
    </div>
  );
}

export function BecomeSeller({ defaultName }: { defaultName: string }) {
  const [name, setName] = useState(defaultName);
  const router = useRouter();
  const [key, setKey] = useState<string | null>(null);
  if (key) {
    return (
      <div className="flex flex-col gap-3">
        <OneTimeSecret label="Seller API key" value={key} />
        <Button variant="secondary" className="w-fit" onClick={() => router.refresh()}>
          Done — I've copied it
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sname">Seller name</Label>
        <Input id="sname" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <Button
        onClick={async () => {
          const r = await becomeSeller(name);
          if ("error" in r) toast.error(r.error);
          else setKey(r.apiKey ?? null);
        }}
      >
        Start selling
      </Button>
    </div>
  );
}

export function SellerSettings({
  payoutReceiver,
  webhookUrl,
}: {
  payoutReceiver: string;
  webhookUrl: string;
}) {
  const [state, action, pending] = useActionState(saveSellerSettings, null);
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="payoutReceiver">Payouts go to (PayPal email)</Label>
        <Input
          id="payoutReceiver"
          name="payoutReceiver"
          type="email"
          defaultValue={payoutReceiver}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="webhookUrl">Webhook URL (optional)</Label>
        <Input
          id="webhookUrl"
          name="webhookUrl"
          type="url"
          defaultValue={webhookUrl}
          placeholder="https://your-api.example/hooks/tab402"
        />
      </div>
      {state && "error" in state && <p className="text-sm text-destructive">{state.error}</p>}
      {state && "secret" in state && state.secret && (
        <OneTimeSecret label="Webhook signing secret" value={state.secret} />
      )}
      <Button type="submit" disabled={pending} className="w-fit">
        Save
      </Button>
    </form>
  );
}
