import { MICROS_PER_CENT, MICROS_PER_USD, MoneyError } from "@tab402/core";

export { floorToCents, MICROS_PER_CENT } from "@tab402/core";

/** 10_000_000 → "10.00". Throws on sub-cent amounts — callers must floor first. */
export function microsToPayPal(micros: number): string {
  if (!Number.isSafeInteger(micros) || micros < 0 || micros % MICROS_PER_CENT !== 0) {
    throw new MoneyError(`not a whole-cent amount: ${micros}`);
  }
  const cents = micros / MICROS_PER_CENT;
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** "9.16" → 9_160_000. Accepts PayPal's decimal strings (up to 2 dp for USD; tolerant up to 6). */
export function payPalToMicros(value: string): number {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!m) throw new MoneyError(`invalid PayPal amount: "${value}"`);
  return Number(m[1]) * MICROS_PER_USD + Number((m[2] ?? "").padEnd(6, "0"));
}
