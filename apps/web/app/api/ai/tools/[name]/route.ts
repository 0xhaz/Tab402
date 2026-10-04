import { revenueTool, ToolInputError } from "@tab402/agents";
import { db, getSession, sellerFor } from "@/lib/server";

/** Revenue agent tools, always scoped to the signed-in user's own seller account. */
export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "sign in first" }, { status: 401 });
  const tool = revenueTool((await params).name);
  if (!tool) return Response.json({ error: "unknown tool" }, { status: 404 });
  const seller = await sellerFor(session.user.id);
  if (!seller) return Response.json({ error: "not a seller" }, { status: 403 });
  const args = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return Response.json(await tool.run(db, seller.id, args ?? {}));
  } catch (err) {
    if (err instanceof ToolInputError)
      return Response.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
