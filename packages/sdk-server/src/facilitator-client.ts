import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  PricingMode,
  ResourceServerManifest,
  SettleResponse,
  VerifyResponse,
} from "@tab402/core";

export interface FacilitatorClientOptions {
  /** Tab402 API base URL, e.g. http://localhost:4000 */
  url: string;
  /** Seller API key (t402_sk_…). */
  apiKey: string;
  fetch?: typeof fetch;
}

export interface EndpointRegistration {
  method: string;
  url: string;
  pricing: Extract<PricingMode, "fixed" | "metered">;
  /** Micro-USD string: price for fixed, maximum for metered. */
  price: string;
  description?: string;
  category?: string;
}

export class FacilitatorError extends Error {
  override name = "FacilitatorError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Typed client for the Tab402 facilitator and seller APIs. */
export class FacilitatorClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: FacilitatorClientOptions) {
    this.base = options.url.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async post<T>(
    path: string,
    body: unknown,
    method = "POST",
  ): Promise<{ status: number; body: T }> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, body: json };
  }

  /** Issue a quote. Returns null when the URL is not a paid endpoint for this seller. */
  async quote(method: string, url: string): Promise<PaymentRequired | null> {
    const r = await this.post<PaymentRequired & { error?: string }>("/quotes", { method, url });
    if (r.status === 404) return null;
    if (r.status !== 201)
      throw new FacilitatorError(r.status, `quote failed: ${r.body.error ?? r.status}`);
    return r.body;
  }

  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const r = await this.post<VerifyResponse>("/verify", {
      x402Version: 2,
      paymentPayload,
      paymentRequirements,
    });
    if (r.status !== 200) throw new FacilitatorError(r.status, "verify failed");
    return r.body;
  }

  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
    amount?: string,
  ): Promise<SettleResponse> {
    const r = await this.post<SettleResponse>("/settle", {
      x402Version: 2,
      paymentPayload,
      paymentRequirements,
      amount,
    });
    if (r.status !== 200) throw new FacilitatorError(r.status, "settle failed");
    return r.body;
  }

  async registerEndpoints(endpoints: EndpointRegistration[]): Promise<void> {
    const r = await this.post<{ error?: string }>("/endpoints", { endpoints }, "PUT");
    if (r.status !== 200)
      throw new FacilitatorError(
        r.status,
        `endpoint registration failed: ${r.body.error ?? r.status}`,
      );
  }

  /** This seller's `/.well-known/x402` manifest, limited to endpoints on `origin`. */
  async manifest(origin: string): Promise<ResourceServerManifest> {
    const res = await this.fetchImpl(
      `${this.base}/seller/x402?origin=${encodeURIComponent(origin)}`,
      { headers: { authorization: `Bearer ${this.options.apiKey}` } },
    );
    if (!res.ok) throw new FacilitatorError(res.status, `manifest failed: ${res.status}`);
    return (await res.json()) as ResourceServerManifest;
  }
}
