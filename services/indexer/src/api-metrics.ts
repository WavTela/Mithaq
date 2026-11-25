/**
 * api-metrics.ts — Bounded-label Prometheus metrics for API traffic (API-16).
 *
 * Instruments request count, latency, status class and rate-limit outcomes
 * without ever using user-supplied values as labels. Label values are drawn
 * from fixed sets:
 *
 *   method        GET | POST | PUT | PATCH | DELETE | HEAD | OPTIONS | OTHER
 *   route         a route pattern declared in this service, or "unmatched"
 *   status_class  2xx | 3xx | 4xx | 5xx | other
 *   outcome       allowed | limited | disabled          (rate limiting)
 *
 * A route label is never the raw request URL, a wallet address, an issuer ID or
 * any other path segment. For matched requests Express supplies the declared
 * route pattern; for requests that never reached routing (rate-limited or 404)
 * we match the path against the app's declared route patterns and otherwise
 * fall back to "unmatched".
 */

import type { Request, RequestHandler, Response } from "express";

export type MethodLabel =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS"
  | "OTHER";

export type StatusClassLabel = "2xx" | "3xx" | "4xx" | "5xx" | "other";

export type RateLimitOutcome = "allowed" | "limited" | "disabled";

export interface RequestLabels {
  method: MethodLabel;
  route: string;
  statusClass: StatusClassLabel;
}

/** Fixed latency buckets in seconds, mirroring typical HTTP latency SLOs. */
export const LATENCY_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

const METHODS: ReadonlySet<string> = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

const FALLBACK_ROUTE = "unmatched";
const MAX_ROUTE_LABEL_LENGTH = 120;

export function classifyMethod(method: string | undefined): MethodLabel {
  const upper = (method ?? "").toUpperCase();
  return METHODS.has(upper) ? (upper as MethodLabel) : "OTHER";
}

export function classifyStatusClass(statusCode: number): StatusClassLabel {
  if (statusCode >= 200 && statusCode < 300) return "2xx";
  if (statusCode >= 300 && statusCode < 400) return "3xx";
  if (statusCode >= 400 && statusCode < 500) return "4xx";
  if (statusCode >= 500 && statusCode < 600) return "5xx";
  return "other";
}

/**
 * Normalize a declared route pattern into a bounded label. Anything that is not
 * a plausible Express route template becomes "unmatched", so a bug that passes
 * a raw URL here still cannot create unbounded cardinality.
 */
export function boundedRouteLabel(path: string | undefined): string {
  if (!path) return FALLBACK_ROUTE;
  const trimmed = path.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.length > MAX_ROUTE_LABEL_LENGTH ||
    !/^[A-Za-z0-9_/:.\-*]+$/.test(trimmed)
  ) {
    return FALLBACK_ROUTE;
  }
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

/** Translate a declared route path into a matcher for a concrete request path. */
function routeMatcher(pattern: string): RegExp {
  const source = pattern
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) return "[^/]+";
      if (segment === "*") return ".*";
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return new RegExp(`^${source}/?$`);
}

function declaredRoutes(app: unknown): string[] {
  const stack =
    (app as { _router?: { stack?: Array<{ route?: { path?: unknown } }> } })
      ._router?.stack ?? [];
  const routes: string[] = [];
  for (const layer of stack) {
    const path = layer.route?.path;
    if (typeof path === "string") routes.push(path);
  }
  return routes;
}

/** Resolve the bounded route label for a request, without reading query strings. */
export function resolveRouteLabel(req: Request): string {
  if (req.route && typeof req.route.path === "string") {
    const base = req.baseUrl ?? "";
    return boundedRouteLabel(`${base}${req.route.path}`);
  }

  const path = req.path;
  if (!path) return FALLBACK_ROUTE;
  for (const pattern of declaredRoutes(req.app)) {
    const label = boundedRouteLabel(pattern);
    if (label === FALLBACK_ROUTE) continue;
    if (routeMatcher(label).test(path)) return label;
  }
  return FALLBACK_ROUTE;
}

interface DurationSeries {
  labels: RequestLabels;
  buckets: number[];
  count: number;
  sum: number;
}

function labelKey(labels: RequestLabels): string {
  return `${labels.method}|${labels.route}|${labels.statusClass}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export class ApiMetrics {
  private requests = new Map<string, { labels: RequestLabels; count: number }>();
  private durations = new Map<string, DurationSeries>();
  private rateLimits = new Map<RateLimitOutcome, number>();

  observeRequest(labels: RequestLabels, durationSeconds: number): void {
    const key = labelKey(labels);

    const request = this.requests.get(key);
    if (request) request.count += 1;
    else this.requests.set(key, { labels: { ...labels }, count: 1 });

    const duration = this.durations.get(key);
    const safeDuration =
      Number.isFinite(durationSeconds) && durationSeconds >= 0
        ? durationSeconds
        : 0;
    if (duration) {
      duration.count += 1;
      duration.sum += safeDuration;
      for (let i = 0; i < LATENCY_BUCKETS_SECONDS.length; i++) {
        if (safeDuration <= LATENCY_BUCKETS_SECONDS[i]) duration.buckets[i] += 1;
      }
    } else {
      this.durations.set(key, {
        labels: { ...labels },
        buckets: LATENCY_BUCKETS_SECONDS.map((bucket) =>
          safeDuration <= bucket ? 1 : 0
        ),
        count: 1,
        sum: safeDuration,
      });
    }
  }

  observeRateLimit(outcome: RateLimitOutcome): void {
    this.rateLimits.set(outcome, (this.rateLimits.get(outcome) ?? 0) + 1);
  }

  /** Render this registry's series as Prometheus exposition lines. */
  render(): string[] {
    const lines: string[] = [];

    lines.push(
      "# HELP indexer_api_requests_total HTTP requests handled by the indexer API.",
    );
    lines.push("# TYPE indexer_api_requests_total counter");
    for (const { labels, count } of this.requests.values()) {
      lines.push(
        `indexer_api_requests_total{method="${labels.method}",route="${escapeLabelValue(
          labels.route,
        )}",status_class="${labels.statusClass}"} ${count}`,
      );
    }

    lines.push(
      "# HELP indexer_api_request_duration_seconds HTTP request latency in seconds.",
    );
    lines.push("# TYPE indexer_api_request_duration_seconds histogram");
    for (const series of this.durations.values()) {
      const { labels } = series;
      const base = `method="${labels.method}",route="${escapeLabelValue(
        labels.route,
      )}",status_class="${labels.statusClass}"`;
      LATENCY_BUCKETS_SECONDS.forEach((bucket, index) => {
        lines.push(
          `indexer_api_request_duration_seconds_bucket{${base},le="${bucket}"} ${series.buckets[index]}`,
        );
      });
      lines.push(
        `indexer_api_request_duration_seconds_bucket{${base},le="+Inf"} ${series.count}`,
      );
      lines.push(`indexer_api_request_duration_seconds_sum{${base}} ${series.sum}`);
      lines.push(`indexer_api_request_duration_seconds_count{${base}} ${series.count}`);
    }

    lines.push(
      "# HELP indexer_api_rate_limit_total Rate-limit decisions by outcome.",
    );
    lines.push("# TYPE indexer_api_rate_limit_total counter");
    for (const [outcome, count] of this.rateLimits.entries()) {
      lines.push(`indexer_api_rate_limit_total{outcome="${outcome}"} ${count}`);
    }

    return lines;
  }
}

/** Record one series per completed request, using only bounded labels. */
export function apiMetricsMiddleware(metrics: ApiMetrics): RequestHandler {
  return (req: Request, res: Response, next) => {
    const startedAt = process.hrtime.bigint();
    res.once("finish", () => {
      const elapsedSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      metrics.observeRequest(
        {
          method: classifyMethod(req.method),
          route: resolveRouteLabel(req),
          statusClass: classifyStatusClass(res.statusCode),
        },
        elapsedSeconds,
      );
    });
    next();
  };
}
