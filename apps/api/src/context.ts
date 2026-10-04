import type { TabNetwork } from "@tab402/core";
import type { Database } from "@tab402/db";
import type { GuardDeps, GuardModel } from "@tab402/guard";
import type { Enqueue } from "@tab402/ledger";
import type { FundingAdapter, PayPalClient } from "@tab402/paypal";
import type { AgentKeyCache } from "./key-cache";

export interface AppConfig {
  network: TabNetwork;
  /** Public URL of this facilitator, advertised in quotes. */
  facilitatorUrl: string;
  quoteTtlSeconds: number;
}

export interface Deps {
  db: Database;
  config: AppConfig;
  keys: AgentKeyCache;
  now?: () => number;
  onError?: (err: unknown) => void;
  /**
   * Spend guard. When set, /verify enforces it on every payment and /guard/decide runs the
   * model for grey-zone purchases. Leave unset only in protocol-level tests.
   */
  guard?: { model: GuardModel; approvalBaseUrl?: string };
  /** Background jobs (pg-boss). Optional so the payment path works without a worker. */
  enqueue?: Enqueue;
  /** Wraps vault tokens and merchant secrets. Required for wallet and webhook endpoints. */
  masterKey?: Buffer;
  paypal?: {
    client: PayPalClient;
    funding: FundingAdapter;
    /** Webhook id from the PayPal app; inbound webhooks are verified against it. */
    webhookId?: string;
    /** Dev only (sandbox): accept unverified webhooks, e.g. from the webhook simulator. */
    skipWebhookVerification?: boolean;
  };
}

export interface Principal {
  ownerType: "seller" | "buyer";
  ownerId: string;
}

export type Env = { Variables: { principal: Principal } };

export function guardDeps(deps: Deps): GuardDeps | null {
  if (!deps.guard) return null;
  return {
    db: deps.db,
    model: deps.guard.model,
    approvalBaseUrl: deps.guard.approvalBaseUrl,
    now: deps.now ? () => new Date((deps.now as () => number)()) : undefined,
  };
}
