# API Deprecation Process

This document defines how Mithaq announces, measures, and removes deprecated endpoints and fields, and what compatibility guarantees downstream SDK consumers can rely on.

---

## Principles

- **Announce early.** Deprecations are signalled at least one minor release before removal.
- **Never break silently.** Every deprecated endpoint and field emits a machine-readable `Deprecation` response header so callers can discover the change without reading release notes.
- **Measure usage before removal.** An endpoint is not removed until its request rate in the `Deprecation` metric drops to zero for at least 14 days in production, or the compatibility window (see below) expires, whichever comes later.

---

## Compatibility Window

| Change type | Minimum notice period |
| :--- | :--- |
| Endpoint removal | 90 days after first `Deprecation` header |
| Field removal from a response | 60 days after first `Deprecation` header |
| Behaviour change with no schema change | 30 days, documented in release notes |

The compatibility window begins the day the `Deprecation` header first appears in a released build, not the day the PR merges.

---

## Response Headers

Deprecated endpoints and fields return two headers on every response:

### `Deprecation`

An [RFC 9745](https://datatracker.ietf.org/doc/html/rfc9745) `Deprecation` header with the ISO-8601 date the deprecation took effect:

```
Deprecation: 2025-06-01T00:00:00Z
```

### `Sunset`

An [RFC 8594](https://datatracker.ietf.org/doc/html/rfc8594) `Sunset` header with the earliest date the endpoint or field may be removed:

```
Sunset: 2025-09-01T00:00:00Z
```

Both dates are midnight UTC. SDK consumers should log a warning on first receipt so operators are aware of the pending removal before it happens.

---

## Announcing a Deprecation

1. **Open an issue** labelled `deprecation` describing the endpoint or field, the reason for removal, and the proposed `Sunset` date.
2. **Add the headers** in the route handler (see [Deprecation header utility](#deprecation-header-utility) below).
3. **Update this document** — add a row to the [Current Deprecations](#current-deprecations) table.
4. **Publish a release note** in `CHANGELOG.md` under the next version.

---

## Deprecation Header Utility

`services/indexer/src/api.ts` exports a helper that stamps a response with both headers:

```typescript
import { setDeprecationHeaders } from "./api";

// Inside a route handler:
setDeprecationHeaders(res, {
  deprecatedAt: "2025-06-01T00:00:00Z",
  sunsetAt:     "2025-09-01T00:00:00Z",
});
```

The helper is a no-op when `deprecatedAt` is not supplied, so callers can pass a config object and enable deprecation without changing the call sites.

---

## Removing a Deprecated Endpoint

1. Confirm the `Sunset` date has passed **and** the usage metric (`indexer_deprecated_requests_total{endpoint="..."}`) has been zero for ≥ 14 days.
2. Remove the route handler and its tests.
3. Update the [Current Deprecations](#current-deprecations) table (move to Removed).
4. Bump the minor version and add a `BREAKING` entry in `CHANGELOG.md`.

---

## SDK Compatibility

The TypeScript SDK (`sdk/`) mirrors the HTTP API's types in `sdk/src/indexer-types.ts`. Deprecated fields are annotated with a `@deprecated` JSDoc tag so IDE tooling surfaces the warning:

```typescript
/**
 * @deprecated Use `state` instead. Will be removed after 2025-09-01.
 */
expired?: boolean;
```

The SDK's type drift check (`sdk/scripts/check-types-drift.ts`) runs in CI and fails if a non-deprecated public field present in the actual HTTP response is missing from the declared types.

---

## Current Deprecations

| Endpoint / Field | Deprecated since | Sunset date | Reason | Replacement |
| :--- | :--- | :--- | :--- | :--- |
| _(none)_ | — | — | — | — |
