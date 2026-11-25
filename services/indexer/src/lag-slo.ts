/**
 * lag-slo.ts — Machine-readable ledger-lag SLO (API-13).
 *
 * Ledger lag is defined as:
 *
 *     lag = headLedger - lastSuccessLedger
 *
 * where `headLedger` is the newest ledger the ingester observed on its most
 * recent tick, and `lastSuccessLedger` is the newest ledger whose events were
 * fully persisted (the durable checkpoint and cursor are already folded into
 * that value by the ingester). A lag of `-1` means the head ledger has not been
 * read yet, so the SLO status is `"unknown"` rather than a false breach.
 *
 * A status of `"ok"` says the indexer is within its lag budget; it does not
 * claim the ingester is healthy. Fetch-error health is reported separately by
 * `statusFromHealth`, so an ingester that is healthy but behind (lag > 0 but
 * within the target) still reports `"ok"` here.
 */

/** Lag budget used when `INDEXER_LAG_SLO_LEDGERS` is unset. */
export const DEFAULT_LAG_SLO_LEDGERS = 30;

export type LagSloStatus = "ok" | "breached" | "unknown";

export interface LagSloSnapshot {
  /** Configured budget, in ledgers. */
  targetLedgers: number;
  /** `headLedger - lastSuccessLedger`, or -1 when the head is unknown. */
  lagLedgers: number;
  status: LagSloStatus;
  /** True only when the lag is known and greater than the target. */
  breached: boolean;
  /** False until the ingester has read a head ledger. */
  headLedgerKnown: boolean;
}

/**
 * Resolve a usable lag target from an env/config value: a positive integer or
 * the documented default. Non-numeric, zero and negative values degrade to the
 * default rather than switching alerting off.
 */
export function resolveLagSloLedgers(value?: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return DEFAULT_LAG_SLO_LEDGERS;
  }
  return Math.floor(value);
}

/** Evaluate the lag SLO for one observed lag value. */
export function evaluateLagSlo(
  lagLedgers: number,
  targetLedgers: number = DEFAULT_LAG_SLO_LEDGERS
): LagSloSnapshot {
  const target = resolveLagSloLedgers(targetLedgers);
  if (lagLedgers < 0) {
    return {
      targetLedgers: target,
      lagLedgers: -1,
      status: "unknown",
      breached: false,
      headLedgerKnown: false,
    };
  }

  const breached = lagLedgers > target;
  return {
    targetLedgers: target,
    lagLedgers,
    status: breached ? "breached" : "ok",
    breached,
    headLedgerKnown: true,
  };
}
