# Health checks

Mithaq exposes health endpoints for the frontend app and the indexer
worker so deployment and monitoring tooling can confirm each service is up and
responding before routing traffic or marking a rollout healthy.

| Service | Endpoint | Purpose |
| --- | --- | --- |
| Frontend (Next.js) | `GET /api/health` | Liveness: process is up and serving requests |
| Frontend (Next.js) | `GET /api/ready` | Readiness: signer, contracts, RPC and Persona config are usable |
| Indexer worker | `GET /health` | Liveness + ingestion health (ledger lag, fetch errors) |
| Indexer worker | `GET /ready` | Readiness: the selected database answers a lightweight query |
| Indexer worker | `GET /diagnostics/rpc` | Operator-only sanitized RPC failure details |

Health and readiness endpoints are unauthenticated, return JSON, and are safe to
poll. `/diagnostics/rpc` is available only when `API_KEY` is configured and
requires that key, so it is never public.

## Common fields

Both `/api/health` (frontend) and `/health` (indexer) return:

| Field | Type | Meaning |
| --- | --- | --- |
| `status` | `"ok" \| "degraded" \| "error"` | Coarse health state (frontend is always `"ok"` while it can respond) |
| `ready` | boolean | `true` when the service should receive traffic |
| `service` | string | `mithaq-frontend` or `mithaq-indexer` |
| `version` | string | Deployed version, `"dev"` when not set |
| `uptimeSeconds` | number | Seconds since the process started |
| `timestamp` | string | ISO-8601 time the response was generated |

### Version metadata

- Frontend: `NEXT_PUBLIC_APP_VERSION` (see `frontend/.env.example`).
- Indexer: `INDEXER_VERSION`, falling back to `npm_package_version` when started
  through `npm start`, then `"dev"`.

Set these in the deployment pipeline (e.g. to the release tag or commit SHA) so
the health response tells you exactly which build is running.

## Frontend `GET /api/health`

```json
{
  "status": "ok",
  "ready": true,
  "service": "mithaq-frontend",
  "version": "1.0.0",
  "uptimeSeconds": 512,
  "timestamp": "2026-10-26T12:00:00.000Z",
  "outboundSink": { "...": "see docs/LOGGING.md" }
}
```

Always HTTP `200` while the process responds. Any non-200 or timeout means the
app is down. For dependency readiness use `GET /api/ready`, which returns `503`
with per-dependency details when it is not ready.

## Indexer `GET /health`

```json
{
  "status": "ok",
  "ready": true,
  "service": "mithaq-indexer",
  "version": "1.0.0",
  "uptimeSeconds": 3600,
  "timestamp": "2026-10-26T12:00:00.000Z",
  "lastLedger": 123456,
  "headLedger": 123460,
  "lag": 4,
  "lagSlo": {
    "targetLedgers": 30,
    "lagLedgers": 4,
    "status": "ok",
    "breached": false,
    "headLedgerKnown": true
  },
  "lastSuccessLedger": 123456,
  "lastError": null,
  "lastErrorTime": null,
  "consecutiveErrors": 0,
  "fetchAttempts": 1200,
  "fetchFailures": 0
}
```

| `status` | Condition | `ready` |
| --- | --- | --- |
| `ok` | `consecutiveErrors === 0` | `true` |
| `degraded` | 1–2 consecutive fetch failures | `true` |
| `error` | 3+ consecutive fetch failures (ingester likely stalled, data may be stale) | `false` |

`lag` is `headLedger - lastSuccessLedger`, or `-1` when the head ledger is not
yet known. `lagSlo` turns that lag into an alertable signal: `targetLedgers`
comes from `INDEXER_LAG_SLO_LEDGERS` (default `30`), `status` is `"breached"`
only when a known lag exceeds the budget, and `headLedgerKnown` is `false` when
there is no head data yet (never alert on missing data).

`/health` is liveness only: it returns HTTP `200` as long as the process can
respond, even during a database outage, so an orchestrator does not restart a
healthy worker. Use `GET /ready` for dependency readiness.

## Indexer `GET /ready`

```json
{
  "status": "ready",
  "ready": true,
  "service": "mithaq-indexer",
  "version": "1.0.0",
  "timestamp": "2026-10-26T12:00:00.000Z",
  "timeoutMs": 2000,
  "checks": [{ "name": "database", "status": "ok", "latencyMs": 3 }]
}
```

Returns HTTP `200` when the database probe succeeds and HTTP `503` when it fails
or exceeds `DB_READINESS_TIMEOUT_MS` (default `2000` ms). A failed check carries
a sanitized `error` string; connection strings and credentials are redacted.

## Deployment integration

### Staging

Gate each deploy on both services before promoting:

```sh
curl -fsS https://staging.example.com/api/health
curl -fsS https://staging.example.com/api/ready
curl -fsS http://indexer.staging.internal:3001/health | jq -e '.ready == true'
```

Also confirm the reported `version` matches the build you just deployed.

### Production

- **Liveness probes** (restart on failure): frontend `/api/health`, indexer
  `/health` (HTTP 200).
- **Readiness probes / load balancer** (stop routing on failure): frontend
  `/api/ready` and indexer `/ready` (HTTP 200 vs 503).
- **Alerting**: alert when indexer `ready` is `false` or `status` is
  `degraded` for several minutes, or when `lagSlo.breached` is `true`.

Kubernetes example:

```yaml
livenessProbe:
  httpGet: { path: /api/health, port: 3000 }
  periodSeconds: 15
readinessProbe:
  httpGet: { path: /api/ready, port: 3000 }
  periodSeconds: 15
# Indexer: liveness /health, readiness /ready (port 3001)
```

Docker Compose already uses the indexer `/health` endpoint as a
`healthcheck` (see `docker-compose.yml`). To also fail the container when the
ingester is stalled, check the `ready` field:

```sh
node -e "fetch('http://localhost:3001/health').then(r=>r.json()).then(b=>process.exit(b.ready?0:1)).catch(()=>process.exit(1))"
```
