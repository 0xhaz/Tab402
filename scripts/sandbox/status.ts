/** Show where the day-1 tests stand (no secrets printed). */
import { call, loadState } from "./paypal";

const s = loadState();
if (s.setupTokenId) {
  const r = await call("GET", `/v3/vault/setup-tokens/${s.setupTokenId}`);
  console.log(`setup token ${s.setupTokenId}: ${r.body?.status ?? r.status}`);
}
console.log(
  `vault id: ${s.vaultId ?? "—"} · last order: ${s.lastOrderId ?? "—"} · payout batch: ${s.payoutBatchId ?? "—"}`,
);
