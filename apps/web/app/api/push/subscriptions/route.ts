import { newId } from "@tab402/core";
import { schema as s } from "@tab402/db";
import { isAllowedPushEndpoint } from "@tab402/notify";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, getSession } from "@/lib/server";

const b64url = z
  .string()
  .regex(/^[A-Za-z0-9_-]+={0,2}$/)
  .max(200);
const Body = z.object({
  subscription: z.object({
    endpoint: z.string().max(1000),
    keys: z.object({ p256dh: b64url, auth: b64url }),
  }),
  /** A rotated subscription's old endpoint (from the service worker's pushsubscriptionchange). */
  replaces: z.string().max(1000).optional(),
});

/** Test-only extra push hosts (never set in production). */
const extraHosts = () => process.env.TAB402_PUSH_TEST_HOSTS?.split(",").filter(Boolean) ?? [];

/** Save this device's push subscription for the signed-in user (from the settings page or the SW). */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "sign in first" }, { status: 401 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad subscription" }, { status: 400 });
  const { subscription, replaces } = parsed.data;
  if (!isAllowedPushEndpoint(subscription.endpoint, extraHosts()))
    return Response.json({ error: "unsupported push service" }, { status: 400 });

  const userId = session.user.id;
  // One row per endpoint: a device that switches accounts moves to the new user.
  await db
    .insert(s.pushSubscriptions)
    .values({
      id: newId("pushSubscription"),
      userId,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
    })
    .onConflictDoUpdate({
      target: s.pushSubscriptions.endpoint,
      set: {
        userId,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        failureCount: 0,
        createdAt: sql`now()`,
      },
    });
  if (replaces && replaces !== subscription.endpoint)
    await db
      .delete(s.pushSubscriptions)
      .where(
        and(eq(s.pushSubscriptions.endpoint, replaces), eq(s.pushSubscriptions.userId, userId)),
      );
  return Response.json({ ok: true });
}

/** Forget a device: `{ endpoint }` for this device, or `{ id }` from the device list. */
export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session) return Response.json({ error: "sign in first" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { endpoint?: string; id?: string };
  const match = body.id
    ? eq(s.pushSubscriptions.id, String(body.id))
    : eq(s.pushSubscriptions.endpoint, String(body.endpoint ?? ""));
  await db
    .delete(s.pushSubscriptions)
    .where(and(match, eq(s.pushSubscriptions.userId, session.user.id)));
  return Response.json({ ok: true });
}
