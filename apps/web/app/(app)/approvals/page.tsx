import { formatUsd } from "@tab402/core";
import { schema as s } from "@tab402/db";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { LiveRefresh } from "@/components/live-refresh";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { db, requireBuyer } from "@/lib/server";

export const metadata = { title: "Approvals" };

export default async function ApprovalsPage() {
  const { buyer } = await requireBuyer("/approvals");
  const rows = await db
    .select({ a: s.approvals, seller: s.sellers.name, agent: s.agents.name })
    .from(s.approvals)
    .innerJoin(s.sellers, eq(s.sellers.id, s.approvals.sellerId))
    .innerJoin(s.agentKeys, eq(s.agentKeys.id, s.approvals.agentKeyId))
    .innerJoin(s.agents, eq(s.agents.id, s.agentKeys.agentId))
    .where(and(eq(s.approvals.buyerId, buyer.id)))
    .orderBy(desc(s.approvals.createdAt))
    .limit(50);
  const now = new Date();
  return (
    <>
      <PageHeader
        title="Approvals"
        description="Purchases your agents asked you to OK — above your approval threshold, or flagged by the spend check."
      />
      <LiveRefresh />
      <Card>
        <CardContent className="flex flex-col divide-y">
          {rows.length === 0 && (
            <p className="py-6 text-sm text-muted-foreground">Nothing to approve.</p>
          )}
          {rows.map(({ a, seller, agent }) => {
            const pending = a.status === "pending" && a.expiresAt > now;
            return (
              <Link
                key={a.id}
                href={`/approve/${a.id}` as never}
                className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 py-4 hover:bg-accent/50 sm:flex"
              >
                <div className="min-w-0 sm:flex-1">
                  <p className="font-medium sm:truncate">
                    {agent} → {seller}
                  </p>
                  <p className="line-clamp-2 text-sm text-muted-foreground sm:truncate">
                    {a.intent ?? a.reason}
                  </p>
                </div>
                <span className="row-span-2 self-start text-lg font-semibold tabular-nums sm:text-base sm:font-normal">
                  {formatUsd(a.amountMicros)}
                </span>
                <Badge variant={pending ? "default" : "secondary"}>
                  {pending ? "Waiting for you" : a.status === "pending" ? "expired" : a.status}
                </Badge>
              </Link>
            );
          })}
        </CardContent>
      </Card>
    </>
  );
}
