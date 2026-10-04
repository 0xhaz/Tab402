import { generateAgentKeyPair, newId } from "@tab402/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../src/client";
import { runMigrations } from "../src/migrate";
import * as s from "../src/schema";

const url = process.env.DATABASE_URL_TEST;
const { db, close } = createDb(url ?? "postgres://invalid", { max: 2 });

async function reset() {
  const tables = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const names = tables.map((t) => `"${t.tablename}"`).join(", ");
  if (names) await db.execute(sql.raw(`truncate ${names} restart identity cascade`));
}

/** Minimal graph: buyer → agent → key, seller → endpoint → quote, channel. */
async function fixture() {
  const buyerId = newId("buyer");
  const agentId = newId("agent");
  const keyId = newId("agentKey");
  const sellerId = newId("seller");
  const endpointId = newId("endpoint");
  const channelId = newId("channel");
  const { publicJwk } = await generateAgentKeyPair();
  await db.insert(s.buyers).values({ id: buyerId, name: "B", email: "b@example.com" });
  await db.insert(s.agents).values({ id: agentId, buyerId, name: "A" });
  await db.insert(s.agentKeys).values({ id: keyId, agentId, buyerId, publicJwk });
  await db.insert(s.sellers).values({ id: sellerId, name: "S" });
  await db.insert(s.endpoints).values({
    id: endpointId,
    sellerId,
    method: "POST",
    url: "http://x/v1",
    pricingMode: "fixed",
    priceMicros: 10_000,
  });
  await db.insert(s.channels).values({ id: channelId, agentKeyId: keyId, sellerId });
  const quote = async () => {
    const id = newId("quote");
    await db.insert(s.quotes).values({
      id,
      endpointId,
      sellerId,
      amountMicros: 10_000,
      pricingMode: "fixed",
      expiresAt: new Date(Date.now() + 300_000),
    });
    return id;
  };
  return { buyerId, keyId, sellerId, endpointId, channelId, quote };
}

describe.skipIf(!url)("ledger constraints (Postgres)", () => {
  beforeAll(async () => {
    await runMigrations(url as string);
  });
  beforeEach(reset);
  afterAll(close);

  it("round-trips micro-USD bigints as numbers", async () => {
    const f = await fixture();
    await db.insert(s.balances).values({ buyerId: f.buyerId, balanceMicros: 9_000_000_000_000 });
    const row = await db.query.balances.findFirst();
    expect(row?.balanceMicros).toBe(9_000_000_000_000);
  });

  it("rejects a negative prepaid balance", async () => {
    const f = await fixture();
    await expect(
      db.insert(s.balances).values({ buyerId: f.buyerId, balanceMicros: -1 }),
    ).rejects.toThrow();
  });

  it("rejects recorded > authorized on a channel", async () => {
    const f = await fixture();
    await expect(
      db.execute(
        sql`update channels set cumulative_recorded_micros = 10 where id = ${f.channelId}`,
      ),
    ).rejects.toThrow();
  });

  it("allows one voucher per (channel, seq) and per quote", async () => {
    const f = await fixture();
    const q1 = await f.quote();
    const q2 = await f.quote();
    const base = {
      channelId: f.channelId,
      cumulativeMicros: 10_000,
      expiresAt: new Date(),
      signature: "sig",
    };
    await db.insert(s.vouchers).values({ ...base, id: newId("voucher"), seq: 1, quoteId: q1 });
    await expect(
      db.insert(s.vouchers).values({ ...base, id: newId("voucher"), seq: 1, quoteId: q2 }),
    ).rejects.toThrow();
    await expect(
      db.insert(s.vouchers).values({ ...base, id: newId("voucher"), seq: 2, quoteId: q1 }),
    ).rejects.toThrow();
  });

  it("rejects a charge above its authorization, and a second charge for one quote", async () => {
    const f = await fixture();
    const quoteId = await f.quote();
    const voucherId = newId("voucher");
    await db.insert(s.vouchers).values({
      id: voucherId,
      channelId: f.channelId,
      seq: 1,
      cumulativeMicros: 10_000,
      quoteId,
      expiresAt: new Date(),
      signature: "sig",
    });
    const charge = {
      buyerId: f.buyerId,
      agentKeyId: f.keyId,
      sellerId: f.sellerId,
      endpointId: f.endpointId,
      quoteId,
      channelId: f.channelId,
      voucherId,
    };
    await expect(
      db
        .insert(s.charges)
        .values({ ...charge, id: newId("charge"), amountMicros: 10_001, authorizedMicros: 10_000 }),
    ).rejects.toThrow();
    await db
      .insert(s.charges)
      .values({ ...charge, id: newId("charge"), amountMicros: 10_000, authorizedMicros: 10_000 });
    await expect(
      db
        .insert(s.charges)
        .values({ ...charge, id: newId("charge"), amountMicros: 10_000, authorizedMicros: 10_000 }),
    ).rejects.toThrow();
  });

  it("applies the default spending policy", async () => {
    const f = await fixture();
    await db.insert(s.policies).values({ buyerId: f.buyerId });
    const p = await db.query.policies.findFirst();
    expect(p).toMatchObject({
      perCallMaxMicros: 1_000_000,
      approvalThresholdMicros: 2_000_000,
      blocklist: [],
    });
  });
});
