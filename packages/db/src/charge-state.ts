/**
 * Charge state machine:
 *   earned → collected → paid_out, with side states refunded / disputed / written_off.
 */
export type ChargeState =
  | "earned"
  | "collected"
  | "paid_out"
  | "refunded"
  | "disputed"
  | "written_off";

export const CHARGE_TRANSITIONS: Readonly<Record<ChargeState, readonly ChargeState[]>> = {
  // Pre-capture refunds just drop off the tab (refund netting). Unrecovered declines are written off.
  earned: ["collected", "refunded", "disputed", "written_off"],
  // Post-capture refunds go back through PayPal (or the prepaid balance) and claw back from payouts.
  collected: ["paid_out", "refunded", "disputed"],
  paid_out: ["refunded", "disputed"],
  // A dispute resolves in the seller's favour (back to where it came from) or the buyer's.
  disputed: ["earned", "collected", "paid_out", "refunded", "written_off"],
  refunded: [],
  written_off: [],
};

export class InvalidTransitionError extends Error {
  override name = "InvalidTransitionError";
  constructor(
    readonly from: ChargeState,
    readonly to: ChargeState,
  ) {
    super(`charge cannot move from ${from} to ${to}`);
  }
}

export function canTransition(from: ChargeState, to: ChargeState): boolean {
  return CHARGE_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ChargeState, to: ChargeState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Which dashboard money state a charge counts toward. Side states count toward none. */
export function moneyState(state: ChargeState): "earned" | "collected" | "paid_out" | null {
  return state === "earned" || state === "collected" || state === "paid_out" ? state : null;
}
