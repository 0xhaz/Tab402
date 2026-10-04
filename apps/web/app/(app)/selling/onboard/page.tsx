import { CATEGORIES, CATEGORY_DEFAULTS } from "@tab402/agents";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requireBuyer, sellerFor } from "@/lib/server";
import { OnboardFlow } from "./onboard-flow";

export const metadata = { title: "Add endpoints from OpenAPI" };

export default async function OnboardPage() {
  const { user } = await requireBuyer("/selling/onboard");
  if (!(await sellerFor(user.id))) redirect("/selling");
  return (
    <>
      <PageHeader
        title="Start charging in five minutes"
        description="Paste your OpenAPI spec. Claude proposes a price for each route; you confirm every one before anything is charged."
      />
      <OnboardFlow
        categories={CATEGORIES.map((c) => ({ id: c, ...CATEGORY_DEFAULTS[c] }))}
        ai={Boolean(process.env.ANTHROPIC_API_KEY)}
      />
    </>
  );
}
