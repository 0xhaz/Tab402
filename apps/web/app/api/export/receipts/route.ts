import { schema as s } from "@tab402/db";
import { desc, eq } from "drizzle-orm";
import { csvResponse, toCsv, usd } from "@/lib/csv";
import { db, getSession } from "@/lib/server";

/** The signed-in buyer's receipts as CSV. */
export async function GET() {
  const session = await getSession();
  if (!session) return new Response("sign in first", { status: 401 });
  const buyer = await db.query.buyers.findFirst({
    where: (b, { eq }) => eq(b.userId, session.user.id),
  });
  if (!buyer) return new Response("no buyer account", { status: 404 });
  const rows = await db
    .select({ c: s.charges, seller: s.sellers.name, url: s.endpoints.url, agent: s.agents.name })
    .from(s.charges)
    .innerJoin(s.sellers, eq(s.sellers.id, s.charges.sellerId))
    .innerJoin(s.endpoints, eq(s.endpoints.id, s.charges.endpointId))
    .innerJoin(s.agentKeys, eq(s.agentKeys.id, s.charges.agentKeyId))
    .innerJoin(s.agents, eq(s.agents.id, s.agentKeys.agentId))
    .where(eq(s.charges.buyerId, buyer.id))
    .orderBy(desc(s.charges.createdAt));
  return csvResponse(
    "tab402-receipts",
    toCsv(
      ["charge_id", "created_at", "agent", "seller", "endpoint", "intent", "amount_usd", "state"],
      rows.map(({ c, seller, url, agent }) => [
        c.id,
        c.createdAt.toISOString(),
        agent,
        seller,
        url,
        c.intent,
        usd(c.amountMicros),
        c.held ? "held" : c.state,
      ]),
    ),
  );
}
