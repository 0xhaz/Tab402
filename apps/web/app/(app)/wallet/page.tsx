import { formatUsd } from "@tab402/core";
import { or } from "drizzle-orm";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db, requireBuyer } from "@/lib/server";
import { BalanceControls } from "./balance-controls";
import { ConnectPayPal } from "./connect-paypal";
import { RedirectReturn } from "./redirect-return";

export const metadata = { title: "Wallet" };

export default async function WalletPage() {
  const { buyer } = await requireBuyer("/wallet");
  const [mandate, balance, past] = await Promise.all([
    db.query.mandates.findFirst({
      where: (m, { and, eq }) =>
        and(eq(m.buyerId, buyer.id), or(eq(m.status, "active"), eq(m.status, "frozen"))),
    }),
    db.query.balances.findFirst({ where: (b, { eq }) => eq(b.buyerId, buyer.id) }),
    db.query.mandates.findMany({ where: (m, { eq }) => eq(m.buyerId, buyer.id) }),
  ]);
  const captures = past.reduce((a, m) => a + m.successfulCaptures, 0);
  const clientId = process.env.PAYPAL_CLIENT_ID ?? "";
  const environment = process.env.PAYPAL_ENV === "live" ? "production" : "sandbox";

  return (
    <>
      <PageHeader
        title="Wallet"
        description="How your agents' tab gets paid. Saved once; charged in batches, never per call."
      />
      <Suspense>
        <RedirectReturn />
      </Suspense>
      {mandate?.status === "frozen" && (
        <Alert variant="destructive">
          <AlertTitle>Payments paused</AlertTitle>
          <AlertDescription>
            The last PayPal charge was declined. Tab402 retries once after 24 hours; you can also
            save a different wallet.
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            PayPal{" "}
            {mandate && (
              <Badge variant={mandate.status === "active" ? "default" : "destructive"}>
                {mandate.status}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            {mandate
              ? `${mandate.payerEmail ?? "Saved wallet"} · ${mandate.mode === "prepaid" ? "prepaid balance" : `tab up to ${formatUsd(mandate.creditLimitMicros)}`} · ${mandate.successfulCaptures} successful charges`
              : "Save your PayPal wallet once. Tab402 charges it when your balance runs low or your tab settles — no checkout per call."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {clientId ? (
            <ConnectPayPal
              clientId={clientId}
              environment={environment}
              canPostpay={captures >= 3}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              PayPal is not configured (PAYPAL_CLIENT_ID).
            </p>
          )}
        </CardContent>
      </Card>
      {mandate?.mode === "prepaid" && (
        <Card>
          <CardHeader>
            <CardDescription>Prepaid balance</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {formatUsd(balance?.balanceMicros ?? 0)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <BalanceControls
              autoTopUp={balance?.autoTopUp ?? true}
              topUpLabel={formatUsd(balance?.topUpMicros ?? 10_000_000)}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}
