/** Show the full status of one or more setup tokens. */
import { call } from "./paypal";

for (const id of process.argv.slice(2)) {
  const r = await call("GET", `/v3/vault/setup-tokens/${id}`);
  const pp = r.body?.payment_source?.paypal ?? {};
  console.log(
    id,
    "→",
    r.body?.status ?? r.status,
    JSON.stringify({
      usage_pattern: pp.usage_pattern,
      usage_type: pp.usage_type,
      email: pp.email_address ?? null,
    }),
  );
}
