import { devices, expect, test } from "@playwright/test";
import { close, signUp } from "./helpers";

test.afterAll(close);

test("signed-out visitors land on the PayPal-first landing page at /; signed-in users get their dashboard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page).toHaveURL("http://localhost:3300/");
  await expect(page).toHaveTitle("Tab402 — pay-per-call for AI agents, settled on PayPal");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Let AI agents pay for APIs by the cent — settled on PayPal.",
  );
  // The diagram names the PayPal API behind every arrow.
  const diagram = page.getByRole("figure", { name: "Tab402 payment flow" });
  for (const api of ["Vault API v3", "Orders API v2 + vault_id", "Payouts API"])
    await expect(diagram.getByText(api)).toBeVisible();
  // Product family: five live, one sandbox-verified, the rest next.
  const products = page.locator("#paypal article");
  await expect(products).toHaveCount(12);
  await expect(products.filter({ hasText: "Live in Tab402" })).toHaveCount(5);
  await expect(products.filter({ hasText: "Verified in sandbox" })).toHaveCount(1);
  await page.screenshot({ path: "test-results/landing-desktop.png", fullPage: true });

  await page.getByRole("link", { name: "Sell your API" }).click();
  await expect(page).toHaveURL(/\/sign-up\?callbackURL=%2Fselling/);

  await signUp(page, "Lan Ding");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Hi, Lan" })).toBeVisible();
  await page.goto("/welcome");
  await expect(page.getByRole("link", { name: "Open dashboard" }).first()).toBeVisible();
});

const { defaultBrowserType: _webkit, ...iphone } = devices["iPhone 13"];
test.describe("on a phone", () => {
  test.use(iphone);
  test("the landing page fits the screen", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    await page.screenshot({ path: "test-results/landing-mobile.png", fullPage: true });
    await page
      .getByRole("figure", { name: "Tab402 payment flow" })
      .screenshot({ path: "test-results/landing-mobile-diagram.png" });
    await page.screenshot({ path: "test-results/landing-mobile-hero.png" });
  });
});
