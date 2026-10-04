import { randomUUID } from "node:crypto";
import type { CaptureResult, FundingAdapter } from "./adapters";
import { type PayPalClient, PayPalError } from "./client";
import { MICROS_PER_CENT, microsToPayPal, payPalToMicros } from "./money";

interface Money {
  currency_code: string;
  value: string;
}

interface OrderResponse {
  id: string;
  status: string;
  purchase_units?: {
    payments?: {
      captures?: {
        id: string;
        status: string;
        amount: Money;
        seller_receivable_breakdown?: { paypal_fee?: Money; net_amount?: Money };
      }[];
    };
  }[];
}

/**
 * PayPal wallet funding: Vault v3 save-without-purchase + Orders v2 merchant-initiated capture
 *.
 */
export class PayPalWalletFunding implements FundingAdapter {
  constructor(
    private readonly client: PayPalClient,
    private readonly brandName = "Tab402",
  ) {}

  async beginMandate({
    returnUrl,
    cancelUrl,
    description,
  }: {
    returnUrl: string;
    cancelUrl: string;
    description: string;
  }) {
    const r = await this.client.request<{ id: string; links?: { rel: string; href: string }[] }>(
      "POST",
      "/v3/vault/setup-tokens",
      {
        payment_source: {
          paypal: {
            description,
            usage_pattern: "THRESHOLD_POSTPAID",
            usage_type: "MERCHANT",
            customer_type: "CONSUMER",
            permit_multiple_payment_tokens: true,
            experience_context: {
              brand_name: this.brandName,
              locale: "en-US",
              shipping_preference: "NO_SHIPPING",
              return_url: returnUrl,
              cancel_url: cancelUrl,
            },
          },
        },
      },
    );
    const approveUrl = r.links?.find((l) => l.rel === "approve")?.href;
    if (!approveUrl) throw new Error("PayPal setup token has no approve link");
    return { setupToken: r.id, approveUrl };
  }

  async completeMandate(setupToken: string) {
    const r = await this.client.request<{
      id: string;
      customer?: { id?: string };
      payment_source?: { paypal?: { email_address?: string } };
    }>("POST", "/v3/vault/payment-tokens", {
      payment_source: { token: { id: setupToken, type: "SETUP_TOKEN" } },
    });
    return {
      vaultToken: r.id,
      payerEmail: r.payment_source?.paypal?.email_address,
      customerId: r.customer?.id,
    };
  }

  async capture(input: Parameters<FundingAdapter["capture"]>[0]): Promise<CaptureResult> {
    const value = microsToPayPal(input.amountMicros);
    // Item lines must sum exactly to the order total; sub-cent parts are folded into the last line.
    const lines = toCentLines(input.lines, input.amountMicros);
    let order: OrderResponse;
    try {
      order = await this.client.request<OrderResponse>(
        "POST",
        "/v2/checkout/orders",
        {
          intent: "CAPTURE",
          purchase_units: [
            {
              reference_id: input.reference,
              custom_id: input.reference,
              description: input.description.slice(0, 127),
              amount: {
                currency_code: "USD",
                value,
                breakdown: { item_total: { currency_code: "USD", value } },
              },
              items: lines.map((l) => ({
                name: l.description.slice(0, 127),
                quantity: "1",
                category: "DIGITAL_GOODS",
                unit_amount: { currency_code: "USD", value: microsToPayPal(l.amountMicros) },
              })),
            },
          ],
          payment_source: {
            paypal: {
              vault_id: input.vaultToken,
              stored_credential: {
                payment_initiator: "MERCHANT",
                usage: "SUBSEQUENT",
                charge_pattern: "THRESHOLD_POSTPAID",
              },
            },
          },
        },
        {
          idempotencyKey: input.idempotencyKey,
          // Risk data: merchant-initiated charges without it are likely to be declined.
          headers: { "paypal-client-metadata-id": randomUUID().replaceAll("-", "") },
        },
      );
    } catch (err) {
      if (err instanceof PayPalError && (err.status === 422 || err.status === 400)) {
        return {
          status: "declined",
          orderId: null,
          reason: err.issue ?? err.paypalName ?? "DECLINED",
        };
      }
      throw err;
    }

    const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
    if (!capture) return { status: "declined", orderId: order.id, reason: `ORDER_${order.status}` };
    if (capture.status === "DECLINED" || capture.status === "FAILED") {
      return { status: "declined", orderId: order.id, reason: `CAPTURE_${capture.status}` };
    }
    const fee = capture.seller_receivable_breakdown?.paypal_fee?.value;
    return {
      status: capture.status === "COMPLETED" ? "captured" : "pending",
      orderId: order.id,
      captureId: capture.id,
      grossMicros: payPalToMicros(capture.amount.value),
      feeMicros: fee ? payPalToMicros(fee) : 0,
    };
  }

  async getOrder(orderId: string): Promise<PayPalWalletFundingOrder> {
    const order = await this.client.request<OrderResponse>("GET", `/v2/checkout/orders/${orderId}`);
    return {
      status: order.status,
      captureStatus: order.purchase_units?.[0]?.payments?.captures?.[0]?.status ?? null,
    };
  }
}

export interface PayPalWalletFundingOrder {
  status: string;
  captureStatus: string | null;
}

/** Floor each line to cents and put the difference on the last line so lines sum to `total`. */
export function toCentLines(lines: { description: string; amountMicros: number }[], total: number) {
  if (lines.length === 0) return [{ description: "Tab402 usage", amountMicros: total }];
  const out = lines.map((l) => ({
    ...l,
    amountMicros: l.amountMicros - (l.amountMicros % MICROS_PER_CENT),
  }));
  const diff = total - out.reduce((a, l) => a + l.amountMicros, 0);
  const last = out[out.length - 1];
  if (last) last.amountMicros += diff;
  return out.filter((l) => l.amountMicros > 0);
}
