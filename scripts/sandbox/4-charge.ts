/** Day-1 test 4: merchant-initiated charge on the vaulted wallet (Orders v2), buyer not present. */
import { randomUUID } from "node:crypto";
import { call, loadState, report, saveState } from "./paypal";

const { vaultId } = loadState();
if (!vaultId) throw new Error("run 3-vault-exchange.ts first");

const amount = process.argv[2] ?? "10.00";
const r = await call(
  "POST",
  "/v2/checkout/orders",
  {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: "stl_day1_test",
        description: "Tab402 tab settlement (day-1 test)",
        custom_id: "stl_day1_test",
        amount: {
          currency_code: "USD",
          value: amount,
          breakdown: { item_total: { currency_code: "USD", value: amount } },
        },
        items: [
          {
            name: "Demo Sellers — /v1/summarize × 600",
            quantity: "1",
            category: "DIGITAL_GOODS",
            unit_amount: { currency_code: "USD", value: (Number(amount) * 0.6).toFixed(2) },
          },
          {
            name: "Demo Sellers — /v1/chat (metered)",
            quantity: "1",
            category: "DIGITAL_GOODS",
            unit_amount: { currency_code: "USD", value: (Number(amount) * 0.4).toFixed(2) },
          },
        ],
      },
    ],
    payment_source: {
      paypal: {
        vault_id: vaultId,
        stored_credential: {
          payment_initiator: "MERCHANT",
          usage: "SUBSEQUENT",
          charge_pattern: "THRESHOLD_POSTPAID",
        },
      },
    },
  },
  // Risk data: PayPal says merchant-initiated charges without it are likely to be declined.
  { "PayPal-Client-Metadata-Id": randomUUID().replaceAll("-", "") },
);
report("create order with vault_id", r, (b) => ({
  id: b.id,
  status: b.status,
  capture: b.purchase_units?.[0]?.payments?.captures?.[0] && {
    id: b.purchase_units[0].payments.captures[0].id,
    status: b.purchase_units[0].payments.captures[0].status,
    fee: b.purchase_units[0].payments.captures[0].seller_receivable_breakdown?.paypal_fee,
    net: b.purchase_units[0].payments.captures[0].seller_receivable_breakdown?.net_amount,
  },
}));

if (r.ok && r.body.status !== "COMPLETED") {
  const c = await call("POST", `/v2/checkout/orders/${r.body.id}/capture`, {});
  report("capture order", c, (b) => ({ status: b.status }));
}
if (r.ok) saveState({ lastOrderId: r.body.id });
