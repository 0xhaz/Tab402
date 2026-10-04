/** Day-1 test 6: Invoicing v2 — create a NET_30 draft and send it (enterprise rail, stretch). */
import { call, report } from "./paypal";

const recipient = process.argv[2] ?? "tab402-enterprise-buyer@example.com";
const r = await call("POST", "/v2/invoicing/invoices", {
  detail: {
    currency_code: "USD",
    note: "Tab402 monthly tab — agent API usage",
    payment_term: { term_type: "NET_30" },
  },
  invoicer: { business_name: "Tab402" },
  primary_recipients: [{ billing_info: { email_address: recipient } }],
  items: [
    {
      name: "Agent API usage — October",
      quantity: "1",
      unit_amount: { currency_code: "USD", value: "184.20" },
      unit_of_measure: "AMOUNT",
    },
  ],
});
report("create NET_30 draft", r, (b) => ({
  id: b.id,
  status: b.status,
  term: b.detail?.payment_term,
  due: b.detail?.payment_term?.due_date,
}));
if (!r.ok) process.exit(1);

const s = await call("POST", `/v2/invoicing/invoices/${r.body.id}/send`, {
  send_to_invoicer: false,
  send_to_recipient: true,
});
report("send invoice", s, (b) => b);
const g = await call("GET", `/v2/invoicing/invoices/${r.body.id}`);
report("invoice after send", g, (b) => ({
  status: b.status,
  due: b.detail?.payment_term?.due_date,
}));
