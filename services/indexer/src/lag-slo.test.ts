import {
  DEFAULT_LAG_SLO_LEDGERS,
  evaluateLagSlo,
  resolveLagSloLedgers,
} from "./lag-slo";

describe("resolveLagSloLedgers", () => {
  it("accepts a positive integer and floors fractions", () => {
    expect(resolveLagSloLedgers(12)).toBe(12);
    expect(resolveLagSloLedgers(12.9)).toBe(12);
  });

  it("falls back to the default for missing or unusable values", () => {
    expect(resolveLagSloLedgers(undefined)).toBe(DEFAULT_LAG_SLO_LEDGERS);
    expect(resolveLagSloLedgers(0)).toBe(DEFAULT_LAG_SLO_LEDGERS);
    expect(resolveLagSloLedgers(-4)).toBe(DEFAULT_LAG_SLO_LEDGERS);
    expect(resolveLagSloLedgers(Number.NaN)).toBe(DEFAULT_LAG_SLO_LEDGERS);
    expect(resolveLagSloLedgers(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_LAG_SLO_LEDGERS
    );
  });
});

describe("evaluateLagSlo", () => {
  it("reports unknown, not a breach, when head-ledger data is missing", () => {
    const snapshot = evaluateLagSlo(-1, 20);
    expect(snapshot).toEqual({
      targetLedgers: 20,
      lagLedgers: -1,
      status: "unknown",
      breached: false,
      headLedgerKnown: false,
    });
  });

  it("reports ok for a healthy indexer that is behind but within budget", () => {
    const snapshot = evaluateLagSlo(8, 20);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.breached).toBe(false);
    expect(snapshot.headLedgerKnown).toBe(true);
    expect(snapshot.lagLedgers).toBe(8);
  });

  it("treats exactly the target as within budget", () => {
    expect(evaluateLagSlo(20, 20).status).toBe("ok");
  });

  it("breaches only once lag exceeds the target", () => {
    const snapshot = evaluateLagSlo(21, 20);
    expect(snapshot.status).toBe("breached");
    expect(snapshot.breached).toBe(true);
  });

  it("resolves an invalid target instead of disabling alerting", () => {
    const snapshot = evaluateLagSlo(100, 0);
    expect(snapshot.targetLedgers).toBe(DEFAULT_LAG_SLO_LEDGERS);
    expect(snapshot.breached).toBe(true);
  });
});
