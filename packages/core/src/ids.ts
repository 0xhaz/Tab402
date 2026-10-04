import { ulid } from "ulid";

/** Sortable, prefixed IDs. */
export const ID_PREFIXES = {
  buyer: "buy",
  agent: "agt",
  agentKey: "key",
  mandate: "man",
  topUp: "top",
  seller: "sel",
  secret: "sec",
  endpoint: "ep",
  quote: "q",
  guardDecision: "gd",
  channel: "ch",
  voucher: "vch",
  charge: "chg",
  settlement: "stl",
  settlementItem: "sti",
  payout: "po",
  payoutItem: "poi",
  eventOut: "evt",
  aiDecision: "ai",
  apiKey: "ak",
  adjustment: "adj",
  approval: "apr",
  pushSubscription: "psub",
  notification: "ntf",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${ulid()}`;
}

export function hasPrefix(id: string, kind: IdKind): boolean {
  return id.startsWith(`${ID_PREFIXES[kind]}_`);
}
