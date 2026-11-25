export interface ClaimResult {
  claimed: boolean;
  processedAt: number | null;
}

export interface RunOnceStore {
  claim(key: string): Promise<ClaimResult>;
  markProcessed(key: string, processedAt: number): Promise<void> | void;
}

export type RunOnceOutcome<T> =
  | { duplicate: false; processedAt: number; value: T }
  | { duplicate: true; processedAt: number | null };

export async function runOnce<T>(
  key: string,
  work: () => Promise<T> | T,
  store: RunOnceStore,
): Promise<RunOnceOutcome<T>> {
  const claim = await store.claim(key);

  if (!claim.claimed) {
    return { duplicate: true, processedAt: claim.processedAt };
  }

  const value = await work();
  const processedAt = Date.now();
  await store.markProcessed(key, processedAt);
  return { duplicate: false, processedAt, value };
}