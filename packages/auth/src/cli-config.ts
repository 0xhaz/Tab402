/** Config used only by `auth generate` (no database: the CLI emits the Drizzle schema from a mock adapter). */
import { createAuth } from "./index";

export const auth = createAuth({
  baseURL: "http://localhost:3000",
  secret: "schema-generation-only-not-a-real-secret-000000",
  mcpResource: "http://localhost:4100/mcp",
});
