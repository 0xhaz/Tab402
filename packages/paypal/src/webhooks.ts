import type { PayPalClient } from "./client";

export interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  resource_type?: string;
  resource: Record<string, unknown>;
  create_time?: string;
}

const SIGNATURE_HEADERS = [
  "paypal-auth-algo",
  "paypal-cert-url",
  "paypal-transmission-id",
  "paypal-transmission-sig",
  "paypal-transmission-time",
] as const;

/**
 * Verify an inbound webhook with PayPal (POST /v1/notifications/verify-webhook-signature).
 * `rawBody` must be the exact bytes received.
 */
export async function verifyWebhook(
  client: PayPalClient,
  webhookId: string,
  headers: Headers,
  rawBody: string,
): Promise<boolean> {
  const values = Object.fromEntries(SIGNATURE_HEADERS.map((h) => [h, headers.get(h)]));
  if (Object.values(values).some((v) => !v)) return false;
  const r = await client.request<{ verification_status: string }>(
    "POST",
    "/v1/notifications/verify-webhook-signature",
    {
      auth_algo: values["paypal-auth-algo"],
      cert_url: values["paypal-cert-url"],
      transmission_id: values["paypal-transmission-id"],
      transmission_sig: values["paypal-transmission-sig"],
      transmission_time: values["paypal-transmission-time"],
      webhook_id: webhookId,
      webhook_event: JSON.parse(rawBody),
    },
  );
  return r.verification_status === "SUCCESS";
}
