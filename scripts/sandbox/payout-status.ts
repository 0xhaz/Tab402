/** Final status and fees of the last payout batch. */
import { call, loadState, report } from "./paypal";

const { payoutBatchId } = loadState();
const g = await call("GET", `/v1/payments/payouts/${payoutBatchId}`);
report("payout batch", g, (b) => ({
  batch_status: b.batch_header.batch_status,
  amount: b.batch_header.amount,
  fees: b.batch_header.fees,
  item: { status: b.items?.[0]?.transaction_status, fee: b.items?.[0]?.payout_item_fee },
}));
