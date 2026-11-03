import { ArrowDown, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

type Node = { title: string; detail: string; paypal?: boolean; accent?: boolean };
type Step = { node: Node; via?: { label: string; api?: string } };

function Box({ node }: { node: Node }) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-1 rounded-xl border bg-card p-4 shadow-xs",
        node.paypal && "border-[#0070e0]/40 bg-[#0070e0]/[0.04]",
        node.accent && "border-primary/50 ring-2 ring-primary/15",
      )}
    >
      {node.paypal && (
        <span className="w-fit rounded-full bg-[#003087] px-2 py-0.5 text-[10px] font-semibold tracking-wide text-white uppercase">
          PayPal
        </span>
      )}
      <span className="font-semibold leading-tight">{node.title}</span>
      <span className="text-sm text-muted-foreground">{node.detail}</span>
    </div>
  );
}

function Connector({ label, api }: { label: string; api?: string }) {
  return (
    <div className="flex shrink-0 items-center gap-2 py-1 lg:w-36 lg:flex-col lg:justify-center lg:gap-1 lg:py-0 lg:text-center">
      <ArrowDown className="size-4 shrink-0 text-muted-foreground lg:hidden" aria-hidden />
      <div className="flex flex-col lg:items-center">
        <span className="text-xs font-medium">{label}</span>
        {api && <code className="text-[11px] text-[#0070e0] dark:text-[#7fb6ff]">{api}</code>}
      </div>
      <ArrowRight className="hidden size-4 text-muted-foreground lg:block" aria-hidden />
    </div>
  );
}

function Lane({ title, note, steps }: { title: string; note: string; steps: Step[] }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-semibold">{title}</h3>
        <span className="text-sm text-muted-foreground">{note}</span>
      </div>
      <div className="flex flex-col lg:flex-row lg:items-stretch">
        {steps.map((s, i) => (
          <div key={s.node.title} className="contents">
            {i > 0 && s.via && <Connector {...s.via} />}
            <Box node={s.node} />
          </div>
        ))}
      </div>
    </section>
  );
}

/** How a paid call flows and how the tab settles on PayPal, with the PayPal API on each arrow. */
export function FlowDiagram() {
  return (
    <figure
      className="flex flex-col gap-8 rounded-2xl border bg-muted/30 p-4 sm:p-6"
      aria-label="Tab402 payment flow"
    >
      <Lane
        title="1 · Once"
        note="The buyer saves a PayPal wallet. Nothing is charged yet."
        steps={[
          { node: { title: "Buyer", detail: "Taps Connect PayPal" } },
          {
            via: { label: "JS SDK v6 save flow", api: "popup · redirect on mobile" },
            node: {
              title: "PayPal approval",
              detail: "Buyer logs in and approves",
              paypal: true,
            },
          },
          {
            via: { label: "Setup → payment token", api: "Vault API v3" },
            node: {
              title: "Tab402 mandate",
              detail: "Encrypted vault token plus a budget",
              accent: true,
            },
          },
        ]}
      />
      <Lane
        title="2 · Every call"
        note="A cent at a time, with no PayPal fee per call."
        steps={[
          {
            node: {
              title: "AI agent",
              detail: "Claude over MCP, or any HTTP client",
            },
          },
          {
            via: { label: "HTTP 402 → signed voucher", api: "x402 tab scheme" },
            node: {
              title: "Seller's API",
              detail: "Middleware quotes a price per route",
            },
          },
          {
            via: { label: "verify · settle", api: "≈ 7 ms gate overhead" },
            node: {
              title: "Tab402 facilitator",
              detail: "Checks the budget and adds the call to the tab",
              accent: true,
            },
          },
        ]}
      />
      <Lane
        title="3 · Settlement"
        note="Hundreds of calls settle as one PayPal charge."
        steps={[
          {
            node: {
              title: "Buyer's tab",
              detail: "Due at $10 or after 24 h",
              accent: true,
            },
          },
          {
            via: { label: "One merchant-initiated capture", api: "Orders API v2 + vault_id" },
            node: {
              title: "Tab402 PayPal account",
              detail: "Merchant of record for the charge",
              paypal: true,
            },
          },
          {
            via: { label: "Weekly batch", api: "Payouts API" },
            node: {
              title: "Seller's PayPal",
              detail: "Webhooks confirm each payout",
              paypal: true,
            },
          },
        ]}
      />
    </figure>
  );
}
