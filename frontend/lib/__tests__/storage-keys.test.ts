import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAllStorageKeys,
  getTimelineKeys,
  isMithaqKey,
  STORAGE_KEYS,
} from "@/lib/storage-keys";

describe("storage-keys", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe("STORAGE_KEYS enumeration", () => {
    it("exports all expected storage keys", () => {
      expect(STORAGE_KEYS.CREDENTIALS).toBe("mithaq:credentials");
      expect(STORAGE_KEYS.EXPORT_VISIBILITY).toBe("mithaq:export-visibility");
      expect(STORAGE_KEYS.PROOF_CACHE).toBe("mithaq:proof-cache");
      expect(STORAGE_KEYS.PROOF_TIMELINE_PREFIX).toBe("proofTimeline:");
      expect(STORAGE_KEYS.ONBOARDING).toBe("mithaq:onboarding");
      expect(STORAGE_KEYS.ONBOARDING_LEGACY).toBe("mithaq_onboarding_seen");
      expect(STORAGE_KEYS.WALLET_ID).toBe("mithaq:wallet-id");
      expect(STORAGE_KEYS.THEME).toBe("theme");
      expect(STORAGE_KEYS.ONBOARDING_NUDGE_DISMISSED).toBe("mithaq:onboarding-nudge-dismissed");
    });
  });

  describe("getTimelineKeys", () => {
    it("returns empty array when no timeline keys exist", () => {
      expect(getTimelineKeys()).toEqual([]);
    });

    it("finds all timeline keys with the correct prefix", () => {
      localStorage.setItem("proofTimeline:commitment1", "{}");
      localStorage.setItem("proofTimeline:commitment2", "{}");
      localStorage.setItem("mithaq:credentials", "{}");
      localStorage.setItem("other-key", "{}");

      const timelineKeys = getTimelineKeys();
      expect(timelineKeys).toHaveLength(2);
      expect(timelineKeys).toContain("proofTimeline:commitment1");
      expect(timelineKeys).toContain("proofTimeline:commitment2");
    });

    it("only returns keys with exact prefix match", () => {
      localStorage.setItem("proofTimeline:abc", "{}");
      localStorage.setItem("proof_timeline:xyz", "{}"); // different format
      localStorage.setItem("timeline:foo", "{}"); // missing prefix

      const timelineKeys = getTimelineKeys();
      expect(timelineKeys).toHaveLength(1);
      expect(timelineKeys[0]).toBe("proofTimeline:abc");
    });
  });

  describe("getAllStorageKeys", () => {
    it("returns all static keys plus dynamic timeline keys", () => {
      localStorage.setItem(STORAGE_KEYS.CREDENTIALS, "{}");
      localStorage.setItem(STORAGE_KEYS.PROOF_CACHE, "{}");
      localStorage.setItem("proofTimeline:c1", "{}");
      localStorage.setItem("proofTimeline:c2", "{}");
      localStorage.setItem(STORAGE_KEYS.THEME, "light");

      const allKeys = getAllStorageKeys();
      
      // Should include all static keys
      expect(allKeys).toContain(STORAGE_KEYS.CREDENTIALS);
      expect(allKeys).toContain(STORAGE_KEYS.EXPORT_VISIBILITY);
      expect(allKeys).toContain(STORAGE_KEYS.PROOF_CACHE);
      expect(allKeys).toContain(STORAGE_KEYS.ONBOARDING);
      expect(allKeys).toContain(STORAGE_KEYS.ONBOARDING_LEGACY);
      expect(allKeys).toContain(STORAGE_KEYS.WALLET_ID);
      expect(allKeys).toContain(STORAGE_KEYS.THEME);
      expect(allKeys).toContain(STORAGE_KEYS.ONBOARDING_NUDGE_DISMISSED);
      
      // Should include dynamic timeline keys
      expect(allKeys).toContain("proofTimeline:c1");
      expect(allKeys).toContain("proofTimeline:c2");
    });

    it("includes keys even when they don't exist in storage", () => {
      // getAllStorageKeys returns the enumerated keys, not just what's in storage
      const allKeys = getAllStorageKeys();
      
      expect(allKeys).toContain(STORAGE_KEYS.CREDENTIALS);
      expect(allKeys).toContain(STORAGE_KEYS.EXPORT_VISIBILITY);
      expect(allKeys).toContain(STORAGE_KEYS.PROOF_CACHE);
      expect(allKeys).toContain(STORAGE_KEYS.ONBOARDING);
      expect(allKeys).toContain(STORAGE_KEYS.WALLET_ID);
      expect(allKeys).toContain(STORAGE_KEYS.THEME);
      expect(allKeys).toContain(STORAGE_KEYS.ONBOARDING_NUDGE_DISMISSED);
    });
  });

  describe("isMithaqKey", () => {
    it("identifies static Mithaq keys", () => {
      expect(isMithaqKey(STORAGE_KEYS.CREDENTIALS)).toBe(true);
      expect(isMithaqKey(STORAGE_KEYS.EXPORT_VISIBILITY)).toBe(true);
      expect(isMithaqKey(STORAGE_KEYS.PROOF_CACHE)).toBe(true);
      expect(isMithaqKey(STORAGE_KEYS.ONBOARDING)).toBe(true);
      expect(isMithaqKey(STORAGE_KEYS.WALLET_ID)).toBe(true);
      expect(isMithaqKey(STORAGE_KEYS.THEME)).toBe(true);
      expect(isMithaqKey(STORAGE_KEYS.ONBOARDING_NUDGE_DISMISSED)).toBe(true);
    });

    it("identifies timeline keys by prefix", () => {
      expect(isMithaqKey("proofTimeline:abc123")).toBe(true);
      expect(isMithaqKey("proofTimeline:commitment456")).toBe(true);
    });

    it("rejects non-Mithaq keys", () => {
      expect(isMithaqKey("random-key")).toBe(false);
      expect(isMithaqKey("proof_timeline:abc")).toBe(false);
      expect(isMithaqKey("")).toBe(false);
    });
  });
});
