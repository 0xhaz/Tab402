import { expect, test } from "@playwright/test";
import { schema as s } from "@tab402/db";
import { eq } from "drizzle-orm";
import { close, db, signUp } from "./helpers";

test.afterAll(close);

test("the agent playground runs MCP tools from buttons, without leaving a usable key behind", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { buyerId } = await signUp(page, "Play Ground");
  await page.goto("/playground");
  await expect(page.getByText("Connected · 7 tools")).toBeVisible();
  for (const tool of ["search_services", "call_paid", "get_budget", "request_approval"])
    await expect(page.getByText(tool, { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: /Check my budget/ }).click();
  const activity = page.locator("article");
  await expect(activity.first()).toContainText("get_budget");
  await expect(activity.first()).toContainText("$10.00");

  await page.getByRole("button", { name: /Find a summarizer/ }).click();
  await expect(activity).toHaveCount(2);
  await expect(activity.first()).toContainText("search_services");
  // The summarize step targets the runnable demo seller, not a look-alike route.
  await expect(page.getByRole("button", { name: /Summarize the note/ })).toContainText(
    "localhost:4200/v1/summarize",
  );

  // Any tool, with hand-written JSON.
  await page.getByLabel("Tool").selectOption("list_receipts");
  await expect(page.getByLabel("Arguments (JSON)")).toHaveValue(/"period": "today"/);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(activity).toHaveCount(3);
  await expect(activity.first()).toContainText("list_receipts");

  // The "ask me first" switch is the approval threshold.
  await page.getByRole("switch", { name: "Ask me before every purchase" }).click();
  await expect(page.getByText("Approval threshold $0.005")).toBeVisible();
  await expect
    .poll(async () => {
      const p = await db.query.policies.findFirst({ where: (p, { eq }) => eq(p.buyerId, buyerId) });
      return p?.approvalThresholdMicros;
    })
    .toBe(5_000);

  // An approval message names the seller URL too; the button must open the approval page.
  await page.getByLabel("Tool").selectOption("request_approval");
  await expect(page.getByLabel("Arguments (JSON)")).toHaveValue(/localhost:4200\/v1\/summarize/);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(activity).toHaveCount(4);
  await expect(activity.first()).toContainText("Needs the buyer's approval");
  const approve = page.getByRole("link", { name: /Open approval page/ });
  await expect(approve).toHaveAttribute("href", /\/approve\/apr_\w+$/);

  // Calls ran as the "Playground" agent, and every key minted for them is already revoked.
  const keys = await db.select().from(s.apiKeys).where(eq(s.apiKeys.ownerId, buyerId));
  expect(keys.length).toBeGreaterThan(0);
  expect(keys.every((k) => k.revokedAt)).toBe(true);
  const agent = await db.query.agents.findFirst({ where: (a, { eq }) => eq(a.buyerId, buyerId) });
  expect(agent?.name).toBe("Playground");
  await page.screenshot({ path: "test-results/playground.png", fullPage: true });
});
