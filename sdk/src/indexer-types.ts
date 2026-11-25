/**
 * indexer-types.ts — Public TypeScript types for Mithaq indexer HTTP responses.
 *
 * These are the wire shapes the indexer emits over HTTP, consumed by the SDK,
 * the frontend, and any downstream integration. They are the single authoritative
 * source for all serialized claim, stats, and pagination responses.
 *
 * Rules:
 *   - Every field here must match the actual JSON the indexer returns.
 *   - Do not add fields that are not in the HTTP response — the type drift check
 *     (sdk/scripts/check-types-drift.ts) will catch mismatches.
 *   - Use `@deprecated` JSDoc to mark fields scheduled for removal, with the
 *     expected sunset date and the replacement field name.
 *
 * See docs/API_DEPRECATION.md for the deprecation process.
 */

// ── Claim response ─────────────────────────────────────────────────────────

/**
 * A single credential claim as returned by /claims, /recent, and
 * /wallets/:wallet/claims.
 */
export interface IndexerClaim {
  /** Auto-increment insertion cursor. Stable as a pagination tiebreaker. */
  id: number;
  /** Stellar wallet address (G…). */
  wallet: string;
  /** Credential type, e.g. "kyc", "age", "jurisdiction". */
  credential_type: string;
  /** Issuer Stellar address (G…). */
  issuer: string;
  /** Unix seconds when the proof was first verified on-chain. */
  verified_at: number;
  /** Unix seconds when the credential expires. */
  expiry: number;
  /** Ledger sequence number of the transaction that emitted the event. */
  ledger_sequence: number;
  /** Numeric threshold stored in the proof (age, income, funds); null otherwise. */
  threshold: number | null;
  /** Revocation reason code, e.g. "expired", "superseded", "fraud". */
  reason_code: string;
  /** 1 if the credential has been revoked, 0 otherwise. */
  revoked: number;
  /** True if the credential's expiry timestamp has passed. Derived server-side. */
  expired: boolean;
  /** Computed claim state: "active" | "expired" | "revoked". */
  state: "active" | "expired" | "revoked";
}

// ── /claims endpoint ───────────────────────────────────────────────────────

/** Response from GET /claims?wallet=G… */
export interface ClaimsResponse {
  wallet: string;
  claims: IndexerClaim[];
}

// ── /stats endpoint ────────────────────────────────────────────────────────

/** Aggregate counts per credential type, returned by GET /stats. */
export interface StatsEntry {
  credential_type: string;
  total: number;
  active: number;
  revoked: number;
}

/** Response from GET /stats. */
export interface StatsResponse {
  stats: StatsEntry[];
}

// ── /recent endpoint ───────────────────────────────────────────────────────

/** Response from GET /recent?limit=N&cursor=… */
export interface RecentResponse {
  claims: IndexerClaim[];
  limit: number;
  /** Opaque cursor to pass as `?cursor=` for the next page; null when exhausted. */
  nextCursor: string | null;
}

// ── /wallets/:wallet/claims endpoint ──────────────────────────────────────

/** Keyset pagination cursor for per-wallet claim pages. */
export interface WalletClaimCursor {
  ledgerSequence: number;
  id: number;
}

/** Response from GET /wallets/:wallet/claims with pagination. */
export interface WalletClaimsPageResponse {
  wallet: string;
  claims: IndexerClaim[];
  limit: number;
  nextCursor: string | null;
}

// ── /issuers/:issuer/stats endpoint ───────────────────────────────────────

/** Response from GET /issuers/:issuer/stats. */
export interface IssuerStatsResponse {
  issuer: string;
  total: number;
  active: number;
  revoked: number;
  /** Distinct credential types this issuer has issued, alphabetical. */
  credential_types: string[];
  /** Unix seconds of this issuer's earliest indexed claim; null if none. */
  first_seen: number | null;
}

// ── Webhook delivery types ─────────────────────────────────────────────────

/** A webhook delivery record as returned by /webhooks/subscriptions/:id/deliveries. */
export interface WebhookDeliveryRecord {
  id: number;
  subscription_id: number;
  event_id: string;
  type: "revoked" | "expired";
  wallet: string;
  credential_type: string;
  expiry: number;
  ledger_sequence: number;
  occurred_at: number;
  reason_code: string;
  target_url: string;
  attempts: number;
  next_attempt_at: number;
  delivered_at: number | null;
  last_error: string | null;
}

/** Pagination cursor for webhook delivery queries. */
export interface DeliveryPageCursor {
  occurredAt: number;
  id: number;
}

/** Response from GET /webhooks/subscriptions/:id/deliveries. */
export interface WebhookDeliveriesResponse {
  deliveries: WebhookDeliveryRecord[];
  nextCursor: DeliveryPageCursor | null;
}
