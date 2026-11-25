# Observability & Prometheus Alerting Guide

This document details the alerting rules for key failure conditions in Mithaq, how to customize thresholds, and how to wire alert notifications to external channels via Prometheus Alertmanager.

---

## Key Paging Conditions & Alert Rules

Prometheus rule definitions are located in `docker/prometheus/alert.rules.yml`.

| Alert Name | Metric / PromQL Expression | Default Threshold | Severity | Description |
| :--- | :--- | :--- | :--- | :--- |
| **IndexerLagHigh** | `mithaq_indexer_ledgers_behind > 10` | > 10 ledgers | `critical` | Indexer falls behind blockchain head. |
| **HighIssuanceFailureRate** | `(sum(rate(mithaq_issuance_failures_total[5m])) / sum(rate(mithaq_issuance_attempts_total[5m]))) > 0.05` | > 5% over 5m | `critical` | Issuance failures spike due to key misconfiguration or third-party outages. |
| **APIReadyFailing** | `mithaq_api_ready_status == 0` | Failing > 1m | `critical` | `/api/ready` health probe returns non-200. |
| **DemoIssuerKeyActiveInProduction** | `mithaq_demo_issuer_mode{env="production"} == 1` | Immediate (0m) | `critical` | Hardcoded demo issuer key detected in production. |
| **WebhookDeliveryExhausted** | `indexer_webhook_subscriptions_exhausted > 0` | Immediate (0m) | `warning` | One or more webhook subscriptions have exhausted all retry attempts with no successful delivery. |
| **WebhookDeliveryFailureRateHigh** | `rate(indexer_webhook_deliveries_failure_total[10m]) / (rate(...success...) + rate(...failure...)) > 0.5` | > 50% over 5m | `warning` | More than half of recent webhook delivery attempts failed. |

---

## Diagnosing Webhook Delivery Failures

When `WebhookDeliveryExhausted` or `WebhookDeliveryFailureRateHigh` fires:

1. **Destination outage vs. signature misconfiguration**: The `last_error` field in `GET /webhooks/subscriptions/:id/deliveries?outcome=failed` contains the HTTP status code or connection error — a `401`/`403` suggests a signing secret mismatch; a `5xx` or timeout suggests the destination is down. No secret material is ever logged or returned.
2. **Check the subscription target URL**: Confirm the destination is reachable and the `WEBHOOK_SIGNING_SECRET` environment variable matches what the destination expects.
3. **Re-queue or delete**: Once the issue is resolved, delete and recreate the subscription to clear the exhausted state. Future deliveries for new events will begin immediately.

---

## Configurable Thresholds

Thresholds can be customized based on environment needs:

1. **Prometheus Rule Adjustments**: Update values directly in `docker/prometheus/alert.rules.yml`.
2. **Environment Overrides**: If using envsubst or Helm charts, parameterize thresholds using environment variables:
   - `INDEXER_LAG_THRESHOLD_LEDGERS` (default: `10`)
   - `ISSUANCE_FAILURE_RATE_THRESHOLD` (default: `0.05`)

---

## Wiring Notifications via Alertmanager

To deliver alerts to notification channels (Slack, Discord, PagerDuty, Webhooks), route Prometheus alerts to an **Alertmanager** instance.

### Example `alertmanager.yml` Configuration

```yaml
global:
  resolve_timeout: 5m

route:
  group_by: ['alertname', 'severity']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  receiver: 'slack-notifications'

receivers:
  - name: 'slack-notifications'
    slack_configs:
      - api_url: '[https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK](https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK)'
        channel: '#mithaq-alerts'
        send_resolved: true
        title: '[{{ .Status | toUpper }}] {{ .CommonAnnotations.summary }}'
        text: '{{ .CommonAnnotations.description }}'

