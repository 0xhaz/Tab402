import { expect, type Page, test } from "@playwright/test";
import { newId } from "@tab402/core";
import { schema as s } from "@tab402/db";
import { eq } from "drizzle-orm";
import { close, db, signUp } from "./helpers";

test.afterAll(close);

const SPEC = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Pixel Search", version: "1" },
  servers: [{ url: "https://pixel.example.com" }],
  paths: {
    "/health": { get: { summary: "Health check" } },
    "/v1/find": { post: { summary: "Search stock photos" } },
    "/v1/render": {
      post: {
        summary: "Render an image",
        responses: { "200": { content: { "image/png": {} } } },
      },
    },
  },
});

async function becomeSeller(page: Page, name = "Sam Seller") {
  const { userId, buyerId } = await signUp(page, name);
  const sellerId = newId("seller");
  await db.insert(s.sellers).values({ id: sellerId, userId, name: `Pixel ${sellerId.slice(-6)}` });
  return { sellerId, buyerId, userId };
}

test("seller pastes an OpenAPI spec, reviews proposed prices, confirms, and is listed in the directory", async ({
  page,
  browser,
}) => {
  const { sellerId } = await becomeSeller(page);
  await page.goto("/selling");
  await page.getByRole("link", { name: "Add from OpenAPI" }).click();
  await page.getByLabel("OpenAPI spec").fill(SPEC);
  await page.getByRole("button", { name: "Propose prices" }).click();

  // Proposals: health stays free; search and media are priced from the category defaults.
  await expect(page.getByText("Pixel Search")).toBeVisible();
  await expect(page.getByLabel("Charge for GET /health")).not.toBeChecked();
  await expect(page.getByLabel("Charge for POST /v1/find")).toBeChecked();
  await expect(page.getByLabel("Category for POST /v1/find")).toHaveValue("search");
  await expect(page.getByLabel("Price for POST /v1/find")).toHaveValue("0.01");
  await expect(page.getByLabel("Category for POST /v1/render")).toHaveValue("media");
  await expect(page.getByLabel("Public base URL of your API")).toHaveValue(
    "https://pixel.example.com",
  );

  // The seller changes one price and confirms.
  await page.getByLabel("Price for POST /v1/find").fill("0.015");
  await page.getByRole("button", { name: "Confirm 2 routes" }).click();
  await expect(page.getByText("You're priced")).toBeVisible();
  await expect(page.locator("pre")).toContainText(
    '"POST /v1/find": { pricing: "fixed", price: 15_000',
  );
  await page.getByRole("tab", { name: "/.well-known/x402" }).click();
  await expect(page.locator("pre")).toContainText('"kind": "resource-server"');

  const endpoints = await db.select().from(s.endpoints).where(eq(s.endpoints.sellerId, sellerId));
  expect(endpoints.map((e) => [e.method, e.url, e.priceMicros, e.category]).sort()).toEqual([
    ["POST", "https://pixel.example.com/v1/find", 15_000, "search"],
    ["POST", "https://pixel.example.com/v1/render", 40_000, "media"],
  ]);
  const decision = await db.query.aiDecisions.findFirst({
    where: (d, { and, eq, sql }) =>
      and(eq(d.agentKind, "onboarding"), sql`${d.subjectIds}->>'sellerId' = ${sellerId}`),
  });
  expect(decision?.humanOverride).toBe("POST /v1/find: 10000 → 15000");

  // Public directory: no sign-in needed.
  const anon = await browser.newContext();
  const visitor = await anon.newPage();
  await visitor.goto(`/directory?q=${encodeURIComponent("stock photos")}`);
  await expect(visitor.getByText("Search stock photos").first()).toBeVisible();
  await expect(visitor.getByText("$0.015").first()).toBeVisible();
  await anon.close();
});

test("a bad spec gets a clear error and nothing is created", async ({ page }) => {
  const { sellerId } = await becomeSeller(page);
  await page.goto("/selling/onboard");
  await page.getByLabel("OpenAPI spec").fill("title: not an api");
  await page.getByRole("button", { name: "Propose prices" }).click();
  await expect(page.getByText("Not an OpenAPI 3.0/3.1 or Swagger 2.0 document.")).toBeVisible();
  expect(await db.select().from(s.endpoints).where(eq(s.endpoints.sellerId, sellerId))).toEqual([]);
});

test("seller sees webhook deliveries and can retry a failed one", async ({ page }) => {
  const { sellerId } = await becomeSeller(page);
  await db
    .update(s.sellers)
    .set({ webhookUrl: "https://hooks.example.com/tab402" })
    .where(eq(s.sellers.id, sellerId));
  const failed = newId("eventOut");
  await db.insert(s.eventsOut).values([
    {
      id: newId("eventOut"),
      sellerId,
      type: "charge.succeeded",
      payload: {},
      deliveryStatus: "delivered",
      attempts: 1,
    },
    {
      id: failed,
      sellerId,
      type: "payout.paid",
      payload: {},
      deliveryStatus: "failed",
      attempts: 9,
      lastError: "HTTP 500",
    },
  ]);
  await page.goto("/selling");
  await page.getByRole("link", { name: "Webhooks" }).click();
  await expect(page.getByText("https://hooks.example.com/tab402")).toBeVisible();
  await expect(page.getByText("HTTP 500", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry now" }).click();
  await expect(
    page.getByText("Queued — the next delivery attempt is within a minute."),
  ).toBeVisible();
  const [row] = await db.select().from(s.eventsOut).where(eq(s.eventsOut.id, failed));
  expect(row?.deliveryStatus).toBe("pending");
});

test("re-running onboarding on a live API lists the changes and asks before updating", async ({
  page,
}) => {
  const { sellerId } = await becomeSeller(page, "Lee Live");
  const run = async (price: string) => {
    await page.goto("/selling/onboard");
    await page.getByLabel("OpenAPI spec").fill(SPEC);
    await page.getByRole("button", { name: "Propose prices" }).click();
    await page.getByLabel("Charge for POST /v1/render").click(); // leave only /v1/find
    await page.getByLabel("Price for POST /v1/find").fill(price);
  };

  await run("0.01");
  await page.getByRole("button", { name: "Confirm 1 route" }).click();
  await expect(page.getByText("You're priced")).toBeVisible();

  // Same base URL, new price: nothing changes until the seller says so.
  await run("0.02");
  await page.getByRole("button", { name: "Confirm 1 route" }).click();
  await expect(page.getByText("These routes are already live")).toBeVisible();
  await expect(page.getByText("POST /v1/find: $0.01 → $0.02")).toBeVisible();
  const price = async () =>
    (await db.select().from(s.endpoints).where(eq(s.endpoints.sellerId, sellerId))).map(
      (e) => e.priceMicros,
    );
  expect(await price()).toEqual([10_000]);

  await page.getByRole("button", { name: "Update live routes" }).click();
  await expect(page.getByText("You're priced")).toBeVisible();
  expect(await price()).toEqual([20_000]);
});
