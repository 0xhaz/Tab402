import { type ChannelState, generateAgentKeyPair, importPrivateJwk, newId } from "@tab402/core";
import { type Database, openSecret, schema as s, sealSecret } from "@tab402/db";
import type { ChannelStore } from "@tab402/sdk-client";
import { and, eq, isNull } from "drizzle-orm";

export interface HeldKey {
  keyId: string;
  agentId: string;
  privateKey: CryptoKey;
}

/**
 * The buyer MCP server is the agent's client, so it holds the agent's signing key: generated
 * here, private half sealed with the master key, public half registered like any other client
 *. One root key per (buyer, agent name); sub-budgets are child keys.
 */
export class AgentKeys {
  private readonly cache = new Map<string, HeldKey>();

  constructor(
    private readonly db: Database,
    private readonly masterKey: Buffer,
  ) {}

  private async load(keyId: string, agentId: string): Promise<HeldKey | null> {
    const cached = this.cache.get(keyId);
    if (cached) return cached;
    const secret = await this.db.query.merchantSecrets.findFirst({
      where: (m, { and, eq }) => and(eq(m.ownerId, keyId), eq(m.kind, "agent_private_key")),
    });
    if (!secret) return null;
    const jwk = JSON.parse(
      openSecret(this.masterKey, keyId, "agent_private_key", secret.blob),
    ) as JsonWebKey;
    const held = { keyId, agentId, privateKey: await importPrivateJwk(jwk) };
    this.cache.set(keyId, held);
    return held;
  }

  private async create(
    buyerId: string,
    agentId: string,
    child?: {
      parentKeyId: string;
      capMicros: number;
      expiresAt: Date;
      scope: { sellers?: string[]; categories?: string[] } | null;
    },
  ): Promise<HeldKey> {
    const pair = await generateAgentKeyPair(true);
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const keyId = newId("agentKey");
    await this.db.transaction(async (tx) => {
      await tx.insert(s.agentKeys).values({
        id: keyId,
        agentId,
        buyerId,
        publicJwk: pair.publicJwk,
        parentKeyId: child?.parentKeyId ?? null,
        budgetCapMicros: child?.capMicros ?? null,
        expiresAt: child?.expiresAt ?? null,
        scope: child?.scope ?? null,
      });
      await tx.insert(s.merchantSecrets).values({
        id: newId("secret"),
        ownerId: keyId,
        kind: "agent_private_key",
        blob: sealSecret(this.masterKey, keyId, "agent_private_key", JSON.stringify(jwk)),
      });
    });
    const held = { keyId, agentId, privateKey: await importPrivateJwk(jwk) };
    this.cache.set(keyId, held);
    return held;
  }

  /** The agent's root key, created on first use. */
  async root(buyerId: string, agentName: string): Promise<HeldKey> {
    let agent = await this.db.query.agents.findFirst({
      where: (a, { and, eq }) => and(eq(a.buyerId, buyerId), eq(a.name, agentName)),
    });
    if (!agent) {
      const id = newId("agent");
      await this.db.insert(s.agents).values({ id, buyerId, name: agentName }).onConflictDoNothing();
      agent = { id, buyerId, name: agentName, createdAt: new Date() };
    }
    const keys = await this.db
      .select({ id: s.agentKeys.id })
      .from(s.agentKeys)
      .innerJoin(
        s.merchantSecrets,
        and(
          eq(s.merchantSecrets.ownerId, s.agentKeys.id),
          eq(s.merchantSecrets.kind, "agent_private_key"),
        ),
      )
      .where(
        and(
          eq(s.agentKeys.agentId, agent.id),
          eq(s.agentKeys.status, "active"),
          isNull(s.agentKeys.parentKeyId),
        ),
      )
      .limit(1);
    const existing = keys[0] ? await this.load(keys[0].id, agent.id) : null;
    return existing ?? this.create(buyerId, agent.id);
  }

  /** A sub-budget key under `parent` (create_sub_budget). */
  async child(
    buyerId: string,
    parent: HeldKey,
    opts: {
      capMicros: number;
      expiresAt: Date;
      scope: { sellers?: string[]; categories?: string[] } | null;
    },
  ): Promise<HeldKey> {
    return this.create(buyerId, parent.agentId, { parentKeyId: parent.keyId, ...opts });
  }

  /** A sub-budget key that belongs to `parent`, by id. */
  async childOf(parent: HeldKey, childKeyId: string): Promise<HeldKey | null> {
    const row = await this.db.query.agentKeys.findFirst({
      where: (k, { and, eq }) => and(eq(k.id, childKeyId), eq(k.parentKeyId, parent.keyId)),
    });
    return row ? this.load(row.id, row.agentId) : null;
  }
}

/** Channel state straight from the ledger: the server is the source of truth, so no resync needed. */
export class DbChannelStore implements ChannelStore {
  constructor(
    private readonly db: Database,
    private readonly keyId: string,
  ) {}

  async get(sellerId: string): Promise<ChannelState | undefined> {
    const ch = await this.db.query.channels.findFirst({
      where: (c, { and, eq }) => and(eq(c.agentKeyId, this.keyId), eq(c.sellerId, sellerId)),
    });
    return ch
      ? { channelId: ch.id, lastSeq: ch.lastSeq, cumulative: String(ch.cumulativeRecordedMicros) }
      : undefined;
  }

  set(): void {
    // The facilitator already recorded the new state.
  }
}
