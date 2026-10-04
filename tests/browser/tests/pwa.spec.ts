import { devices, expect, test } from "@playwright/test";
import { generateAgentKeyPair, newId } from "@tab402/core";
import { schema as s } from "@tab402/db";
import { eq } from "drizzle-orm";
import { close, db, signUp } from "./helpers";

test.afterAll(close);

test("installable: manifest, icons and a service worker that controls the app", async ({
  page,
  request,
}) => {
  const manifest = (await (await request.get("/manifest.webmanifest")).json()) as {
    display: string;
    start_url: string;
    icons: { src: string; sizes: string; purpose: string }[];
  };
  expect(manifest).toMatchObject({ display: "standalone", start_url: "/" });
  expect(manifest.icons.map((i) => `${i.sizes}/${i.purpose}`)).toEqual([
    "192x192/any",
    "512x512/any",
    "512x512/maskable",
  ]);
  for (const icon of [
    ...manifest.icons.map((i) => i.src),
    "/icons/apple-touch-180.png",
    "/icons/badge-96.png",
  ]) {
    const res = await request.get(icon);
    expect(res.headers()["content-type"], icon).toBe("image/png");
  }
  const sw = await request.get("/serwist/sw.js");
  expect(sw.headers()["service-worker-allowed"]).toBe("/");
  expect(await sw.text()).toContain("pushsubscriptionchange");

  await page.goto("/sign-in");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    "/icons/apple-touch-180.png",
  );
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toBe("http://localhost:3300/");
});

test("offline: pages fall back to the offline screen; money is never served from cache", async ({
  page,
  context,
}) => {
  await signUp(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload(); // now controlled by the service worker
  await context.setOffline(true);
  await page.goto("/receipts").catch(() => {});
  await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
  await context.setOffline(false);
  await page.goto("/receipts");
  await expect(page.getByRole("heading", { name: "Receipts" })).toBeVisible();
});

test("push subscriptions: saved per user, listed, removable; only real push services accepted (SSRF)", async ({
  page,
}) => {
  const { userId } = await signUp(page);
  const keys = {
    p256dh:
      "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
    auth: "tBHItJI5svbpez7KI4CCXg",
  };
  const post = (endpoint: string) =>
    page.request.post("/api/push/subscriptions", { data: { subscription: { endpoint, keys } } });
  expect((await post("https://169.254.169.254/latest/meta-data")).status()).toBe(400);
  expect((await post("http://fcm.googleapis.com/fcm/send/x")).status()).toBe(400);
  expect((await post("https://fcm.googleapis.com/fcm/send/pw-device")).status()).toBe(200);

  await page.goto("/security");
  const list = page.getByRole("list", { name: "Devices with notifications" });
  await expect(list).toContainText("Chrome");
  await list.getByRole("button", { name: "Remove" }).click();
  await expect(list).toBeHidden();
  expect(
    await db.select().from(s.pushSubscriptions).where(eq(s.pushSubscriptions.userId, userId)),
  ).toEqual([]);
});

// iPhone viewport, touch and user agent, still on Chromium (WebKit isn't installed here).
const { defaultBrowserType: _webkit, ...iphone } = devices["iPhone 13"];

test.describe("on a phone", () => {
  test.use(iphone);

  test("card lists instead of wide tables, a light analytics summary, and big approve buttons", async ({
    page,
  }) => {
    const { buyerId, userId } = await signUp(page, "Pat Mobile");
    const sellerId = newId("seller");
    await db.insert(s.sellers).values({ id: sellerId, userId, name: "PixelForge Images" });
    const endpointId = newId("endpoint");
    await db.insert(s.endpoints).values({
      id: endpointId,
      sellerId,
      method: "POST",
      url: "https://pixelforge.example/v1/images",
      pricingMode: "fixed",
      priceMicros: 40_000,
    });
    const agentId = newId("agent");
    await db.insert(s.agents).values({ id: agentId, buyerId, name: "Claude Code" });
    const keyId = newId("agentKey");
    await db
      .insert(s.agentKeys)
      .values({ id: keyId, agentId, buyerId, publicJwk: (await generateAgentKeyPair()).publicJwk });
    const channelId = newId("channel");
    await db
      .insert(s.channels)
      .values({ id: channelId, agentKeyId: keyId, sellerId, cumulativeAuthorizedMicros: 1e9 });
    const quoteId = newId("quote");
    await db.insert(s.quotes).values({
      id: quoteId,
      endpointId,
      sellerId,
      amountMicros: 40_000,
      pricingMode: "fixed",
      status: "paid",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const voucherId = newId("voucher");
    await db.insert(s.vouchers).values({
      id: voucherId,
      channelId,
      seq: 1,
      cumulativeMicros: 40_000,
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
      amountMicros: 40_000,
      authorizedMicros: 40_000,
      intent: "cover image for the Q3 deck",
    });
    const approvalId = newId("approval");
    await db.insert(s.approvals).values({
      id: approvalId,
      buyerId,
      agentKeyId: keyId,
      sellerId,
      endpointId,
      amountMicros: 2_500_000,
      intent: "storyboard",
      reason: "over threshold",
      expiresAt: new Date(Date.now() + 900_000),
    });

    for (const path of [
      "/",
      "/receipts",
      "/approvals",
      "/selling",
      "/analytics",
      "/selling/analytics",
      `/approve/${approvalId}`,
    ]) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(0);
    }

    await page.goto("/receipts");
    const cards = page.getByRole("list", { name: "Purchases" });
    await expect(cards).toContainText("PixelForge Images");
    await expect(cards).toContainText("$0.04");
    await expect(cards).toContainText("cover image for the Q3 deck");
    await expect(page.locator("table")).toBeHidden();

    await page.goto("/analytics");
    await expect(page.getByText("Spend, last 7 days")).toBeVisible();
    await expect(
      page.getByText("Open on a larger screen for the full AG Studio dashboard."),
    ).toBeVisible();
    await page.goto("/selling/analytics");
    await expect(page.getByText("Revenue, last 7 days")).toBeVisible();
    await expect(page.getByText("By endpoint")).toBeVisible();

    await page.goto(`/approve/${approvalId}`);
    for (const name of ["Approve with passkey", "Decline"]) {
      const box = await page.getByRole("button", { name }).boundingBox();
      expect(box?.height, name).toBeGreaterThanOrEqual(44); // Apple's minimum touch target
    }
  });

  test("iPhone Safari outside the home screen is told to add Tab402 first (iOS 16.4+)", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      // iOS Safari tabs expose no PushManager; only home-screen apps do.
      // biome-ignore lint/suspicious/noExplicitAny: test shim
      delete (window as any).PushManager;
    });
    await signUp(page);
    await page.goto("/security");
    await expect(page.getByText("Share → Add to Home Screen")).toBeVisible();
  });
});
