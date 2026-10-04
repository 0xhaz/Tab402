import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  HEADERS,
  isTabRequirements,
  type PaymentPayload,
  type PaymentRequired,
  type PricingMode,
  type ResourceServerManifest,
  type SettleResponse,
} from "@tab402/core";
import type { Context, Handler, MiddlewareHandler } from "hono";
import { type EndpointRegistration, FacilitatorClient } from "./facilitator-client";

export interface RoutePrice {
  pricing?: Extract<PricingMode, "fixed" | "metered">;
  /** Micro-USD: price for fixed, maximum authorization for metered. */
  price: number;
  description?: string;
  category?: string;
}

export interface GateOptions {
  /** Tab402 API (facilitator) URL. */
  facilitatorUrl: string;
  /** Seller API key (t402_sk_…). */
  apiKey: string;
  /** Public base URL of this API, e.g. https://api.seller.dev — quotes are keyed by full URL. */
  baseUrl: string;
  /**
   * Priced routes as "METHOD /path". Registered with Tab402 on first request. Requests to routes not
   * listed pass through unpaid. Omit to treat every request through this middleware as paid, with
   * prices managed in the Tab402 dashboard.
   */
  routes?: Record<string, RoutePrice>;
  fetch?: typeof fetch;
}

/** Per-request handle for paid routes. Metered handlers must report their actual cost. */
export interface PaidRequest {
  pricing: PricingMode;
  /** Maximum authorized for this call (micro-USD). */
  maxMicros: number;
  payer: string;
  /** Report the actual cost of a metered call (micro-USD). Capped at the authorization. */
  setActualCost(micros: number): void;
}

export type GateVariables = { tab402: PaidRequest };

function paymentRequired(c: Context, body: PaymentRequired) {
  c.header(HEADERS.paymentRequired, encodePaymentRequiredHeader(body));
  c.header("cache-control", "private, no-store");
  return c.json(body, 402);
}

/**
 * Tab402 gate for Hono: 402 → verify voucher → run handler → settle.
 * The charge is only recorded when the handler succeeds (status < 400).
 */
export function tab402Gate(options: GateOptions): MiddlewareHandler<{ Variables: GateVariables }> {
  const facilitator = new FacilitatorClient({
    url: options.facilitatorUrl,
    apiKey: options.apiKey,
    fetch: options.fetch,
  });
  const base = options.baseUrl.replace(/\/+$/, "");
  let registered: Promise<void> | undefined;

  const register = () => {
    if (!options.routes) return Promise.resolve();
    registered ??= facilitator
      .registerEndpoints(
        Object.entries(options.routes).map(([route, cfg]): EndpointRegistration => {
          const [method = "GET", path = "/"] = route.trim().split(/\s+/, 2);
          return {
            method,
            url: `${base}${path}`,
            pricing: cfg.pricing ?? "fixed",
            price: String(cfg.price),
            description: cfg.description,
            category: cfg.category,
          };
        }),
      )
      .catch((err) => {
        registered = undefined;
        throw err;
      });
    return registered;
  };

  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    const path = new URL(c.req.url).pathname;
    if (options.routes && !options.routes[`${method} ${path}`]) return next();
    await register();

    const resourceUrl = `${base}${path}`;
    const quote = async (error?: string, channel?: unknown) => {
      const required = await facilitator.quote(method, resourceUrl);
      if (!required) return c.json({ error: "endpoint is not priced in Tab402" }, 500);
      if (error) required.error = error;
      if (channel)
        for (const a of required.accepts)
          if (isTabRequirements(a)) a.extra.channel = channel as never;
      return paymentRequired(c, required);
    };

    const header = c.req.header(HEADERS.paymentSignature);
    if (!header) return quote();

    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(header);
    } catch {
      return quote("malformed_payload");
    }
    const requirements = payload.accepted;
    if (!requirements || !isTabRequirements(requirements)) return quote("unsupported_scheme");

    const verified = await facilitator.verify(payload, requirements);
    if (!verified.isValid)
      return quote(verified.invalidReason ?? "invalid_payment", verified.extra?.channel);

    let actual: number | undefined;
    const pricing = requirements.extra.pricing;
    c.set("tab402", {
      pricing,
      maxMicros: Number(requirements.amount),
      payer: verified.payer ?? "",
      setActualCost(micros: number) {
        if (!Number.isSafeInteger(micros) || micros < 0)
          throw new RangeError("cost must be non-negative integer micros");
        actual = micros;
      },
    });

    await next();
    if (c.res.status >= 400) return; // No charge for failed calls.

    if (pricing === "metered" && actual === undefined) {
      c.res = c.json(
        { error: "metered route did not report its cost (call c.var.tab402.setActualCost)" },
        500,
      );
      return;
    }
    const settled: SettleResponse = await facilitator.settle(
      payload,
      requirements,
      actual === undefined ? undefined : String(actual),
    );
    if (!settled.success) {
      // Don't hand out the result unpaid; ask the client to pay again.
      c.res = undefined;
      c.res = await quote(settled.errorReason ?? "settle_failed", settled.extra?.channel);
      return;
    }
    c.header(HEADERS.paymentResponse, encodePaymentResponseHeader(settled));
  };
}

/**
 * `/.well-known/x402` for your API, generated from your endpoints in Tab402 (cached for a minute).
 * Mount it yourself: `app.get("/.well-known/x402", tab402Discovery(options))`.
 */
export function tab402Discovery(
  options: Pick<GateOptions, "facilitatorUrl" | "apiKey" | "baseUrl" | "fetch">,
): Handler {
  const facilitator = new FacilitatorClient({
    url: options.facilitatorUrl,
    apiKey: options.apiKey,
    fetch: options.fetch,
  });
  const origin = new URL(options.baseUrl).origin;
  let cached: { manifest: ResourceServerManifest; expires: number } | undefined;
  return async (c) => {
    if (!cached || cached.expires <= Date.now()) {
      try {
        cached = { manifest: await facilitator.manifest(origin), expires: Date.now() + 60_000 };
      } catch {
        if (!cached) return c.json({ error: "discovery unavailable" }, 503);
      }
    }
    c.header("cache-control", "public, max-age=300");
    c.header("access-control-allow-origin", "*");
    return c.json(cached.manifest);
  };
}
