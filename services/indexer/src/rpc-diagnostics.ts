/**
 * rpc-diagnostics.ts — Sanitized recent-RPC-failure diagnostics (API-15).
 *
 * The tracker records only operational metadata: when an RPC call failed, what
 * kind of failure it was, which (sanitized) endpoint failed, and a redacted
 * message. Request payloads, contract arguments, auth headers and provider
 * tokens are never stored or returned.
 *
 * Recovery status is derived from the last recorded event:
 *   "unknown"  — no RPC operation has run yet (or there is no client)
 *   "failing"  — the most recent attempts failed and no success has followed
 *   "recovered"— failures happened, but a later call succeeded
 *   "healthy"  — no failure has been observed
 */

import type { RpcFailureKind } from "./rpc-client";

/** Maximum number of failure records retained for the diagnostics endpoint. */
export const MAX_RECENT_RPC_FAILURES = 20;

/** Cap stored message length so a verbose provider error cannot bloat a response. */
const MAX_MESSAGE_LENGTH = 240;

export type RpcRecoveryStatus = "healthy" | "recovered" | "failing" | "unknown";

export interface RpcFailureRecord {
  /** Unix milliseconds at which the failure was observed. */
  time: number;
  kind: RpcFailureKind;
  /** Sanitized endpoint URL (credentials and token params removed). */
  endpoint: string;
  /** Sanitized error message (credentials removed, length-capped). */
  message: string;
}

export interface RpcFailureDiagnostics {
  recoveryStatus: RpcRecoveryStatus;
  /** Total failed RPC attempts observed since process start. */
  failureCount: number;
  /** Number of records retained in `recentFailures`. */
  recentFailureCount: number;
  /** Unix milliseconds of the most recent failure, or null. */
  latestFailureAt: number | null;
  /** Unix milliseconds of the most recent successful call, or null. */
  lastSuccessAt: number | null;
  /** Failed attempts since the last successful call. */
  consecutiveFailures: number;
  /** Sanitized URL of the endpoint currently in use. */
  activeEndpoint: string | null;
  /** How many times the client moved to another endpoint after failures. */
  failoverCount: number;
  recentFailures: RpcFailureRecord[];
}

/** Keep a record's message sanitized even if a caller forgets to. */
function sanitizeMessage(message: string): string {
  const safe = message
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer <redacted>")
    .replace(/((?:api[_-]?key|token|secret)["'=:\s]+)[^\s"',}&]+/gi, "$1<redacted>")
    .replace(/https?:\/\/[^\s"']+/gi, "<redacted-url>");
  return safe.length > MAX_MESSAGE_LENGTH ? `${safe.slice(0, MAX_MESSAGE_LENGTH)}…` : safe;
}

export class RpcFailureTracker {
  private failures: RpcFailureRecord[] = [];
  private failureCount = 0;
  private latestFailureAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private consecutiveFailures = 0;
  private hasAttempted = false;
  private activeEndpoint: string | null = null;
  private failoverCount = 0;

  recordFailure(record: Omit<RpcFailureRecord, "message"> & { message: string }): void {
    this.hasAttempted = true;
    this.failureCount += 1;
    this.consecutiveFailures += 1;
    this.latestFailureAt = record.time;
    this.failures.push({
      time: record.time,
      kind: record.kind,
      endpoint: record.endpoint,
      message: sanitizeMessage(record.message),
    });
    if (this.failures.length > MAX_RECENT_RPC_FAILURES) {
      this.failures.splice(0, this.failures.length - MAX_RECENT_RPC_FAILURES);
    }
  }

  recordSuccess(time: number, activeEndpoint?: string): void {
    this.hasAttempted = true;
    this.lastSuccessAt = time;
    this.consecutiveFailures = 0;
    if (activeEndpoint) this.activeEndpoint = activeEndpoint;
  }

  setActiveEndpoint(endpoint: string, failoverCount?: number): void {
    this.activeEndpoint = endpoint;
    if (failoverCount !== undefined) this.failoverCount = failoverCount;
  }

  reset(): void {
    this.failures = [];
    this.failureCount = 0;
    this.latestFailureAt = null;
    this.lastSuccessAt = null;
    this.consecutiveFailures = 0;
    this.hasAttempted = false;
    this.activeEndpoint = null;
    this.failoverCount = 0;
  }

  snapshot(): RpcFailureDiagnostics {
    let recoveryStatus: RpcRecoveryStatus;
    if (!this.hasAttempted) recoveryStatus = "unknown";
    else if (this.consecutiveFailures > 0) recoveryStatus = "failing";
    else if (this.failureCount > 0) recoveryStatus = "recovered";
    else recoveryStatus = "healthy";

    return {
      recoveryStatus,
      failureCount: this.failureCount,
      recentFailureCount: this.failures.length,
      latestFailureAt: this.latestFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      consecutiveFailures: this.consecutiveFailures,
      activeEndpoint: this.activeEndpoint,
      failoverCount: this.failoverCount,
      recentFailures: this.failures.map((record) => ({ ...record })),
    };
  }
}

/** Process-wide tracker shared by every resilient RPC client instance. */
const tracker = new RpcFailureTracker();

export function recordRpcFailure(
  record: Omit<RpcFailureRecord, "message"> & { message: string }
): void {
  tracker.recordFailure(record);
}

export function recordRpcSuccess(time: number, activeEndpoint?: string): void {
  tracker.recordSuccess(time, activeEndpoint);
}

export function setActiveRpcEndpoint(endpoint: string, failoverCount?: number): void {
  tracker.setActiveEndpoint(endpoint, failoverCount);
}

export function getRpcFailureDiagnostics(): RpcFailureDiagnostics {
  return tracker.snapshot();
}

/** Reset the process-wide tracker (tests and long-lived process reuse). */
export function resetRpcDiagnostics(): void {
  tracker.reset();
}
