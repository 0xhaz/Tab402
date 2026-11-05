import { formatUsd } from "@tab402/core";
import { schema as s } from "@tab402/db";
import { verifyDeclineToken } from "@tab402/notify";
import { eq } from "drizzle-orm";
import { CheckCircle2, XCircle } from "lucide-react";
import Link from "next/link";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/lib/server";
import { declineFromEmail } from "./actions";

export const metadata = { title: "Decline a purchase" };

/**
 * The Decline link in an approval email. It needs no sign-in, but it only declines after a click:
 * mail scanners open links, and a GET that declined would cancel requests nobody read.
 */
export default async function DeclinePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string; done?: string }>;
}) {
  const { id } = await params;
  const { t = "", done } = await searchParams;
  const secret = process.env.BETTER_AUTH_SECRET;
  const valid = !!secret && verifyDeclineToken(secret, id, t);
  const [row] = valid
    ? await db
        .select({ approval: s.approvals, seller: s.sellers.name, agent: s.agents.name })
        .from(s.approvals)
        .innerJoin(s.sellers, eq(s.sellers.id, s.approvals.sellerId))
        .innerJoin(s.agentKeys, eq(s.agentKeys.id, s.approvals.agentKeyId))
        .innerJoin(s.agents, eq(s.agents.id, s.agentKeys.agentId))
        .where(eq(s.approvals.id, id))
    : [];
  const a = row?.approval;
  const expired = a?.status === "expired" || (a?.status === "pending" && a.expiresAt <= new Date());

  let body: React.ReactNode;
  if (!a)
    body = <Status ok={false}>This link isn't valid. Open Tab402 to see your requests.</Status>;
  else if (a.status === "denied" || done === "denied")
    body = <Status ok>Declined. Nothing was charged, and your agent has been told.</Status>;
  else if (expired) body = <Status ok>This request already expired. Nothing was charged.</Status>;
  else if (a.status !== "pending")
    body = (
      <Status ok={false}>This request was already approved, so it can't be declined here.</Status>
    );
  else
    body = (
      <form action={declineFromEmail} className="flex flex-col gap-3">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="t" value={t} />
        <Button type="submit" variant="destructive" size="lg">
          Decline this purchase
        </Button>
        <Button asChild variant="ghost">
          <Link href={`/approve/${id}`}>Review it in Tab402 instead</Link>
        </Button>
      </form>
    );

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-10">
      <ThemeToggle className="absolute top-4 right-4" />
      <Brand />
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardDescription>
            {row ? `${row.agent} wants to pay ${row.seller}` : "Tab402"}
          </CardDescription>
          <CardTitle className="text-4xl tabular-nums">
            {a ? formatUsd(a.amountMicros) : "Decline a purchase"}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {a?.intent && <p className="text-sm">{a.intent}</p>}
          {body}
        </CardContent>
      </Card>
    </main>
  );
}

function Status({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  const Icon = ok ? CheckCircle2 : XCircle;
  return (
    <p className="flex items-center gap-2 font-medium text-muted-foreground">
      <Icon className="size-5" />
      {children}
    </p>
  );
}
