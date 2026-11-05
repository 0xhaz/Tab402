import { type CDPSession, expect, type Page, test } from "@playwright/test";
import { generateAgentKeyPair, newId } from "@tab402/core";
import { schema as s } from "@tab402/db";
import { declineToken } from "@tab402/notify";
import { eq } from "drizzle-orm";
import { close, db, signUp } from "./helpers";

test.afterAll(close);

/** Chrome's virtual authenticator: a platform passkey that does user verification (like Touch ID). */
async function virtualAuthenticator(
  page: Page,
): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

/** A pending purchase from one of this buyer's agents, as the spend guard would create it. */
async function pendingApproval(buyerId: string, amountMicros = 2_500_000) {
  const sellerId = newId("seller");
  await db.insert(s.sellers).values({ id: sellerId, name: "PixelForge" });
  const endpointId = newId("endpoint");
  await db.insert(s.endpoints).values({
    id: endpointId,
    sellerId,
    method: "POST",
    url: "https://pixelforge.example/v1/images",
    pricingMode: "fixed",
    priceMicros: amountMicros,
    description: "Generate 4K images",
  });
  const agentId = newId("agent");
  await db.insert(s.agents).values({ id: agentId, buyerId, name: "Claude Code" });
  const keyId = newId("agentKey");
  await db
    .insert(s.agentKeys)
    .values({ id: keyId, agentId, buyerId, publicJwk: (await generateAgentKeyPair()).publicJwk });
  const id = newId("approval");
  await db.insert(s.approvals).values({
    id,
    buyerId,
    agentKeyId: keyId,
    sellerId,
    endpointId,
    amountMicros,
    intent: "make a cover image for the Q3 report",
    reason: "$2.50 is above the approval threshold $2.00",
    expiresAt: new Date(Date.now() + 15 * 60_000),
  });
  return id;
}

const status = async (id: string) =>
  (
    await db.select({ status: s.approvals.status }).from(s.approvals).where(eq(s.approvals.id, id))
  )[0]?.status;

test("buyer adds a passkey, then approves an agent's purchase with it", async ({ page }) => {
  await virtualAuthenticator(page);
  const { buyerId } = await signUp(page);

  await page.goto("/security");
  await expect(page.getByText("No passkeys yet.")).toBeVisible();
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByText("Passkey added")).toBeVisible();
  await expect(page.getByText("No passkeys yet.")).toBeHidden();

  const id = await pendingApproval(buyerId);
  await page.goto("/approvals");
  await expect(page.getByText("Claude Code → PixelForge")).toBeVisible();
  await page.getByText("Claude Code → PixelForge").click();

  await expect(page.getByText("$2.50")).toBeVisible();
  await expect(page.getByText("make a cover image for the Q3 report")).toBeVisible();
  await page.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(page.getByText("Approved. Your agent can complete the purchase now")).toBeVisible();
  expect(await status(id)).toBe("approved");
});

test("first approval without a passkey offers to add one, then approves", async ({ page }) => {
  await virtualAuthenticator(page);
  const { buyerId } = await signUp(page);
  const id = await pendingApproval(buyerId);
  await page.goto(`/approve/${id}`);
  await page.getByRole("button", { name: "Approve with passkey" }).click();
  await page.getByRole("button", { name: "Add a passkey and approve" }).click();
  await expect(page.getByText("Approved. Your agent can complete the purchase now")).toBeVisible();
  expect(await status(id)).toBe("approved");
});

test("declining needs no passkey and charges nothing", async ({ page }) => {
  const { buyerId } = await signUp(page);
  const id = await pendingApproval(buyerId);
  await page.goto(`/approve/${id}`);
  await page.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByText("Declined. Nothing was charged.")).toBeVisible();
  expect(await status(id)).toBe("denied");
});

test("a passkey that skips user verification (no Face ID / fingerprint) can't approve", async ({
  page,
}) => {
  const { cdp, authenticatorId } = await virtualAuthenticator(page);
  const { buyerId } = await signUp(page);
  await page.goto("/security");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByText("Passkey added")).toBeVisible();

  // Same registered credential; the device now answers without verifying the user.
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
  const id = await pendingApproval(buyerId);
  await page.goto(`/approve/${id}`);
  await page.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(page.getByText(/Passkey check (failed|was cancelled)/)).toBeVisible();
  expect(await status(id)).toBe("pending");
});

test("someone else's approval is not visible", async ({ page }) => {
  const other = await signUp(page);
  const id = await pendingApproval(other.buyerId);
  await page.context().clearCookies();
  await signUp(page);
  const res = await page.goto(`/approve/${id}`);
  expect(res?.status()).toBe(404);
});

test("buyer turns on approval emails, and Save says so", async ({ page }) => {
  const { buyerId } = await signUp(page);
  await page.goto("/security");
  await page.getByRole("switch", { name: "Email me approval requests" }).click();
  await expect(page.getByText(/Approval requests will be emailed to/)).toBeVisible();
  await page.getByLabel("Send them to").fill("pat.buyer@gmail.example");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByText("Approval requests will be emailed to pat.buyer@gmail.example."),
  ).toBeVisible();
  const email = async () =>
    (await db.select().from(s.buyers).where(eq(s.buyers.id, buyerId)))[0]?.approvalEmail;
  expect(await email()).toBe("pat.buyer@gmail.example");

  await page.getByRole("switch", { name: "Email me approval requests" }).click();
  await expect(page.getByText("Approval emails are off.")).toBeVisible();
  expect(await email()).toBeNull();
});

test("the emailed Decline link works signed out, but only after a click", async ({
  page,
  browser,
}) => {
  const { buyerId } = await signUp(page);
  const id = await pendingApproval(buyerId);
  const secret = process.env.BETTER_AUTH_SECRET as string;

  const inbox = await browser.newPage(); // no session, like a phone's mail app
  await inbox.goto(`/decline/${id}?t=wrong`);
  await expect(inbox.getByText("This link isn't valid.")).toBeVisible();
  expect(await status(id)).toBe("pending");

  await inbox.goto(`/decline/${id}?t=${declineToken(secret, id)}`);
  await expect(inbox.getByText("$2.50")).toBeVisible();
  expect(await status(id)).toBe("pending"); // opening the link (or a mail scanner) does nothing
  await inbox.getByRole("button", { name: "Decline this purchase" }).click();
  await expect(inbox.getByText("Declined. Nothing was charged")).toBeVisible();
  expect(await status(id)).toBe("denied");
  await inbox.close();
});
