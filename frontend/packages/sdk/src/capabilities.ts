// Capability-descriptor bootstrap (issue #639).
//
// A deployment publishes its machine-readable capability descriptor at
// GET {base}/api/capabilities: network, contract IDs + on-chain versions,
// supported credential types, registered-issuer summary, optional public
// indexer URL, sponsored-submission availability, and the SDK version range
// known to work. `bootstrap()` fetches it once and configures the SDK, so an
// integrator supplies one URL (the deployment base URL) instead of a set of
// contract IDs. The descriptor is public, cacheable, and contains nothing
// sensitive; it must agree with the DEPLOYMENTS.md registry record.

import { ConfigError, configure, getConfig } from "./claims";

/** One deployed contract entry in the descriptor. */
export interface CapabilitiesContractEntry {
  id: string;
  version?: string | null;
}

export type CapabilitiesContractKey =
  "issuer_registry" | "credential_verifier" | "proof_registry" | "gated_pool";

/** Shape of GET {base}/api/capabilities. Only fields the SDK uses are required. */
export interface CapabilitiesDescriptor {
  descriptor_version: number;
  app_version?: string;
  network: {
    id?: string;
    passphrase?: string;
    rpc_url?: string;
  };
  contracts?: Partial<
    Record<CapabilitiesContractKey, CapabilitiesContractEntry | null>
  >;
  credential_types?: string[];
  issuers?: { count: number; credential_types?: string[] } | null;
  indexer?: { url: string } | null;
  sponsored_submission?: { available: boolean };
  sdk?: { package?: string; version_range?: string };
}

export interface BootstrapOptions {
  /** Full descriptor URL. Defaults to `{baseUrl}/api/capabilities`. */
  descriptorUrl?: string;
  requestTimeoutMs?: number;
  /** Test seam — override the global fetch. */
  fetchImpl?: typeof fetch;
}

export function validateCapabilitiesDescriptor(
  raw: unknown,
): CapabilitiesDescriptor {
  const fail = (detail: string): never => {
    throw new ConfigError(`Invalid capability descriptor: ${detail}`);
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("expected a JSON object");
  }
  const d = raw as Record<string, unknown>;
  if (typeof d.descriptor_version !== "number" || d.descriptor_version < 1) {
    fail("descriptor_version must be a positive number");
  }
  if (!d.network || typeof d.network !== "object" || Array.isArray(d.network)) {
    fail("network object is missing");
  }
  const network = d.network as Record<string, unknown>;
  if (
    typeof network.passphrase !== "string" ||
    network.passphrase.length === 0
  ) {
    fail("network.passphrase must be a non-empty string");
  }
  if (network.rpc_url !== undefined && network.rpc_url !== null) {
    if (typeof network.rpc_url !== "string" || network.rpc_url.length === 0) {
      fail("network.rpc_url must be a non-empty string when present");
    }
    try {
      new URL(network.rpc_url as string);
    } catch {
      fail("network.rpc_url must be a valid URL");
    }
  }
  if (
    network.id !== undefined &&
    network.id !== null &&
    typeof network.id !== "string"
  ) {
    fail("network.id must be a string when present");
  }
  if (d.contracts !== undefined) {
    if (
      !d.contracts ||
      typeof d.contracts !== "object" ||
      Array.isArray(d.contracts)
    ) {
      fail("contracts must be an object");
    }
    const contracts = d.contracts as Record<string, unknown>;
    for (const [key, entry] of Object.entries(contracts)) {
      if (entry === null) continue;
      if (typeof entry !== "object" || Array.isArray(entry)) {
        fail(`contracts.${key} must be an object or null`);
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.id !== "string" || e.id.length === 0) {
        fail(`contracts.${key}.id must be a non-empty string`);
      }
      if (
        e.version !== undefined &&
        e.version !== null &&
        typeof e.version !== "string"
      ) {
        fail(`contracts.${key}.version must be a string when present`);
      }
    }
  }
  if (d.credential_types !== undefined) {
    if (!Array.isArray(d.credential_types)) {
      fail("credential_types must be an array when present");
    }
    for (const ct of d.credential_types as unknown[]) {
      if (typeof ct !== "string" || ct.length === 0) {
        fail("each entry in credential_types must be a non-empty string");
      }
    }
  }
  if (d.issuers !== undefined && d.issuers !== null) {
    if (typeof d.issuers !== "object" || Array.isArray(d.issuers)) {
      fail("issuers must be an object or null when present");
    }
    const issuers = d.issuers as Record<string, unknown>;
    if (
      typeof issuers.count !== "number" ||
      !Number.isInteger(issuers.count) ||
      issuers.count < 0
    ) {
      fail("issuers.count must be a non-negative integer");
    }
    if (issuers.credential_types !== undefined) {
      if (!Array.isArray(issuers.credential_types)) {
        fail("issuers.credential_types must be an array when present");
      }
      for (const ct of issuers.credential_types as unknown[]) {
        if (typeof ct !== "string" || ct.length === 0) {
          fail(
            "each entry in issuers.credential_types must be a non-empty string",
          );
        }
      }
    }
  }
  if (d.sponsored_submission !== undefined && d.sponsored_submission !== null) {
    if (
      typeof d.sponsored_submission !== "object" ||
      Array.isArray(d.sponsored_submission)
    ) {
      fail("sponsored_submission must be an object or null when present");
    }
    const ss = d.sponsored_submission as Record<string, unknown>;
    if (typeof ss.available !== "boolean") {
      fail("sponsored_submission.available must be a boolean");
    }
  }
  if (d.sdk !== undefined && d.sdk !== null) {
    if (typeof d.sdk !== "object" || Array.isArray(d.sdk)) {
      fail("sdk must be an object or null when present");
    }
    const sdk = d.sdk as Record<string, unknown>;
    if (sdk.package !== undefined && typeof sdk.package !== "string") {
      fail("sdk.package must be a string when present");
    }
    if (
      sdk.version_range !== undefined &&
      typeof sdk.version_range !== "string"
    ) {
      fail("sdk.version_range must be a string when present");
    }
  }
  if (d.app_version !== undefined && typeof d.app_version !== "string") {
    fail("app_version must be a string when present");
  }
  return raw as CapabilitiesDescriptor;
}

/** Default descriptor URL for a deployment base URL: `{base}/api/capabilities`. */
export function capabilitiesUrl(baseUrl?: string): string {
  const base = (baseUrl ?? getConfig().baseUrl).replace(/\/+$/, "");
  return `${base}/api/capabilities`;
}

/**
 * Fetch and validate the capability descriptor from a deployment. Throws
 * ConfigError on network failure, non-2xx, invalid JSON, or a malformed
 * payload.
 */
export async function fetchCapabilities(
  opts: BootstrapOptions = {},
): Promise<CapabilitiesDescriptor> {
  const url = opts.descriptorUrl ?? capabilitiesUrl();
  const timeoutMs = opts.requestTimeoutMs ?? getConfig().requestTimeoutMs;
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ConfigError(
      `Failed to fetch capability descriptor at ${url}: ${(e as Error).message}`,
    );
  }
  if (!res.ok) {
    throw new ConfigError(
      `Capability descriptor at ${url} returned HTTP ${res.status}`,
    );
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (e) {
    throw new ConfigError(
      `Capability descriptor at ${url} is not valid JSON: ${(e as Error).message}`,
    );
  }
  return validateCapabilitiesDescriptor(raw);
}

/**
 * Configure the SDK from a deployment's capability descriptor — the one-URL
 * setup path. Applies the ProofRegistry contract ID (registryId), and the
 * RPC URL / network passphrase when the descriptor provides them.
 *
 * @example
 * await Mithaq.bootstrap({ descriptorUrl: "https://app.example.com/api/capabilities" });
 * await Mithaq.hasClaim(wallet, "kyc");
 */
export async function bootstrap(
  opts: BootstrapOptions = {},
): Promise<CapabilitiesDescriptor> {
  const descriptor = await fetchCapabilities(opts);

  const proofRegistry = descriptor.contracts?.proof_registry;
  if (
    !proofRegistry ||
    typeof proofRegistry.id !== "string" ||
    proofRegistry.id === ""
  ) {
    throw new ConfigError(
      "Capability descriptor has no proof_registry contract ID — cannot bootstrap",
    );
  }

  configure({
    registryId: proofRegistry.id,
    ...(descriptor.network.rpc_url
      ? { rpcUrl: descriptor.network.rpc_url }
      : {}),
    ...(descriptor.network.passphrase
      ? { networkPassphrase: descriptor.network.passphrase }
      : {}),
  });
  return descriptor;
}
