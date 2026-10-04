import { randomUUID } from "node:crypto";

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  env: "sandbox" | "live";
  fetch?: typeof fetch;
}

export const PAYPAL_BASE = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
} as const;

/** A non-2xx PayPal response. `name` / `details` are PayPal's error fields; `debugId` is for support. */
export class PayPalError extends Error {
  override name = "PayPalError";
  constructor(
    readonly status: number,
    readonly paypalName: string | undefined,
    readonly details: { issue?: string; description?: string }[],
    readonly debugId: string | null,
    message: string,
  ) {
    super(message);
  }

  /** First `details[].issue`, e.g. INSTRUMENT_DECLINED, PAYER_ACTION_REQUIRED. */
  get issue(): string | undefined {
    return this.details[0]?.issue;
  }
}

export interface RequestOptions {
  /** PayPal-Request-Id: makes POSTs idempotent. Pass a stable id (settlement / payout id) for retries. */
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

/**
 * One typed REST client for every PayPal API Tab402 uses (Vault v3, Orders v2, Payouts v1,
 * Invoicing v2, webhook verification). Caches the OAuth token; never logs credentials.
 */
export class PayPalClient {
  readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private token: { value: string; expires: number } | undefined;

  constructor(private readonly config: PayPalConfig) {
    this.base = PAYPAL_BASE[config.env];
    this.fetchImpl = config.fetch ?? fetch;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now()) return this.token.value;
    const res = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!res.ok || !body.access_token)
      throw new PayPalError(
        res.status,
        body.error,
        [],
        res.headers.get("paypal-debug-id"),
        "PayPal OAuth failed",
      );
    this.token = {
      value: body.access_token,
      expires: Date.now() + ((body.expires_in ?? 300) - 60) * 1000,
    };
    return body.access_token;
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        "content-type": "application/json",
        prefer: "return=representation",
        "paypal-request-id": options.idempotencyKey ?? randomUUID(),
        ...options.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      const details =
        (json.details as { issue?: string; description?: string }[] | undefined) ?? [];
      const name = json.name as string | undefined;
      throw new PayPalError(
        res.status,
        name,
        details,
        res.headers.get("paypal-debug-id"),
        `PayPal ${method} ${path} → ${res.status} ${name ?? ""} ${details[0]?.issue ?? ""}`.trim(),
      );
    }
    return json as T;
  }
}
