import type { Database } from "@tab402/db";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Executor = Database | Tx;

export class LedgerError extends Error {
  override name = "LedgerError";
  constructor(
    readonly code:
      | "not_found"
      | "forbidden"
      | "in_settlement"
      | "not_refundable"
      | "not_flaggable"
      | "no_mandate"
      | "invalid_state",
    message: string,
  ) {
    super(message);
  }
}
