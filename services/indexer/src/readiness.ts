/**
 * readiness.ts — Dependency readiness checks (API-14).
 *
 * Liveness (`/health`) answers "is this process alive?" and must not depend on
 * the database: a temporary database outage should not make an orchestrator
 * restart a healthy worker. Readiness (`/ready`) answers "can this instance
 * serve traffic?", which requires proving the selected database backend can
 * execute a lightweight query — not merely that the HTTP server started.
 *
 * The probe runs through the same `Db` abstraction as every other query, so
 * SQLite and Postgres are both covered, and it is bounded by a timeout so a
 * hung connection cannot hang the probe.
 */

import type { Db } from "./db";
import { SERVICE_NAME, resolveVersion } from "./health";

export const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

export interface DependencyCheck {
  name: string;
  status: "ok" | "error";
  latencyMs: number;
  /** Sanitized failure detail; never a connection string or credential. */
  error?: string;
}

export interface ReadinessResponse {
  status: "ready" | "not_ready";
  ready: boolean;
  service: string;
  version: string;
  timestamp: string;
  timeoutMs: number;
  checks: DependencyCheck[];
}

export interface ReadinessOptions {
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * Redact anything that could carry a credential out of a database error before
 * it reaches an operator-facing response.
 */
export function sanitizeDbError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const safe = raw
    .replace(/(?:postgres(?:ql)?|sqlite):\/\/\S+/gi, "<redacted-database-url>")
    .replace(/(password|passwd|pwd)\s*=\s*[^\s;&]+/gi, "$1=<redacted>")
    .replace(/(Bearer\s+)\S+/gi, "$1<redacted>")
    .replace(/([?&](?:token|key|secret|auth|password)=)[^&\s]+/gi, "$1<redacted>");
  return safe.length > 240 ? `${safe.slice(0, 240)}…` : safe;
}

/** Keep a probe from hanging readiness forever when the driver stalls. */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Probe the selected database with a lightweight query and build the readiness
 * payload. The returned status is `"not_ready"` when the probe fails or times
 * out; the caller maps that to HTTP 503.
 */
export async function checkReadiness(
  db: Db,
  options: ReadinessOptions = {}
): Promise<ReadinessResponse> {
  const timeoutMs =
    options.timeoutMs && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : DEFAULT_READINESS_TIMEOUT_MS;
  const now = options.now?.() ?? new Date();
  const startedAt = Date.now();

  const check: DependencyCheck = {
    name: "database",
    status: "ok",
    latencyMs: 0,
  };

  try {
    await withTimeout(
      Promise.resolve().then(() => db.ping()),
      timeoutMs,
      `database probe timed out after ${timeoutMs}ms`
    );
  } catch (error) {
    check.status = "error";
    check.error = sanitizeDbError(error);
  } finally {
    check.latencyMs = Date.now() - startedAt;
  }

  const ready = check.status === "ok";
  return {
    status: ready ? "ready" : "not_ready",
    ready,
    service: SERVICE_NAME,
    version: resolveVersion(),
    timestamp: now.toISOString(),
    timeoutMs,
    checks: [check],
  };
}
