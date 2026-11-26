import { describe, it, expect } from 'vitest';
import { runOnce, type ClaimResult, type RunOnceStore } from '../../Backend/src/idempotency';

describe('runOnce claim race', () => {
  it('duplicate loser observes processedAt real or null and work runs once', async () => {
    let claimCount = 0;
    let resolveSecondClaim!: (result: ClaimResult) => void;
    const secondClaim = new Promise<ClaimResult>((resolve) => {
      resolveSecondClaim = resolve;
    });

    let workCalls = 0;
    const store: RunOnceStore = {
      async claim() {
        claimCount += 1;
        if (claimCount === 1) {
          return { claimed: true, processedAt: null };
        }
        return secondClaim;
      },
      async markProcessed() {},
    };

    const work = async () => {
      workCalls += 1;
      return 'ok';
    };

    const firstCall = runOnce('same-key', work, store);
    const secondCall = runOnce('same-key', work, store);

    const firstOutcome = await firstCall;
    resolveSecondClaim({ claimed: false, processedAt: firstOutcome.processedAt });
    const secondOutcome = await secondCall;

    expect(workCalls).toBe(1);
    expect(firstOutcome).toMatchObject({ duplicate: false, value: 'ok' });
    expect(secondOutcome.duplicate).toBe(true);
    expect(
      secondOutcome.processedAt === null || typeof secondOutcome.processedAt === 'number',
    ).toBe(true);
  });
});