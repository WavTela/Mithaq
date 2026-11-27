/**
 * WEB-03: Robots policy
 *
 * Allows crawlers to index all public-facing content while blocking private,
 * operational, and API routes from being advertised for indexing.
 *
 * Blocked route categories:
 *   /api/*          — backend endpoints, not user-facing content
 *   /admin          — admin tooling (also protected by ADMIN_API_KEY at runtime)
 *   /login          — authentication flow; no indexable content
 *   /es/admin       — locale-prefixed admin route
 *   /es/login       — locale-prefixed login route
 *   /csp-report     — CSP violation sink
 *   /_next/*        — Next.js build assets (already unreachable, belt+braces)
 */

import type { MetadataRoute } from "next";

function resolveBaseUrl(): string {
  const candidate =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_STELLARCRED_BASE_URL;

  if (candidate) {
    return candidate.replace(/\/$/, "");
  }

  return "http://localhost:3000";
}

export default function robots(): MetadataRoute.Robots {
  const baseUrl = resolveBaseUrl();

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          // API routes — machine-to-machine, never user-facing pages
          "/api/",
          // Admin panel — requires ADMIN_API_KEY; must not appear in search results
          "/admin",
          "/admin/",
          // Login — transient auth flow with no stable indexable content
          "/login",
          "/login/",
          // Locale-prefixed equivalents of the above private routes
          "/es/admin",
          "/es/admin/",
          "/es/login",
          "/es/login/",
          // Next.js internal asset paths (precautionary)
          "/_next/",
        ],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
    host: baseUrl,
  };
}
