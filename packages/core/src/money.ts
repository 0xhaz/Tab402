/**
 * Money is integer micro-USD everywhere (6 decimals, matching USDC). No floats.
 * Values are JS safe integers: the ceiling is ~$9 billion, far above any single tab or payout.
 */

export const MICROS_PER_USD = 1_000_000;

/** Fiat rails move whole cents. 1 cent = 10,000 micro-USD. */
export const MICROS_PER_CENT = 10_000;

export class MoneyError extends Error {
  override name = "MoneyError";
}

export function isMicros(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function assertMicros(value: unknown, label = "amount"): asserts value is number {
  if (!isMicros(value)) throw new MoneyError(`${label} must be a non-negative safe integer`);
}

/** Parse a wire amount ("10000") into micros. Rejects decimals, signs, whitespace and leading zeros. */
export function parseMicros(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new MoneyError(`invalid micro-unit amount: "${value}"`);
  const n = Number(value);
  assertMicros(n);
  return n;
}

export function microsToWire(micros: number): string {
  assertMicros(micros);
  return String(micros);
}

/** "0.01" → 10000. Up to 6 decimal places; no float arithmetic. */
export function usdToMicros(usd: string): number {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(usd);
  if (!match) throw new MoneyError(`invalid USD amount: "${usd}"`);
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").padEnd(6, "0");
  const n = Number(whole) * MICROS_PER_USD + Number(fraction);
  assertMicros(n);
  return n;
}

/** 10000 → "$0.01"; 4200 → "$0.0042". Always at least 2 decimals, trailing zeros trimmed beyond that. */
export function formatUsd(micros: number): string {
  assertMicros(micros);
  const whole = Math.floor(micros / MICROS_PER_USD);
  let fraction = String(micros % MICROS_PER_USD).padStart(6, "0");
  fraction = fraction.replace(/0+$/, "").padEnd(2, "0");
  return `$${whole.toLocaleString("en-US")}.${fraction}`;
}

/**
 * Split `total` across `weights` pro rata, using the largest-remainder method so the parts
 * always sum exactly to `total`. Ties go to the earlier index (deterministic).
 * Used for processor-fee allocation across sellers in one capture.
 */
export function splitProRata(total: number, weights: readonly number[]): number[] {
  assertMicros(total, "total");
  for (const [i, w] of weights.entries()) assertMicros(w, `weights[${i}]`);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (sum === 0) {
    if (total === 0) return weights.map(() => 0);
    throw new MoneyError("cannot split a non-zero total across zero weights");
  }

  const bigTotal = BigInt(total);
  const bigSum = BigInt(sum);
  const parts = weights.map((w) => {
    const numerator = bigTotal * BigInt(w);
    return { floor: numerator / bigSum, remainder: numerator % bigSum };
  });

  let leftover = Number(bigTotal - parts.reduce((a, p) => a + p.floor, 0n));
  const order = parts
    .map((p, i) => ({ i, remainder: p.remainder }))
    .sort((a, b) => (a.remainder === b.remainder ? a.i - b.i : a.remainder > b.remainder ? -1 : 1));

  const result = parts.map((p) => Number(p.floor));
  for (const { i } of order) {
    if (leftover === 0) break;
    result[i] = (result[i] ?? 0) + 1;
    leftover--;
  }
  return result;
}

/** Largest whole-cent amount ≤ micros, and the sub-cent remainder to carry forward. */
export function floorToCents(micros: number): { cents: number; remainder: number } {
  assertMicros(micros);
  const remainder = micros % MICROS_PER_CENT;
  return { cents: micros - remainder, remainder };
}
