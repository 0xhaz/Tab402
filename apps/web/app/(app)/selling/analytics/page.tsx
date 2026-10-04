import { redirect } from "next/navigation";
import { MobileSummary } from "@/components/mobile-summary";
import { PageHeader } from "@/components/page-header";
import { StudioDashboard } from "@/components/studio-dashboard";
import { COLUMNS, sellerDataset } from "@/lib/analytics";
import { sellerSummary } from "@/lib/mobile-analytics";
import { SELLER_REPORT } from "@/lib/reports";
import { requireBuyer, sellerFor } from "@/lib/server";

export const metadata = { title: "Seller analytics" };

export default async function SellerAnalyticsPage() {
  const { user } = await requireBuyer("/selling/analytics");
  const seller = await sellerFor(user.id);
  if (!seller) redirect("/selling");
  const d = await sellerDataset(seller.id);
  return (
    <>
      <PageHeader
        title="Seller analytics"
        description="Revenue by money state, what agents do with your prices, and payouts. Built with AG Studio — switch to edit to build your own views."
      />
      <StudioDashboard
        licenseKey={process.env.AG_STUDIO_LICENSE_KEY}
        mobile={<MobileSummary {...sellerSummary(d)} />}
        ai={process.env.ANTHROPIC_API_KEY ? "seller" : undefined}
        report={SELLER_REPORT}
        tables={[
          {
            id: "charges",
            columns: COLUMNS.charges,
            name: "Charges",
            description: "One row per paid call: endpoint, buyer, money state and amount in USD.",
            data: d.charges,
          },
          {
            id: "quotes",
            columns: COLUMNS.quotes,
            name: "402 quotes",
            description: "Every price quoted to an agent and whether it was paid.",
            data: d.quotes,
          },
          {
            id: "guard",
            columns: COLUMNS.guard,
            name: "Spend guard",
            description:
              "Buyer spend checks that denied or asked about your prices, with the rule that fired.",
            data: d.guard,
          },
          {
            id: "payouts",
            columns: COLUMNS.payouts,
            name: "Payouts",
            description: "PayPal payouts to you, with batch ids and fees.",
            data: d.payouts,
          },
        ]}
      />
    </>
  );
}
