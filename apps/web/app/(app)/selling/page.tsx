import { formatUsd } from "@tab402/core";
import { schema as s } from "@tab402/db";
import { asc, eq, sql } from "drizzle-orm";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
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
import { db, requireBuyer, sellerFor } from "@/lib/server";
import { BecomeSeller, SellerSettings } from "./seller-forms";

export const metadata = { title: "Selling" };

export default async function SellingPage() {
  const { user } = await requireBuyer("/selling");
  const seller = await sellerFor(user.id);
  if (!seller) {
    return (
      <>
        <PageHeader
          title="Selling"
          description="Charge agents per call for your API. One line of middleware; payouts to PayPal weekly."
        />
        <Card>
          <CardHeader>
            <CardTitle>Sell your API to agents</CardTitle>
            <CardDescription>
              You'll get a seller API key for the Tab402 gate. Agents pay per call; Tab402 settles
              in batches and pays you out through PayPal.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BecomeSeller defaultName={user.name} />
          </CardContent>
        </Card>
      </>
    );
  }
  const [money] = await db
    .select({
      earned: sql<string>`coalesce(sum(${s.charges.amountMicros}) filter (where ${s.charges.state} = 'earned'), 0)::text`,
      collected: sql<string>`coalesce(sum(${s.charges.amountMicros}) filter (where ${s.charges.state} = 'collected'), 0)::text`,
      paidOut: sql<string>`coalesce(sum(${s.charges.amountMicros}) filter (where ${s.charges.state} = 'paid_out'), 0)::text`,
    })
    .from(s.charges)
    .where(eq(s.charges.sellerId, seller.id));
  const endpoints = await db
    .select()
    .from(s.endpoints)
    .where(eq(s.endpoints.sellerId, seller.id))
    .orderBy(asc(s.endpoints.url), asc(s.endpoints.method));
  const tiles = [
    {
      label: "Earned",
      hint: "on buyers' tabs, not charged yet",
      value: money?.earned,
      color: "bg-earned",
    },
    {
      label: "Collected",
      hint: "charged through PayPal, with Tab402",
      value: money?.collected,
      color: "bg-collected",
    },
    { label: "Paid out", hint: "sent to your PayPal", value: money?.paidOut, color: "bg-paid-out" },
  ];
  return (
    <>
      <PageHeader
        title={seller.name}
        description="Your money is always in one of three states: earned, collected, paid out."
        action={
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link href="/selling/webhooks">Webhooks</Link>
            </Button>
            <Button variant="outline" asChild>
              <a href="/api/export/payouts" download>
                Payouts CSV
              </a>
            </Button>
            <Button asChild>
              <Link href="/selling/analytics">Analytics</Link>
            </Button>
          </div>
        }
      />
      <section className="grid gap-4 sm:grid-cols-3">
        {tiles.map((t) => (
          <Card key={t.label} className="gap-1 py-4">
            <CardHeader className="px-4">
              <CardDescription className="flex items-center gap-2">
                <span className={`size-2 rounded-full ${t.color}`} /> {t.label}
              </CardDescription>
              <CardTitle className="text-2xl tabular-nums">
                {formatUsd(Number(t.value ?? 0))}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 text-xs text-muted-foreground">{t.hint}</CardContent>
          </Card>
        ))}
      </section>
      <Card>
        <CardHeader className="flex flex-wrap items-start justify-between gap-2">
          <div className="grid gap-1.5">
            <CardTitle>Endpoints</CardTitle>
            <CardDescription>
              Priced routes, listed in the public directory. Your gate registers them, or add them
              from your OpenAPI spec.
            </CardDescription>
          </div>
          <Button asChild>
            <Link href="/selling/onboard">Add from OpenAPI</Link>
          </Button>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Route</TableHead>
                <TableHead className="hidden sm:table-cell">What it does</TableHead>
                <TableHead className="hidden sm:table-cell">Category</TableHead>
                <TableHead className="text-right">Price</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {endpoints.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="whitespace-normal text-muted-foreground">
                    No endpoints yet.
                  </TableCell>
                </TableRow>
              )}
              {endpoints.map((e) => (
                <TableRow key={e.id} className={e.active ? undefined : "opacity-50"}>
                  <TableCell className="font-mono text-xs break-all whitespace-normal sm:break-normal">
                    <span className="font-semibold">{e.method}</span> {e.url}
                    {e.description && (
                      <div className="mt-1 font-sans text-sm text-muted-foreground sm:hidden">
                        {e.description}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="hidden max-w-72 truncate sm:table-cell">
                    {e.description ?? "—"}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {e.category && <Badge variant="secondary">{e.category}</Badge>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {e.pricingMode === "metered" ? "up to " : ""}
                    {formatUsd(e.priceMicros)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
          <CardDescription className="font-mono text-xs">{seller.id}</CardDescription>
        </CardHeader>
        <CardContent>
          <SellerSettings
            payoutReceiver={seller.payoutReceiver ?? user.email}
            webhookUrl={seller.webhookUrl ?? ""}
          />
        </CardContent>
      </Card>
    </>
  );
}
