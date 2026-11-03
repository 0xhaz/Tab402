import { expect, test } from "@playwright/test";
import { generateAgentKeyPair, newId } from "@tab402/core";
import { schema as s } from "@tab402/db";
import { close, db, signUp } from "./helpers";

test.afterAll(close);

/** A seller (owned by this user) with a few days of traffic in every money state. */
async function sellerWithTraffic(userId: string, buyerId: string) {
  const sellerId = newId("seller");
  await db.insert(s.sellers).values({
    id: sellerId,
    userId,
    name: "Acme Data API",
    payoutReceiver: "acme@business.example.com",
  });
  const eps = [
    { path: "/v1/search", price: 5_000 },
    { path: "/v1/summarize", price: 10_000 },
    { path: "/v1/chat", price: 50_000 },
  ].map((e) => ({ ...e, id: newId("endpoint") }));
  await db.insert(s.endpoints).values(
    eps.map((e) => ({
      id: e.id,
      sellerId,
      method: "POST",
      url: `https://api.acme.example${e.path}`,
      pricingMode: "fixed" as const,
      priceMicros: e.price,
    })),
  );
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
  const states = ["paid_out", "paid_out", "collected", "collected", "earned"] as const;
  let seq = 0;
  for (let d = 6; d >= 0; d--) {
    for (let i = 0; i < 12; i++) {
      const ep = eps[(i + d) % eps.length];
      if (!ep) continue;
      const at = new Date(Date.now() - d * 86_400_000 - i * 60_000);
      const quoteId = newId("quote");
      const paid = i % 4 !== 3;
      await db.insert(s.quotes).values({
        id: quoteId,
        endpointId: ep.id,
        sellerId,
        amountMicros: ep.price,
        pricingMode: "fixed",
        status: paid ? "paid" : "issued",
        expiresAt: new Date(at.getTime() + 300_000),
        createdAt: at,
      });
      if (!paid) continue;
      seq++;
      const voucherId = newId("voucher");
      await db.insert(s.vouchers).values({
        id: voucherId,
        channelId,
        seq,
        cumulativeMicros: ep.price,
        quoteId,
        expiresAt: at,
        signature: "x",
      });
      await db.insert(s.charges).values({
        id: newId("charge"),
        buyerId,
        agentKeyId: keyId,
        sellerId,
        endpointId: ep.id,
        quoteId,
        channelId,
        voucherId,
        amountMicros: ep.price,
        authorizedMicros: ep.price,
        state: states[Math.min(d, 4) % states.length] ?? "earned",
        intent: "research competitors",
        createdAt: at,
      });
    }
  }
  for (const rule of [
    "deny.per_call_max",
    "deny.per_call_max",
    "ask.over_threshold",
    "deny.daily_budget",
  ]) {
    await db.insert(s.guardDecisions).values({
      id: newId("guardDecision"),
      agentKeyId: keyId,
      sellerId,
      endpointUrl: "https://api.acme.example/v1/chat",
      amountMicros: 50_000,
      outcome: rule.startsWith("ask") ? "ask" : "deny",
      decidedBy: "rule",
      rule,
    });
  }
  return sellerId;
}

test("seller and buyer analytics render the pre-built AG Studio reports", async ({ page }) => {
  test.setTimeout(120_000);
  const { userId, buyerId } = await signUp(page, "Ana Lytics");
  await sellerWithTraffic(userId, buyerId);
  await page.setViewportSize({ width: 1440, height: 1000 });

  const logs: string[] = [];
  page.on("console", async (m) => {
    if (!["error", "warning"].includes(m.type())) return;
    const args = await Promise.all(m.args().map((a) => a.jsonValue().catch(() => String(a))));
    logs.push(
      `[${m.type()}] ${args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ")
        .slice(0, 600)}`,
    );
  });
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message.slice(0, 400)}`));
  await page.goto("/selling/analytics");
  await page.waitForTimeout(8000);
  await page.screenshot({ path: "test-results/seller-analytics.png", fullPage: true });
  console.log(logs.slice(0, 15).join("\n"));
  await expect(page.getByText("Revenue by day, by money state")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Revenue by endpoint")).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "test-results/seller-analytics.png", fullPage: true });
  // Each report page is reachable from the app's tabs.
  for (const [name, heading] of [
    ["demand", "402 → paid, by endpoint"],
    ["payouts", "Payouts ledger"],
  ] as const) {
    await page.getByRole("tab", { name }).click();
    await expect(page.getByText(heading)).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `test-results/seller-${name}.png`, fullPage: true });
  }
  await page.getByRole("tab", { name: "revenue" }).click();
  expect(logs.filter((l) => l.includes("Fatal"))).toEqual([]);

  await page.goto("/analytics");
  await expect(page.getByText("Spend by day, by agent")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "test-results/buyer-analytics.png", fullPage: true });
  await page.getByRole("tab", { name: "spend guard" }).click();
  await expect(page.getByText("Decision log")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "test-results/buyer-guard.png", fullPage: true });
  // Dark mode: Studio switches to the dark look with the app.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/selling/analytics");
  await expect(page.getByText("Revenue by day, by money state")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "test-results/seller-analytics-dark.png", fullPage: true });
  // No console errors on either dashboard (the trial-license banner used to be 7 of them).
  expect(logs.filter((l) => l.startsWith("[error]") || l.startsWith("[pageerror]"))).toEqual([]);
});
