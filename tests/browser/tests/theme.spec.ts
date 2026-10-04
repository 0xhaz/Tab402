import { expect, type Page, test } from "@playwright/test";
import { close, signUp } from "./helpers";

test.afterAll(close);

const theme = (page: Page) => page.evaluate(() => document.documentElement.className);

async function pick(page: Page, name: "Light" | "Dark" | "System") {
  await page.getByRole("button", { name: "Theme" }).first().click();
  await page.getByRole("menuitemradio", { name }).click();
}

test("visitors pick light or dark (or follow the system); the choice sticks", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  expect(await theme(page)).toContain("dark"); // follows the system by default

  await pick(page, "Light");
  expect(await theme(page)).toContain("light");
  await page.reload();
  expect(await theme(page)).toContain("light");
  await page.screenshot({ path: "test-results/landing-light.png", fullPage: true });

  await pick(page, "Dark");
  expect(await theme(page)).toContain("dark");
  await page.screenshot({ path: "test-results/landing-dark.png", fullPage: true });

  await pick(page, "System");
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => theme(page)).toContain("light");
});

test("signed-in pages have the toggle in the sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signUp(page);
  await pick(page, "Dark");
  expect(await theme(page)).toContain("dark");
  await page.goto("/receipts");
  expect(await theme(page)).toContain("dark");
  await page.screenshot({ path: "test-results/app-dark.png" });
});
