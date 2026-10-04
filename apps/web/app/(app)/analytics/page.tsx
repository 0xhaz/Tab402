import { MobileSummary } from "@/components/mobile-summary";
import { PageHeader } from "@/components/page-header";
import { StudioDashboard } from "@/components/studio-dashboard";
import { buyerDataset, COLUMNS } from "@/lib/analytics";
import { buyerSummary } from "@/lib/mobile-analytics";
import { BUYER_REPORT } from "@/lib/reports";
import { requireBuyer } from "@/lib/server";

export const metadata = { title: "Analytics" };

export default async function BuyerAnalyticsPage() {
  const { buyer } = await requireBuyer("/analytics");
  const d = await buyerDataset(buyer.id);
  return (
    <>
      <PageHeader
        title="Analytics"
        description="Where your agents' money goes, and what the spend guard did about it."
      />
      <StudioDashboard
        licenseKey={process.env.AG_STUDIO_LICENSE_KEY}
        mobile={<MobileSummary {...buyerSummary(d)} />}
        ai={process.env.ANTHROPIC_API_KEY ? "buyer" : undefined}
        report={BUYER_REPORT}
        tables={[
          {
            id: "spend",
            columns: COLUMNS.spend,
            name: "Spend",
            description: "One row per paid call: agent, seller, what it was for, money state, USD.",
            data: d.spend,
          },
          {
            id: "checks",
            columns: COLUMNS.checks,
            name: "Spend checks",
            description:
              "Every spend-guard decision: outcome, who decided (rule, cache, AI, you) and the agent's stated intent.",
            data: d.checks,
          },
        ]}
      />
    </>
  );
}
