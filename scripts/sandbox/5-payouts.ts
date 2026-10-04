/** Day-1 test 5: Payouts batch to a seller. sender_batch_id is derived from the run date (idempotent retries). */
import { call, report, saveState } from "./paypal";

const receiver = process.argv[2] ?? "tab402-demo-seller@example.com";
const runDate = new Date().toISOString().slice(0, 10);
const senderBatchId = `tab402-day1-${runDate}-${Date.now().toString(36)}`;

const r = await call("POST", "/v1/payments/payouts", {
  sender_batch_header: {
    sender_batch_id: senderBatchId,
    recipient_type: "EMAIL",
    email_subject: "Tab402 payout",
    email_message: "Your Tab402 earnings for the week.",
  },
  items: [
    {
      recipient_type: "EMAIL",
      receiver,
      amount: { currency: "USD", value: "5.90" },
      note: "Tab402 weekly payout (day-1 test)",
      sender_item_id: "poi_day1_1",
    },
  ],
});
report("create payout batch", r, (b) => b.batch_header);
if (!r.ok) process.exit(1);

const batchId = r.body.batch_header.payout_batch_id;
saveState({ payoutBatchId: batchId });
for (let i = 0; i < 6; i++) {
  await new Promise((res) => setTimeout(res, 3000));
  const g = await call("GET", `/v1/payments/payouts/${batchId}`);
  const status = g.body?.batch_header?.batch_status;
  console.log(`  poll ${i + 1}: batch ${status}; item ${g.body?.items?.[0]?.transaction_status}`);
  if (status && !["PENDING", "PROCESSING"].includes(status)) {
    report("payout batch final", g, (b) => ({
      batch_status: b.batch_header.batch_status,
      fees: b.batch_header.fees,
      item: { status: b.items?.[0]?.transaction_status, fee: b.items?.[0]?.payout_item_fee },
    }));
    break;
  }
}
