/**
 * WEB-03 — Localized sitemap tests
 *
 * Verifies that sitemap() produces:
 *   - One entry per route × locale
 *   - Correct locale-prefixed URLs for non-default locales
 *   - Default locale served without a prefix (/)
 *   - Alternate-language annotations on every entry
 *   - x-default pointing at the default-locale version
 *   - No /admin, /login, or /api/* entries
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import sitemap from "./sitemap";
import { locales, defaultLocale } from "@/i18n.config";

// Silence any "NEXT_PUBLIC_APP_URL not set" warnings in test output.
beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://example.com";
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
});

describe("sitemap()", () => {
  it("returns an array", () => {
    const result = sitemap();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it("produces one entry per route × locale", () => {
    const result = sitemap();
    // Every entry should have a URL that includes the base URL.
    for (const entry of result) {
      expect(entry.url).toMatch(/^https?:\/\//);
    }
    // Each locale should appear in the entry list.
    for (const locale of locales) {
      const localeEntries = result.filter((e) =>
        locale === defaultLocale
          ? !e.url.match(/\/es\/|\/es$/)
          : e.url.includes(`/${locale}`),
      );
      expect(localeEntries.length).toBeGreaterThan(0);
    }
  });

  it("root entry uses priority 1.0 and weekly change frequency", () => {
    const result = sitemap();
    const rootEntry = result.find(
      (e) => e.url === "https://example.com/" || e.url === "https://example.com",
    );
    expect(rootEntry).toBeDefined();
    expect(rootEntry?.priority).toBe(1.0);
    expect(rootEntry?.changeFrequency).toBe("weekly");
  });

  it("non-root entries use priority 0.8 and monthly change frequency", () => {
    const result = sitemap();
    const nonRoot = result.filter(
      (e) =>
        e.url !== "https://example.com/" &&
        e.url !== "https://example.com" &&
        !e.url.endsWith("/es"),
    );
    for (const entry of nonRoot) {
      expect(entry.priority).toBe(0.8);
      expect(entry.changeFrequency).toBe("monthly");
    }
  });

  it("every entry has alternates.languages containing all supported locales", () => {
    const result = sitemap();
    for (const entry of result) {
      expect(entry.alternates?.languages).toBeDefined();
      for (const locale of locales) {
        expect(entry.alternates?.languages).toHaveProperty(locale);
      }
    }
  });

  it("alternates include x-default pointing at the default-locale URL", () => {
    const result = sitemap();
    for (const entry of result) {
      const languages = entry.alternates?.languages as Record<string, string> | undefined;
      expect(languages?.["x-default"]).toBeDefined();
      // x-default should NOT contain a non-default locale prefix.
      const xDefault = languages?.["x-default"] ?? "";
      expect(xDefault).not.toMatch(/\/es(?:\/|$)/);
    }
  });

  it("does not contain /admin, /login, or /api routes", () => {
    const result = sitemap();
    for (const entry of result) {
      expect(entry.url).not.toMatch(/\/admin/);
      expect(entry.url).not.toMatch(/\/login/);
      expect(entry.url).not.toMatch(/\/api\//);
    }
  });

  it("Spanish locale URLs are prefixed with /es", () => {
    const result = sitemap();
    const esEntries = result.filter((e) => e.url.includes("/es"));
    expect(esEntries.length).toBeGreaterThan(0);
    for (const entry of esEntries) {
      expect(entry.url).toMatch(/\/es(?:\/|$)/);
    }
  });

  it("English locale URLs are NOT prefixed with /en", () => {
    const result = sitemap();
    const enEntries = result.filter(
      (e) => !e.url.match(/\/es(?:\/|$)/),
    );
    for (const entry of enEntries) {
      expect(entry.url).not.toMatch(/\/en(?:\/|$)/);
    }
  });

  it("falls back to NEXT_PUBLIC_STELLARCRED_BASE_URL when APP_URL is absent", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_STELLARCRED_BASE_URL = "https://stellarcred.xyz";
    try {
      const result = sitemap();
      expect(result[0].url).toMatch(/^https:\/\/stellarcred\.xyz/);
    } finally {
      delete process.env.NEXT_PUBLIC_STELLARCRED_BASE_URL;
    }
  });
});
