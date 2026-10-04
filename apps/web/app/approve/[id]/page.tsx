import { formatUsd } from "@tab402/core";
import { schema as s } from "@tab402/db";
import { and, eq } from "drizzle-orm";
import { CheckCircle2, XCircle } from "lucide-react";
import { notFound } from "next/navigation";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-toggle";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db, requireBuyer } from "@/lib/server";
import { ApprovePanel } from "./approve-panel";

export const metadata = { title: "Approve a purchase" };

/** The approval page an agent's URL elicitation (or push/email link) opens. */
export default async function ApprovePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { buyer } = await requireBuyer(`/approve/${id}`);
  const [row] = await db
    .select({
      approval: s.approvals,
      seller: s.sellers.name,
      url: s.endpoints.url,
      description: s.endpoints.description,
      agent: s.agents.name,
    })
    .from(s.approvals)
    .innerJoin(s.sellers, eq(s.sellers.id, s.approvals.sellerId))
    .innerJoin(s.endpoints, eq(s.endpoints.id, s.approvals.endpointId))
    .innerJoin(s.agentKeys, eq(s.agentKeys.id, s.approvals.agentKeyId))
    .innerJoin(s.agents, eq(s.agents.id, s.agentKeys.agentId))
    .where(and(eq(s.approvals.id, id), eq(s.approvals.buyerId, buyer.id)));
  if (!row) notFound();
  const { approval: a } = row;
  const expired = a.status === "pending" && a.expiresAt <= new Date();

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-10">
      <ThemeToggle className="absolute top-4 right-4" />
      <Brand />
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardDescription>{row.agent} wants to pay</CardDescription>
          <CardTitle className="text-4xl tabular-nums">{formatUsd(a.amountMicros)}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Seller</dt>
            <dd>{row.seller}</dd>
            <dt className="text-muted-foreground">For</dt>
            <dd>{row.description ?? row.url}</dd>
            <dt className="text-muted-foreground">Agent says</dt>
            <dd>{a.intent ?? <span className="text-muted-foreground">no reason given</span>}</dd>
            <dt className="text-muted-foreground">Why it needs you</dt>
            <dd>{a.reason}</dd>
            <dt className="text-muted-foreground">Endpoint</dt>
            <dd className="truncate font-mono text-xs">{row.url}</dd>
          </dl>
          {a.status === "pending" && !expired ? (
            <ApprovePanel approvalId={a.id} />
          ) : a.status === "approved" || a.status === "used" ? (
            <p className="flex items-center gap-2 font-medium text-paid-out">
              <CheckCircle2 className="size-5" />
              {a.status === "used"
                ? "Approved and used."
                : "Approved. Your agent can complete the purchase now — you can close this tab."}
            </p>
          ) : (
            <p className="flex items-center gap-2 font-medium text-muted-foreground">
              <XCircle className="size-5" />
              {expired || a.status === "expired"
                ? "This request expired. Nothing was charged."
                : "Declined. Nothing was charged."}
            </p>
          )}
        </CardContent>
      </Card>
      <p className="max-w-lg text-center text-xs text-muted-foreground">
        Approving covers one purchase up to this amount, for the next 15 minutes. Your agent can
        never raise its own limits.
      </p>
    </main>
  );
}
