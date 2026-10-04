import { describe, expect, it } from "vitest";
import { formatUsd, MoneyError, parseMicros, splitProRata, usdToMicros } from "../src/money";

describe("parseMicros", () => {
  it("parses wire amounts", () => {
    expect(parseMicros("10000")).toBe(10_000);
    expect(parseMicros("0")).toBe(0);
  });
  it.each(["", "-1", "1.5", "01", " 1", "1e6", "9007199254740993"])("rejects %j", (v) => {
    expect(() => parseMicros(v)).toThrow(MoneyError);
  });
});

describe("usdToMicros / formatUsd", () => {
  it("converts without floats", () => {
    expect(usdToMicros("0.01")).toBe(10_000);
    expect(usdToMicros("0.1")).toBe(100_000);
    expect(usdToMicros("10")).toBe(10_000_000);
    expect(usdToMicros("0.000001")).toBe(1);
    expect(usdToMicros("1234.567891")).toBe(1_234_567_891);
  });
  it("rejects more than 6 decimals and junk", () => {
    expect(() => usdToMicros("0.0000001")).toThrow(MoneyError);
    expect(() => usdToMicros("$1")).toThrow(MoneyError);
    expect(() => usdToMicros(".5")).toThrow(MoneyError);
  });
  it("formats", () => {
    expect(formatUsd(10_000)).toBe("$0.01");
    expect(formatUsd(4_200)).toBe("$0.0042");
    expect(formatUsd(10_000_000)).toBe("$10.00");
    expect(formatUsd(1_234_567_891)).toBe("$1,234.567891");
    expect(formatUsd(0)).toBe("$0.00");
  });
});

describe("splitProRata", () => {
  it("always sums exactly to the total", () => {
    for (let trial = 0; trial < 500; trial++) {
      const n = 1 + Math.floor(Math.random() * 12);
      const weights = Array.from({ length: n }, () => Math.floor(Math.random() * 5_000_000));
      const total = Math.floor(Math.random() * 1_000_000);
      if (weights.every((w) => w === 0)) continue;
      const parts = splitProRata(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      parts.forEach((p) => {
        expect(Number.isSafeInteger(p) && p >= 0).toBe(true);
      });
    }
  });
  it("is proportional and deterministic on ties", () => {
    expect(splitProRata(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(splitProRata(590_000, [6_000_000, 4_000_000])).toEqual([354_000, 236_000]);
  });
  it("handles zero weights", () => {
    expect(splitProRata(0, [0, 0])).toEqual([0, 0]);
    expect(() => splitProRata(1, [0, 0])).toThrow(MoneyError);
    expect(splitProRata(10, [0, 5])).toEqual([0, 10]);
  });
  it("does not overflow on large values", () => {
    const parts = splitProRata(9_000_000_000_000, [3_000_000_000_000, 6_000_000_000_000]);
    expect(parts).toEqual([3_000_000_000_000, 6_000_000_000_000]);
  });
});
