import { token } from "./paypal";

const t = await token();
console.log(`[PASS] OAuth token (app ${t.appId})`);
const scopes = t.scope.split(" ").map((s) => s.replace("https://uri.paypal.com/services/", ""));
const features: Record<string, RegExp> = {
  vault: /vault\/payment-tokens/,
  payouts: /payouts/,
  invoicing: /invoicing/,
  orders: /payments\/payment|checkout/,
  webhooks: /webhook/,
  crypto: /crypto/i,
};
for (const [name, re] of Object.entries(features)) {
  const hits = scopes.filter((s) => re.test(s));
  console.log(
    `${hits.length ? "  ok " : "  -- "} ${name.padEnd(10)} ${hits.join(", ") || "NOT GRANTED"}`,
  );
}
