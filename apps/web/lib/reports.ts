/**
 * Pre-built AG Studio reports. Plain JSON state: pages → widgets → layout on a 24-column grid.
 * Layout follows payment dashboards (Stripe, PayPal): a filter strip, a KPI row with sparklines,
 * one hero trend, breakdowns, then the transactions table. Clicking a chart value filters the
 * other widgets on the page (cross-filter). Analysts can still switch to edit mode and change
 * anything.
 */
type Agg = "sum" | "count" | "countd" | "avg" | "max" | "min";
type Ref = { id: string; aggregation?: Agg };

/** Money-state colors, shared with the rest of the app. */
export const MONEY = {
  earned: "#c2870a",
  collected: "#3a63d8",
  paidOut: "#1f9d63",
  fee: "#e0566b",
};

const sum = (id: string): Ref => ({ id, aggregation: "sum" });
const title = (text: string, subtitle?: string, size = 15) => ({
  title: { enabled: true, text, typography: { fontSize: size, fontWeight: "bold" } },
  ...(subtitle
    ? { subtitle: { enabled: true, text: subtitle, typography: { fontSize: 11 } } }
    : {}),
});

/** KPI tile with a sparkline over `day`. */
const kpi = (field: string, t: string, sub: string, day: string, color?: string) => ({
  type: "value",
  dataMapping: { value: [sum(field)], sparklineX: [{ id: day }] },
  format: {
    ...title(t, sub),
    style: {
      ...(color ? { color } : {}),
      sparkline: { type: "line", lineWidth: 2, areaFill: true },
    },
  },
});

/** Zoom, navigator and a crosshair on time-series charts. */
const explore = {
  theme: {
    common: {
      zoom: { enabled: true, enableSelecting: true, enableScrolling: true },
      navigator: { enabled: true, miniChart: { enabled: true } },
    },
  },
  custom: { crosshair: { enabled: true, snap: true } },
};

const donut = (category: string, value: string, t: string, sub?: string) => ({
  type: "donut-chart",
  dataMapping: { categoryKey: [{ id: category }], valueKey: [sum(value)] },
  format: {
    ...title(t, sub),
    crossFilter: "filter",
    style: {
      custom: {
        totalLabel: { enabled: true },
        pieDataLabel: { enabled: true, format: "percent", position: "outside" },
      },
    },
  },
});

const dateFilter = (field: string) => ({
  type: "date-filter",
  dataMapping: { value: [{ id: field }] },
  format: { ...title("Dates", undefined, 12), style: { filterType: "between" } },
});
const buttons = (field: string, t: string) => ({
  type: "button-filter",
  dataMapping: { value: [{ id: field }] },
  format: { ...title(t, undefined, 12), style: { selection: { type: "multiple" } } },
});
const list = (field: string, t: string) => ({
  type: "list-filter",
  dataMapping: { value: [{ id: field }] },
  format: { ...title(t, undefined, 12), style: { selection: { type: "multiple" } } },
});

const FILTER_ROW = { yTrack: 0, ySpan: 6 };

export const SELLER_REPORT = {
  selectedPageId: "revenue",
  pages: [
    {
      id: "revenue",
      widgets: {
        dates: dateFilter("charges.day"),
        states: buttons("charges.state", "Money state"),
        endpoints: list("charges.endpoint", "Endpoint"),
        earned: kpi("charges.earned", "Earned", "on buyers' tabs", "charges.day", MONEY.earned),
        collected: kpi(
          "charges.collected",
          "Collected",
          "charged via PayPal",
          "charges.day",
          MONEY.collected,
        ),
        paid: kpi("charges.paid_out", "Paid out", "in your PayPal", "charges.day", MONEY.paidOut),
        fees: kpi("charges.paypal_fee", "PayPal fees", "on settled tabs", "charges.day", MONEY.fee),
        net: kpi("charges.net", "Net to you", "settled, after fees", "charges.day"),
        calls: kpi("charges.calls", "Paid calls", "in range", "charges.day"),
        trend: {
          type: "area-chart-stacked",
          dataMapping: {
            categoryKey: [{ id: "charges.day" }],
            valueKey: [sum("charges.earned"), sum("charges.collected"), sum("charges.paid_out")],
          },
          format: {
            ...title("Revenue by day, by money state", "every dollar is in exactly one state"),
            style: explore,
          },
        },
        byBuyer: donut("charges.buyer", "charges.amount", "Revenue by buyer", "click to filter"),
        grossToNet: {
          type: "column-chart-stacked",
          dataMapping: {
            categoryKey: [{ id: "charges.day" }],
            valueKey: [sum("charges.net"), sum("charges.paypal_fee"), sum("charges.platform_fee")],
          },
          format: title("Gross to net", "each settled column = gross: net + PayPal + Tab402 fee"),
        },
        byEndpoint: {
          type: "treemap-chart",
          dataMapping: {
            categoryKey: [{ id: "charges.endpoint" }],
            valueKey: [sum("charges.amount")],
          },
          format: { ...title("Revenue by endpoint", "click to filter"), crossFilter: "filter" },
        },
        grid: {
          type: "grid",
          dataMapping: {
            cols: [
              { id: "charges.endpoint" },
              { id: "charges.buyer" },
              { id: "charges.state" },
              sum("charges.calls"),
              sum("charges.amount"),
              sum("charges.paypal_fee"),
              sum("charges.net"),
            ],
          },
          format: {
            ...title("By endpoint and buyer"),
            style: { grandTotalRow: { enabled: true } },
          },
        },
      },
      widgetLayout: {
        dates: { xTrack: 0, xSpan: 8, ...FILTER_ROW },
        states: { xTrack: 8, xSpan: 10, ...FILTER_ROW },
        endpoints: { xTrack: 18, xSpan: 6, ...FILTER_ROW },
        earned: { xTrack: 0, yTrack: 6, xSpan: 4, ySpan: 9 },
        collected: { xTrack: 4, yTrack: 6, xSpan: 4, ySpan: 9 },
        paid: { xTrack: 8, yTrack: 6, xSpan: 4, ySpan: 9 },
        fees: { xTrack: 12, yTrack: 6, xSpan: 4, ySpan: 9 },
        net: { xTrack: 16, yTrack: 6, xSpan: 4, ySpan: 9 },
        calls: { xTrack: 20, yTrack: 6, xSpan: 4, ySpan: 9 },
        trend: { xTrack: 0, yTrack: 15, xSpan: 16, ySpan: 17 },
        byBuyer: { xTrack: 16, yTrack: 15, xSpan: 8, ySpan: 17 },
        grossToNet: { xTrack: 0, yTrack: 32, xSpan: 14, ySpan: 14 },
        byEndpoint: { xTrack: 14, yTrack: 32, xSpan: 10, ySpan: 14 },
        grid: { xTrack: 0, yTrack: 46, xSpan: 24, ySpan: 14 },
      },
    },
    {
      id: "demand",
      widgets: {
        dates: dateFilter("quotes.day"),
        endpoints: list("quotes.endpoint", "Endpoint"),
        quotes: kpi("quotes.quotes", "402 quotes", "prices shown to agents", "quotes.day"),
        paid: kpi(
          "quotes.paid",
          "Paid",
          "quotes that became payments",
          "quotes.day",
          MONEY.paidOut,
        ),
        funnel: {
          type: "combo-chart-grouped-column-line",
          dataMapping: {
            categoryKey: [{ id: "quotes.endpoint" }],
            valueKey: [sum("quotes.quotes"), sum("quotes.paid")],
            secondaryValueKey: [{ id: "quotes.price", aggregation: "avg" }],
          },
          format: title("402 → paid, by endpoint", "columns: quotes vs paid · line: average price"),
        },
        outcomes: donut("quotes.outcome", "quotes.quotes", "What happened to each quote"),
        denials: {
          type: "bar-chart-stacked",
          dataMapping: {
            categoryKey: [{ id: "guard.reason" }],
            valueKey: [sum("guard.count")],
            legendKey: [{ id: "guard.outcome" }],
          },
          format: title("Why buyers' spend guards said no", "only Tab402 sees the buyer side"),
        },
      },
      widgetLayout: {
        dates: { xTrack: 0, xSpan: 12, ...FILTER_ROW },
        endpoints: { xTrack: 12, xSpan: 12, ...FILTER_ROW },
        quotes: { xTrack: 0, yTrack: 6, xSpan: 6, ySpan: 9 },
        paid: { xTrack: 6, yTrack: 6, xSpan: 6, ySpan: 9 },
        outcomes: { xTrack: 12, yTrack: 6, xSpan: 12, ySpan: 22 },
        funnel: { xTrack: 0, yTrack: 15, xSpan: 12, ySpan: 14 },
        denials: { xTrack: 0, yTrack: 29, xSpan: 24, ySpan: 14 },
      },
    },
    {
      id: "payouts",
      widgets: {
        dates: dateFilter("payouts.date"),
        total: kpi(
          "payouts.amount",
          "Paid out",
          "matches your PayPal statement",
          "payouts.date",
          MONEY.paidOut,
        ),
        fees: kpi(
          "payouts.fee",
          "Payout fees",
          "charged by PayPal Payouts",
          "payouts.date",
          MONEY.fee,
        ),
        trend: {
          type: "combo-chart-grouped-column-line",
          dataMapping: {
            categoryKey: [{ id: "payouts.date" }],
            valueKey: [sum("payouts.amount")],
            secondaryValueKey: [sum("payouts.fee")],
          },
          format: {
            ...title("Payouts and their fees", "columns: paid out · line: fee"),
            style: explore,
          },
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
        dates: { xTrack: 0, xSpan: 24, ...FILTER_ROW },
        total: { xTrack: 0, yTrack: 6, xSpan: 6, ySpan: 9 },
        fees: { xTrack: 0, yTrack: 15, xSpan: 6, ySpan: 8 },
        trend: { xTrack: 6, yTrack: 6, xSpan: 18, ySpan: 16 },
        ledger: { xTrack: 0, yTrack: 23, xSpan: 24, ySpan: 20 },
      },
    },
  ],
};

const usd = (n: number) => `$${n.toFixed(2)}`;

/** The buyer report; the gauge's scale is the buyer's own daily budget. */
export function buyerReport({ dailyBudget }: { dailyBudget: number }) {
  return {
    selectedPageId: "spend",
    pages: [
      {
        id: "spend",
        widgets: {
          dates: dateFilter("spend.day"),
          agents: buttons("spend.agent", "Agent"),
          sellers: list("spend.seller", "Seller"),
          total: kpi("spend.amount", "Spent", "all agents, in range", "spend.day", MONEY.collected),
          calls: kpi("spend.calls", "Paid calls", "in range", "spend.day"),
          today: {
            type: "linear-gauge",
            dataMapping: { value: [sum("spend.today")] },
            format: {
              ...title("Today", `of your ${usd(dailyBudget)} daily budget`, 13),
              style: {
                direction: "horizontal",
                thickness: 14,
                label: { enabled: true, placement: "bar-outside-end" },
                scaleLabel: { enabled: true, min: 0, max: dailyBudget },
              },
            },
          },
          denied: kpi("checks.denied", "Denied", "by the spend guard", "checks.day", MONEY.fee),
          asked: kpi(
            "checks.asked",
            "Asked you",
            "needed your approval",
            "checks.day",
            MONEY.earned,
          ),
          trend: {
            type: "combo-chart-stacked-column-line",
            dataMapping: {
              categoryKey: [{ id: "spend.day" }],
              valueKey: [sum("spend.amount")],
              legendKey: [{ id: "spend.agent" }],
              secondaryValueKey: [sum("spend.calls")],
            },
            format: {
              ...title("Spend by day, by agent", "columns: USD per agent · line: paid calls"),
              style: explore,
            },
          },
          bySeller: donut("spend.seller", "spend.amount", "By seller", "click to filter"),
          byEndpoint: {
            type: "treemap-chart",
            dataMapping: {
              categoryKey: [{ id: "spend.seller" }, { id: "spend.endpoint" }],
              valueKey: [sum("spend.amount")],
            },
            format: { ...title("What you paid for", "seller → endpoint"), crossFilter: "filter" },
          },
          pivot: {
            type: "pivot-grid",
            dataMapping: {
              rows: [{ id: "spend.agent" }],
              columns: [{ id: "spend.seller" }],
              values: [sum("spend.amount")],
            },
            format: {
              ...title("Agent × seller"),
              style: { grandTotalRow: { enabled: true } },
            },
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
            format: { ...title("Receipts"), style: { grandTotalRow: { enabled: true } } },
          },
        },
        widgetLayout: {
          dates: { xTrack: 0, xSpan: 8, ...FILTER_ROW },
          agents: { xTrack: 8, xSpan: 10, ...FILTER_ROW },
          sellers: { xTrack: 18, xSpan: 6, ...FILTER_ROW },
          total: { xTrack: 0, yTrack: 6, xSpan: 5, ySpan: 9 },
          calls: { xTrack: 5, yTrack: 6, xSpan: 4, ySpan: 9 },
          today: { xTrack: 9, yTrack: 6, xSpan: 7, ySpan: 9 },
          denied: { xTrack: 16, yTrack: 6, xSpan: 4, ySpan: 9 },
          asked: { xTrack: 20, yTrack: 6, xSpan: 4, ySpan: 9 },
          trend: { xTrack: 0, yTrack: 15, xSpan: 16, ySpan: 17 },
          bySeller: { xTrack: 16, yTrack: 15, xSpan: 8, ySpan: 17 },
          byEndpoint: { xTrack: 0, yTrack: 32, xSpan: 12, ySpan: 14 },
          pivot: { xTrack: 12, yTrack: 32, xSpan: 12, ySpan: 14 },
          receipts: { xTrack: 0, yTrack: 46, xSpan: 24, ySpan: 15 },
        },
      },
      {
        id: "spend guard",
        widgets: {
          dates: dateFilter("checks.day"),
          agents: buttons("checks.agent", "Agent"),
          checks: kpi("checks.count", "Spend checks", "every purchase is checked", "checks.day"),
          denied: kpi("checks.denied", "Denied", "never charged", "checks.day", MONEY.fee),
          asked: kpi("checks.asked", "Asked you", "sent for approval", "checks.day", MONEY.earned),
          outcomes: {
            type: "bar-chart-stacked",
            dataMapping: {
              categoryKey: [{ id: "checks.outcome" }],
              valueKey: [sum("checks.count")],
              legendKey: [{ id: "checks.decided_by" }],
            },
            format: {
              ...title("Who decided", "rules, cache, AI or you · click to filter"),
              crossFilter: "filter",
            },
          },
          rules: donut("checks.rule", "checks.count", "Which rule fired"),
          log: {
            type: "grid",
            dataMapping: {
              cols: [
                { id: "checks.day" },
                { id: "checks.agent" },
                { id: "checks.outcome" },
                { id: "checks.decided_by" },
                { id: "checks.rule" },
                { id: "checks.intent" },
                { id: "checks.price", aggregation: "max" },
              ],
            },
            format: title("Decision log", "what the agent said it was buying"),
          },
        },
        widgetLayout: {
          dates: { xTrack: 0, xSpan: 12, ...FILTER_ROW },
          agents: { xTrack: 12, xSpan: 12, ...FILTER_ROW },
          checks: { xTrack: 0, yTrack: 6, xSpan: 8, ySpan: 9 },
          denied: { xTrack: 8, yTrack: 6, xSpan: 8, ySpan: 9 },
          asked: { xTrack: 16, yTrack: 6, xSpan: 8, ySpan: 9 },
          outcomes: { xTrack: 0, yTrack: 15, xSpan: 14, ySpan: 16 },
          rules: { xTrack: 14, yTrack: 15, xSpan: 10, ySpan: 16 },
          log: { xTrack: 0, yTrack: 31, xSpan: 24, ySpan: 16 },
        },
      },
    ],
  };
}
