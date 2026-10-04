import { formatUsd } from "@tab402/core";
import { Badge } from "@/components/ui/badge";

export interface PurchaseItem {
  id: string;
  at: Date;
  agent: string;
  seller: string;
  intent: string | null;
  amountMicros: number;
  state: string;
  action?: React.ReactNode;
}

/** Purchases as a card list for phones; pages show their full table from `sm` up. */
export function PurchaseCards({ items }: { items: PurchaseItem[] }) {
  return (
    <ul className="flex flex-col divide-y sm:hidden" aria-label="Purchases">
      {items.map((p) => (
        <li key={p.id} className="flex flex-col gap-1 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate font-medium">{p.seller}</span>
            <span className="font-semibold tabular-nums">{formatUsd(p.amountMicros)}</span>
          </div>
          {p.intent && <p className="line-clamp-2 text-sm">{p.intent}</p>}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="truncate">
              {p.agent} ·{" "}
              {p.at.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}
            </span>
            <Badge variant="secondary" className="ml-auto">
              {p.state.replace("_", " ")}
            </Badge>
            {p.action}
          </div>
        </li>
      ))}
    </ul>
  );
}
