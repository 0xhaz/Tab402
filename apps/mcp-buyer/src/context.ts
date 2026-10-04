import type { Database } from "@tab402/db";

export interface McpDeps {
  db: Database;
  /** Seals agent private keys. */
  masterKey: Buffer;
  /** fetch used to reach sellers and the Tab402 API (injectable for tests). */
  fetch?: typeof fetch;
  /** Approval page base, e.g. http://localhost:3000/approve (for request_approval). */
  approvalBaseUrl?: string;
  /**
   * OAuth 2.1 (claude.ai / Desktop connectors): tokens issued by the web app's Better Auth
   * authorization server, audience-bound to `resource` (this server's /mcp URL).
   */
  oauth?: { issuer: string; resource: string; jwksUrl: string };
  /** Allowed Host header values (DNS-rebinding protection); defaults to localhost. */
  allowedHosts?: string[];
  now?: () => Date;
}

/** Who is calling, resolved from the bearer token. Carried in AuthInfo.extra. */
export interface Caller {
  buyerId: string;
  /** One key, budget and receipt trail per agent. */
  agentName: string;
}
