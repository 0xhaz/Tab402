import { describe, expect, it } from "vitest";
import {
  assertTransition,
  CHARGE_TRANSITIONS,
  type ChargeState,
  canTransition,
  InvalidTransitionError,
  moneyState,
} from "../src/charge-state";

describe("charge state machine", () => {
  it("follows the happy path earned → collected → paid_out", () => {
    expect(canTransition("earned", "collected")).toBe(true);
    expect(canTransition("collected", "paid_out")).toBe(true);
  });

  it("never skips collection or moves backwards", () => {
    expect(canTransition("earned", "paid_out")).toBe(false);
    expect(canTransition("paid_out", "collected")).toBe(false);
    expect(canTransition("collected", "earned")).toBe(false);
    expect(() => assertTransition("earned", "paid_out")).toThrow(InvalidTransitionError);
  });

  it("treats refunded and written_off as terminal", () => {
    const states = Object.keys(CHARGE_TRANSITIONS) as ChargeState[];
    for (const to of states) {
      expect(canTransition("refunded", to)).toBe(false);
      expect(canTransition("written_off", to)).toBe(false);
    }
  });

  it("allows refund netting before capture and clawback after payout", () => {
    expect(canTransition("earned", "refunded")).toBe(true);
    expect(canTransition("paid_out", "refunded")).toBe(true);
  });

  it("maps side states to no money state", () => {
    expect(moneyState("collected")).toBe("collected");
    expect(moneyState("disputed")).toBeNull();
  });
});
