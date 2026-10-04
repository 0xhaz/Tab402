/** Settlement rules. Defaults are the DECIDED values; all are overridable. */
export interface LedgerConfig {
  /** Tab402's cut of gross, in basis points (200 = 2%). */
  platformFeeBps: number;
  /** Settle a post-paid tab when it reaches this... */
  settleThresholdMicros: number;
  /** ...or this long after its first unsettled charge. */
  settleAfterMs: number;
  /** Tabs under this after `settleAfterMs` roll over... */
  smallTabMicros: number;
  /** ...until they reach the threshold or this age. */
  smallTabMaxAgeMs: number;
  /** Open-tab caps: new buyers, and buyers with `trustedAfterCaptures` successful captures. */
  creditLimitNewMicros: number;
  creditLimitTrustedMicros: number;
  trustedAfterCaptures: number;
  /** A declined capture is retried until this many attempts, then written off. */
  maxCaptureAttempts: number;
  /** Threshold payouts run for sellers whose payable reaches this. */
  payoutThresholdMicros: number;
}

export const DEFAULT_LEDGER_CONFIG: LedgerConfig = {
  platformFeeBps: 200,
  settleThresholdMicros: 10_000_000,
  settleAfterMs: 24 * 3600_000,
  smallTabMicros: 1_000_000,
  smallTabMaxAgeMs: 30 * 24 * 3600_000,
  creditLimitNewMicros: 10_000_000,
  creditLimitTrustedMicros: 25_000_000,
  trustedAfterCaptures: 3,
  maxCaptureAttempts: 2,
  payoutThresholdMicros: 20_000_000,
};
