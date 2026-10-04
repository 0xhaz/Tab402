import { formatUsd } from "@tab402/core";
import { schema as s } from "@tab402/db";
import { desc, eq } from "drizzle-orm";
import { LiveRefresh } from "@/components/live-refresh";
import { PageHeader } from "@/components/page-header";
import { PurchaseCards } from "@/components/purchase-cards";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { db, requireBuyer } from "@/lib/server";
import { FlagButton } from "./flag-button";

export const metadata = { title: "Receipts" };

export default async function ReceiptsPage() {
  const { buyer } = await requireBuyer("/receipts");
  const rows = await db
    .select({ c: s.charges, seller: s.sellers.name, url: s.endpoints.url, agent: s.agents.name })
    .from(s.charges)
    .innerJoin(s.sellers, eq(s.sellers.id, s.charges.sellerId))
    .innerJoin(s.endpoints, eq(s.endpoints.id, s.charges.endpointId))
    .innerJoin(s.agentKeys, eq(s.agentKeys.id, s.charges.agentKeyId))
    .innerJoin(s.agents, eq(s.agents.id, s.agentKeys.agentId))
    .where(eq(s.charges.buyerId, buyer.id))
    .orderBy(desc(s.charges.createdAt))
    .limit(200);
  return (
    <>
      <PageHeader
        title="Receipts"
        description="Every paid call, what it was for, and where it is: on your tab, charged to PayPal, or paid to the seller."
        action={
          <Button variant="outline" asChild>
            <a href="/api/export/receipts" download>
              Download CSV
            </a>
          </Button>
        }
      />
      <LiveRefresh />
      <Card>
        <CardContent>
          {rows.length > 0 && (
            <PurchaseCards
              items={rows.map(({ c, seller, agent }) => ({
                id: c.id,
                at: c.createdAt,
                agent,
                seller,
                intent: c.intent,
                amountMicros: c.amountMicros,
                state: c.held ? "held" : c.state,
                action:
                  c.state === "earned" && !c.held ? <FlagButton chargeId={c.id} /> : undefined,
              }))}
            />
          )}
          {rows.length === 0 && <p className="text-sm text-muted-foreground">No purchases yet.</p>}
          <Table className={rows.length ? "hidden sm:table" : "hidden"}>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Seller</TableHead>
                <TableHead>For</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>State</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ c, seller, url, agent }) => (
                <TableRow key={c.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {c.createdAt.toLocaleString()}
                  </TableCell>
                  <TableCell>{agent}</TableCell>
                  <TableCell title={url}>{seller}</TableCell>
                  <TableCell className="max-w-72 truncate">{c.intent ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatUsd(c.amountMicros)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{c.held ? "held" : c.state.replace("_", " ")}</Badge>
                  </TableCell>
                  <TableCell>
                    {c.state === "earned" && !c.held && <FlagButton chargeId={c.id} />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}
