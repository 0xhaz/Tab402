import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Status = "live" | "sandbox" | "next";
type Product = { name: string; api: string; role: string; status: Status };

const STATUS: Record<Status, { label: string; className: string }> = {
  live: { label: "Live in Tab402", className: "bg-[#003087] text-white" },
  sandbox: {
    label: "Verified in sandbox",
    className: "bg-[#0070e0]/15 text-[#003087] dark:text-[#7fb6ff]",
  },
  next: { label: "Next — same adapter", className: "bg-muted text-muted-foreground" },
};

/** The PayPal family Tab402 plugs into — what runs today, what's proven, what comes next. */
export const PAYPAL_PRODUCTS: Product[] = [
  {
    name: "PayPal JS SDK v6",
    api: "Save payment method (vault without purchase)",
    role: "Buyers connect their wallet once — popup on desktop, redirect on mobile, resumed server-side if the browser changes.",
    status: "live",
  },
  {
    name: "Payment Method Tokens (Vault)",
    api: "/v3/vault/setup-tokens → payment-tokens",
    role: "Merchant-usage vault token, sealed with envelope encryption; it never reaches a browser or an agent.",
    status: "live",
  },
  {
    name: "Orders API v2",
    api: "/v2/checkout/orders + vault_id, stored_credential",
    role: "One merchant-initiated capture per tab or top-up, with the device-risk header. Completes in one call.",
    status: "live",
  },
  {
    name: "Payouts",
    api: "/v1/payments/payouts",
    role: "Weekly batch to every seller's PayPal account; PayPal's own fee recorded per item, retried on INSUFFICIENT_FUNDS.",
    status: "live",
  },
  {
    name: "Webhooks",
    api: "verify-webhook-signature",
    role: "Signature-checked, de-duplicated PAYMENT.CAPTURE.* and PAYOUTS-ITEM.* events reconcile the ledger.",
    status: "live",
  },
  {
    name: "Invoicing v2",
    api: "/v2/invoicing/invoices (NET_30)",
    role: "Enterprise buyers: the month's tab as a PayPal invoice with payment terms instead of a saved wallet.",
    status: "sandbox",
  },
  {
    name: "Braintree",
    api: "transaction.sale · paymentMethodToken",
    role: "Saved cards for agents, charged merchant-initiated; Fraud Protection Advanced risk scores feed the spend guard.",
    status: "next",
  },
  {
    name: "Venmo",
    api: "Vaulted via the PayPal SDK / Braintree",
    role: "A second wallet for US buyers' personal agents, on the same funding adapter.",
    status: "next",
  },
  {
    name: "PYUSD",
    api: "PayPal crypto settlement",
    role: "Stablecoin settlement of tabs — the bridge to x402 USDC sellers.",
    status: "next",
  },
  {
    name: "Hyperwallet",
    api: "REST v4 payouts",
    role: "Local-bank payouts for sellers outside PayPal's Payouts countries, no PayPal account needed.",
    status: "next",
  },
  {
    name: "Subscriptions",
    api: "Plans + metered overage on the tab",
    role: "Keep the subscription for the base fee; Tab402 meters usage above the allowance and charges it each cycle.",
    status: "next",
  },
  {
    name: "Agent Toolkit · MCP server",
    api: "PayPal's agent tools",
    role: "Pairs with Tab402's buyer MCP: PayPal's tools for commerce, Tab402 for pay-per-call APIs.",
    status: "next",
  },
];

export function PayPalProducts() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {PAYPAL_PRODUCTS.map((p) => (
        <article
          key={p.name}
          className={cn(
            "flex flex-col gap-2 rounded-xl border bg-card p-4",
            p.status === "live" && "border-[#0070e0]/40",
            p.status === "next" && "border-dashed",
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-semibold leading-tight">{p.name}</h3>
            <Badge className={cn("shrink-0 border-0", STATUS[p.status].className)}>
              {STATUS[p.status].label}
            </Badge>
          </div>
          <code className="text-xs text-[#0070e0] dark:text-[#7fb6ff]">{p.api}</code>
          <p className="text-sm text-muted-foreground">{p.role}</p>
        </article>
      ))}
    </div>
  );
}
