import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openSecret, parseMasterKey, rewrapSecret, sealSecret } from "../src/envelope";

const master = randomBytes(32);

describe("envelope encryption", () => {
  it("round-trips and never contains the plaintext", () => {
    const blob = sealSecret(master, "sel_1", "paypal_client_secret", "s3cr3t-value");
    expect(blob).not.toContain("s3cr3t");
    expect(openSecret(master, "sel_1", "paypal_client_secret", blob)).toBe("s3cr3t-value");
  });

  it("uses a fresh data key and IV each time", () => {
    const a = sealSecret(master, "sel_1", "k", "same");
    const b = sealSecret(master, "sel_1", "k", "same");
    expect(a).not.toBe(b);
  });

  it("binds the blob to its owner and kind", () => {
    const blob = sealSecret(master, "sel_1", "paypal_client_secret", "x");
    expect(() => openSecret(master, "sel_2", "paypal_client_secret", blob)).toThrow();
    expect(() => openSecret(master, "sel_1", "webhook_signing_secret", blob)).toThrow();
  });

  it("fails on a wrong master key or tampering", () => {
    const blob = sealSecret(master, "sel_1", "k", "x");
    expect(() => openSecret(randomBytes(32), "sel_1", "k", blob)).toThrow();
    const parts = blob.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => openSecret(master, "sel_1", "k", parts.join("."))).toThrow();
  });

  it("rotates by re-wrapping the data key", () => {
    const next = randomBytes(32);
    const blob = sealSecret(master, "sel_1", "k", "rotate-me");
    const rewrapped = rewrapSecret(master, next, "sel_1", "k", blob);
    expect(rewrapped.split(".")[3]).toBe(blob.split(".")[3]);
    expect(openSecret(next, "sel_1", "k", rewrapped)).toBe("rotate-me");
    expect(() => openSecret(master, "sel_1", "k", rewrapped)).toThrow();
  });

  it("validates master key length", () => {
    expect(() => parseMasterKey(randomBytes(16).toString("base64"))).toThrow();
    expect(parseMasterKey(master.toString("base64")).equals(master)).toBe(true);
  });
});
