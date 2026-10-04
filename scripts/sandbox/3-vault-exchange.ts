/** Day-1 test 3b: exchange the approved setup token for a long-lived payment token (vault id). */
import { call, loadState, report, saveState } from "./paypal";

const { setupTokenId } = loadState();
if (!setupTokenId) throw new Error("run 2-vault-setup.ts first");

const st = await call("GET", `/v3/vault/setup-tokens/${setupTokenId}`);
report("setup token status", st, (b) => ({ status: b.status }));

const r = await call("POST", "/v3/vault/payment-tokens", {
  payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } },
});
report("create payment token", r, (b) => ({
  id: b.id,
  customer: b.customer?.id,
  payer: b.payment_source?.paypal?.email_address,
  usage_type: b.payment_source?.paypal?.usage_type,
}));
if (r.ok) saveState({ vaultId: r.body.id, customerId: r.body.customer?.id });
