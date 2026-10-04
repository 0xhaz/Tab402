import { generateAgentKeyPair, newId } from "@tab402/core";
import { type Database, schema as s } from "@tab402/db";

/**
 * A seller's two weeks: steady traffic, then on Tuesday 2026-09-29 the seller raised the /v1/chat
 * ceiling to $1.50 — above buyers' $1 per-call max — so most chat purchases were denied by buyers'
 * spend guards. Search is unchanged. The baseline is Tuesday 2026-09-22.
 */
export const DROP_DAY = "2026-09-29";
export const BASELINE_DAY = "2026-09-22";

export async function seedRevenueDrop(db: Database, sellerId = newId("seller")) {
  await db.insert(s.sellers).values({ id: sellerId, name: "Acme AI" });
  const search = {
    id: newId("endpoint"),
    url: "https://api.acme.example/v1/search",
    price: 10_000,
  };
  const chat = { id: newId("endpoint"), url: "https://api.acme.example/v1/chat", price: 50_000 };
  await db.insert(s.endpoints).values([
    {
      id: search.id,
      sellerId,
      method: "POST",
      url: search.url,
      pricingMode: "fixed",
      priceMicros: search.price,
      category: "search",
    },
    {
      id: chat.id,
      sellerId,
      method: "POST",
      url: chat.url,
      pricingMode: "metered",
      priceMicros: chat.price,
      category: "llm",
    },
  ]);
  const buyers = await Promise.all(
    [0, 1, 2, 3].map(async (i) => {
      const buyerId = newId("buyer");
      await db
        .insert(s.buyers)
        .values({ id: buyerId, name: `Buyer ${i}`, email: `b${i}-${buyerId}@example.com` });
      const agentId = newId("agent");
      await db.insert(s.agents).values({ id: agentId, buyerId, name: `Agent ${i}` });
      const keyId = newId("agentKey");
      await db.insert(s.agentKeys).values({
        id: keyId,
        agentId,
        buyerId,
        publicJwk: (await generateAgentKeyPair()).publicJwk,
      });
      const channelId = newId("channel");
      await db
        .insert(s.channels)
        .values({ id: channelId, agentKeyId: keyId, sellerId, cumulativeAuthorizedMicros: 1e12 });
      return { buyerId, keyId, channelId, seq: 0 };
    }),
  );

  const quotes: (typeof s.quotes.$inferInsert)[] = [];
  const vouchers: (typeof s.vouchers.$inferInsert)[] = [];
  const charges: (typeof s.charges.$inferInsert)[] = [];
  const guard: (typeof s.guardDecisions.$inferInsert)[] = [];
  const day = (iso: string, minute: number) =>
    new Date(new Date(`${iso}T09:00:00Z`).getTime() + minute * 60_000);

  const traffic = (
    iso: string,
    ep: typeof search,
    quoted: number,
    paid: number,
    priceMicros: number,
    denied: number,
  ) => {
    for (let i = 0; i < quoted; i++) {
      const at = day(iso, i);
      const b = buyers[i % buyers.length];
      if (!b) continue;
      const quoteId = newId("quote");
      const isPaid = i < paid;
      quotes.push({
        id: quoteId,
        endpointId: ep.id,
        sellerId,
        amountMicros: priceMicros,
        pricingMode: ep === chat ? "metered" : "fixed",
        status: isPaid ? "paid" : "issued",
        expiresAt: new Date(at.getTime() + 300_000),
        createdAt: at,
      });
      if (isPaid) {
        const voucherId = newId("voucher");
        vouchers.push({
          id: voucherId,
          channelId: b.channelId,
          seq: ++b.seq,
          cumulativeMicros: priceMicros,
          quoteId,
          expiresAt: at,
          signature: "x",
        });
        charges.push({
          id: newId("charge"),
          buyerId: b.buyerId,
          agentKeyId: b.keyId,
          sellerId,
          endpointId: ep.id,
          quoteId,
          channelId: b.channelId,
          voucherId,
          // Metered chat actually costs ~$0.03 per call whatever the ceiling.
          amountMicros: ep === chat ? 30_000 : priceMicros,
          authorizedMicros: priceMicros,
          state: iso === DROP_DAY ? "earned" : "collected",
          createdAt: at,
        });
      } else if (i - paid < denied) {
        guard.push({
          id: newId("guardDecision"),
          agentKeyId: b.keyId,
          quoteId,
          sellerId,
          endpointUrl: ep.url,
          amountMicros: priceMicros,
          outcome: "deny",
          decidedBy: "rule",
          rule: "deny.per_call_max",
          createdAt: at,
        });
      }
    }
  };
  // Baseline Tuesday and the drop Tuesday; Wednesday in between for noise.
  traffic(BASELINE_DAY, search, 110, 100, search.price, 0);
  traffic(BASELINE_DAY, chat, 44, 40, chat.price, 0);
  traffic("2026-09-23", search, 100, 90, search.price, 0);
  traffic(DROP_DAY, search, 106, 96, search.price, 0);
  traffic(DROP_DAY, chat, 42, 8, 1_500_000, 30);

  await db.insert(s.quotes).values(quotes);
  await db.insert(s.vouchers).values(vouchers);
  for (let i = 0; i < charges.length; i += 200)
    await db.insert(s.charges).values(charges.slice(i, i + 200));
  await db.insert(s.guardDecisions).values(guard);
  return { sellerId, search, chat };
}
