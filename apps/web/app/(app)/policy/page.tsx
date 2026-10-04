import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db, requireBuyer } from "@/lib/server";
import { PolicyForm } from "./policy-form";

export const metadata = { title: "Spending policy" };
const usd = (m: number) => (m / 1e6).toFixed(2);

export default async function PolicyPage() {
  const { buyer } = await requireBuyer("/policy");
  const p = await db.query.policies.findFirst({ where: (x, { eq }) => eq(x.buyerId, buyer.id) });
  return (
    <>
      <PageHeader
        title="Spending policy"
        description="The rules every purchase is checked against before any money moves. Your agents can't change them."
      />
      <Card>
        <CardHeader>
          <CardTitle>Limits</CardTitle>
          <CardDescription>
            Routine purchases from sellers you've used before pass instantly. New sellers and
            unusual prices get a quick AI check against what the agent says it's buying. Big ones
            come to you.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PolicyForm
            values={{
              dailyBudget: usd(p?.dailyBudgetMicros ?? 10_000_000),
              perCallMax: usd(p?.perCallMaxMicros ?? 1_000_000),
              approvalThreshold: usd(p?.approvalThresholdMicros ?? 2_000_000),
              blocklist: (p?.blocklist ?? []).join(", "),
              allowlist: (p?.allowlist ?? []).join(", "),
            }}
          />
        </CardContent>
      </Card>
    </>
  );
}
