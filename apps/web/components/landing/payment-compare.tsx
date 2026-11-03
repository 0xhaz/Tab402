"use client";

import { Bot, CreditCard, FileSignature, Hand, ReceiptText, Wallet } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "@/lib/utils";

const PRICE = 0.01;
const FIXED = 0.49;
const RATE = 0.0349;
const TAB_LIMIT = 10;
const MAX_DOTS = 300;

const fee = (amount: number) => FIXED + RATE * amount;
const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

/** PayPal fees for `calls` one-cent calls, charged one by one or as tabs of up to $10. */
export function compareFees(calls: number) {
  const spend = calls * PRICE;
  const full = Math.floor(spend / TAB_LIMIT + 1e-9);
  const rest = spend - full * TAB_LIMIT;
  const tabCharges = full + (rest > 1e-9 ? 1 : 0);
  return {
    spend,
    perCall: { charges: calls, fees: calls * fee(PRICE) },
    tab: { charges: tabCharges, fees: full * fee(TAB_LIMIT) + (rest > 1e-9 ? fee(rest) : 0) },
  };
}

type Node = { icon: typeof Bot; label: string; note?: string; paypal?: boolean; stop?: boolean };

function Pipeline({ nodes, slow }: { nodes: Node[]; slow?: boolean }) {
  return (
    <ol className="flex items-start">
      {nodes.map((n, i) => (
        <li key={n.label} className={cn("flex min-w-0 items-start", i > 0 && "flex-1")}>
          {i > 0 && (
            <span
              aria-hidden
              className={cn(
                "flow-line mt-5 h-0.5 min-w-3 flex-1 rounded-full",
                slow ? "text-destructive/50 [animation-duration:2.4s]" : "text-primary/60",
              )}
            />
          )}
          <div className="flex w-14 shrink-0 flex-col items-center gap-1.5 text-center sm:w-20">
            <span
              className={cn(
                "grid size-10 place-items-center rounded-full border bg-card",
                n.paypal &&
                  "border-[#0070e0]/50 bg-[#0070e0]/10 text-[#003087] dark:text-[#7fb6ff]",
                n.stop && "border-destructive/50 bg-destructive/10 text-destructive",
              )}
            >
              <n.icon className="size-4" aria-hidden />
            </span>
            <span className="text-xs leading-tight font-medium">{n.label}</span>
            {n.note && (
              <span className="text-[11px] leading-tight text-muted-foreground">{n.note}</span>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Dots({ count, className }: { count: number; className: string }) {
  return (
    <div aria-hidden className="flex flex-wrap content-start gap-[3px]">
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: identical dots
        <span key={i} className={cn("size-1.5 rounded-full", className)} />
      ))}
    </div>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: "bad" | "good" }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-2xl font-semibold tracking-tight tabular-nums",
          tone === "bad" && "text-destructive",
          tone === "good" && "text-paid-out",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function FeeBar({ share, tone }: { share: number; tone: "bad" | "good" }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-muted">
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500",
          tone === "bad" ? "bg-destructive" : "bg-paid-out",
        )}
        style={{ width: `max(${Math.min(share, 1) * 100}%, 4px)` }}
      />
    </div>
  );
}

/** Charging every agent call through PayPal vs. adding it to a Tab402 tab, at a chosen volume. */
export function PaymentCompare() {
  const [calls, setCalls] = useState(300);
  const sliderId = useId();
  const { spend, perCall, tab } = compareFees(calls);
  // Whole calls per dot, so the label is exact.
  const perDot = Math.ceil(calls / MAX_DOTS);
  const shown = Math.ceil(calls / perDot);
  const scale = (
    <p className="text-[11px] text-muted-foreground">
      {perDot > 1 ? `1 dot = ${perDot} calls` : "1 dot = 1 call"}
    </p>
  );

  return (
    <figure
      aria-label="Charging per call compared with a Tab402 tab"
      className="flex flex-col gap-6 rounded-2xl border bg-card p-4 shadow-xs sm:p-6"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-6">
        <label htmlFor={sliderId} className="shrink-0 text-sm font-medium">
          <span className="tabular-nums">{calls.toLocaleString("en-US")}</span> calls at 1¢
          <span className="text-muted-foreground"> · {usd(spend)} of API use</span>
        </label>
        <input
          id={sliderId}
          type="range"
          min={10}
          max={3000}
          step={10}
          value={calls}
          onChange={(e) => setCalls(Number(e.target.value))}
          className="w-full accent-primary"
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section
          aria-label="Charge every call"
          className="flex flex-col gap-5 rounded-xl border border-destructive/25 bg-destructive/[0.03] p-4"
        >
          <div>
            <h3 className="font-semibold">Charge every call</h3>
            <p className="text-sm text-muted-foreground">How checkout works on the web today</p>
          </div>
          <Pipeline
            slow
            nodes={[
              { icon: Bot, label: "Agent call" },
              { icon: Hand, label: "Checkout", note: "a person, each time", stop: true },
              { icon: CreditCard, label: "PayPal charge", note: "every call", paypal: true },
            ]}
          />
          <div className="flex flex-col gap-1.5">
            <Dots count={shown} className="bg-destructive/70" />
            {scale}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Figure label="PayPal charges" value={perCall.charges.toLocaleString("en-US")} />
            <Figure label="PayPal fees" value={usd(perCall.fees)} tone="bad" />
          </div>
          <FeeBar share={1} tone="bad" />
          <p className="text-xs text-muted-foreground">
            The fees are {Math.round(perCall.fees / spend)}× what the calls cost.
          </p>
        </section>

        <section
          aria-label="Tab402"
          className="flex flex-col gap-5 rounded-xl border border-primary/30 bg-primary/[0.03] p-4"
        >
          <div>
            <h3 className="font-semibold">Tab402</h3>
            <p className="text-sm text-muted-foreground">Calls go on a tab, PayPal settles it</p>
          </div>
          <Pipeline
            nodes={[
              { icon: Bot, label: "Agent call" },
              { icon: FileSignature, label: "Signed voucher", note: "≈ 7 ms" },
              { icon: ReceiptText, label: "Tab", note: "up to $10" },
              { icon: Wallet, label: "PayPal charge", note: "once per tab", paypal: true },
            ]}
          />
          <div className="flex flex-col gap-1.5">
            <Dots count={shown} className="bg-earned/70" />
            {scale}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Figure label="PayPal charges" value={tab.charges.toLocaleString("en-US")} />
            <Figure label="PayPal fees" value={usd(tab.fees)} tone="good" />
          </div>
          <FeeBar share={tab.fees / perCall.fees} tone="good" />
          <p className="text-xs text-muted-foreground">
            The buyer approves once, when they save their wallet.
          </p>
        </section>
      </div>

      <figcaption className="text-xs text-muted-foreground">
        PayPal's US rate of $0.49 + 3.49% per charge. Tab402 charges a tab when it reaches $10 or
        after 24 hours; this assumes the calls land within a day.
      </figcaption>
    </figure>
  );
}
