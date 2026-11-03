import { devices, expect, test } from "@playwright/test";
import { close, signUp } from "./helpers";

test.afterAll(close);

test("signed-out visitors land on the PayPal-first landing page at /; signed-in users get their dashboard", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page).toHaveURL("http://localhost:3300/");
  await expect(page).toHaveTitle("Tab402: pay-per-call for AI agents, settled on PayPal");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Let AI agents pay for APIs by the cent, settled on PayPal.",
  );
  // No dashes left in the visible copy.
  expect(await page.locator("main").innerText()).not.toMatch(/[\u2013\u2014]/);

  // Per-call charging vs. a tab, driven by the slider.
  const compare = page.getByRole("figure", {
    name: "Charging per call compared with a Tab402 tab",
  });
  const perCall = compare.getByRole("region", { name: "Charge every call" });
  const tab = compare.getByRole("region", { name: "Tab402" });
  await expect(perCall.getByText("$147.10")).toBeVisible();
  await expect(tab.getByText("$0.59")).toBeVisible();
  await compare.screenshot({ path: "test-results/landing-compare.png" });
  await compare.getByRole("slider").fill("3000");
  await expect(compare.getByText("3,000 calls at 1¢")).toBeVisible();
  await expect(perCall.getByText("$1,471.05")).toBeVisible();
  await expect(tab.getByText("$2.52")).toBeVisible(); // three $10 tabs at $0.839 each
  await expect(compare.getByText("1 dot = 10 calls").first()).toBeVisible();

  // The diagram names the PayPal API behind every arrow.
  const diagram = page.getByRole("figure", { name: "Tab402 payment flow" });
  for (const api of ["Vault API v3", "Orders API v2 + vault_id", "Payouts API"])
    await expect(diagram.getByText(api)).toBeVisible();

  // Product family: five live, one sandbox-tested, the rest planned. Hover shows details.
  const products = page.locator("#paypal article");
  await expect(products).toHaveCount(12);
  await expect(products.filter({ hasText: "Live in Tab402" })).toHaveCount(5);
  await expect(products.filter({ hasText: "Tested in sandbox" })).toHaveCount(1);
  const details = page.getByRole("complementary", { name: "Product details" });
  await expect(details.getByRole("heading", { name: "PayPal JS SDK v6" })).toBeVisible();
  await products.filter({ hasText: "Payouts" }).first().hover();
  await expect(details.getByRole("heading", { name: "Payouts" })).toBeVisible();
  await expect(details.getByText("/v1/payments/payouts")).toBeVisible();
  // The status filter dims the other products.
  await page
    .getByRole("group", { name: "Filter by status" })
    .getByRole("button", { name: /Planned/ })
    .click();
  await expect(products.filter({ hasText: "Orders API v2" })).toHaveClass(/opacity-35/);
  await expect(products.filter({ hasText: "Venmo" })).not.toHaveClass(/opacity-35/);
  await page
    .getByRole("group", { name: "Filter by status" })
    .getByRole("button", { name: /Planned/ })
    .click();

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
    // Tapping a product expands it in place.
    const venmo = page.locator("#paypal article").filter({ hasText: "Venmo" });
    await venmo.getByRole("button").click();
    await expect(venmo.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    await expect(venmo.getByText("same funding adapter")).toBeVisible();
    await page.screenshot({ path: "test-results/landing-mobile.png", fullPage: true });
    await page
      .getByRole("figure", { name: "Charging per call compared with a Tab402 tab" })
      .screenshot({ path: "test-results/landing-mobile-compare.png" });
    await page
      .getByRole("figure", { name: "Tab402 payment flow" })
      .screenshot({ path: "test-results/landing-mobile-diagram.png" });
    await page.screenshot({ path: "test-results/landing-mobile-hero.png" });
  });
});
