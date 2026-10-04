import type { KeyObject } from "node:crypto";
import type { P256PublicJwk } from "@tab402/core";
import type { Database } from "@tab402/db";
import { publicKeyObject } from "./signature";

export interface CachedAgentKey {
  id: string;
  buyerId: string;
  agentId: string;
  status: "active" | "frozen" | "revoked";
  expiresAt: Date | null;
  publicKey: KeyObject;
}

/**
 * Agent key lookups for the verify hot path. Entries live at most `ttlMs` (30 s by default),
 * which bounds how long a revoked key keeps working.
 */
export class AgentKeyCache {
  private readonly entries = new Map<string, { value: CachedAgentKey | null; expires: number }>();

  constructor(
    private readonly db: Database,
    private readonly ttlMs = 30_000,
  ) {}

  async get(keyId: string): Promise<CachedAgentKey | null> {
    const hit = this.entries.get(keyId);
    if (hit && hit.expires > Date.now()) return hit.value;
    const row = await this.db.query.agentKeys.findFirst({ where: (k, { eq }) => eq(k.id, keyId) });
    const value = row
      ? {
          id: row.id,
          buyerId: row.buyerId,
          agentId: row.agentId,
          status: row.status,
          expiresAt: row.expiresAt,
          publicKey: publicKeyObject(row.publicJwk as P256PublicJwk),
        }
      : null;
    this.entries.set(keyId, { value, expires: Date.now() + this.ttlMs });
    return value;
  }

  invalidate(keyId: string): void {
    this.entries.delete(keyId);
  }
}
