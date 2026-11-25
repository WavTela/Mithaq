/**
 * check-types-drift.ts — Verify that the public indexer types in
 * sdk/src/indexer-types.ts stay in sync with the actual HTTP response shapes
 * the indexer produces in services/indexer/src/api.ts.
 *
 * The script compares, for each key response type, that every non-deprecated
 * field present in the actual response is also declared in the SDK type, and
 * that no SDK type adds fields the response does not contain.
 *
 * Run:
 *   npx ts-node --esm sdk/scripts/check-types-drift.ts
 *
 * In CI, this is run as part of the `check-drift` npm script in sdk/package.json.
 * The process exits with code 1 if any drift is detected.
 */

// ── Known wire fields per endpoint ────────────────────────────────────────
// These are the actual fields serialized by serializeClaim() and the stats /
// recent endpoint handlers in services/indexer/src/api.ts. Update this map
// when the wire format changes.

const WIRE_CLAIM_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "wallet",
  "credential_type",
  "issuer",
  "verified_at",
  "expiry",
  "ledger_sequence",
  "threshold",
  "reason_code",
  "revoked",
  "expired",
  "state",
]);

const WIRE_STATS_ENTRY_FIELDS: ReadonlySet<string> = new Set([
  "credential_type",
  "total",
  "active",
  "revoked",
]);

const WIRE_ISSUER_STATS_FIELDS: ReadonlySet<string> = new Set([
  "issuer",
  "total",
  "active",
  "revoked",
  "credential_types",
  "first_seen",
]);

const WIRE_WEBHOOK_DELIVERY_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "subscription_id",
  "event_id",
  "type",
  "wallet",
  "credential_type",
  "expiry",
  "ledger_sequence",
  "occurred_at",
  "reason_code",
  "target_url",
  "attempts",
  "next_attempt_at",
  "delivered_at",
  "last_error",
]);

// ── SDK declared fields per type ──────────────────────────────────────────
// Extracted by reading sdk/src/indexer-types.ts. These match the TypeScript
// interface field names; deprecated fields are still kept here until removed.

const SDK_CLAIM_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "wallet",
  "credential_type",
  "issuer",
  "verified_at",
  "expiry",
  "ledger_sequence",
  "threshold",
  "reason_code",
  "revoked",
  "expired",
  "state",
]);

const SDK_STATS_ENTRY_FIELDS: ReadonlySet<string> = new Set([
  "credential_type",
  "total",
  "active",
  "revoked",
]);

const SDK_ISSUER_STATS_FIELDS: ReadonlySet<string> = new Set([
  "issuer",
  "total",
  "active",
  "revoked",
  "credential_types",
  "first_seen",
]);

const SDK_WEBHOOK_DELIVERY_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "subscription_id",
  "event_id",
  "type",
  "wallet",
  "credential_type",
  "expiry",
  "ledger_sequence",
  "occurred_at",
  "reason_code",
  "target_url",
  "attempts",
  "next_attempt_at",
  "delivered_at",
  "last_error",
]);

// ── Drift comparison ──────────────────────────────────────────────────────

function checkDrift(
  typeName: string,
  wire: ReadonlySet<string>,
  sdk: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];

  for (const field of wire) {
    if (!sdk.has(field)) {
      errors.push(`${typeName}: wire field "${field}" is missing from SDK type`);
    }
  }

  for (const field of sdk) {
    if (!wire.has(field)) {
      errors.push(`${typeName}: SDK type declares "${field}" but it is not in the wire response`);
    }
  }

  return errors;
}

const allErrors = [
  ...checkDrift("IndexerClaim", WIRE_CLAIM_FIELDS, SDK_CLAIM_FIELDS),
  ...checkDrift("StatsEntry", WIRE_STATS_ENTRY_FIELDS, SDK_STATS_ENTRY_FIELDS),
  ...checkDrift("IssuerStatsResponse", WIRE_ISSUER_STATS_FIELDS, SDK_ISSUER_STATS_FIELDS),
  ...checkDrift("WebhookDeliveryRecord", WIRE_WEBHOOK_DELIVERY_FIELDS, SDK_WEBHOOK_DELIVERY_FIELDS),
];

if (allErrors.length > 0) {
  console.error("❌  Type drift detected between sdk/src/indexer-types.ts and the indexer wire format:\n");
  for (const err of allErrors) {
    console.error(`  • ${err}`);
  }
  console.error("\nUpdate sdk/src/indexer-types.ts or the WIRE_* sets in this script to fix the drift.");
  process.exit(1);
} else {
  console.log("✅  No type drift detected — SDK types match the indexer wire format.");
}
