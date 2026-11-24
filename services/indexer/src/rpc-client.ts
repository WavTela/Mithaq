import { SorobanRpc } from "@stellar/stellar-sdk";
import type { Config } from "./config";
import {
  recordRpcFailure,
  recordRpcSuccess,
  setActiveRpcEndpoint,
} from "./rpc-diagnostics";

export type RpcFailureKind = "transient" | "permanent" | "not-found";

export interface RpcEndpointStatus {
  index: number;
  url: string;
  failures: number;
  lastError: string | null;
  lastErrorAt: number | null;
}

export interface RpcDiagnostics {
  activeIndex: number;
  activeUrl: string;
  failoverCount: number;
  lastFailoverReason: string | null;
  endpoints: RpcEndpointStatus[];
}

export interface ResilientRpcClient {
  getContractData(
    contractId: string,
    key: Parameters<SorobanRpc.Server["getContractData"]>[1],
    durability: SorobanRpc.Durability,
  ): Promise<Awaited<ReturnType<SorobanRpc.Server["getContractData"]>>>;
  status(): RpcDiagnostics;
}

export interface RpcClientOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function sanitizeRpcUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (/token|key|secret|auth/i.test(key)) url.searchParams.set(key, "<redacted>");
    }
    return url.toString();
  } catch {
    return "<invalid-rpc-url>";
  }
}

function sanitizeRpcMessage(message: string, endpoints: string[]): string {
  let safe = message;
  for (const endpoint of endpoints) {
    safe = safe.split(endpoint).join(sanitizeRpcUrl(endpoint));
  }
  return safe
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer <redacted>")
    .replace(/((?:api[_-]?key|token|secret)["'=:\s]+)[^\s"',}&]+/gi, "$1<redacted>");
}

function errorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const record = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  const values = [record.status, record.code, record.response?.status];
  for (const value of values) {
    const status = Number(value);
    if (Number.isFinite(status) && status >= 100 && status <= 599) return status;
  }
  return undefined;
}

export function classifyRpcError(err: unknown): RpcFailureKind {
  const status = errorStatus(err);
  if (status === 404) return "not-found";
  if (status === 408 || status === 429 || (status !== undefined && status >= 500)) {
    return "transient";
  }
  const message = ((err as Error)?.message ?? String(err)).toLowerCase();
  if (/(not found|could not find|does not exist|404)/.test(message)) return "not-found";
  if (
    /(fetch failed|network|timeout|timed out|econnreset|enotfound|socket hang up|terminated|rate.?limit|temporarily unavailable|bad gateway|service unavailable|gateway timeout)/.test(
      message,
    )
  ) {
    return "transient";
  }
  return "permanent";
}

let latestRpcDiagnostics: RpcDiagnostics | undefined;

export function getRpcDiagnostics(): RpcDiagnostics | undefined {
  if (!latestRpcDiagnostics) return undefined;
  return {
    ...latestRpcDiagnostics,
    endpoints: latestRpcDiagnostics.endpoints.map((endpoint) => ({ ...endpoint })),
  };
}

export function createResilientRpcClient(
  config: Config,
  options: RpcClientOptions = {},
): ResilientRpcClient {
  const endpoints = config.rpcUrls?.length ? config.rpcUrls : [config.rpcUrl];
  const maxAttempts = options.maxAttempts ?? config.httpClient?.retry.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? config.httpClient?.retry.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? config.httpClient?.retry.maxDelayMs ?? 8_000;
  const jitterRatio = options.jitterRatio ?? config.httpClient?.retry.jitterRatio ?? 0.2;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const servers = endpoints.map((endpoint) => new SorobanRpc.Server(endpoint));

  const diagnostics: RpcDiagnostics = {
    activeIndex: 0,
    activeUrl: sanitizeRpcUrl(endpoints[0]),
    failoverCount: 0,
    lastFailoverReason: null,
    endpoints: endpoints.map((endpoint, index) => ({
      index,
      url: sanitizeRpcUrl(endpoint),
      failures: 0,
      lastError: null,
      lastErrorAt: null,
    })),
  };
  latestRpcDiagnostics = diagnostics;
  setActiveRpcEndpoint(diagnostics.activeUrl, diagnostics.failoverCount);

  const backoff = (attempt: number): number => {
    const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
    return Math.min(exponential + exponential * jitterRatio * random(), maxDelayMs);
  };

  const perform = async <T>(operation: (server: SorobanRpc.Server) => Promise<T>): Promise<T> => {
    const attempted = new Set<number>();

    while (attempted.size < endpoints.length) {
      const index = diagnostics.activeIndex;
      attempted.add(index);
      const endpoint = diagnostics.endpoints[index];

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const result = await operation(servers[index]);
          diagnostics.activeIndex = index;
          diagnostics.activeUrl = endpoint.url;
          recordRpcSuccess(now(), endpoint.url);
          return result;
        } catch (err) {
          const kind = classifyRpcError(err);
          const reason = sanitizeRpcMessage((err as Error)?.message ?? String(err), endpoints);
          endpoint.failures += 1;
          endpoint.lastError = reason;
          endpoint.lastErrorAt = now();
          diagnostics.lastFailoverReason = reason;
          recordRpcFailure({
            time: endpoint.lastErrorAt,
            kind,
            endpoint: endpoint.url,
            message: reason,
          });

          if (kind !== "transient") throw err;
          if (attempt >= maxAttempts) break;
          await sleep(backoff(attempt));
        }
      }

      const next = diagnostics.endpoints.find((candidate) => !attempted.has(candidate.index));
      if (!next) break;
      diagnostics.activeIndex = next.index;
      diagnostics.activeUrl = next.url;
      diagnostics.failoverCount += 1;
      setActiveRpcEndpoint(diagnostics.activeUrl, diagnostics.failoverCount);
    }

    const endpoint = diagnostics.endpoints[diagnostics.activeIndex];
    throw new Error(
      `Soroban RPC unavailable after trying ${attempted.size} endpoint(s); last endpoint ${endpoint.url}: ${endpoint.lastError ?? "unknown error"}`,
    );
  };

  return {
    getContractData(contractId, key, durability) {
      return perform((server) => server.getContractData(contractId, key, durability));
    },
    status() {
      return {
        ...diagnostics,
        endpoints: diagnostics.endpoints.map((endpoint) => ({ ...endpoint })),
      };
    },
  };
}
