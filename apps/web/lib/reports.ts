/**
 * Pre-built AG Studio reports. Plain JSON state: pages → widgets → layout on a
 * 24-column grid. Analysts can still switch to edit mode and change anything.
 */
type Ref = { id: string; aggregation?: "sum" | "count" | "countd" | "avg" | "max" | "min" };
const title = (text: string, subtitle?: string) => ({
  title: { enabled: true, text },
  ...(subtitle ? { subtitle: { enabled: true, text: subtitle } } : {}),
});
const value = (field: string, t: string, sub: string, color?: string) => ({
  type: "value",
  dataMapping: { value: [{ id: field, aggregation: "sum" } as Ref] },
  format: { ...title(t, sub), ...(color ? { style: { color } } : {}) },
});

export const SELLER_REPORT = {
  selectedPageId: "revenue",
  pages: [
    {
      id: "revenue",
      widgets: {
        earned: value("charges.earned", "Earned", "on buyers' tabs, not charged yet", "#c2870a"),
        collected: value("charges.collected", "Collected", "charged through PayPal", "#3a63d8"),
        paid: value("charges.paid_out", "Paid out", "in your PayPal account", "#1f9d63"),
        calls: {
          type: "value",
          dataMapping: { value: [{ id: "charges.calls", aggregation: "sum" }] },
          format: title("Paid calls", "all time"),
        },
        trend: {
          type: "area-chart-stacked",
          dataMapping: {
            categoryKey: [{ id: "charges.day" }],
            valueKey: [
              { id: "charges.earned", aggregation: "sum" },
              { id: "charges.collected", aggregation: "sum" },
              { id: "charges.paid_out", aggregation: "sum" },
            ],
          },
          format: title("Revenue by day, by money state", "every dollar is in exactly one state"),
        },
        byEndpoint: {
          type: "bar-chart-grouped",
          dataMapping: {
            categoryKey: [{ id: "charges.endpoint" }],
            valueKey: [{ id: "charges.amount", aggregation: "sum" }],
          },
          format: title("Revenue by endpoint"),
        },
        grid: {
          type: "grid",
          dataMapping: {
            cols: [
              { id: "charges.endpoint" },
              { id: "charges.buyer" },
              { id: "charges.state" },
              { id: "charges.calls", aggregation: "sum" },
              { id: "charges.amount", aggregation: "sum" },
            ],
          },
          format: title("By endpoint and buyer"),
        },
      },
      widgetLayout: {
        earned: { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 7 },
        collected: { xTrack: 6, yTrack: 0, xSpan: 6, ySpan: 7 },
        paid: { xTrack: 12, yTrack: 0, xSpan: 6, ySpan: 7 },
        calls: { xTrack: 18, yTrack: 0, xSpan: 6, ySpan: 7 },
        trend: { xTrack: 0, yTrack: 7, xSpan: 16, ySpan: 15 },
        byEndpoint: { xTrack: 16, yTrack: 7, xSpan: 8, ySpan: 15 },
        grid: { xTrack: 0, yTrack: 22, xSpan: 24, ySpan: 14 },
      },
    },
    {
      id: "demand",
      widgets: {
        quotes: {
          type: "value",
          dataMapping: { value: [{ id: "quotes.quotes", aggregation: "sum" }] },
          format: title("402 quotes", "every price shown to an agent"),
        },
        paid: {
          type: "value",
          dataMapping: { value: [{ id: "quotes.paid", aggregation: "sum" }] },
          format: title("Paid", "quotes that became payments"),
        },
        funnel: {
          type: "column-chart-grouped",
          dataMapping: {
            categoryKey: [{ id: "quotes.endpoint" }],
            valueKey: [
              { id: "quotes.quotes", aggregation: "sum" },
              { id: "quotes.paid", aggregation: "sum" },
            ],
          },
          format: title(
            "402 → paid, by endpoint",
            "a big gap means agents walk away at this price",
          ),
        },
        outcomes: {
          type: "donut-chart",
          dataMapping: {
            categoryKey: [{ id: "quotes.outcome" }],
            valueKey: [{ id: "quotes.quotes", aggregation: "sum" }],
          },
          format: title("What happened to each quote"),
        },
        denials: {
          type: "bar-chart-grouped",
          dataMapping: {
            categoryKey: [{ id: "guard.reason" }],
            valueKey: [{ id: "guard.count", aggregation: "sum" }],
          },
          format: title("Why buyers' spend guards said no", "only Tab402 sees the buyer side"),
        },
      },
      widgetLayout: {
        quotes: { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 7 },
        paid: { xTrack: 6, yTrack: 0, xSpan: 6, ySpan: 7 },
        outcomes: { xTrack: 12, yTrack: 0, xSpan: 12, ySpan: 20 },
        funnel: { xTrack: 0, yTrack: 7, xSpan: 12, ySpan: 13 },
        denials: { xTrack: 0, yTrack: 20, xSpan: 24, ySpan: 14 },
      },
    },
    {
      id: "payouts",
      widgets: {
        total: {
          type: "value",
          dataMapping: { value: [{ id: "payouts.amount", aggregation: "sum" }] },
          format: title("Paid out", "matches your PayPal statement"),
        },
        fees: {
          type: "value",
          dataMapping: { value: [{ id: "payouts.fee", aggregation: "sum" }] },
          format: title("Payout fees"),
        },
        ledger: {
          type: "grid",
          dataMapping: {
            cols: [
              { id: "payouts.date" },
              { id: "payouts.batch" },
              { id: "payouts.status" },
              { id: "payouts.amount" },
              { id: "payouts.fee" },
            ],
          },
          format: title("Payouts ledger", "PayPal batch id per payout"),
        },
      },
      widgetLayout: {
        total: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 7 },
        fees: { xTrack: 12, yTrack: 0, xSpan: 12, ySpan: 7 },
        ledger: { xTrack: 0, yTrack: 7, xSpan: 24, ySpan: 27 },
      },
    },
  ],
};

export const BUYER_REPORT = {
  selectedPageId: "spend",
  pages: [
    {
      id: "spend",
      widgets: {
        total: {
          type: "value",
          dataMapping: { value: [{ id: "spend.amount", aggregation: "sum" }] },
          format: title("Spent", "all agents"),
        },
        calls: {
          type: "value",
          dataMapping: { value: [{ id: "spend.calls", aggregation: "sum" }] },
          format: title("Paid calls"),
        },
        trend: {
          type: "column-chart-stacked",
          dataMapping: {
            categoryKey: [{ id: "spend.day" }],
            valueKey: [{ id: "spend.amount", aggregation: "sum" }],
            legendKey: [{ id: "spend.agent" }],
          },
          format: title("Spend by day, by agent"),
        },
        sellers: {
          type: "donut-chart",
          dataMapping: {
            categoryKey: [{ id: "spend.seller" }],
            valueKey: [{ id: "spend.amount", aggregation: "sum" }],
          },
          format: title("By seller"),
        },
        checks: {
          type: "bar-chart-grouped",
          dataMapping: {
            categoryKey: [{ id: "checks.outcome" }],
            valueKey: [{ id: "checks.count", aggregation: "sum" }],
            legendKey: [{ id: "checks.decided_by" }],
          },
          format: title("Spend checks", "who decided: rules, cache, AI or you"),
        },
        receipts: {
          type: "grid",
          dataMapping: {
            cols: [
              { id: "spend.day" },
              { id: "spend.agent" },
              { id: "spend.seller" },
              { id: "spend.intent" },
              { id: "spend.state" },
              { id: "spend.amount" },
            ],
          },
          format: title("Receipts"),
        },
      },
      widgetLayout: {
        total: { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 7 },
        calls: { xTrack: 6, yTrack: 0, xSpan: 6, ySpan: 7 },
        trend: { xTrack: 0, yTrack: 7, xSpan: 12, ySpan: 14 },
        sellers: { xTrack: 12, yTrack: 0, xSpan: 6, ySpan: 21 },
        checks: { xTrack: 18, yTrack: 0, xSpan: 6, ySpan: 21 },
        receipts: { xTrack: 0, yTrack: 21, xSpan: 24, ySpan: 15 },
      },
    },
  ],
};
