/**
 * WEB-03 — Robots policy tests
 *
 * Verifies that robots() produces:
 *   - A single allow "/" rule for all user agents
 *   - Disallow entries for every private/operational path
 *   - A sitemap reference pointing at the correct base URL
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import robots from "./robots";

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://example.com";
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
});

describe("robots()", () => {
  it("returns a rules array with at least one entry", () => {
    const result = robots();
    expect(Array.isArray(result.rules)).toBe(true);
    expect((result.rules as unknown[]).length).toBeGreaterThan(0);
  });

  it("allows all user agents with allow '/'", () => {
    const result = robots();
    const rule = Array.isArray(result.rules) ? result.rules[0] : result.rules;
    expect(rule.userAgent).toBe("*");
    expect(rule.allow).toBe("/");
  });

  it("disallows /api/ routes", () => {
    const result = robots();
    const rule = Array.isArray(result.rules) ? result.rules[0] : result.rules;
    const disallow = Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow];
    expect(disallow).toContain("/api/");
  });

  it("disallows /admin routes", () => {
    const result = robots();
    const rule = Array.isArray(result.rules) ? result.rules[0] : result.rules;
    const disallow = Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow];
    expect(disallow.some((d: string) => d.startsWith("/admin"))).toBe(true);
  });

  it("disallows /login routes", () => {
    const result = robots();
    const rule = Array.isArray(result.rules) ? result.rules[0] : result.rules;
    const disallow = Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow];
    expect(disallow.some((d: string) => d.startsWith("/login"))).toBe(true);
  });

  it("disallows locale-prefixed /es/admin and /es/login", () => {
    const result = robots();
    const rule = Array.isArray(result.rules) ? result.rules[0] : result.rules;
    const disallow = Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow];
    expect(disallow.some((d: string) => d.startsWith("/es/admin"))).toBe(true);
    expect(disallow.some((d: string) => d.startsWith("/es/login"))).toBe(true);
  });

  it("includes a sitemap reference with the correct base URL", () => {
    const result = robots();
    expect(result.sitemap).toBe("https://example.com/sitemap.xml");
  });

  it("falls back to NEXT_PUBLIC_STELLARCRED_BASE_URL when APP_URL is absent", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_STELLARCRED_BASE_URL = "https://stellarcred.xyz";
    try {
      const result = robots();
      expect(result.sitemap).toBe("https://stellarcred.xyz/sitemap.xml");
    } finally {
      delete process.env.NEXT_PUBLIC_STELLARCRED_BASE_URL;
    }
  });
});
