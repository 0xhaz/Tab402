import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical";

// Vectors from RFC 8785 §3.2.2 / Appendix B.
describe("canonicalJson (RFC 8785)", () => {
  it("sorts keys by UTF-16 code units and strips whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: true, c: null } })).toBe(
      '{"a":{"c":null,"d":true},"b":1}',
    );
    expect(canonicalJson({ "€": 1, "\r": 2, "1": 3, ö: 4 })).toBe('{"\\r":2,"1":3,"ö":4,"€":1}');
  });
  it("serializes numbers per ECMAScript", () => {
    expect(canonicalJson([1e21, 1e-7, 0.000001, -0, 333333333.3333333])).toBe(
      "[1e+21,1e-7,0.000001,0,333333333.3333333]",
    );
  });
  it("is independent of insertion order", () => {
    const a = { channelId: "ch_1", seq: 2, cumulative: "20000" };
    const b = { cumulative: "20000", seq: 2, channelId: "ch_1" };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
  it("throws on non-serializable input", () => {
    expect(() => canonicalJson(undefined)).toThrow();
  });
});
