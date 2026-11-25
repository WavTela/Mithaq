/**
 * VerifyRequestReview — Confirmation panel shown before the user begins
 * verification from a protocol-issued verify link.
 *
 * Displays:
 *   - The requesting origin (domain that sent the link)
 *   - The credential type being requested
 *   - Any threshold or restriction attached to the request
 *
 * Suspicious, malformed, or unsupported requests are rejected upstream by
 * parseVerifyParams() and shown via VerifyLinkError instead — this component
 * only renders for structurally valid requests that passed all checks.
 */

"use client";

import { IconAlertTriangle, IconExternalLink, IconShieldCheck } from "@tabler/icons-react";

export interface VerifyRequestSummary {
  /** Hostname of the requesting origin, e.g. "app.example.com". */
  requestingDomain: string;
  /** Validated credential type, e.g. "kyc", "age". */
  claimType: string | null;
  /** Human-readable threshold, e.g. "≥ 18 years", "$50,000". Null when not applicable. */
  thresholdLabel: string | null;
  /** Restricted country codes, if any. */
  restrictedCodes?: string[];
}

const CLAIM_DISPLAY_NAMES: Record<string, string> = {
  kyc: "Identity verification (KYC)",
  age: "Age credential",
  income: "Income credential",
  funds: "Available funds credential",
  jurisdiction: "Jurisdiction credential",
  accreditation: "Accredited investor credential",
  employment: "Employment credential",
};

function claimDisplayName(claimType: string | null): string {
  if (!claimType) return "Credential (type not specified)";
  return CLAIM_DISPLAY_NAMES[claimType] ?? `"${claimType}" credential`;
}

interface VerifyRequestReviewProps {
  summary: VerifyRequestSummary;
  onConfirm: () => void;
  onDecline: () => void;
}

export function VerifyRequestReview({
  summary,
  onConfirm,
  onDecline,
}: VerifyRequestReviewProps) {
  const { requestingDomain, claimType, thresholdLabel, restrictedCodes } = summary;

  return (
    <div
      data-testid="verify-request-review"
      className="card"
      style={{ maxWidth: 480, margin: "0 auto" }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.6rem",
          marginBottom: "1.25rem",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 36,
            height: 36,
            borderRadius: "50%",
            background: "rgba(62, 207, 142, 0.1)",
            flexShrink: 0,
          }}
        >
          <IconShieldCheck size={18} color="var(--accent)" stroke={2} />
        </span>
        <div>
          <div className="eyebrow" style={{ marginBottom: "0.1rem" }}>
            Verification request
          </div>
          <div style={{ fontWeight: 600, fontSize: "0.95rem", lineHeight: 1.3 }}>
            Review before you continue
          </div>
        </div>
      </div>

      {/* Request details */}
      <div
        style={{
          borderRadius: "var(--radius)",
          border: "1px solid var(--border)",
          overflow: "hidden",
          marginBottom: "1.25rem",
        }}
      >
        {/* Requesting origin */}
        <div
          style={{
            padding: "0.75rem 1rem",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <span className="faint" style={{ fontSize: "0.8125rem", flexShrink: 0 }}>
            Requesting origin
          </span>
          <span
            data-testid="review-requesting-domain"
            style={{
              fontWeight: 600,
              fontSize: "0.875rem",
              color: "var(--accent)",
              display: "flex",
              alignItems: "center",
              gap: "0.3rem",
              wordBreak: "break-all",
            }}
          >
            {requestingDomain}
            <IconExternalLink size={12} stroke={2} style={{ flexShrink: 0, opacity: 0.6 }} />
          </span>
        </div>

        {/* Requested credential */}
        <div
          style={{
            padding: "0.75rem 1rem",
            borderBottom: thresholdLabel || (restrictedCodes && restrictedCodes.length > 0)
              ? "1px solid var(--border)"
              : undefined,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "0.5rem",
          }}
        >
          <span className="faint" style={{ fontSize: "0.8125rem", flexShrink: 0 }}>
            Requested credential
          </span>
          <span
            data-testid="review-claim-type"
            style={{ fontWeight: 500, fontSize: "0.875rem", textAlign: "right" }}
          >
            {claimDisplayName(claimType)}
          </span>
        </div>

        {/* Threshold, if applicable */}
        {thresholdLabel && (
          <div
            style={{
              padding: "0.75rem 1rem",
              borderBottom:
                restrictedCodes && restrictedCodes.length > 0
                  ? "1px solid var(--border)"
                  : undefined,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "0.5rem",
            }}
          >
            <span className="faint" style={{ fontSize: "0.8125rem", flexShrink: 0 }}>
              Requirement
            </span>
            <span
              data-testid="review-threshold"
              style={{ fontWeight: 500, fontSize: "0.875rem", textAlign: "right" }}
            >
              {thresholdLabel}
            </span>
          </div>
        )}

        {/* Restricted jurisdictions, if any */}
        {restrictedCodes && restrictedCodes.length > 0 && (
          <div
            style={{
              padding: "0.75rem 1rem",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: "0.5rem",
            }}
          >
            <span
              className="faint"
              style={{ fontSize: "0.8125rem", flexShrink: 0, paddingTop: "0.1rem" }}
            >
              Restricted regions
            </span>
            <span
              data-testid="review-restricted"
              style={{
                fontWeight: 500,
                fontSize: "0.8125rem",
                textAlign: "right",
                color: "var(--warning, #f59e0b)",
              }}
            >
              {restrictedCodes.join(", ")}
            </span>
          </div>
        )}
      </div>

      {/* Warning for unknown or unrecognised domains */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: "0.5rem",
          padding: "0.65rem 0.8rem",
          borderRadius: "var(--radius-xs)",
          background: "rgba(245, 158, 11, 0.07)",
          border: "1px solid rgba(245, 158, 11, 0.2)",
          marginBottom: "1.25rem",
          fontSize: "0.8125rem",
          lineHeight: 1.6,
          color: "var(--muted)",
        }}
      >
        <IconAlertTriangle
          size={15}
          stroke={2}
          style={{ flexShrink: 0, marginTop: "0.15rem", color: "var(--warning, #f59e0b)" }}
        />
        <span>
          Only continue if you trust{" "}
          <strong style={{ color: "var(--fg)" }}>{requestingDomain}</strong> and
          intended to open this link. Your credential is never shared — only a
          zero-knowledge proof is submitted.
        </span>
      </div>

      {/* Action buttons */}
      <div style={{ display: "flex", gap: "0.6rem" }}>
        <button
          data-testid="review-confirm-btn"
          className="btn btn-primary"
          style={{ flex: 1 }}
          onClick={onConfirm}
        >
          Continue
        </button>
        <button
          data-testid="review-decline-btn"
          className="btn btn-ghost"
          style={{ flex: 1 }}
          onClick={onDecline}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default VerifyRequestReview;
