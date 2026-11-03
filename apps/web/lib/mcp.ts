import "server-only";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { newId } from "@tab402/core";
import { generateApiKey, schema as s } from "@tab402/db";
import { eq } from "drizzle-orm";
import { db } from "@/lib/server";

export const MCP_URL = process.env.MCP_URL ?? "http://localhost:4100/mcp";

export type ToolInfo = { name: string; title?: string; description?: string };
export type ToolRun = {
  tool: string;
  args: Record<string, unknown>;
  text: string;
  isError: boolean;
  ms: number;
};

/**
 * Talk to the buyer MCP server exactly as an outside agent would: over Streamable HTTP with a
 * buyer API key. The key is minted for this one request and revoked straight after, so the
 * playground never stores a usable key.
 */
export async function withMcp<T>(
  buyerId: string,
  agentName: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const { key, hash, prefix } = generateApiKey("buyer");
  const id = newId("apiKey");
  await db.insert(s.apiKeys).values({ id, ownerType: "buyer", ownerId: buyerId, prefix, hash });
  const client = new Client({ name: "tab402-playground", version: "1.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(MCP_URL), {
        requestInit: {
          headers: { authorization: `Bearer ${key}`, "x-tab402-agent": agentName },
        },
      }),
    );
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
    await db.update(s.apiKeys).set({ revokedAt: new Date() }).where(eq(s.apiKeys.id, id));
  }
}
