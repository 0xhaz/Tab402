import { queueNotification } from "@tab402/db";
import { deliverNotifications, vapidFromEnv, WebPushSender } from "@tab402/notify";
import { db, getSession } from "@/lib/server";

/** Send a test notification to the signed-in user's devices right now (no worker needed). */
export async function POST() {
  const session = await getSession();
  if (!session) return Response.json({ error: "sign in first" }, { status: 401 });
  const vapid = vapidFromEnv();
  if (!vapid)
    return Response.json({ error: "push is not configured on this server" }, { status: 503 });
  const id = await queueNotification(
    db,
    { userId: session.user.id },
    {
      kind: "test",
      title: "Tab402 notifications are on",
      body: "Approvals from your agents will show up here.",
      url: "/approvals",
      tag: `test-${session.user.id}`,
      ttlSeconds: 300,
    },
  );
  const r = await deliverNotifications(db, new WebPushSender(vapid), { ids: id ? [id] : [] });
  return Response.json({ devices: r.devices });
}
