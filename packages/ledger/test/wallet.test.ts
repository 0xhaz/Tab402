import { randomBytes } from "node:crypto";
import { newId } from "@tab402/core";
import { createDb, schema as s } from "@tab402/db";
import { runMigrations } from "@tab402/db/migrate";
import { testDatabase } from "@tab402/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { beginWalletMandate, completeWalletMandate, type MandateProvider } from "../src";

const url = await testDatabase("ledger_wallet");
await runMigrations(url);
const { db, close } = createDb(url, { max: 6 });
afterAll(close);
const key = randomBytes(32);

class SlowProvider implements MandateProvider {
  completes = 0;
  fail = false;
  async beginMandate() {
    return {
      setupToken: `SETUP-${randomBytes(4).toString("hex")}`,
      approveUrl: "https://paypal.example/approve",
    };
  }
  async completeMandate(_setupToken: string) {
    this.completes++;
    await new Promise((r) => setTimeout(r, 30));
    if (this.fail) throw new Error("PayPal 422: setup token not approved");
    return { vaultToken: "VAULT-1", payerEmail: "pat@example.com" };
  }
}

let buyerId: string;
beforeEach(async () => {
  const tables = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  await db.execute(
    sql.raw(
      `truncate ${tables.map((t) => `"${t.tablename}"`).join(", ")} restart identity cascade`,
    ),
  );
  buyerId = newId("buyer");
  await db.insert(s.buyers).values({ id: buyerId, name: "Pat", email: "pat@example.com" });
});

const input = {
  mode: "prepaid" as const,
  returnUrl: "https://web.example/wallet",
  cancelUrl: "https://web.example/wallet",
};

describe("saving a wallet (redirect-safe)", () => {
  it("SDK onApprove and the redirect fallback racing: PayPal is asked once, one mandate goes active", async () => {
    const provider = new SlowProvider();
    const begun = await beginWalletMandate(db, provider, { buyerId, ...input });
    const results = await Promise.all([
      completeWalletMandate(db, provider, key, { buyerId, setupToken: begun.setupToken }),
      completeWalletMandate(db, provider, key, { buyerId, mandateId: begun.mandateId }),
    ]);
    expect(provider.completes).toBe(1);
    expect(results.filter(Boolean)).toHaveLength(1);
    const [m] = await db.select().from(s.mandates).where(eq(s.mandates.id, begun.mandateId));
    expect(m).toMatchObject({ status: "active", setupToken: null, payerEmail: "pat@example.com" });
    expect(await db.select().from(s.merchantSecrets)).toHaveLength(1);
  });

  it("a PayPal failure releases the claim so the buyer can retry", async () => {
    const provider = new SlowProvider();
    provider.fail = true;
    const begun = await beginWalletMandate(db, provider, { buyerId, ...input });
    await expect(
      completeWalletMandate(db, provider, key, { buyerId, mandateId: begun.mandateId }),
    ).rejects.toThrow(/422/);
    const [m] = await db.select().from(s.mandates).where(eq(s.mandates.id, begun.mandateId));
    expect(m).toMatchObject({ status: "pending", setupToken: begun.setupToken });
    provider.fail = false;
    expect(
      await completeWalletMandate(db, provider, key, { buyerId, mandateId: begun.mandateId }),
    ).toMatchObject({
      mandateId: begun.mandateId,
    });
  });

  it("another buyer can't complete it", async () => {
    const provider = new SlowProvider();
    const begun = await beginWalletMandate(db, provider, { buyerId, ...input });
    const other = newId("buyer");
    await db.insert(s.buyers).values({ id: other, name: "X", email: "x@example.com" });
    expect(
      await completeWalletMandate(db, provider, key, {
        buyerId: other,
        mandateId: begun.mandateId,
      }),
    ).toBeNull();
    expect(provider.completes).toBe(0);
  });
});
