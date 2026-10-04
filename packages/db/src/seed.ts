import { newId } from "@tab402/core";
import { eq } from "drizzle-orm";
import { apiKeyOwnerOf, displayPrefix, hashApiKey } from "./api-keys";
import { createDb } from "./client";
import {
  agents,
  apiKeys,
  balances,
  buyers,
  endpoints,
  mandates,
  policies,
  sellers,
} from "./schema";

/**
 * Local seed (idempotent): the demo seller with its two endpoints, and a demo
 * buyer with an active prepaid mandate ($10 balance) and one agent. API keys come from env
 * (DEMO_SELLER_API_KEY / DEMO_BUYER_API_KEY) so services and tests can use them; only hashes are stored.
 * Agent keys are generated and registered by clients, so none are seeded.
 */
const DEMO_SELLERS_URL = process.env.DEMO_SELLERS_URL ?? "http://localhost:4200";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const { db, close } = createDb(url, { max: 1 });

async function ensureApiKey(
  key: string | undefined,
  ownerType: "seller" | "buyer",
  ownerId: string,
) {
  if (!key) return console.log(`seed: no ${ownerType} API key in env — skipped`);
  if (apiKeyOwnerOf(key) !== ownerType)
    throw new Error(`${ownerType} API key has the wrong prefix`);
  const hash = hashApiKey(key);
  const existing = await db.query.apiKeys.findFirst({ where: (k, { eq }) => eq(k.hash, hash) });
  if (existing) return;
  await db
    .insert(apiKeys)
    .values({ id: newId("apiKey"), ownerType, ownerId, prefix: displayPrefix(key), hash });
  console.log(`seed: registered ${ownerType} API key ${displayPrefix(key)}`);
}

try {
  let seller = await db.query.sellers.findFirst({
    where: (s, { eq }) => eq(s.name, "Tab402 Demo Sellers"),
  });
  if (!seller) {
    const sellerId = newId("seller");
    await db.transaction(async (tx) => {
      await tx.insert(sellers).values({
        id: sellerId,
        name: "Tab402 Demo Sellers",
        payoutReceiver: "seller@example.com",
      });
      await tx.insert(endpoints).values([
        {
          id: newId("endpoint"),
          sellerId,
          method: "POST",
          url: `${DEMO_SELLERS_URL}/v1/summarize`,
          description: "Summarize text",
          category: "llm",
          pricingMode: "fixed",
          priceMicros: 10_000,
        },
        {
          id: newId("endpoint"),
          sellerId,
          method: "POST",
          url: `${DEMO_SELLERS_URL}/v1/chat`,
          description: "Chat with a model (metered, provider cost × 1.3)",
          category: "llm",
          pricingMode: "metered",
          priceMicros: 50_000,
        },
      ]);
    });
    seller = await db.query.sellers.findFirst({ where: (s, { eq }) => eq(s.id, sellerId) });
    console.log(`seed: seller ${sellerId}`);
  }

  let buyer = await db.query.buyers.findFirst({
    where: (b, { eq }) => eq(b.email, "buyer@example.com"),
  });
  if (!buyer) {
    const buyerId = newId("buyer");
    await db.transaction(async (tx) => {
      await tx
        .insert(buyers)
        .values({ id: buyerId, name: "Demo Buyer", email: "buyer@example.com" });
      await tx.insert(policies).values({ buyerId });
      await tx.insert(balances).values({ buyerId, balanceMicros: 10_000_000 });
      await tx.insert(agents).values({ id: newId("agent"), buyerId, name: "Claude Code" });
    });
    buyer = await db.query.buyers.findFirst({ where: (b, { eq }) => eq(b.id, buyerId) });
    console.log(`seed: buyer ${buyerId}`);
  }
  if (!seller || !buyer) throw new Error("seed failed");

  // Demo mandate: active prepaid. A real one is created by the PayPal wallet-save flow (Phase 3/5).
  const mandate = await db.query.mandates.findFirst({
    where: (m, { eq }) => eq(m.buyerId, buyer.id),
  });
  if (!mandate) {
    await db.insert(mandates).values({
      id: newId("mandate"),
      buyerId: buyer.id,
      rail: "paypal_wallet",
      mode: "prepaid",
      status: "active",
    });
  } else if (mandate.status === "pending") {
    await db.update(mandates).set({ status: "active" }).where(eq(mandates.id, mandate.id));
  }

  await ensureApiKey(process.env.DEMO_SELLER_API_KEY, "seller", seller.id);
  await ensureApiKey(process.env.DEMO_BUYER_API_KEY, "buyer", buyer.id);
  console.log(`seed: ok (seller ${seller.id}, buyer ${buyer.id})`);
} finally {
  await close();
}
