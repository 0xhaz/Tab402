import { formatUsd } from "@tab402/core";
import { schema as s } from "@tab402/db";
import { asc, eq, sql } from "drizzle-orm";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db, requireBuyer } from "@/lib/server";
import { AllowAgainButton, RevokeButton } from "./revoke-button";

export const metadata = { title: "Agents & keys" };

export default async function AgentsPage() {
  const { buyer } = await requireBuyer("/agents");
  const rows = await db
    .select({
      key: s.agentKeys,
      agent: s.agents.name,
      spent: sql<string>`(select coalesce(sum(${s.charges.amountMicros}), 0)::text from ${s.charges} where ${s.charges.agentKeyId} = ${s.agentKeys.id})`,
      // Keys the Tab402 MCP server holds for the agent (vs. keys an SDK client keeps itself).
      held: sql<boolean>`exists (select 1 from ${s.merchantSecrets} where ${s.merchantSecrets.ownerId} = ${s.agentKeys.id} and ${s.merchantSecrets.kind} = 'agent_private_key')`,
    })
    .from(s.agentKeys)
    .innerJoin(s.agents, eq(s.agents.id, s.agentKeys.agentId))
    .where(eq(s.agentKeys.buyerId, buyer.id))
    .orderBy(asc(s.agents.name), asc(s.agentKeys.createdAt));
  const roots = rows.filter((r) => !r.key.parentKeyId);
  const now = new Date();
  return (
    <>
      <PageHeader
        title="Agents & keys"
        description="Each agent signs its payments with its own key. Revoke one and it stops paying within 30 seconds."
      />
      {roots.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No agents yet</CardTitle>
            <CardDescription>
              Add the Tab402 MCP server to Claude Code (or any MCP client); each agent shows up here
              on its first purchase.
            </CardDescription>
          </CardHeader>
        </Card>
      )}
      {roots.map((r) => {
        const children = rows.filter((c) => c.key.parentKeyId === r.key.id);
        return (
          <Card key={r.key.id}>
            <CardHeader className="flex flex-row items-start justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2">
                  {r.agent}{" "}
                  <Badge variant={r.key.status === "active" ? "secondary" : "destructive"}>
                    {r.key.status}
                  </Badge>
                </CardTitle>
                <CardDescription className="font-mono text-xs">{r.key.id}</CardDescription>
              </div>
              {r.key.status === "active" && <RevokeButton keyId={r.key.id} />}
              {r.key.status === "revoked" && r.held && <AllowAgainButton keyId={r.key.id} />}
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <p>
                Spent {formatUsd(Number(r.spent))}
                {r.key.dailyBudgetMicros !== null &&
                  ` · daily budget ${formatUsd(r.key.dailyBudgetMicros)}`}
              </p>
              {children.length > 0 && (
                <div className="flex flex-col gap-2 border-l-2 pl-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Sub-budgets
                  </p>
                  {children.map((c) => {
                    const expired = c.key.expiresAt && c.key.expiresAt <= now;
                    return (
                      <p key={c.key.id} className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs">{c.key.id}</span>
                        <span>
                          {formatUsd(Number(c.spent))} of{" "}
                          {c.key.budgetCapMicros === null ? "—" : formatUsd(c.key.budgetCapMicros)}
                        </span>
                        <Badge variant="outline">{expired ? "expired" : c.key.status}</Badge>
                      </p>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </>
  );
}
