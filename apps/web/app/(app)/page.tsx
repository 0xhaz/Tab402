import { formatUsd } from "@tab402/core";
import { schema as s } from "@tab402/db";
import { and, count, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import Link from "next/link";
import { LiveRefresh } from "@/components/live-refresh";
import { PageHeader } from "@/components/page-header";
import { PurchaseCards } from "@/components/purchase-cards";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { db, requireBuyer } from "@/lib/server";

export const metadata = { title: "Overview" };

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      {hint && <CardContent className="px-4 text-xs text-muted-foreground">{hint}</CardContent>}
    </Card>
  );
}

export default async function OverviewPage() {
  const { buyer } = await requireBuyer("/");
  const dayStart = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()),
  );
  const [policy, mandate, balance, [today], [open], [agents], recent] = await Promise.all([
    db.query.policies.findFirst({ where: (p, { eq }) => eq(p.buyerId, buyer.id) }),
    db.query.mandates.findFirst({
      where: (m, { and, eq }) =>
        and(eq(m.buyerId, buyer.id), or(eq(m.status, "active"), eq(m.status, "frozen"))),
    }),
    db.query.balances.findFirst({ where: (b, { eq }) => eq(b.buyerId, buyer.id) }),
    db
      .select({ v: sql<string>`coalesce(sum(${s.charges.amountMicros}), 0)::text` })
      .from(s.charges)
      .where(and(eq(s.charges.buyerId, buyer.id), gte(s.charges.createdAt, dayStart))),
    db
      .select({ v: sql<string>`coalesce(sum(${s.charges.amountMicros}), 0)::text`, n: count() })
      .from(s.charges)
      .where(and(eq(s.charges.buyerId, buyer.id), eq(s.charges.state, "earned"))),
    db.select({ n: count() }).from(s.agents).where(eq(s.agents.buyerId, buyer.id)),
    db
      .select({
        id: s.charges.id,
        at: s.charges.createdAt,
        amount: s.charges.amountMicros,
        state: s.charges.state,
        intent: s.charges.intent,
        seller: s.sellers.name,
        agent: s.agents.name,
      })
      .from(s.charges)
      .innerJoin(s.sellers, eq(s.sellers.id, s.charges.sellerId))
      .innerJoin(s.agentKeys, eq(s.agentKeys.id, s.charges.agentKeyId))
      .innerJoin(s.agents, eq(s.agents.id, s.agentKeys.agentId))
      .where(
        and(
          eq(s.charges.buyerId, buyer.id),
          inArray(s.charges.state, ["earned", "collected", "paid_out", "refunded"]),
        ),
      )
      .orderBy(desc(s.charges.createdAt))
      .limit(8),
  ]);
  const daily = policy?.dailyBudgetMicros ?? 10_000_000;
  const spent = Number(today?.v ?? 0);

  return (
    <>
      <PageHeader
        title={`Hi, ${buyer.name.split(" ")[0]}`}
        description="What your agents spent, and what's left."
      />
      <LiveRefresh />
      {!mandate && (
        <Card className="border-primary/40 bg-primary/5">
          <CardHeader>
            <CardTitle>Connect PayPal to let your agents pay</CardTitle>
            <CardDescription>
              Save your PayPal wallet once. Agents pay per call on a tab, settled in one PayPal
              charge.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/wallet">Connect PayPal</Link>
            </Button>
          </CardContent>
        </Card>
      )}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile
          label="Spent today"
          value={formatUsd(spent)}
          hint={`of ${formatUsd(daily)} daily budget`}
        />
        <Tile label="Left today" value={formatUsd(Math.max(0, daily - spent))} />
        {mandate?.mode === "postpaid" ? (
          <Tile
            label="Open tab"
            value={formatUsd(Number(open?.v ?? 0))}
            hint={`${open?.n ?? 0} calls · settles at $10 or 24 h`}
          />
        ) : (
          <Tile
            label="Prepaid balance"
            value={formatUsd(balance?.balanceMicros ?? 0)}
            hint={mandate ? "auto top-up below $2" : "no wallet yet"}
          />
        )}
        <Tile
          label="Agents"
          value={String(agents?.n ?? 0)}
          hint={mandate?.status === "frozen" ? "payments paused: last charge declined" : undefined}
        />
      </section>
      <Card>
        <CardHeader>
          <CardTitle>Recent purchases</CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No purchases yet. Connect an agent through the Tab402 MCP server to start.
            </p>
          ) : (
            <>
              <PurchaseCards
                items={recent.map((r) => ({
                  id: r.id,
                  at: r.at,
                  agent: r.agent,
                  seller: r.seller,
                  intent: r.intent,
                  amountMicros: r.amount,
                  state: r.state,
                }))}
              />
              <Table className="hidden sm:table">
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Seller</TableHead>
                    <TableHead>For</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>State</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recent.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {r.at.toLocaleString()}
                      </TableCell>
                      <TableCell>{r.agent}</TableCell>
                      <TableCell>{r.seller}</TableCell>
                      <TableCell className="max-w-64 truncate">{r.intent ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatUsd(r.amount)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{r.state.replace("_", " ")}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
