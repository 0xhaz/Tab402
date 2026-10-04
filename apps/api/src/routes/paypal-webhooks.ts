import { schema as s } from "@tab402/db";
import { JOBS } from "@tab402/ledger";
import { type PayPalWebhookEvent, verifyWebhook } from "@tab402/paypal";
import { Hono } from "hono";
import type { Deps } from "../context";

/**
 * Inbound PayPal webhooks: verify with PayPal, store once by event id, process in the worker.
 * Plain Hono route (raw body needed for verification); documented in the README, not the spec.
 */
export function payPalWebhookRoutes(deps: Deps) {
  const app = new Hono();
  app.post("/webhooks/paypal", async (c) => {
    if (!deps.paypal) return c.json({ error: "PayPal is not configured" }, 503);
    const raw = await c.req.text();
    let event: PayPalWebhookEvent;
    try {
      event = JSON.parse(raw) as PayPalWebhookEvent;
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (!event?.id || !event.event_type) return c.json({ error: "not a PayPal event" }, 400);

    const { webhookId, skipWebhookVerification } = deps.paypal;
    const verified = webhookId
      ? await verifyWebhook(deps.paypal.client, webhookId, c.req.raw.headers, raw)
      : Boolean(skipWebhookVerification);
    if (!verified) return c.json({ error: "signature verification failed" }, 401);

    const inserted = await deps.db
      .insert(s.webhookEventsIn)
      .values({ id: event.id, provider: "paypal", eventType: event.event_type, payload: event })
      .onConflictDoNothing()
      .returning({ id: s.webhookEventsIn.id });
    if (inserted.length > 0)
      await deps.enqueue?.(JOBS.paypalWebhook, { eventId: event.id }, { singletonKey: event.id });
    return c.json({ received: true }, 200);
  });
  return app;
}
