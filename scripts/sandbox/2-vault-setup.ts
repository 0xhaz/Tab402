/** Day-1 test 3a: create a setup token to save a PayPal wallet without purchase (Vault v3). */
import { call, report, saveState } from "./paypal";

// `--minimal` matches PayPal's documented example (no usage_pattern / multiple-token flag).
const minimal = process.argv.includes("--minimal");

const r = await call("POST", "/v3/vault/setup-tokens", {
  payment_source: {
    paypal: {
      description: "Tab402 — pay-per-call tab for your AI agents",
      ...(minimal
        ? {}
        : { usage_pattern: "THRESHOLD_POSTPAID", permit_multiple_payment_tokens: true }),
      usage_type: "MERCHANT",
      customer_type: "CONSUMER",
      experience_context: {
        brand_name: "Tab402",
        locale: "en-US",
        shipping_preference: "NO_SHIPPING",
        return_url: "http://localhost:3000/wallet/return",
        cancel_url: "http://localhost:3000/wallet/cancel",
      },
    },
  },
});
report("create setup token", r, (b) => ({ id: b.id, status: b.status }));
if (r.ok) {
  saveState({ setupTokenId: r.body.id });
  const approve = r.body.links?.find((l: { rel: string }) => l.rel === "approve")?.href;
  console.log(`\nApprove as the sandbox PERSONAL (buyer) account:\n${approve}\n`);
  console.log(
    "The redirect to localhost:3000 will fail to load — that's expected. Then run 3-vault-exchange.ts.",
  );
}
