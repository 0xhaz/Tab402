import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { generateAgentKeyPair, newId } from "@tab402/core";
import { schema as s } from "@tab402/db";
import { close, db, signUp } from "./helpers";

test.afterAll(close);

/** A seller owned by `userId` (if given) with one endpoint, and an agent of `buyerId` with a channel to it. */
async function setup(buyerId: string, userId?: string) {
  const sellerId = newId("seller");
  await db.insert(s.sellers).values({ id: sellerId, userId, name: "Acme Data API" });
  const endpointId = newId("endpoint");
  await db.insert(s.endpoints).values({
    id: endpointId,
    sellerId,
    method: "POST",
    url: "https://api.acme.example/v1/search",
    pricingMode: "fixed",
    priceMicros: 5_000,
  });
  const agentId = newId("agent");
  await db.insert(s.agents).values({ id: agentId, buyerId, name: "Research agent" });
  const keyId = newId("agentKey");
  await db
    .insert(s.agentKeys)
    .values({ id: keyId, agentId, buyerId, publicJwk: (await generateAgentKeyPair()).publicJwk });
  const channelId = newId("channel");
  await db
    .insert(s.channels)
    .values({ id: channelId, agentKeyId: keyId, sellerId, cumulativeAuthorizedMicros: 1e12 });
  let seq = 0;
  /** One paid call, as the facilitator records it. */
  const pay = async (amountMicros: number, intent: string) => {
    const quoteId = newId("quote");
    await db.insert(s.quotes).values({
      id: quoteId,
      endpointId,
      sellerId,
      amountMicros,
      pricingMode: "fixed",
      status: "paid",
      expiresAt: new Date(Date.now() + 300_000),
    });
    const voucherId = newId("voucher");
    await db.insert(s.vouchers).values({
      id: voucherId,
      channelId,
      seq: ++seq,
      cumulativeMicros: amountMicros,
      quoteId,
      expiresAt: new Date(),
      signature: "x",
    });
    await db.insert(s.charges).values({
      id: newId("charge"),
      buyerId,
      agentKeyId: keyId,
      sellerId,
      endpointId,
      quoteId,
      channelId,
      voucherId,
      amountMicros,
      authorizedMicros: amountMicros,
      intent,
    });
  };
  return { sellerId, pay };
}

test("a new receipt shows up live, and receipts download as CSV", async ({ page }) => {
  const { buyerId } = await signUp(page);
  const { pay } = await setup(buyerId);
  await page.goto("/receipts");
  await expect(page.getByText("No purchases yet.")).toBeVisible();

  // The agent pays while the page is open: no reload.
  await pay(5_000, "find three competitors");
  await expect(page.getByRole("cell", { name: "find three competitors" })).toBeVisible({
    timeout: 15_000,
  });

  await pay(1_234_567, '=HYPERLINK("https://evil.example","click")');
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download CSV" }).click();
  const csv = await readFile((await (await download).path()) ?? "", "utf8");
  const lines = csv.trim().split("\r\n");
  expect(lines[0]).toBe("charge_id,created_at,agent,seller,endpoint,intent,amount_usd,state");
  expect(lines).toHaveLength(3);
  expect(csv).toContain(",1.234567,earned");
  expect(csv).toContain(",find three competitors,0.005,earned");
  // Seller- or agent-supplied text never runs as a spreadsheet formula.
  expect(csv).toContain(`"'=HYPERLINK(""https://evil.example"",""click"")"`);
});

test("sellers download payouts as CSV; buyers without a seller account get 404", async ({
  page,
}) => {
  const { buyerId, userId } = await signUp(page, "Sam Seller");
  const res = await page.request.get("/api/export/payouts");
  expect(res.status()).toBe(404);

  const { sellerId } = await setup(buyerId, userId);
  const payoutId = newId("payout");
  await db.insert(s.payouts).values({
    id: payoutId,
    senderBatchId: `pw_${payoutId}`,
    paypalPayoutBatchId: "PB-123",
    status: "success",
    totalMicros: 2_350_000,
  });
  await db.insert(s.payoutItems).values({
    id: newId("payoutItem"),
    payoutId,
    sellerId,
    amountMicros: 2_350_000,
    feeMicros: 250_000,
    status: "success",
  });
  await page.goto("/selling");
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Payouts CSV" }).click();
  const csv = await readFile((await (await download).path()) ?? "", "utf8");
  expect(csv).toMatch(/^payout_item_id,created_at,paypal_batch_id,amount_usd,fee_usd,status\r\n/);
  expect(csv).toContain(",PB-123,2.35,0.25,success\r\n");
});

test("exports need a session", async ({ request }) => {
  const res = await request.get("/api/export/receipts", { maxRedirects: 0 });
  expect([302, 307, 401]).toContain(res.status());
});
