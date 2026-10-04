import { splitProRata } from "@tab402/core";

export interface ItemFees {
  processorFeeMicros: number;
  platformFeeMicros: number;
  netMicros: number;
}

/**
 * Split one capture's processor fee pro rata by gross, take the platform fee per item, and
 * compute what each seller is owed (payable = gross − pro-rata fee − Tab402 fee).
 * Net never goes negative: the platform fee absorbs the shortfall first.
 */
export function allocateFees(
  grossByItem: readonly number[],
  processorFeeMicros: number,
  platformFeeBps: number,
): ItemFees[] {
  const processor = splitProRata(processorFeeMicros, grossByItem);
  return grossByItem.map((gross, i) => {
    const proc = Math.min(processor[i] ?? 0, gross);
    const platform = Math.min(Math.floor((gross * platformFeeBps) / 10_000), gross - proc);
    return {
      processorFeeMicros: proc,
      platformFeeMicros: platform,
      netMicros: gross - proc - platform,
    };
  });
}
