/**
 * api.ts â€” Read-only HTTP API for the indexer.
 *
 * Security & Access Model:
 *   - CORS: Configurable origin allowlist (via CORS_ORIGIN / CORS_ALLOWED_ORIGINS).
 *     Defaults to same-origin / default-deny in production; http://localhost:3000 in dev.
 *   - Rate Limiting: Per-IP fixed-window rate limiting with 429 Too Many Requests
 *     and Retry-After header. Configurable via RATE_LIMIT_WINDOW_SECONDS and RATE_LIMIT_MAX.
 *   - Authentication / API Keys: Public read endpoints do NOT require API keys.
 *     App review writes and webhook subscription management are protected by API_KEY.
 *
 * Endpoints:
 *
 *   GET /health
 *     â†’ { status, ready, service, version, uptimeSeconds, timestamp,
 *         lastLedger, headLedger, lag, lastError, lastErrorTime,
 *         consecutiveErrors, fetchAttempts, fetchFailures }
 *
 *   GET /claims?wallet=Gâ€¦
 *     â†’ { wallet: string, claims: SerializedClaim[] }
 *
 *   GET /stats
 *     â†’ { stats: StatsRow[] }
 *
 *   GET /recent?limit=20&cursor=<opaque>
 *     â†’ { claims: SerializedClaim[], limit: number, nextCursor: string | null }
 *
 *   GET /issuers/:issuer/stats
 *     â†’ { issuer, total, active, revoked, credential_types: string[], first_seen: number | null }
 *
 *   GET /apps
 *     â†’ { apps: AppSubmission[] }  (approved only)
 *
 *   GET /apps/:id
 *     â†’ { app: AppSubmission }
 *
 *   POST /apps/submit
 *     Body: { appName, description, requiredClaims, verifyUrl, contactEmail }
 *     â†’ { id: number, status: "pending" }
 *
 *   GET /integrity/status
 *     â†’ on-chain verification metadata for #612: when the last pass ran,
 *       whether it read every sampled claim, and the most recent mismatches
 *
 *   POST /integrity/check[?sampleSize=25]
 *     Body: none
 *     â†’ { checked, unreadable, mismatchCount, complete, durationSeconds,
 *         mismatches }  (requires API_KEY when one is configured)
 *
 *   POST /webhooks/subscriptions
 *     Body: { url, wallet, claimType } (requires API_KEY + WEBHOOK_SIGNING_SECRET)
 *     â†’ { id, wallet, claimType }
 *
 *   GET /webhooks/subscriptions[?wallet=Gâ€¦]
 *   DELETE /webhooks/subscriptions/:id
 *   GET /webhooks/subscriptions/:id/deliveries[?outcome=delivered|failed|retrying&startTime=N&endTime=N&limit=20&cursor=…]
 *     â†' { deliveries, limit, nextCursor }
 *
 * /recent uses keyset (cursor) pagination ordered by (ledger_sequence, id) â€”
 * the `nextCursor` returned with each page is an opaque token that must be
 * passed back as `?cursor=` to fetch the next page. Unlike OFFSET pagination
 * this stays stable (no duplicate/skipped rows) while new claims are ingested
 * between requests, and the indexed range scan never pays OFFSET's skip cost.
 *
 * All responses are JSON. Webhook targets receive public chain lifecycle data only.
 * No identity fields are stored, so all data here is public chain data.
 *
 * SerializedClaim response schema (pinned by tests in api.test.ts, identical
 * across both DB_DRIVER backends â€” see serializeClaim below):
 *
 *   id               number   insertion cursor; the /recent tiebreaker
 *   wallet           string
 *   credential_type  string
 *   issuer           string
 *   verified_at      number   unix seconds
 *   expiry           number   unix seconds
 *   ledger_sequence  number
 *   threshold        number | null
 *   revoked          number   0 or 1 â€” intentionally not a boolean; this is
 *                             the shape existing consumers (SDK/UI) already
 *                             code against, so it's pinned as-is rather than
 *                             changed to avoid a breaking wire-format change.
 *   expired          boolean  DERIVED: expiry > 0 && expiry <= now. The
 *                             contract enforces expiry lazily in is_verified
 *                             and emits no expiry event, so this is computed
 *                             by the indexer from the indexed `expiry`
 *                             timestamp â€” see integrity.ts.
 *   state            "active" | "expired" | "revoked"  DERIVED: revoked
 *                             wins, then locally-expired, then active.
 *
 * Consumers that need authoritative answers for `state === "expired"` claims
 * must make the live on-chain `is_verified` / `check_claim` call: once a
 * claim's expiry passes, the contract's TTL-bumped entry can be evicted from
 * state entirely, so the chain can no longer confirm anything about it.
 */

import express, {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";
import type { Db, ClaimRow, ClaimState, SubmissionStatus } from "./db";
import type { Ingester } from "./ingester";
import type { Config } from "./config";
import { parseCorsOrigins } from "./config";
import { createCorsMiddleware } from "./cors";
import { RateLimiter } from "./rate-limit";
import type { RecentCursor, DeliveryPageCursor } from "./db";
import { requireAuth } from "./auth";
import { claimState, isExpired } from "./integrity";
import type { IntegrityChecker } from "./integrity";
import { isIP } from "net";
import { StrKey } from "@stellar/stellar-sdk";
import { MAX_WEBHOOK_DELIVERY_ATTEMPTS } from "./webhooks";
import { createGraphQLHandler } from "./graphql";
import { buildHealthResponse, SERVICE_NAME } from "./health";
import { evaluateLagSlo } from "./lag-slo";
import { checkReadiness, DEFAULT_READINESS_TIMEOUT_MS } from "./readiness";
import { getRpcFailureDiagnostics } from "./rpc-diagnostics";
import { ApiMetrics, apiMetricsMiddleware } from "./api-metrics";
import { randomUUID } from "crypto";
import { CursorError, sendApiError, sendCursorError } from "./api-errors";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const MAX_LEDGER_RANGE = 100_000;
const MAX_TIME_RANGE_SECONDS = 30 * 24 * 60 * 60;

/** Known Mithaq credential types â€” submissions must reference only these. */
const VALID_CLAIM_TYPES = new Set([
  "kyc",
  "age",
  "jurisdiction",
  "income",
  "funds",
  "accreditation",
  "employment",
]);

const MAX_APP_NAME = 120;
const MAX_DESCRIPTION = 2000;
const MAX_CLAIMS = 10;
const MAX_CONTACT_EMAIL = 254;
// â”€â”€ Response schema (#349) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// `ClaimRow` (db.ts) is the internal row shape the two DB adapters happen to
// hand back â€” on Postgres, `pg` parses BIGINT columns (id, verified_at,
// expiry, ledger_sequence, threshold) as strings by default to avoid silent
// precision loss, while better-sqlite3 hands back plain JS numbers for the
// same INTEGER columns. Left unhandled, a consumer coding against one
// backend's shape breaks against the other's. `serializeClaim` is the one
// place that boundary gets normalized, and its explicit field list also
// means a future internal-only column added to the `claims` table can't
// leak into the API response by accident the way a bare `...row` spread
// would allow.

/** The wire shape every claim-bearing endpoint (/claims, /recent) returns. */
export interface SerializedClaim {
  id: number;
  wallet: string;
  credential_type: string;
  issuer: string;
  verified_at: number;
  expiry: number;
  ledger_sequence: number;
  threshold: number | null;
  /** 0 or 1 â€” see the module doc comment for why this isn't a boolean. */
  reason_code: string;
  revoked: number;
  /** Derived, not event-sourced â€” see the module doc comment. */
  expired: boolean;
  /** Derived, not event-sourced â€” see the module doc comment. */
  state: "active" | "expired" | "revoked";
}

/**
 * `options.now` is injectable so the derived expiry fields are deterministic
 * under test; it defaults to wall-clock time at call time.
 *
 * It is an options object rather than a bare second parameter on purpose: this
 * is called as `claims.map(serializeClaim)`, and `map` hands the array *index*
 * to the second position â€” a bare `now` parameter would silently receive `0`.
 */
export function serializeClaim(
  row: ClaimRow,
  options: { now?: number } = {}
): SerializedClaim {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  return {
    id: Number(row.id),
    wallet: row.wallet,
    credential_type: row.credential_type,
    issuer: row.issuer,
    verified_at: Number(row.verified_at),
    expiry: Number(row.expiry),
    ledger_sequence: Number(row.ledger_sequence),
    threshold: row.threshold === null ? null : Number(row.threshold),
    reason_code: row.reason_code,
    revoked: Number(row.revoked),
    expired: isExpired(row, now),
    state: claimState(row, now),
  };
}

// â”€â”€ Opaque cursor encoding â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The nextCursor token is the base64url form of "<ledgerSequence>:<id>" â€” the
// keyset boundary of the last row on the page. It is opaque to clients: they
// must echo it back verbatim, never construct or interpret it.

const CURSOR_SCOPES = {
  claims: "claims.v1",
  recent: "recent.v1",
} as const;

type CursorScope = keyof typeof CURSOR_SCOPES;

function encodeScopedCursor(scope: CursorScope, cursor: RecentCursor): string {
  return Buffer.from(
    `${CURSOR_SCOPES[scope]}:${cursor.ledgerSequence}:${cursor.id}`,
    "utf8",
  ).toString("base64url");
}

function decodeScopedCursor(scope: CursorScope, raw: string): RecentCursor {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const parts = decoded.split(":");
  if (parts.length === 2) {
    const [ledgerRaw, idRaw] = parts;
    const ledgerSequence = Number(ledgerRaw);
    const id = Number(idRaw);
    if (
      Number.isInteger(ledgerSequence) &&
      Number.isInteger(id) &&
      ledgerSequence >= 0 &&
      id >= 1
    ) {
      return { ledgerSequence, id };
    }
    throw new CursorError("malformed", "invalid cursor");
  }

  const [tokenScope, ledgerRaw, idRaw, ...extra] = parts;
  if (tokenScope !== CURSOR_SCOPES[scope] || extra.length > 0) {
    throw new CursorError(
      "unsupported",
      `Cursor belongs to a different endpoint or version; omit cursor to restart.`,
    );
  }
  const ledgerSequence = Number(ledgerRaw);
  const id = Number(idRaw);
  if (
    !Number.isInteger(ledgerSequence) ||
    !Number.isInteger(id) ||
    ledgerSequence < 0 ||
    id < 1
  ) {
    throw new CursorError("malformed", "invalid cursor");
  }
  return { ledgerSequence, id };
}

// â"€â"€ Delivery cursor encoding â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
// Delivery cursors encode (occurred_at, id) for stable keyset pagination.

function encodeDeliveryCursor(
  occurredAt: number,
  id: number
): string {
  return Buffer.from(`${occurredAt}:${id}`, "utf8").toString("base64url");
}

function decodeDeliveryCursor(raw: string): { occurredAt: number; id: number } {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const [timeRaw, idRaw] = decoded.split(":");
  const occurredAt = Number(timeRaw);
  const id = Number(idRaw);
  if (
    !Number.isInteger(occurredAt) ||
    !Number.isInteger(id) ||
    occurredAt < 0 ||
    id < 1
  ) {
    throw new CursorError("malformed", "invalid cursor");
  }
  return { occurredAt, id };
}

// Helper: wrap an async handler and forward errors to next()
function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * Stamp a response with RFC 9745 `Deprecation` and RFC 8594 `Sunset` headers.
 *
 * Call this inside any route handler for a deprecated endpoint or field. Both
 * dates must be ISO-8601 UTC strings, e.g. "2025-06-01T00:00:00Z". The
 * function is a no-op when `deprecatedAt` is falsy, so it is safe to gate on
 * a feature-flag without changing call sites.
 *
 * See docs/API_DEPRECATION.md for the full deprecation process.
 */
export function setDeprecationHeaders(
  res: Response,
  options: { deprecatedAt?: string; sunsetAt?: string },
): void {
  if (!options.deprecatedAt) return;
  res.setHeader("Deprecation", options.deprecatedAt);
  if (options.sunsetAt) {
    res.setHeader("Sunset", options.sunsetAt);
  }
}

export function buildApp(
  db: Db,
  ingester: Ingester,
  config?: Partial<Config>,
  integrity?: IntegrityChecker
): express.Application {
  const app = express();

  // ── Bounded-label API metrics (API-16) ─────────────────────────────────────
  // Installed first so every response, including 404s and 429s, is counted.
  // Labels come only from fixed sets; see api-metrics.ts.
  const apiMetrics = new ApiMetrics();
  app.locals["apiMetrics"] = apiMetrics;
  app.use(apiMetricsMiddleware(apiMetrics));

  const parseCursorParam = async (
    res: Response,
    scope: CursorScope,
    raw: unknown,
  ): Promise<{ cursor: RecentCursor | null; failed: boolean }> => {
    if (raw == null || String(raw).trim() === "") {
      return { cursor: null, failed: false };
    }
    let cursor: RecentCursor;
    try {
      cursor = decodeScopedCursor(scope, String(raw));
    } catch (err) {
      if (err instanceof CursorError) sendCursorError(res, err);
      else sendApiError(res, 400, "invalid cursor");
      return { cursor: null, failed: true };
    }
    const minLedger = await db.getMinClaimLedger();
    if (minLedger > 0 && cursor.ledgerSequence < minLedger) {
      sendCursorError(
        res,
        new CursorError("stale", "Cursor is outside the retained claim window."),
      );
      return { cursor: null, failed: true };
    }
    return { cursor, failed: false };
  };

  app.use((req, res, next) => {
    const inbound = req.header("x-request-id");
    const requestId =
      inbound && /^[a-zA-Z0-9_-]{1,64}$/.test(inbound) ? inbound : randomUUID();
    res.locals["requestId"] = requestId;
    res.setHeader("x-request-id", requestId);
    next();
  });

  // Trust reverse proxies (e.g. AWS ALB, Cloudflare, Nginx) so client IP extraction is accurate.
  app.set("trust proxy", true);

  // Security: no body parsing (read-only), conservative headers.
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // â”€â”€ CORS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const corsOrigins =
    config?.corsOrigins ??
    parseCorsOrigins(process.env["CORS_ALLOWED_ORIGINS"] ?? process.env["CORS_ORIGIN"]);
  app.use(createCorsMiddleware(corsOrigins));

  // â”€â”€ Rate Limiting â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const windowMs =
    config?.rateLimitWindowMs ??
    Number(process.env["RATE_LIMIT_WINDOW_SECONDS"] ?? "60") * 1000;
  const max =
    config?.rateLimitMax ??
    Number(
      process.env["RATE_LIMIT_MAX"] ??
        process.env["RATE_LIMIT_MAX_REQUESTS"] ??
        "120"
    );
  const enabled =
    config?.rateLimitEnabled ??
    (process.env["RATE_LIMIT_ENABLED"]?.toLowerCase() !== "false");

  const rateLimiter = new RateLimiter({ windowMs, max, enabled });
  app.locals["rateLimiter"] = rateLimiter;
  app.use(
    rateLimiter.middleware((result, limiterEnabled) => {
      apiMetrics.observeRateLimit(
        !limiterEnabled ? "disabled" : result.allowed ? "allowed" : "limited"
      );
    })
  );

  // â”€â”€ Auth guard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // requireAuth(undefined) â†’ no-op; public mode, all endpoints open (default).
  // requireAuth("secret")  â†’ enforces Bearer / X-API-Key on guarded routes.
  // Resolved from config first so tests can inject the key directly without
  // touching the environment.
  const envApiKey = process.env["API_KEY"]?.trim();
  const apiKey = config?.apiKey ?? (envApiKey || undefined);
  const guard = requireAuth(apiKey);
  const webhookSecret =
    config?.webhookSigningSecret ?? process.env["WEBHOOK_SIGNING_SECRET"];
  const webhookGuard: RequestHandler = (req, res, next) => {
    if (!apiKey || !webhookSecret || webhookSecret.length < 32) {
      sendApiError(
        res,
        503,
        "webhook subscriptions require API_KEY and a 32-character WEBHOOK_SIGNING_SECRET",
      );
      return;
    }
    guard(req, res, next);
  };

  // â”€â”€ GraphQL endpoint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Provides a flexible, typed query interface over the claims store.
  // Supports filtering by wallet, credential_type, issuer, active/revoked,
  // and time range, with cursor-based pagination.
  const graphqlHandler = createGraphQLHandler(db);
  app.use("/graphql", graphqlHandler as any);

  // â”€â”€ GET /health â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Exposes ingester lag so operators can alert when the indexer falls behind.
  //
  // status semantics:
  //   "ok"       â€” consecutiveErrors === 0
  //   "degraded" â€” last fetch failed but some succeeded before it
  //   "error"    â€” 3+ consecutive failures (stale data, indexer likely stalled)
  app.get(
    "/health",
    asyncHandler(async (_req, res) => {
      // Shape and status semantics live in health.ts (docs/HEALTHCHECKS.md).
      // Liveness must not depend on the database (API-14): a temporary outage
      // should not make an orchestrator restart a healthy worker. Fall back to
      // the ingester's last durable checkpoint if the cursor read fails.
      const health = ingester.getHealth();
      let lastLedger = health.checkpointLedger ?? health.lastSuccessLedger;
      try {
        lastLedger = await db.getLastLedger();
      } catch {
        // Keep serving liveness; /ready reports dependency failure.
      }
      res.json(
        buildHealthResponse(
          lastLedger,
          health,
          new Date(),
          config?.lagSloLedgers
        )
      );
    })
  );

  // ── GET /ready ────────────────────────────────────────────────────────────
  // Dependency readiness (API-14): prove the selected database can execute a
  // lightweight query before accepting traffic. Returns 503 when it cannot, so
  // a load balancer stops routing to this instance without restarting it —
  // liveness (/health) stays independent of the database.
  app.get(
    "/ready",
    asyncHandler(async (_req, res) => {
      const readiness = await checkReadiness(db, {
        timeoutMs: config?.dbReadinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
      });
      res.status(readiness.ready ? 200 : 503).json(readiness);
    })
  );

  // ── GET /diagnostics/rpc ──────────────────────────────────────────────────
  // Sanitized operational details about recent RPC failures (API-15), intended
  // for authorized operators only. Requires an API_KEY to be configured: with
  // none set the endpoint is not exposed at all rather than becoming public.
  const diagnosticsGuard: RequestHandler = (req, res, next) => {
    if (!apiKey) {
      sendApiError(
        res,
        503,
        "diagnostics require API_KEY to be configured"
      );
      return;
    }
    guard(req, res, next);
  };

  app.get(
    "/diagnostics/rpc",
    diagnosticsGuard,
    asyncHandler(async (_req, res) => {
      const diagnostics = getRpcFailureDiagnostics();
      res.json({
        service: SERVICE_NAME,
        timestamp: new Date().toISOString(),
        ...diagnostics,
      });
    })
  );

  // â”€â”€ GET /metrics â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Exposes Prometheus metrics for the indexer.
  //   - indexer_events_processed_total: total events processed since start
  //   - indexer_fetch_errors_total: total fetch errors since start
  //   - indexer_uptime_seconds: uptime in seconds since start
  //   - indexer_db_write_latency_seconds: latest tick DB write latency in seconds
  //   - indexer_ledgers_behind_head: ledgers between head and last processed
  //
  // This endpoint is left public (no auth required) so monitoring stacks can
  // scrape it, but it is separate from the claim API routes so it is not
  // colliding with public dApp/wallet endpoints. If operators want to gate it,
  // they can add a reverse-proxy or firewall rule in front of /metrics.
  app.get(
    "/metrics",
    asyncHandler(async (_req, res) => {
      const metrics = ingester.getMetrics();
      const health = ingester.getHealth();
      const exhaustedCount = await ingester.countExhaustedWebhookSubscriptions();
      const lines: string[] = [];

      // Events processed total
      lines.push(
        `# HELP indexer_events_processed_total Total number of events processed since the ingester started.`,
      );
      lines.push(
        `# TYPE indexer_events_processed_total counter`,
      );
      lines.push(`indexer_events_processed_total ${metrics.eventsProcessedTotal}`);

      // Fetch errors total
      lines.push(
        `# HELP indexer_fetch_errors_total Total number of fetch errors (all retries exhausted) since start.`,
      );
      lines.push(
        `# TYPE indexer_fetch_errors_total counter`,
      );
      lines.push(`indexer_fetch_errors_total ${metrics.fetchErrorsTotal}`);

      // Uptime in seconds
      lines.push(
        `# HELP indexer_uptime_seconds Uptime in seconds since the ingester started.`,
      );
      lines.push(
        `# TYPE indexer_uptime_seconds gauge`,
      );
      lines.push(`indexer_uptime_seconds ${metrics.uptimeSeconds}`);

      // DB write latency in seconds
      lines.push(
        `# HELP indexer_db_write_latency_seconds Latest tick DB write latency in seconds.`,
      );
      lines.push(
        `# TYPE indexer_db_write_latency_seconds gauge`,
      );
      lines.push(`indexer_db_write_latency_seconds ${metrics.dbWriteLatencySeconds}`);

      // Ledgers behind head
      lines.push(
        `# HELP indexer_ledgers_behind_head Number of ledgers between network head and last processed ledger.`,
      );
      lines.push(
        `# TYPE indexer_ledgers_behind_head gauge`,
      );
      lines.push(`indexer_ledgers_behind_head ${metrics.lag}`);

      lines.push(
        `# HELP indexer_checkpoint_ledger Durable ingestion checkpoint ledger.`,
      );
      lines.push(`# TYPE indexer_checkpoint_ledger gauge`);
      lines.push(`indexer_checkpoint_ledger ${health.checkpointLedger ?? 0}`);

      // ── Webhook delivery metrics (issue #17) ──────────────────────────────
      lines.push(
        `# HELP indexer_webhook_deliveries_success_total Webhook deliveries that received a 2xx response since start.`,
      );
      lines.push(`# TYPE indexer_webhook_deliveries_success_total counter`);
      lines.push(`indexer_webhook_deliveries_success_total ${metrics.webhookDeliverySuccessTotal}`);

      lines.push(
        `# HELP indexer_webhook_deliveries_failure_total Webhook delivery attempts that resulted in an error since start.`,
      );
      lines.push(`# TYPE indexer_webhook_deliveries_failure_total counter`);
      lines.push(`indexer_webhook_deliveries_failure_total ${metrics.webhookDeliveryFailureTotal}`);

      lines.push(
        `# HELP indexer_webhook_subscriptions_exhausted Subscriptions with all retry attempts consumed and no successful delivery.`,
      );
      lines.push(`# TYPE indexer_webhook_subscriptions_exhausted gauge`);
      lines.push(`indexer_webhook_subscriptions_exhausted ${exhaustedCount}`);

      // â”€â”€ On-chain data integrity (#612) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // `indexer_state_mismatches` is the alerting series: it holds the number
      // of claims in the last completed check that disagreed with the
      // contract. It is a gauge, not a counter, so an alert can fire on "the
      // indexer is currently wrong about N claims" and clear on its own once a
      // later check (or a fix + reindex) resolves the drift. Only successfully
      // read claims can produce a mismatch, so an RPC outage moves
      // `indexer_state_check_errors` instead and never fakes a mismatch.
      if (integrity) {
        const im = integrity.getMetrics();

        lines.push(
          `# HELP indexer_state_mismatches Indexed claims that disagreed with on-chain contract state in the last completed integrity check.`,
        );
        lines.push(`# TYPE indexer_state_mismatches gauge`);
        lines.push(`indexer_state_mismatches ${im.lastMismatchCount}`);

        lines.push(
          `# HELP indexer_state_checked Claims compared against contract state in the last completed integrity check.`,
        );
        lines.push(`# TYPE indexer_state_checked gauge`);
        lines.push(`indexer_state_checked ${im.lastCheckedCount}`);

        lines.push(
          `# HELP indexer_state_mismatches_total Cumulative mismatches since the indexer started.`,
        );
        lines.push(`# TYPE indexer_state_mismatches_total counter`);
        lines.push(`indexer_state_mismatches_total ${im.mismatchesTotal}`);

        for (const [kind, count] of Object.entries(im.mismatchesByKind)) {
          lines.push(
            `# HELP indexer_state_mismatches_by_kind Cumulative mismatches by kind since the indexer started.`,
          );
          lines.push(`# TYPE indexer_state_mismatches_by_kind counter`);
          lines.push(
            `indexer_state_mismatches_by_kind{kind="${kind}"} ${count}`,
          );
        }

        lines.push(
          `# HELP indexer_state_checks_total Integrity checks run since the indexer started.`,
        );
        lines.push(`# TYPE indexer_state_checks_total counter`);
        lines.push(`indexer_state_checks_total ${im.checksTotal}`);

        lines.push(
          `# HELP indexer_state_checks_incomplete_total Integrity checks in which at least one sampled claim could not be read from the contract.`,
        );
        lines.push(`# TYPE indexer_state_checks_incomplete_total counter`);
        lines.push(
          `indexer_state_checks_incomplete_total ${im.checksIncompleteTotal}`,
        );

        lines.push(
          `# HELP indexer_state_check_errors Sampled claims the last integrity check could not read from the contract.`,
        );
        lines.push(`# TYPE indexer_state_check_errors gauge`);
        lines.push(`indexer_state_check_errors ${im.lastUnreadableCount}`);

        lines.push(
          `# HELP indexer_state_last_check_timestamp_seconds Unix time of the last completed integrity check; 0 if none has run.`,
        );
        lines.push(`# TYPE indexer_state_last_check_timestamp_seconds gauge`);
        lines.push(
          `indexer_state_last_check_timestamp_seconds ${im.lastRunTimestampSeconds}`,
        );

        lines.push(
          `# HELP indexer_state_last_success_timestamp_seconds Unix time of the last integrity check that read every sampled claim; 0 if none has.`,
        );
        lines.push(`# TYPE indexer_state_last_success_timestamp_seconds gauge`);
        lines.push(
          `indexer_state_last_success_timestamp_seconds ${im.lastSuccessTimestampSeconds}`,
        );

        lines.push(
          `# HELP indexer_state_last_check_duration_seconds Duration of the last completed integrity check.`,
        );
        lines.push(`# TYPE indexer_state_last_check_duration_seconds gauge`);
        lines.push(
          `indexer_state_last_check_duration_seconds ${im.lastDurationSeconds}`,
        );
      }

      // ── Lag SLO (API-13) ─────────────────────────────────────────────────
      // `indexer_lag_slo_breached` is the alertable series: 1 when the known
      // lag exceeds the configured budget, 0 when it is within budget or the
      // head ledger is not known yet (never alert on missing data).
      const lagSlo = evaluateLagSlo(health.lag, config?.lagSloLedgers);
      lines.push(
        `# HELP indexer_lag_slo_target_ledgers Configured ledger-lag budget.`,
      );
      lines.push(`# TYPE indexer_lag_slo_target_ledgers gauge`);
      lines.push(`indexer_lag_slo_target_ledgers ${lagSlo.targetLedgers}`);
      lines.push(
        `# HELP indexer_lag_slo_lag_ledgers Current ledger lag, or -1 when the head ledger is unknown.`,
      );
      lines.push(`# TYPE indexer_lag_slo_lag_ledgers gauge`);
      lines.push(`indexer_lag_slo_lag_ledgers ${lagSlo.lagLedgers}`);
      lines.push(
        `# HELP indexer_lag_slo_breached 1 when the known ledger lag exceeds the configured budget.`,
      );
      lines.push(`# TYPE indexer_lag_slo_breached gauge`);
      lines.push(`indexer_lag_slo_breached ${lagSlo.breached ? 1 : 0}`);

      // ── API traffic metrics (API-16) ─────────────────────────────────────
      lines.push(...apiMetrics.render());

      res.type("text/plain").send(lines.join("\n") + "\n");
    })
  );

  // â”€â”€ GET /integrity/status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Operational metadata about the on-chain state verification routine (#612):
  // when it last ran, whether it read every sampled claim, and the most recent
  // mismatches. Public like /health and /metrics â€” it reports indexer health,
  // not wallet data â€” and omitted entirely when no checker is wired in.
  app.get(
    "/integrity/status",
    asyncHandler(async (_req, res) => {
      if (!integrity) {
        sendApiError(res, 404, "integrity checks are not configured");
        return;
      }
      const report = integrity.getLastReport();
      const metrics = integrity.getMetrics();
      res.json({
        lastRunTimestamp: report?.finishedAt ?? null,
        lastSuccessTimestamp: metrics.lastSuccessTimestampSeconds
          ? metrics.lastSuccessTimestampSeconds * 1000
          : null,
        checksTotal: metrics.checksTotal,
        checksIncompleteTotal: metrics.checksIncompleteTotal,
        mismatchCount: metrics.lastMismatchCount,
        mismatchesTotal: metrics.mismatchesTotal,
        lastCheckedCount: metrics.lastCheckedCount,
        lastUnreadableCount: metrics.lastUnreadableCount,
        lastError: metrics.lastError,
        mismatches: report?.mismatches ?? [],
      });
    })
  );

  // â”€â”€ POST /integrity/check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // On-demand trigger for the same routine the schedule runs. Gated by API_KEY
  // like the other expensive operations: each call costs one RPC read per
  // sampled claim, and it moves the rotating sample cursor, so an unauthenticated
  // caller could both exhaust the RPC quota and starve the periodic sweep.
  app.post(
    "/integrity/check",
    guard,
    asyncHandler(async (req, res) => {
      if (!integrity) {
        sendApiError(res, 404, "integrity checks are not configured");
        return;
      }
      const raw = req.query["sampleSize"];
      const parsed = raw === undefined ? NaN : Number(raw);
      if (raw !== undefined && (!Number.isInteger(parsed) || parsed < 1)) {
        sendApiError(res, 400, "sampleSize must be a positive integer");
        return;
      }
      const report = await integrity.run(
        parsed ? { sampleSize: parsed } : undefined
      );
      res.json({
        checked: report.checked,
        unreadable: report.unreadable,
        mismatchCount: report.mismatchCount,
        complete: report.complete,
        durationSeconds: report.durationSeconds,
        mismatches: report.mismatches,
      });
    })
  );

  // â”€â”€ GET /claims?wallet=Gâ€¦ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Gated when API_KEY is set: per-wallet claim history makes per-holder
  // correlation much easier than per-ledger chain queries.
  app.get(
    "/claims",
    guard,
    asyncHandler(async (req, res) => {
      const wallet = req.query["wallet"];
      if (typeof wallet !== "string" || wallet.trim() === "") {
        sendApiError(res, 400, "wallet query parameter is required");
        return;
      }

      const credentialType = req.query["credential_type"];
      if (
        credentialType !== undefined &&
        (typeof credentialType !== "string" ||
          !VALID_CLAIM_TYPES.has(credentialType.trim()))
      ) {
        sendApiError(
          res,
          400,
          `credential_type must be one of: ${[...VALID_CLAIM_TYPES].join(", ")}`,
        );
        return;
      }

      const issuer = req.query["issuer"];
      if (
        issuer !== undefined &&
        (typeof issuer !== "string" ||
          !StrKey.isValidEd25519PublicKey(issuer.trim()))
      ) {
        sendApiError(res, 400, "issuer must be a valid Stellar public key");
        return;
      }

      const rawState = req.query["state"];
      const states: ClaimState[] = ["active", "expired", "revoked"];
      if (
        rawState !== undefined &&
        (typeof rawState !== "string" ||
          !states.includes(rawState.trim() as ClaimState))
      ) {
        sendApiError(res, 400, "state must be one of: active, expired, revoked");
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      const state =
        typeof rawState === "string" ? rawState.trim() as ClaimState : undefined;
      const filters = {
        credentialType: typeof credentialType === "string" ? credentialType.trim() : undefined,
        issuer: typeof issuer === "string" ? issuer.trim() : undefined,
        state,
        now,
      };

      const paginated =
        req.query["limit"] !== undefined || req.query["cursor"] !== undefined;
      if (!paginated) {
        const claims = await db.claimsByWallet(wallet.trim(), filters);
        res.json({
          wallet: wallet.trim(),
          claims: claims.map((row) => serializeClaim(row, { now })),
        });
        return;
      }

      const rawLimit = Number(req.query["limit"] ?? DEFAULT_LIMIT);
      if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_LIMIT) {
        sendApiError(res, 400, `limit must be an integer between 1 and ${MAX_LIMIT}`);
        return;
      }
      const parsed = await parseCursorParam(res, "claims", req.query["cursor"]);
      if (parsed.failed) return;

      const page = await db.claimsByWalletPage(wallet.trim(), filters, rawLimit, parsed.cursor);
      res.json({
        wallet: wallet.trim(),
        claims: page.claims.map((row) => serializeClaim(row, { now })),
        limit: rawLimit,
        nextCursor: page.nextCursor ? encodeScopedCursor("claims", page.nextCursor) : null,
      });
    })
  );

  // â”€â”€ GET /stats â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Gated when API_KEY is set: reveals total verified-holder counts per type.
  app.get(
    "/stats",
    guard,
    asyncHandler(async (_req, res) => {
      const stats = await db.stats();
      res.json({ stats });
    })
  );

  // â”€â”€ GET /recent?limit=20&cursor=<opaque> â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get(
    "/recent",
    guard,
    asyncHandler(async (req, res) => {
      const rawLimit = parseInt(String(req.query["limit"] ?? DEFAULT_LIMIT), 10);
      const limit = isNaN(rawLimit) || rawLimit < 1
        ? DEFAULT_LIMIT
        : Math.min(rawLimit, MAX_LIMIT);

      const readBound = (name: string): number | undefined => {
        const raw = req.query[name];
        if (raw === undefined) return undefined;
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 0) {
          throw new Error(`${name} must be a non-negative integer`);
        }
        return value;
      };

      let startTime: number | undefined;
      let endTime: number | undefined;
      let minLedger: number | undefined;
      let maxLedger: number | undefined;
      try {
        startTime = readBound("startTime");
        endTime = readBound("endTime");
        minLedger = readBound("startLedger");
        maxLedger = readBound("endLedger");
      } catch (err) {
        sendApiError(res, 400, (err as Error).message);
        return;
      }

      if (startTime !== undefined && endTime !== undefined && startTime > endTime) {
        sendApiError(res, 400, "startTime must be before endTime");
        return;
      }
      if (minLedger !== undefined && maxLedger !== undefined && minLedger > maxLedger) {
        sendApiError(res, 400, "startLedger must be before endLedger");
        return;
      }
      if (minLedger !== undefined && maxLedger !== undefined && maxLedger - minLedger > MAX_LEDGER_RANGE) {
        sendApiError(res, 400, `ledger range cannot exceed ${MAX_LEDGER_RANGE} ledgers`);
        return;
      }
      if (startTime !== undefined && endTime !== undefined && endTime - startTime > MAX_TIME_RANGE_SECONDS) {
        sendApiError(res, 400, `time range cannot exceed ${MAX_TIME_RANGE_SECONDS} seconds`);
        return;
      }

      const parsed = await parseCursorParam(res, "recent", req.query["cursor"]);
      if (parsed.failed) return;

      const { claims, nextCursor } = await db.recent(limit, parsed.cursor, {
        startTime,
        endTime,
        minLedger,
        maxLedger,
      });
      res.json({
        claims: claims.map((row) => serializeClaim(row)),
        limit,
        nextCursor: nextCursor ? encodeScopedCursor("recent", nextCursor) : null,
      });
    })
  );

  // â”€â”€ GET /issuers/:issuer/stats â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Reputation stats derived entirely from indexed events (#398) â€” how many
  // credentials an issuer has issued, active vs revoked, which credential
  // types they cover, and how long they've been indexed. Public: this is the
  // same class of aggregate chain data /stats already exposes, just sliced
  // by issuer instead of by credential_type.
  app.get(
    "/issuers/:issuer/stats",
    asyncHandler(async (req, res) => {
      const issuer = req.params["issuer"];
      if (typeof issuer !== "string" || issuer.trim() === "") {
        sendApiError(res, 400, "issuer path parameter is required");
        return;
      }
      const stats = await db.issuerStats(issuer.trim());
      res.json(stats);
    })
  );

  // â”€â”€ GET /issuers/:issuer/credentials â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Returns all credentials issued by this issuer, for the revocation dashboard (#540).
  app.get(
    "/issuers/:issuer/credentials",
    asyncHandler(async (req, res) => {
      const issuer = req.params["issuer"];
      if (typeof issuer !== "string" || issuer.trim() === "") {
        sendApiError(res, 400, "issuer path parameter is required");
        return;
      }
      const rawClaims = await db.claimsByIssuer(issuer.trim());
      res.json({
        issuer: issuer.trim(),
        credentials: rawClaims.map((row) => serializeClaim(row)),
      });
    })
  );

  // â”€â”€ GET /issuers/:issuer/analytics â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Verification volume over time, success rates, top verifiers, and exportable events (#542).
  app.get(
    "/issuers/:issuer/analytics",
    asyncHandler(async (req, res) => {
      const issuer = req.params["issuer"];
      if (typeof issuer !== "string" || issuer.trim() === "") {
        sendApiError(res, 400, "issuer path parameter is required");
        return;
      }
      const analytics = await db.issuerAnalytics(issuer.trim());
      res.json(analytics);
    })
  );

  // â”€â”€ GET /credentials/:commitment/events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Returns on-chain lifecycle events for a specific credential commitment (#541).
  app.get(
    "/credentials/:commitment/events",
    asyncHandler(async (req, res) => {
      const commitment = req.params["commitment"];
      if (typeof commitment !== "string" || commitment.trim() === "") {
        sendApiError(res, 400, "commitment path parameter is required");
        return;
      }
      const wallet = typeof req.query["wallet"] === "string" ? req.query["wallet"].trim() : undefined;
      const type = typeof req.query["type"] === "string" ? req.query["type"].trim() : undefined;

      const history = await db.credentialEvents(commitment.trim(), wallet, type);
      res.json(history);
    })
  );

  // â”€â”€ GET /apps â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Returns all approved app submissions for the gallery.
  app.get(
    "/apps",
    asyncHandler(async (_req, res) => {
      const apps = await db.listApprovedApps();
      res.json({ apps });
    })
  );

  // â”€â”€ GET /apps/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get(
    "/apps/:id",
    asyncHandler(async (req, res) => {
      const id = parseInt(req.params["id"], 10);
      if (isNaN(id)) {
        sendApiError(res, 400, "invalid id");
        return;
      }
      const appRow = await db.getAppSubmission(id);
      if (!appRow) {
        sendApiError(res, 404, "app not found");
        return;
      }
      res.json({ app: appRow });
    })
  );

  // â”€â”€ POST /apps/submit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Third parties submit their app for review.
  app.use("/apps", express.json({ limit: "16kb" }));
  app.post(
    "/apps/submit",
    asyncHandler(async (req, res) => {
      const { appName, description, requiredClaims, verifyUrl, contactEmail } =
        req.body;

      if (typeof appName !== "string" || appName.trim().length === 0) {
        sendApiError(res, 400, "appName is required");
        return;
      }
      if (appName.trim().length > MAX_APP_NAME) {
        sendApiError(res, 400, `appName must be at most ${MAX_APP_NAME} characters`);
        return;
      }

      if (typeof description !== "string" || description.trim().length === 0) {
        sendApiError(res, 400, "description is required");
        return;
      }
      if (description.trim().length > MAX_DESCRIPTION) {
        sendApiError(res, 400, `description must be at most ${MAX_DESCRIPTION} characters`);
        return;
      }

      if (!Array.isArray(requiredClaims) || requiredClaims.length === 0) {
        sendApiError(res, 400, "requiredClaims must be a non-empty array");
        return;
      }
      if (requiredClaims.length > MAX_CLAIMS) {
        sendApiError(res, 400, `requiredClaims must contain at most ${MAX_CLAIMS} items`);
        return;
      }
      for (const claim of requiredClaims) {
        if (typeof claim !== "string" || !VALID_CLAIM_TYPES.has(claim)) {
          sendApiError(
            res,
            400,
            `invalid claim type: "${claim}". Valid types: ${[...VALID_CLAIM_TYPES].join(", ")}`,
          );
          return;
        }
      }

      if (typeof verifyUrl !== "string" || verifyUrl.trim().length === 0) {
        sendApiError(res, 400, "verifyUrl is required");
        return;
      }
      try {
        const parsed = new URL(verifyUrl.trim());
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          sendApiError(res, 400, "verifyUrl must use http or https");
          return;
        }
      } catch {
        sendApiError(res, 400, "verifyUrl must be a valid URL");
        return;
      }

      if (typeof contactEmail !== "string" || contactEmail.trim().length === 0) {
        sendApiError(res, 400, "contactEmail is required");
        return;
      }
      if (contactEmail.trim().length > MAX_CONTACT_EMAIL) {
        sendApiError(res, 400, `contactEmail must be at most ${MAX_CONTACT_EMAIL} characters`);
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.trim())) {
        sendApiError(res, 400, "contactEmail must be a valid email address");
        return;
      }

      const id = await db.insertAppSubmission(
        appName.trim(),
        description.trim(),
        requiredClaims.map((c: string) => c.trim()),
        verifyUrl.trim(),
        contactEmail.trim(),
      );

      res.status(201).json({ id, status: "pending" });
    })
  );

  // â”€â”€ PATCH /apps/:id/status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Update submission review status (approved | rejected | pending).
  app.patch(
    "/apps/:id/status",
    guard,
    asyncHandler(async (req, res) => {
      const id = parseInt(req.params["id"], 10);
      if (isNaN(id)) {
        sendApiError(res, 400, "invalid id");
        return;
      }
      const { status } = req.body ?? {};
      if (status !== "approved" && status !== "rejected" && status !== "pending") {
        sendApiError(res, 400, "status must be one of: approved, rejected, pending");
        return;
      }
      const existing = await db.getAppSubmission(id);
      if (!existing) {
        sendApiError(res, 404, "app not found");
        return;
      }
      await db.updateSubmissionStatus(id, status as SubmissionStatus);
      const updated = await db.getAppSubmission(id);
      res.json({ app: updated });
    })
  );

  // â”€â”€ Webhook subscriptions (#635) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.use("/webhooks", express.json({ limit: "16kb" }));
  app.post(
    "/webhooks/subscriptions",
    webhookGuard,
    asyncHandler(async (req, res) => {
      const { url, wallet, claimType } = req.body ?? {};
      if (typeof url !== "string" || url.length > 2048) {
        sendApiError(res, 400, "url must be a valid HTTPS URL");
        return;
      }
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        sendApiError(res, 400, "url must be a valid HTTPS URL");
        return;
      }
      if (
        parsedUrl.protocol !== "https:" ||
        parsedUrl.username ||
        parsedUrl.password ||
        parsedUrl.hostname.length === 0 ||
        isIP(parsedUrl.hostname) !== 0 ||
        parsedUrl.hostname === "localhost" ||
        parsedUrl.hostname.endsWith(".localhost") ||
        parsedUrl.hostname.endsWith(".local")
      ) {
        sendApiError(res, 400, "url must be an HTTPS URL with a public DNS hostname and no credentials");
        return;
      }
      if (
        typeof wallet !== "string" ||
        !StrKey.isValidEd25519PublicKey(wallet)
      ) {
        sendApiError(res, 400, "wallet must be a valid Stellar public key");
        return;
      }
      if (typeof claimType !== "string" || !VALID_CLAIM_TYPES.has(claimType)) {
        sendApiError(res, 400, `claimType must be one of: ${[...VALID_CLAIM_TYPES].join(", ")}`);
        return;
      }

      const id = await db.createWebhookSubscription({
        url: parsedUrl.toString(),
        wallet,
        credential_type: claimType,
      });
      res.status(201).json({ id, wallet, claimType });
    }),
  );

  app.get(
    "/webhooks/subscriptions",
    webhookGuard,
    asyncHandler(async (req, res) => {
      const wallet = req.query["wallet"];
      if (wallet !== undefined && typeof wallet !== "string") {
        sendApiError(res, 400, "wallet must be a single value");
        return;
      }
      res.json({
        subscriptions: await db.listWebhookSubscriptions(wallet as string | undefined),
      });
    }),
  );

  app.delete(
    "/webhooks/subscriptions/:id",
    webhookGuard,
    asyncHandler(async (req, res) => {
      const id = Number(req.params["id"]);
      if (!Number.isSafeInteger(id) || id < 1) {
        sendApiError(res, 400, "id must be a positive integer");
        return;
      }
      if (!(await db.deleteWebhookSubscription(id))) {
        sendApiError(res, 404, "subscription not found");
        return;
      }
      res.status(204).end();
    }),
  );

  app.get(
    "/webhooks/subscriptions/:id/deliveries",
    webhookGuard,
    asyncHandler(async (req, res) => {
      const id = Number(req.params["id"]);
      if (!Number.isSafeInteger(id) || id < 1) {
        sendApiError(res, 400, "id must be a positive integer");
        return;
      }
      const subscriptions = await db.listWebhookSubscriptions();
      if (!subscriptions.some((subscription) => subscription.id === id)) {
        sendApiError(res, 404, "subscription not found");
        return;
      }

      // Parse query parameters
      const limit = Math.min(
        Number(req.query["limit"] ?? DEFAULT_LIMIT) || DEFAULT_LIMIT,
        MAX_LIMIT
      );
      const outcome = req.query["outcome"];
      if (
        outcome !== undefined &&
        outcome !== "delivered" &&
        outcome !== "failed" &&
        outcome !== "retrying"
      ) {
        sendApiError(
          res,
          400,
          "outcome must be one of: delivered, failed, retrying"
        );
        return;
      }

      let startTime: number | undefined;
      if (req.query["startTime"] !== undefined) {
        startTime = Number(req.query["startTime"]);
        if (!Number.isInteger(startTime) || startTime < 0) {
          sendApiError(res, 400, "startTime must be a non-negative integer");
          return;
        }
      }

      let endTime: number | undefined;
      if (req.query["endTime"] !== undefined) {
        endTime = Number(req.query["endTime"]);
        if (!Number.isInteger(endTime) || endTime < 0) {
          sendApiError(res, 400, "endTime must be a non-negative integer");
          return;
        }
      }

      if (startTime !== undefined && endTime !== undefined && startTime > endTime) {
        sendApiError(res, 400, "startTime must be before endTime");
        return;
      }

      let cursor: DeliveryPageCursor | undefined;
      if (req.query["cursor"] !== undefined) {
        try {
          const decoded = decodeDeliveryCursor(req.query["cursor"] as string);
          cursor = decoded;
        } catch (err) {
          if (err instanceof CursorError) {
            sendCursorError(res, err);
          } else {
            sendApiError(res, 400, "invalid cursor");
          }
          return;
        }
      }

      const page = await db.queryWebhookDeliveries(id, {
        outcome: outcome as "delivered" | "failed" | "retrying" | undefined,
        startTime,
        endTime,
        cursor,
        limit,
        maxAttempts: MAX_WEBHOOK_DELIVERY_ATTEMPTS,
      });

      res.json({
        deliveries: page.deliveries.map((delivery) => ({
          id: delivery.id,
          eventId: delivery.event_id,
          type: delivery.type,
          wallet: delivery.wallet,
          claimType: delivery.credential_type,
          expiry: delivery.expiry,
          ledgerSequence: delivery.ledger_sequence,
          occurredAt: delivery.occurred_at,
          reasonCode: delivery.reason_code,
          attempts: delivery.attempts,
          status: delivery.delivered_at !== null
            ? "delivered"
            : delivery.attempts >= MAX_WEBHOOK_DELIVERY_ATTEMPTS
              ? "failed"
              : "retrying",
          deliveredAt: delivery.delivered_at,
          lastError: delivery.last_error,
        })),
        limit,
        nextCursor: page.nextCursor
          ? encodeDeliveryCursor(page.nextCursor.occurredAt, page.nextCursor.id)
          : null,
      });
    }),
  );

  // â”€â”€ 404 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.use((_req, res) => {
    sendApiError(res, 404, "not found");
  });

  // â”€â”€ Error handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.use((err: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === "entity.too.large") {
      sendApiError(res, 413, "request body exceeds the endpoint size limit");
      return;
    }
    if (err.type === "entity.parse.failed") {
      sendApiError(res, 400, "invalid JSON body");
      return;
    }
    console.error("[indexer/api] unhandled error:", err);
    sendApiError(res, 500, "internal server error");
  });

  return app;
}
