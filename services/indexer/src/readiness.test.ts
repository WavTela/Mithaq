import type { Db } from "./db";
import {
  checkReadiness,
  sanitizeDbError,
  withTimeout,
} from "./readiness";

function fakeDb(ping: () => void | Promise<void>): Db {
  return { ping } as unknown as Db;
}

describe("sanitizeDbError", () => {
  it("removes connection strings, passwords, bearer tokens and query secrets", () => {
    const safe = sanitizeDbError(
      new Error(
        "connect failed postgres://user:pass@db.internal:5432/indexer password=hunter2 " +
          "Authorization: Bearer abc.def ?token=supersecret"
      )
    );
    expect(safe).not.toContain("user:pass");
    expect(safe).not.toContain("hunter2");
    expect(safe).not.toContain("abc.def");
    expect(safe).not.toContain("supersecret");
    expect(safe).toContain("<redacted-database-url>");
    expect(safe).toContain("password=<redacted>");
  });

  it("caps very long messages", () => {
    const safe = sanitizeDbError(new Error("x".repeat(500)));
    expect(safe.length).toBeLessThanOrEqual(241);
    expect(safe.endsWith("…")).toBe(true);
  });
});

describe("withTimeout", () => {
  it("resolves a fast probe", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 50, "timeout")).resolves.toBe(
      "ok"
    );
  });

  it("rejects with the supplied message when the probe stalls", async () => {
    const stalled = new Promise<string>(() => undefined);
    await expect(withTimeout(stalled, 5, "probe timed out")).rejects.toThrow(
      "probe timed out"
    );
  });
});

describe("checkReadiness", () => {
  it("reports ready when the database probe succeeds", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const result = await checkReadiness(fakeDb(async () => undefined), {
      now: () => now,
    });

    expect(result.status).toBe("ready");
    expect(result.ready).toBe(true);
    expect(result.timestamp).toBe("2026-01-01T00:00:00.000Z");
    expect(result.checks).toEqual([
      { name: "database", status: "ok", latencyMs: expect.any(Number) },
    ]);
  });

  it("reports not ready with a sanitized reason when the probe fails", async () => {
    const result = await checkReadiness(
      fakeDb(() => {
        throw new Error("could not connect to postgres://u:p@db/app");
      })
    );

    expect(result.status).toBe("not_ready");
    expect(result.ready).toBe(false);
    expect(result.checks[0]).toMatchObject({
      name: "database",
      status: "error",
      error: expect.stringContaining("<redacted-database-url>"),
    });
    expect(result.checks[0].error).not.toContain("u:p@db");
  });

  it("reports not ready when the probe exceeds its timeout", async () => {
    const result = await checkReadiness(
      fakeDb(() => new Promise<void>(() => undefined)),
      { timeoutMs: 5 }
    );

    expect(result.ready).toBe(false);
    expect(result.checks[0].status).toBe("error");
    expect(result.checks[0].error).toMatch(/timed out after 5ms/);
  });
});
