"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

type Status = "live" | "sandbox" | "next";
type Stage = "fund" | "charge" | "payout" | "reconcile";
type Product = {
  name: string;
  tagline: string;
  api: string;
  role: string;
  status: Status;
  stage: Stage;
};

const STATUS: Record<Status, { label: string; dot: string; badge: string }> = {
  live: {
    label: "Live in Tab402",
    dot: "bg-[#0070e0]",
    badge: "bg-[#003087] text-white",
  },
  sandbox: {
    label: "Tested in sandbox",
    dot: "border-2 border-[#0070e0] bg-[#0070e0]/30",
    badge: "bg-[#0070e0]/15 text-[#003087] dark:text-[#7fb6ff]",
  },
  next: {
    label: "Planned",
    dot: "border-2 border-dashed border-muted-foreground/60",
    badge: "bg-muted text-muted-foreground",
  },
};

const STAGES: { id: Stage; title: string; note: string }[] = [
  { id: "fund", title: "Buyer funds", note: "How a buyer pays in" },
  { id: "charge", title: "Tab402 charges", note: "How a tab is settled" },
  { id: "payout", title: "Seller is paid", note: "How money goes out" },
  { id: "reconcile", title: "Reconcile", note: "Books and agent tools" },
];

/** The PayPal products Tab402 plugs into, grouped by where they sit in the money flow. */
const PAYPAL_PRODUCTS: Product[] = [
  {
    name: "PayPal JS SDK v6",
    tagline: "Connect a wallet once",
    api: "Save payment method (vault without purchase)",
    role: "Buyers save their PayPal wallet without buying anything. It opens a popup on desktop and a redirect on phones, and the server finishes the flow if the browser changes.",
    status: "live",
    stage: "fund",
  },
  {
    name: "Vault (payment tokens)",
    tagline: "Keep the wallet token safe",
    api: "/v3/vault/setup-tokens → payment-tokens",
    role: "PayPal returns a merchant vault token. Tab402 encrypts it on the server, and no browser or agent ever sees it.",
    status: "live",
    stage: "fund",
  },
  {
    name: "Invoicing v2",
    tagline: "Monthly invoice, NET 30",
    api: "/v2/invoicing/invoices",
    role: "Enterprise buyers can get the month's tab as a PayPal invoice with payment terms instead of saving a wallet.",
    status: "sandbox",
    stage: "fund",
  },
  {
    name: "Braintree",
    tagline: "Saved cards, fraud scores",
    api: "transaction.sale · paymentMethodToken",
    role: "Agents could pay with saved cards, charged merchant-initiated. Fraud Protection Advanced scores would feed the spend guard.",
    status: "next",
    stage: "fund",
  },
  {
    name: "Venmo",
    tagline: "A second wallet in the US",
    api: "Vaulted via the PayPal SDK or Braintree",
    role: "US buyers could fund their personal agents with Venmo, through the same funding adapter as PayPal.",
    status: "next",
    stage: "fund",
  },
  {
    name: "Orders API v2",
    tagline: "One charge per tab",
    api: "/v2/checkout/orders + vault_id",
    role: "Tab402 captures a whole tab or top-up in one merchant-initiated call, sending PayPal's device-risk header.",
    status: "live",
    stage: "charge",
  },
  {
    name: "Subscriptions",
    tagline: "Base plan plus metered usage",
    api: "Plans + overage on the tab",
    role: "A seller keeps a subscription for the base fee. Tab402 meters usage above the allowance and charges it each billing cycle.",
    status: "next",
    stage: "charge",
  },
  {
    name: "PYUSD",
    tagline: "Stablecoin settlement",
    api: "PayPal crypto settlement",
    role: "Tabs could settle in PayPal's stablecoin, for sellers who already take USDC over x402.",
    status: "next",
    stage: "charge",
  },
  {
    name: "Payouts",
    tagline: "Weekly seller payouts",
    api: "/v1/payments/payouts",
    role: "One batch a week to each seller's PayPal account. PayPal's fee is recorded per item, and items that hit INSUFFICIENT_FUNDS are retried.",
    status: "live",
    stage: "payout",
  },
  {
    name: "Hyperwallet",
    tagline: "Payouts to local banks",
    api: "REST v4 payouts",
    role: "Sellers in countries PayPal Payouts doesn't reach could be paid straight to a local bank account, with no PayPal account.",
    status: "next",
    stage: "payout",
  },
  {
    name: "Webhooks",
    tagline: "Keep the ledger in sync",
    api: "verify-webhook-signature",
    role: "Tab402 checks the signature on each PAYMENT.CAPTURE.* and PAYOUTS-ITEM.* event, drops duplicates and updates the ledger.",
    status: "live",
    stage: "reconcile",
  },
  {
    name: "Agent Toolkit · MCP",
    tagline: "PayPal's own agent tools",
    api: "PayPal MCP server",
    role: "PayPal's MCP tools handle shopping and invoices; Tab402's MCP server handles pay-per-call APIs. One agent can use both.",
    status: "next",
    stage: "reconcile",
  },
];

function Detail({ p, className }: { p: Product; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <span
        className={cn(
          "w-fit rounded-full px-2 py-0.5 text-[11px] font-medium",
          STATUS[p.status].badge,
        )}
      >
        {STATUS[p.status].label}
      </span>
      <code className="text-xs break-words text-[#0070e0] dark:text-[#7fb6ff]">{p.api}</code>
      <p className="text-sm text-muted-foreground">{p.role}</p>
    </div>
  );
}

export function PayPalProducts() {
  const [selected, setSelected] = useState(PAYPAL_PRODUCTS[0]?.name ?? "");
  const [filter, setFilter] = useState<Status | null>(null);
  const current = PAYPAL_PRODUCTS.find((p) => p.name === selected) ?? PAYPAL_PRODUCTS[0];
  const counts = (s: Status) => PAYPAL_PRODUCTS.filter((p) => p.status === s).length;

  return (
    <div className="flex flex-col gap-6">
      <fieldset className="flex min-w-0 flex-wrap items-center gap-2" aria-label="Filter by status">
        {(Object.keys(STATUS) as Status[]).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={filter === s}
            onClick={() => setFilter(filter === s ? null : s)}
            className={cn(
              "flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-sm transition-colors hover:bg-muted",
              filter === s && "border-primary bg-primary/10",
            )}
          >
            <span className={cn("size-2.5 rounded-full", STATUS[s].dot)} aria-hidden />
            <span className="tabular-nums font-medium">{counts(s)}</span> {STATUS[s].label}
          </button>
        ))}
      </fieldset>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="grid gap-6 sm:grid-cols-2">
          {STAGES.map((stage, i) => (
            <section key={stage.id} aria-label={stage.title} className="flex flex-col gap-2">
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-semibold text-primary tabular-nums">{i + 1}</span>
                <h3 className="font-semibold">{stage.title}</h3>
                <span className="text-xs text-muted-foreground">{stage.note}</span>
              </div>
              {PAYPAL_PRODUCTS.filter((p) => p.stage === stage.id).map((p) => {
                const active = p.name === current?.name;
                const dimmed = filter !== null && filter !== p.status;
                return (
                  <article
                    key={p.name}
                    className={cn(
                      "rounded-xl border bg-card transition-all duration-200",
                      "hover:-translate-y-0.5 hover:shadow-md",
                      p.status === "next" && "border-dashed",
                      active && "border-[#0070e0]/60 ring-2 ring-[#0070e0]/15",
                      dimmed && "opacity-35",
                    )}
                  >
                    <button
                      type="button"
                      aria-expanded={active}
                      onMouseEnter={() => setSelected(p.name)}
                      onFocus={() => setSelected(p.name)}
                      onClick={() => setSelected(p.name)}
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left"
                    >
                      <span
                        className={cn("size-2.5 shrink-0 rounded-full", STATUS[p.status].dot)}
                        aria-hidden
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium">{p.name}</span>
                        <span className="truncate text-xs text-muted-foreground">{p.tagline}</span>
                      </span>
                      <span className="sr-only">{STATUS[p.status].label}</span>
                      <ChevronDown
                        aria-hidden
                        className={cn(
                          "size-4 shrink-0 text-muted-foreground transition-transform lg:-rotate-90",
                          active && "rotate-180 lg:rotate-0 lg:text-[#0070e0]",
                        )}
                      />
                    </button>
                    {/* Phones and tablets expand in place; desktop shows the side panel. */}
                    <div
                      className={cn(
                        "grid transition-[grid-template-rows] duration-300 lg:hidden",
                        active ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                      )}
                    >
                      <div className="overflow-hidden">
                        <Detail p={p} className="px-3 pb-3" />
                      </div>
                    </div>
                  </article>
                );
              })}
            </section>
          ))}
        </div>

        {current && (
          <aside aria-live="polite" aria-label="Product details" className="hidden lg:block">
            <div
              key={current.name}
              className="sticky top-24 flex flex-col gap-3 rounded-2xl border border-[#0070e0]/30 bg-card p-5 shadow-sm animate-in fade-in slide-in-from-right-2 duration-300"
            >
              <span className="text-xs text-muted-foreground">
                {STAGES.find((s) => s.id === current.stage)?.title}
              </span>
              <h3 className="text-xl font-semibold tracking-tight">{current.name}</h3>
              <Detail p={current} />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
