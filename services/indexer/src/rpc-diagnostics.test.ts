import {
  getRpcFailureDiagnostics,
  MAX_RECENT_RPC_FAILURES,
  RpcFailureTracker,
  recordRpcFailure,
  recordRpcSuccess,
  resetRpcDiagnostics,
  setActiveRpcEndpoint,
} from "./rpc-diagnostics";

describe("RpcFailureTracker", () => {
  it("starts unknown and healthy once a call succeeds", () => {
    const tracker = new RpcFailureTracker();
    expect(tracker.snapshot().recoveryStatus).toBe("unknown");

    tracker.recordSuccess(1_000);
    const snapshot = tracker.snapshot();
    expect(snapshot.recoveryStatus).toBe("healthy");
    expect(snapshot.lastSuccessAt).toBe(1_000);
    expect(snapshot.failureCount).toBe(0);
  });

  it("becomes failing after a failure and recovered after a later success", () => {
    const tracker = new RpcFailureTracker();
    tracker.recordFailure({
      time: 2_000,
      kind: "transient",
      endpoint: "https://rpc.example.com",
      message: "timeout",
    });

    let snapshot = tracker.snapshot();
    expect(snapshot.recoveryStatus).toBe("failing");
    expect(snapshot.failureCount).toBe(1);
    expect(snapshot.consecutiveFailures).toBe(1);
    expect(snapshot.latestFailureAt).toBe(2_000);

    tracker.recordSuccess(3_000);
    snapshot = tracker.snapshot();
    expect(snapshot.recoveryStatus).toBe("recovered");
    expect(snapshot.consecutiveFailures).toBe(0);
    expect(snapshot.failureCount).toBe(1);
  });

  it("keeps only the most recent bounded failure records", () => {
    const tracker = new RpcFailureTracker();
    for (let i = 0; i < MAX_RECENT_RPC_FAILURES + 5; i++) {
      tracker.recordFailure({
        time: i,
        kind: "permanent",
        endpoint: "https://rpc.example.com",
        message: `failure ${i}`,
      });
    }

    const snapshot = tracker.snapshot();
    expect(snapshot.failureCount).toBe(MAX_RECENT_RPC_FAILURES + 5);
    expect(snapshot.recentFailureCount).toBe(MAX_RECENT_RPC_FAILURES);
    expect(snapshot.recentFailures[0].time).toBe(5);
    expect(snapshot.recentFailures.at(-1)?.time).toBe(
      MAX_RECENT_RPC_FAILURES + 4
    );
  });

  it("redacts credentials and URLs from stored messages", () => {
    const tracker = new RpcFailureTracker();
    tracker.recordFailure({
      time: 1,
      kind: "transient",
      endpoint: "https://rpc.example.com/<redacted>",
      message:
        "POST https://user:secret@rpc.example.com failed with Bearer tok_123 api_key=abc",
    });

    const [record] = tracker.snapshot().recentFailures;
    expect(record.message).not.toContain("tok_123");
    expect(record.message).not.toContain("abc");
    expect(record.message).not.toContain("user:secret");
    expect(record.message).toContain("<redacted-url>");
    expect(record.message).toContain("Bearer <redacted>");
  });

  it("tracks failover metadata", () => {
    const tracker = new RpcFailureTracker();
    tracker.setActiveEndpoint("https://rpc-b.example.com", 1);
    const snapshot = tracker.snapshot();
    expect(snapshot.activeEndpoint).toBe("https://rpc-b.example.com");
    expect(snapshot.failoverCount).toBe(1);
  });
});

describe("process-wide RPC diagnostics", () => {
  afterEach(() => resetRpcDiagnostics());

  it("records failures and successes through the shared tracker", () => {
    recordRpcFailure({
      time: 10,
      kind: "transient",
      endpoint: "https://rpc.example.com",
      message: "timeout",
    });
    setActiveRpcEndpoint("https://rpc.example.com", 0);

    let diagnostics = getRpcFailureDiagnostics();
    expect(diagnostics.recoveryStatus).toBe("failing");
    expect(diagnostics.recentFailureCount).toBe(1);

    recordRpcSuccess(20, "https://rpc.example.com");
    diagnostics = getRpcFailureDiagnostics();
    expect(diagnostics.recoveryStatus).toBe("recovered");
    expect(diagnostics.lastSuccessAt).toBe(20);

    resetRpcDiagnostics();
    expect(getRpcFailureDiagnostics().recoveryStatus).toBe("unknown");
  });
});
