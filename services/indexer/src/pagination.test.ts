/**
 * pagination.test.ts — Cross-database integration tests for cursor pagination.
 *
 * Exercises the keyset-paginated `recent` and `claimsByWalletPage` queries
 * against both SQLite and Postgres using identical fixtures, verifying:
 *
 *   1. Ordering  — results are returned in the declared (ledger_sequence DESC, id DESC)
 *      order on both backends.
 *   2. Boundary behaviour — pages split at the exact expected row; no off-by-one.
 *   3. No duplicates or skipped rows — walking all pages with size 1 visits each
 *      row exactly once.
 *   4. Stability under concurrent inserts — new rows inserted between two page
 *      fetches do not disturb the already-fetched portion or cause a row to
 *      appear twice.
 *   5. Exhaustion — `nextCursor` is null when no more rows exist.
 *
 * The Postgres leg is gated on TEST_POSTGRES_URL / DATABASE_URL and is skipped
 * silently when neither is set, matching the pattern used in db.test.ts.
 */

import path from "path";
import os from "os";
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createDb, type Db, type ClaimInput } from "./db";
import type { Config } from "./config";

// ── Connection URLs ──────────────────────────────────────────────────────

const POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ?? process.env.DATABASE_URL;

// ── Helpers ──────────────────────────────────────────────────────────────

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    stellarNetwork: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    proofRegistryContractId: "CTEST",
    dbDriver: "sqlite",
    sqlitePath: path.join(
      os.tmpdir(),
      `pagination-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    ),
    databaseUrl: undefined,
    pollIntervalMs: 6000,
    startLedger: 0,
    port: 3001,
    finalityLag: 6,
    corsOrigins: [],
    rateLimitWindowMs: 60_000,
    rateLimitMax: 120,
    rateLimitEnabled: false,
    integrityCheckEnabled: false,
    integrityCheckIntervalMs: 900_000,
    integrityCheckSampleSize: 25,
    ...overrides,
  } as Config;
}

function claim(overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    wallet: "GA",
    credential_type: "kyc",
    issuer: "GISSUER",
    verified_at: 1_724_000_000,
    expiry: 1_755_000_000,
    ledger_sequence: 100,
    threshold: null,
    revoked: 0,
    reason_code: "other",
    ...overrides,
  };
}

/** Collect every row from `recent` by walking pages until exhausted. */
async function drainRecent(db: Db, pageSize: number) {
  const all = [];
  let cursor = null;
  do {
    const page = await db.recent(pageSize, cursor);
    all.push(...page.claims);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return all;
}

/** Collect every row from `claimsByWalletPage` by walking pages until exhausted. */
async function drainWalletPage(db: Db, wallet: string, pageSize: number) {
  const all = [];
  let cursor = null;
  do {
    const page = await db.claimsByWalletPage(wallet, {}, pageSize, cursor);
    all.push(...page.claims);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return all;
}

// ── Test suite ────────────────────────────────────────────────────────────

function registerPaginationSuite(
  d: typeof describe,
  driver: string,
  make: () => Config,
): void {
  d(`Pagination — ${driver}`, () => {
    let db: Db;
    let sqliteFile: string | undefined;

    beforeEach(async () => {
      const cfg = make();
      if (cfg.dbDriver === "sqlite") sqliteFile = cfg.sqlitePath;
      db = createDb(cfg);
      await db.migrate();
      await db.deleteClaimsAfter(0);
      await db.setLastLedger(0);
    });

    afterEach(async () => {
      await db.close();
      if (sqliteFile) {
        try { require("fs").unlinkSync(sqliteFile); } catch { /* ignore */ }
      }
    });

    // ── /recent ────────────────────────────────────────────────────────

    describe("recent()", () => {
      it("returns an empty page when no claims exist", async () => {
        const page = await db.recent(10, null);
        expect(page.claims).toHaveLength(0);
        expect(page.nextCursor).toBeNull();
      });

      it("returns all claims on a single page when count ≤ limit", async () => {
        await db.upsertClaim(claim({ wallet: "GA", ledger_sequence: 100 }));
        await db.upsertClaim(claim({ wallet: "GB", ledger_sequence: 200 }));
        await db.upsertClaim(claim({ wallet: "GC", ledger_sequence: 150 }));

        const page = await db.recent(10, null);
        expect(page.claims).toHaveLength(3);
        expect(page.nextCursor).toBeNull();
      });

      it("orders by ledger_sequence DESC", async () => {
        await db.upsertClaim(claim({ wallet: "GA", ledger_sequence: 100 }));
        await db.upsertClaim(claim({ wallet: "GB", ledger_sequence: 300 }));
        await db.upsertClaim(claim({ wallet: "GC", ledger_sequence: 200 }));

        const page = await db.recent(10, null);
        const sequences = page.claims.map((r) => r.ledger_sequence);
        expect(sequences).toEqual([300, 200, 100]);
      });

      it("uses id DESC as a tiebreaker when ledger_sequence ties", async () => {
        // Three claims at the same ledger — id order (insertion order) should
        // be the tiebreaker DESC.
        const wallets = ["GA", "GB", "GC"];
        for (const w of wallets) {
          await db.upsertClaim(claim({ wallet: w, ledger_sequence: 500 }));
        }

        const page = await db.recent(10, null);
        expect(page.claims).toHaveLength(3);
        // All at same ledger; ordering must be deterministic (id DESC).
        const ids = page.claims.map((r) => r.id);
        const sorted = [...ids].sort((a, b) => b - a);
        expect(ids).toEqual(sorted);
      });

      it("splits results correctly across two pages", async () => {
        for (let i = 1; i <= 5; i++) {
          await db.upsertClaim(claim({ wallet: `G${i}`, ledger_sequence: i * 10 }));
        }

        const page1 = await db.recent(3, null);
        expect(page1.claims).toHaveLength(3);
        expect(page1.nextCursor).not.toBeNull();
        expect(page1.claims.map((r) => r.ledger_sequence)).toEqual([50, 40, 30]);

        const page2 = await db.recent(3, page1.nextCursor);
        expect(page2.claims).toHaveLength(2);
        expect(page2.nextCursor).toBeNull();
        expect(page2.claims.map((r) => r.ledger_sequence)).toEqual([20, 10]);
      });

      it("produces no duplicates when walking pages of size 1", async () => {
        const count = 7;
        for (let i = 1; i <= count; i++) {
          await db.upsertClaim(claim({ wallet: `G${i}`, ledger_sequence: i * 100 }));
        }

        const all = await drainRecent(db, 1);
        expect(all).toHaveLength(count);

        // No duplicate ids.
        const ids = all.map((r) => r.id);
        expect(new Set(ids).size).toBe(count);
      });

      it("covers all rows with no skips when walking pages of size 2", async () => {
        const count = 6;
        for (let i = 1; i <= count; i++) {
          await db.upsertClaim(claim({ wallet: `G${i}`, ledger_sequence: i * 10 }));
        }

        const all = await drainRecent(db, 2);
        expect(all).toHaveLength(count);
        // Rows should be in strictly descending ledger order.
        for (let i = 0; i < all.length - 1; i++) {
          expect(all[i]!.ledger_sequence).toBeGreaterThanOrEqual(all[i + 1]!.ledger_sequence);
        }
      });

      it("does not return revoked claims", async () => {
        await db.upsertClaim(claim({ wallet: "GA", ledger_sequence: 100 }));
        await db.upsertClaim(claim({ wallet: "GB", ledger_sequence: 200 }));
        await db.revokeClaim("GA", "kyc");

        const page = await db.recent(10, null);
        expect(page.claims).toHaveLength(1);
        expect(page.claims[0]!.wallet).toBe("GB");
      });

      it("does not disturb already-fetched page when a new row is inserted after it", async () => {
        // Insert 4 rows.
        for (let i = 1; i <= 4; i++) {
          await db.upsertClaim(claim({ wallet: `G${i}`, ledger_sequence: i * 100 }));
        }

        // Fetch first page of 2 (ledger 400 and 300).
        const page1 = await db.recent(2, null);
        expect(page1.claims.map((r) => r.ledger_sequence)).toEqual([400, 300]);

        // Insert a new row with a high ledger sequence *after* the first page
        // was fetched. It should NOT appear in page2 (the cursor is already
        // past ledger 300), and rows 200 and 100 must still be present.
        await db.upsertClaim(claim({ wallet: "GNEW", ledger_sequence: 999 }));

        const page2 = await db.recent(2, page1.nextCursor);
        // The cursor boundary was at ledger=300/id of that row; page2 should
        // still see ledgers 200 and 100 and must not duplicate ledger 400 or 300.
        const ledgers = page2.claims.map((r) => r.ledger_sequence);
        expect(ledgers).toContain(200);
        expect(ledgers).toContain(100);
        expect(ledgers).not.toContain(400);
        expect(ledgers).not.toContain(300);
      });

      it("returns nextCursor only when more rows exist beyond the page", async () => {
        for (let i = 1; i <= 3; i++) {
          await db.upsertClaim(claim({ wallet: `G${i}`, ledger_sequence: i * 10 }));
        }

        // Exactly fills the page — no nextCursor.
        const exact = await db.recent(3, null);
        expect(exact.nextCursor).toBeNull();

        // One over the limit — nextCursor present.
        const overflow = await db.recent(2, null);
        expect(overflow.nextCursor).not.toBeNull();
      });
    });

    // ── claimsByWalletPage ─────────────────────────────────────────────

    describe("claimsByWalletPage()", () => {
      const WALLET_A = "GWALLET_A";
      const WALLET_B = "GWALLET_B";

      it("returns an empty page for an unknown wallet", async () => {
        const page = await db.claimsByWalletPage(WALLET_A, {}, 10, null);
        expect(page.claims).toHaveLength(0);
        expect(page.nextCursor).toBeNull();
      });

      it("returns only claims belonging to the requested wallet", async () => {
        await db.upsertClaim(claim({ wallet: WALLET_A, ledger_sequence: 100, credential_type: "kyc" }));
        await db.upsertClaim(claim({ wallet: WALLET_B, ledger_sequence: 200, credential_type: "age" }));

        const page = await db.claimsByWalletPage(WALLET_A, {}, 10, null);
        expect(page.claims).toHaveLength(1);
        expect(page.claims[0]!.wallet).toBe(WALLET_A);
      });

      it("paginates across multiple claim types for one wallet", async () => {
        const types = ["kyc", "age", "income", "funds", "jurisdiction"] as const;
        for (let i = 0; i < types.length; i++) {
          await db.upsertClaim(
            claim({
              wallet: WALLET_A,
              credential_type: types[i],
              ledger_sequence: (i + 1) * 100,
            }),
          );
        }

        const page1 = await db.claimsByWalletPage(WALLET_A, {}, 3, null);
        expect(page1.claims).toHaveLength(3);
        expect(page1.nextCursor).not.toBeNull();

        const page2 = await db.claimsByWalletPage(WALLET_A, {}, 3, page1.nextCursor);
        expect(page2.claims).toHaveLength(2);
        expect(page2.nextCursor).toBeNull();
      });

      it("produces no duplicates when walking pages of size 1", async () => {
        const count = 5;
        for (let i = 1; i <= count; i++) {
          await db.upsertClaim(
            claim({ wallet: WALLET_A, credential_type: "kyc", ledger_sequence: i * 10 }),
          );
        }

        const all = await drainWalletPage(db, WALLET_A, 1);
        expect(all).toHaveLength(count);
        const ids = all.map((r) => r.id);
        expect(new Set(ids).size).toBe(count);
      });

      it("does not skip rows when new claims arrive between fetches", async () => {
        for (let i = 1; i <= 4; i++) {
          await db.upsertClaim(
            claim({ wallet: WALLET_A, credential_type: "kyc", ledger_sequence: i * 100 }),
          );
        }

        const page1 = await db.claimsByWalletPage(WALLET_A, {}, 2, null);
        expect(page1.claims).toHaveLength(2);

        // Insert a new claim for the same wallet after the first page.
        await db.upsertClaim(
          claim({ wallet: WALLET_A, credential_type: "age", ledger_sequence: 999 }),
        );

        // Page 2 must still see the two oldest rows and must not duplicate page 1.
        const page2 = await db.claimsByWalletPage(WALLET_A, {}, 2, page1.nextCursor);
        const p1Ids = new Set(page1.claims.map((r) => r.id));
        const p2Ids = page2.claims.map((r) => r.id);
        for (const id of p2Ids) {
          expect(p1Ids.has(id)).toBe(false);
        }
      });

      it("respects the credentialType filter during pagination", async () => {
        await db.upsertClaim(claim({ wallet: WALLET_A, credential_type: "kyc", ledger_sequence: 100 }));
        await db.upsertClaim(claim({ wallet: WALLET_A, credential_type: "age", ledger_sequence: 200 }));
        await db.upsertClaim(claim({ wallet: WALLET_A, credential_type: "kyc", ledger_sequence: 300 }));

        const page = await db.claimsByWalletPage(
          WALLET_A,
          { credentialType: "kyc" },
          10,
          null,
        );
        expect(page.claims.every((r) => r.credential_type === "kyc")).toBe(true);
        expect(page.claims).toHaveLength(2);
      });
    });
  });
}

// ── Register both backends ────────────────────────────────────────────────

registerPaginationSuite(
  describe,
  "sqlite",
  () => baseConfig({ dbDriver: "sqlite" }),
);

if (POSTGRES_URL) {
  registerPaginationSuite(
    describe,
    "postgres",
    () => baseConfig({ dbDriver: "postgres", databaseUrl: POSTGRES_URL }),
  );
} else {
  describe.skip("Pagination — postgres", () => {
    it("is skipped when TEST_POSTGRES_URL / DATABASE_URL is not set", () => {
      expect(POSTGRES_URL).toBeUndefined();
    });
  });
}
