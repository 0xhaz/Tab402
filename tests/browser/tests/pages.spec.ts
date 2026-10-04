import { expect, test } from "@playwright/test";
import { generateAgentKeyPair, newId } from "@tab402/core";
import { hashApiKey, schema as s } from "@tab402/db";
import { eq } from "drizzle-orm";
import { close, db, signUp } from "./helpers";

test.afterAll(close);

test("wallet: PayPal JS SDK v6 save button opens PayPal sandbox with a real setup token", async ({
  page,
}) => {
  test.skip(!process.env.PAYPAL_CLIENT_ID, "PayPal sandbox credentials not configured");
  const { buyerId } = await signUp(page);
  await page.goto("/wallet");
  await expect(page.getByText("Save your PayPal wallet once")).toBeVisible();
  const button = page.locator("paypal-button");
  await expect(button).toBeVisible({ timeout: 20_000 });
  await expect(button).not.toHaveAttribute("disabled", { timeout: 20_000 }); // enabled once the SDK has loaded
  const popupPromise = page.waitForEvent("popup", { timeout: 20_000 });
  await button.click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded").catch(() => {});
  await expect.poll(() => popup.url(), { timeout: 20_000 }).toMatch(/sandbox\.paypal\.com/);
  // The SDK opens the popup first, then asks our server action for the setup token.
  await expect
    .poll(
      async () => (await db.select().from(s.mandates).where(eq(s.mandates.buyerId, buyerId)))[0],
      { timeout: 20_000 },
    )
    .toMatchObject({
      status: "pending",
      mode: "prepaid",
      rail: "paypal_wallet",
      setupToken: expect.stringMatching(/\w{10,}/),
    });
  await popup.close();
});

test("policy: buyer edits limits; the version bumps so cached guard decisions stop applying", async ({
  page,
}) => {
  const { buyerId } = await signUp(page);
  await page.goto("/policy");
  await page.getByLabel("Daily budget (USD)").fill("25");
  await page.getByLabel("Ask me above (USD)").fill("0.50");
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByText("Policy saved")).toBeVisible();
  const [p] = await db.select().from(s.policies).where(eq(s.policies.buyerId, buyerId));
  expect(p).toMatchObject({
    dailyBudgetMicros: 25_000_000,
    approvalThresholdMicros: 500_000,
    version: 2,
  });

  await page.getByLabel("Per-call max (USD)").fill("100");
  await page.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByText("Per-call max can't be above the daily budget")).toBeVisible();
});

test("selling: become a seller, get a working API key once", async ({ page }) => {
  await signUp(page, "Sam Seller");
  await page.goto("/selling");
  await page.getByLabel("Seller name").fill("Sam's Search API");
  await page.getByRole("button", { name: "Start selling" }).click();
  const key = await page.locator("input[readonly]").inputValue();
  expect(key).toMatch(/^t402_sk_/);
  await page.getByRole("button", { name: "Done — I've copied it" }).click();
  // Stored hashed, owned by the new seller (the API authenticates it the same way).
  const [stored] = await db
    .select()
    .from(s.apiKeys)
    .where(eq(s.apiKeys.hash, hashApiKey(key)));
  expect(stored).toMatchObject({ ownerType: "seller", revokedAt: null });
  await expect(page.getByRole("heading", { name: "Sam's Search API" })).toBeVisible();
  await expect(page.locator("input[readonly]")).toHaveCount(0); // shown once only
});

test("agents: revoking a key revokes its sub-budgets too", async ({ page }) => {
  const { buyerId } = await signUp(page);
  const agentId = newId("agent");
  await db.insert(s.agents).values({ id: agentId, buyerId, name: "Research bot" });
  const parent = newId("agentKey");
  const child = newId("agentKey");
  await db
    .insert(s.agentKeys)
    .values({ id: parent, agentId, buyerId, publicJwk: (await generateAgentKeyPair()).publicJwk });
  await db.insert(s.agentKeys).values({
    id: child,
    agentId,
    buyerId,
    parentKeyId: parent,
    budgetCapMicros: 500_000,
    publicJwk: (await generateAgentKeyPair()).publicJwk,
  });
  await page.goto("/agents");
  await expect(page.getByText("Research bot")).toBeVisible();
  await expect(page.getByText(child)).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Revoke" }).click();
  await expect
    .poll(async () =>
      (
        await db
          .select({ st: s.agentKeys.status })
          .from(s.agentKeys)
          .where(eq(s.agentKeys.agentId, agentId))
      )
        .map((r) => r.st)
        .sort(),
    )
    .toEqual(["revoked", "revoked"]);
});

test("signed-out visitors are sent to sign-in and back", async ({ page }) => {
  await page.goto("/policy");
  await expect(page).toHaveURL(/\/sign-in\?callbackURL=%2Fpolicy/);
});
