import "server-only";
import { lastDays, type MobileSummaryProps, usd } from "@/components/mobile-summary";
import type { BuyerDataset, SellerDataset } from "./analytics";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const short = (day: string) => day.slice(5).replace("-", "/");
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Seller, small screens: money by state, last 7 days stacked by state, endpoints by revenue. */
export function sellerSummary(d: SellerDataset): MobileSummaryProps {
  const days = lastDays(7);
  const byEndpoint = new Map<string, { revenue: number; calls: number }>();
  for (const c of d.charges) {
    const e = byEndpoint.get(c.endpoint) ?? { revenue: 0, calls: 0 };
    e.revenue += c.amount;
    e.calls += 1;
    byEndpoint.set(c.endpoint, e);
  }
  return {
    tiles: [
      {
        label: "Earned",
        value: usd(sum(d.charges.map((c) => c.earned))),
        hint: "on tabs",
        color: "bg-earned",
      },
      {
        label: "Collected",
        value: usd(sum(d.charges.map((c) => c.collected))),
        hint: "via PayPal",
        color: "bg-collected",
      },
      {
        label: "Paid out",
        value: usd(sum(d.charges.map((c) => c.paid_out))),
        hint: "to you",
        color: "bg-paid-out",
      },
      { label: "Paid calls", value: d.charges.length.toLocaleString() },
    ],
    chart: {
      title: "Revenue, last 7 days",
      legend: [
        { name: "earned", color: "bg-earned" },
        { name: "collected", color: "bg-collected" },
        { name: "paid out", color: "bg-paid-out" },
      ],
      bars: days.map((day) => {
        const rows = d.charges.filter((c) => iso(c.day) === day);
        return {
          label: short(day),
          segments: [
            { name: "paid out", value: sum(rows.map((r) => r.paid_out)), color: "bg-paid-out" },
            { name: "collected", value: sum(rows.map((r) => r.collected)), color: "bg-collected" },
            { name: "earned", value: sum(rows.map((r) => r.earned)), color: "bg-earned" },
          ],
        };
      }),
    },
    list: {
      title: "By endpoint",
      empty: "No paid calls yet.",
      items: [...byEndpoint]
        .sort((a, b) => b[1].revenue - a[1].revenue)
        .slice(0, 10)
        .map(([endpoint, e]) => ({
          key: endpoint,
          title: endpoint,
          subtitle: `${e.calls.toLocaleString()} paid calls`,
          value: usd(e.revenue),
        })),
    },
  };
}

/** Buyer, small screens: spend and guard outcomes, last 7 days of spend, top sellers. */
export function buyerSummary(d: BuyerDataset): MobileSummaryProps {
  const days = lastDays(7);
  const bySeller = new Map<string, { amount: number; calls: number }>();
  for (const s of d.spend) {
    const e = bySeller.get(s.seller) ?? { amount: 0, calls: 0 };
    e.amount += s.amount;
    e.calls += 1;
    bySeller.set(s.seller, e);
  }
  const count = (o: string) => d.checks.filter((c) => c.outcome === o).length;
  return {
    tiles: [
      { label: "Spent", value: usd(sum(d.spend.map((s) => s.amount))), hint: "all agents" },
      { label: "Paid calls", value: d.spend.length.toLocaleString() },
      { label: "Asked you", value: String(count("ask")), hint: "spend checks" },
      { label: "Denied", value: String(count("deny")), hint: "spend checks" },
    ],
    chart: {
      title: "Spend, last 7 days",
      legend: [],
      bars: days.map((day) => ({
        label: short(day),
        segments: [
          {
            name: "spend",
            value: sum(d.spend.filter((s) => iso(s.day) === day).map((s) => s.amount)),
            color: "bg-primary",
          },
        ],
      })),
    },
    list: {
      title: "By seller",
      empty: "No purchases yet.",
      items: [...bySeller]
        .sort((a, b) => b[1].amount - a[1].amount)
        .slice(0, 10)
        .map(([seller, e]) => ({
          key: seller,
          title: seller,
          subtitle: `${e.calls.toLocaleString()} paid calls`,
          value: usd(e.amount),
        })),
    },
  };
}
