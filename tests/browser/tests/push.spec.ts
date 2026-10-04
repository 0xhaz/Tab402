import { expect, test } from "@playwright/test";
import { close, signUp } from "./helpers";

// The default headless shell never grants notification permission; full Chromium (new headless) does.
test.use({ channel: "chromium" });
test.afterAll(close);

test("a push message shows a notification that links to the approval page", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["notifications"]);
  await signUp(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  const cdp = await context.newCDPSession(page);
  const registrationId = await new Promise<string>((resolve) => {
    cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
      const r = registrations.find(
        (x: { scopeURL: string }) => x.scopeURL === "http://localhost:3300/",
      );
      if (r) resolve(r.registrationId);
    });
    void cdp.send("ServiceWorker.enable");
  });
  await cdp.send("ServiceWorker.deliverPushMessage", {
    origin: "http://localhost:3300",
    registrationId,
    data: JSON.stringify({
      id: "ntf_1",
      kind: "approval.requested",
      title: "Approve $2.50 for PixelForge?",
      body: "Claude Desktop: render the storyboard",
      url: "/approve/apr_123",
      tag: "apr_123",
    }),
  });
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({
          title: n.title,
          body: n.body,
          tag: n.tag,
          url: (n.data as { url: string }).url,
          sticky: n.requireInteraction,
        })),
      ),
    )
    .toEqual([
      {
        title: "Approve $2.50 for PixelForge?",
        body: "Claude Desktop: render the storyboard",
        tag: "apr_123",
        url: "/approve/apr_123",
        sticky: true,
      },
    ]);
});
