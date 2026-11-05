import { schema as s } from "@tab402/db";
import { eq } from "drizzle-orm";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db, requireBuyer } from "@/lib/server";
import { EmailSettings } from "./email-settings";
import { PasskeyList } from "./passkeys";
import { PushSettings } from "./push-settings";

export const metadata = { title: "Security" };

export default async function SecurityPage() {
  const { user, buyer } = await requireBuyer("/security");
  const [keys, devices] = await Promise.all([
    db.select().from(s.passkey).where(eq(s.passkey.userId, user.id)),
    db.select().from(s.pushSubscriptions).where(eq(s.pushSubscriptions.userId, user.id)),
  ]);
  return (
    <>
      <PageHeader title="Security & alerts" />
      <Card>
        <CardHeader>
          <CardTitle>Passkeys</CardTitle>
          <CardDescription>
            Used to sign in and to confirm purchases your agents can't make on their own.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PasskeyList
            keys={keys.map((k) => ({
              id: k.id,
              name: k.name ?? "Passkey",
              createdAt: k.createdAt?.toISOString() ?? null,
              deviceType: k.deviceType,
            }))}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Notifications</CardTitle>
          <CardDescription>
            Get a push when an agent needs your OK, a payout lands, or a PayPal charge fails — then
            approve with your passkey right from the notification.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PushSettings
            vapidPublicKey={process.env.VAPID_PUBLIC_KEY ?? null}
            devices={devices.map((d) => ({
              id: d.id,
              label: deviceLabel(d.userAgent, d.endpoint),
              createdAt: d.createdAt.toISOString(),
              lastSuccessAt: d.lastSuccessAt?.toISOString() ?? null,
            }))}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Email</CardTitle>
          <CardDescription>
            Get approval requests by email too, for when push isn't set up on a device.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EmailSettings current={buyer.approvalEmail} accountEmail={user.email} />
        </CardContent>
      </Card>
    </>
  );
}

/** "Chrome on Android" from a user agent, falling back to the push service. */
function deviceLabel(ua: string | null, endpoint: string): string {
  const u = ua ?? "";
  const browser = /Edg\//.test(u)
    ? "Edge"
    : /Firefox\//.test(u)
      ? "Firefox"
      : /Chrome\//.test(u)
        ? "Chrome"
        : /Safari\//.test(u)
          ? "Safari"
          : null;
  const os = /iPhone|iPad/.test(u)
    ? "iOS"
    : /Android/.test(u)
      ? "Android"
      : /Mac OS X/.test(u)
        ? "macOS"
        : /Windows/.test(u)
          ? "Windows"
          : /Linux/.test(u)
            ? "Linux"
            : null;
  if (browser || os) return [browser, os].filter(Boolean).join(" on ");
  return new URL(endpoint).hostname;
}
