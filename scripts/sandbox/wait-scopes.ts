/** Poll fresh tokens until vault + invoicing scopes appear (feature changes can take a minute). */
import { BASE } from "./paypal";

const auth = Buffer.from(
  `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`,
).toString("base64");
for (let i = 1; i <= 8; i++) {
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const { scope = "" } = (await res.json()) as { scope?: string };
  const vault = scope.includes("vault/payment-tokens");
  const invoicing = /services\/invoicing/.test(scope);
  console.log(`check ${i}: vault ${vault ? "yes" : "no"} · invoicing ${invoicing ? "yes" : "no"}`);
  if (vault && invoicing) process.exit(0);
  await new Promise((r) => setTimeout(r, 15_000));
}
process.exit(1);
