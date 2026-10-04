import { schema as s } from "@tab402/db";
import { eq } from "drizzle-orm";
import { Brand } from "@/components/brand";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db, requireBuyer } from "@/lib/server";
import { ConsentButtons } from "./consent-buttons";

export const metadata = { title: "Connect an agent" };

const SCOPES: Record<string, string> = {
  "tab402:pay": "Pay for API calls on your tab, within your budget and spending policy",
  openid: "Know who you are",
  profile: "See your name",
  email: "See your email address",
  offline_access: "Stay connected until you disconnect it",
};

/** OAuth consent for MCP clients (Claude, Cursor, …) connecting to the Tab402 buyer MCP server. */
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const q = await searchParams;
  await requireBuyer(`/consent?${new URLSearchParams(q as Record<string, string>).toString()}`);
  const client = q.client_id
    ? (await db.select().from(s.oauthClient).where(eq(s.oauthClient.clientId, q.client_id)))[0]
    : undefined;
  const scopes = (q.scope ?? "").split(" ").filter(Boolean);
  const name = client?.name ?? q.client_id ?? "An application";

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-10">
      <Brand />
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{name} wants to use your Tab402 wallet</CardTitle>
          <CardDescription>It will be able to:</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
            {scopes.map((sc) => (
              <li key={sc}>{SCOPES[sc] ?? sc}</li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            It can never raise your limits. Purchases above your approval threshold still ask you
            first. Disconnect any time by revoking its key under Agents.
          </p>
          <ConsentButtons />
        </CardContent>
      </Card>
    </main>
  );
}
