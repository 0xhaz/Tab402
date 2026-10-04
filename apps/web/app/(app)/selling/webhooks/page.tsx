import { schema as s } from "@tab402/db";
import { desc, eq, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { LiveRefresh } from "@/components/live-refresh";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { db, requireBuyer, sellerFor } from "@/lib/server";
import { RetryButton } from "./retry-button";

export const metadata = { title: "Webhooks" };

const STATUS = {
  delivered: "secondary",
  pending: "outline",
  failed: "destructive",
} as const;

/** Signed outbound events: what was sent to the seller's webhook URL, and what happened. */
export default async function WebhooksPage() {
  const { user } = await requireBuyer("/selling/webhooks");
  const seller = await sellerFor(user.id);
  if (!seller) redirect("/selling");
  const [rows, counts] = await Promise.all([
    db
      .select()
      .from(s.eventsOut)
      .where(eq(s.eventsOut.sellerId, seller.id))
      .orderBy(desc(s.eventsOut.createdAt))
      .limit(100),
    db
      .select({ status: s.eventsOut.deliveryStatus, n: sql<string>`count(*)` })
      .from(s.eventsOut)
      .where(eq(s.eventsOut.sellerId, seller.id))
      .groupBy(s.eventsOut.deliveryStatus),
  ]);
  const count = (k: string) => Number(counts.find((c) => c.status === k)?.n ?? 0);
  return (
    <>
      <PageHeader
        title="Webhooks"
        description="Every event Tab402 sent you, signed with your Tab402-Signature secret. Failed sends retry with backoff for 24 hours."
      />
      <LiveRefresh />
      <section className="grid gap-4 sm:grid-cols-3">
        {(["delivered", "pending", "failed"] as const).map((k) => (
          <Card key={k} className="gap-1 py-4">
            <CardHeader className="px-4">
              <CardDescription className="capitalize">{k}</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{count(k)}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </section>
      <Card>
        <CardHeader>
          <CardTitle>Deliveries</CardTitle>
          <CardDescription>
            {seller.webhookUrl ? (
              <>
                Sending to <code className="font-mono text-xs">{seller.webhookUrl}</code>
              </>
            ) : (
              "No webhook URL set — events wait here (and in GET /events) until you add one in Selling."
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="hidden sm:table-cell">When</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Attempts</TableHead>
                <TableHead className="hidden sm:table-cell">Last error / next try</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">
                    No events yet. They start with your first paid call.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">
                    {e.createdAt.toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <code className="font-mono text-xs">{e.type}</code>
                    <div className="font-mono text-[11px] text-muted-foreground">{e.id}</div>
                    {e.lastError && (
                      <div className="text-xs text-destructive sm:hidden">
                        {e.lastError} · {e.attempts} attempts
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS[e.deliveryStatus]}>{e.deliveryStatus}</Badge>
                  </TableCell>
                  <TableCell className="hidden text-right tabular-nums sm:table-cell">
                    {e.attempts}
                  </TableCell>
                  <TableCell className="hidden max-w-72 text-xs text-muted-foreground sm:table-cell">
                    {e.lastError && (
                      <div className="truncate" title={e.lastError}>
                        {e.lastError}
                      </div>
                    )}
                    {e.deliveryStatus === "pending" && e.nextAttemptAt && (
                      <div>next: {e.nextAttemptAt.toLocaleTimeString()}</div>
                    )}
                  </TableCell>
                  <TableCell>
                    {e.deliveryStatus !== "delivered" && seller.webhookUrl && (
                      <RetryButton eventId={e.id} />
                    )}
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
