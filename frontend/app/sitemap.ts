/**
 * WEB-03: Localized sitemap
 *
 * Generates sitemap entries for every public route × supported locale.
 * Each entry carries xhtml:link alternate-language annotations so that
 * crawlers can discover the full locale matrix from any single URL.
 *
 * Private, operational, and API routes are intentionally omitted:
 *   /admin, /login, /api/*, and their locale-prefixed equivalents.
 */

import type { MetadataRoute } from "next";
import { locales, defaultLocale, type Locale } from "@/i18n.config";

// ---------------------------------------------------------------------------
// Public routes that should be indexed.
// Add a new entry here whenever a new user-facing page is added.
// Do NOT list /admin, /login, /api/*, or any internal-use route.
// ---------------------------------------------------------------------------
const PUBLIC_ROUTES = [
  "/",
  "/apps",
  "/badge",
  "/developers",
  "/docs",
  "/holder",
  "/issuer",
  "/presets",
  "/privacy-guide",
  "/verifier",
  "/verify",
  "/verify-preset",
] as const;

/** Resolve the base URL in priority order. */
function resolveBaseUrl(): string {
  const candidate =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_STELLARCRED_BASE_URL;

  if (candidate) {
    // Strip any trailing slash so paths join cleanly.
    return candidate.replace(/\/$/, "");
  }

  // Fallback for local development or preview deploys.
  return "http://localhost:3000";
}

/** Build the absolute URL for a route in a given locale. */
function buildUrl(baseUrl: string, route: string, locale: Locale): string {
  const isDefault = locale === defaultLocale;
  const prefix = isDefault ? "" : `/${locale}`;
  // For the root path the prefix alone is enough; avoid a trailing slash on
  // non-root paths when combining with the prefix.
  const path = route === "/" ? prefix || "/" : `${prefix}${route}`;
  return `${baseUrl}${path}`;
}

/**
 * Build the full set of `alternates.languages` for a route.
 *
 * Returns a record keyed by BCP-47 tag (e.g. "en", "es", "x-default").
 * "x-default" always points at the English (default) version.
 */
function buildAlternates(
  baseUrl: string,
  route: string,
): MetadataRoute.Sitemap[number]["alternates"] {
  const languages: Record<string, string> = {};

  for (const locale of locales) {
    languages[locale] = buildUrl(baseUrl, route, locale);
  }

  // x-default signals the fallback language-agnostic URL to crawlers.
  languages["x-default"] = buildUrl(baseUrl, route, defaultLocale);

  return { languages };
}

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = resolveBaseUrl();

  const entries: MetadataRoute.Sitemap = [];

  for (const route of PUBLIC_ROUTES) {
    const alternates = buildAlternates(baseUrl, route);

    for (const locale of locales) {
      entries.push({
        url: buildUrl(baseUrl, route, locale),
        lastModified: new Date(),
        changeFrequency: route === "/" ? "weekly" : "monthly",
        priority: route === "/" ? 1.0 : 0.8,
        alternates,
      });
    }
  }

  return entries;
}
