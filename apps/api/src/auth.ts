import { apiKeyOwnerOf, type Database, hashApiKey } from "@tab402/db";
import { createMiddleware } from "hono/factory";
import type { Env, Principal } from "./context";

/** Bearer API key auth. Resolved principals are cached briefly; revocation takes effect within the TTL. */
export function apiKeyAuth(db: Database, allow: Principal["ownerType"][], ttlMs = 30_000) {
  const cache = new Map<string, { principal: Principal | null; expires: number }>();

  return createMiddleware<Env>(async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const owner = apiKeyOwnerOf(key);
    if (!owner || !allow.includes(owner)) return c.json({ error: "unauthorized" }, 401);

    const hash = hashApiKey(key);
    let entry = cache.get(hash);
    if (!entry || entry.expires <= Date.now()) {
      const row = await db.query.apiKeys.findFirst({ where: (k, { eq }) => eq(k.hash, hash) });
      const principal =
        row && !row.revokedAt ? { ownerType: row.ownerType, ownerId: row.ownerId } : null;
      entry = { principal, expires: Date.now() + ttlMs };
      cache.set(hash, entry);
    }
    if (!entry.principal) return c.json({ error: "unauthorized" }, 401);
    c.set("principal", entry.principal);
    await next();
  });
}
