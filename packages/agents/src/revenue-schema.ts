/** Revenue agent tool declarations — no server imports, so the browser (AG Studio) can use them. */
export interface RevenueToolSchema {
  name: string;
  description: string;
  /** JSON Schema for the arguments (Anthropic `input_schema` / AG Studio tool parameters). */
  parameters: Record<string, unknown>;
}

export const REVENUE_TOOL_SCHEMAS: {
  revenueChange: RevenueToolSchema;
  moneyStates: RevenueToolSchema;
} = {
  revenueChange: {
    name: "tab402_revenue_change",
    description:
      "Explain a change in revenue between two UTC days for this seller: per endpoint revenue, paid calls, distinct buyers, 402 quotes, quote→paid conversion and walk-aways, plus purchases buyers' spend guards denied or held for approval (by rule). Default comparison is the same weekday one week earlier. Use for questions like 'why did revenue drop on Tuesday?'.",
    parameters: {
      type: "object",
      properties: {
        day: { type: "string", description: "The day to explain, YYYY-MM-DD (UTC)" },
        compare_to: {
          type: "string",
          description: "Baseline day, YYYY-MM-DD (UTC). Default: 7 days before `day`.",
        },
      },
      required: ["day"],
      additionalProperties: false,
    },
  },
  moneyStates: {
    name: "tab402_money_states",
    description:
      "This seller's money right now, by state: earned (on buyers' tabs, not charged yet), collected (charged through PayPal), paid out, held for disputes, refunded, written off; plus the last payout and open disputes.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};
