import { schema as s } from "@tab402/db";
import { desc, eq } from "drizzle-orm";
import { csvResponse, toCsv, usd } from "@/lib/csv";
import { db, getSession, sellerFor } from "@/lib/server";

/** The signed-in seller's payouts as CSV. */
export async function GET() {
  const session = await getSession();
  if (!session) return new Response("sign in first", { status: 401 });
  const seller = await sellerFor(session.user.id);
  if (!seller) return new Response("no seller account", { status: 404 });
  const rows = await db
    .select({ i: s.payoutItems, p: s.payouts })
    .from(s.payoutItems)
    .innerJoin(s.payouts, eq(s.payouts.id, s.payoutItems.payoutId))
    .where(eq(s.payoutItems.sellerId, seller.id))
    .orderBy(desc(s.payouts.createdAt));
  return csvResponse(
    "tab402-payouts",
    toCsv(
      ["payout_item_id", "created_at", "paypal_batch_id", "amount_usd", "fee_usd", "status"],
      rows.map(({ i, p }) => [
        i.id,
        p.createdAt.toISOString(),
        p.paypalPayoutBatchId ?? p.senderBatchId,
        usd(i.amountMicros),
        usd(i.feeMicros),
        i.status,
      ]),
    ),
  );
}
