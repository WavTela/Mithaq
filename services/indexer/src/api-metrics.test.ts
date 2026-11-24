import express from "express";
import request from "supertest";
import {
  ApiMetrics,
  apiMetricsMiddleware,
  boundedRouteLabel,
  classifyMethod,
  classifyStatusClass,
  LATENCY_BUCKETS_SECONDS,
  resolveRouteLabel,
} from "./api-metrics";

describe("bounded label classification", () => {
  it("maps methods to a fixed set", () => {
    expect(classifyMethod("get")).toBe("GET");
    expect(classifyMethod("POST")).toBe("POST");
    expect(classifyMethod("TRACE")).toBe("OTHER");
    expect(classifyMethod(undefined)).toBe("OTHER");
  });

  it("maps status codes to status classes", () => {
    expect(classifyStatusClass(204)).toBe("2xx");
    expect(classifyStatusClass(304)).toBe("3xx");
    expect(classifyStatusClass(404)).toBe("4xx");
    expect(classifyStatusClass(503)).toBe("5xx");
    expect(classifyStatusClass(100)).toBe("other");
  });

  it("rejects anything that is not a declared route template", () => {
    expect(boundedRouteLabel("/claims")).toBe("/claims");
    expect(boundedRouteLabel("/issuers/:issuer/stats")).toBe(
      "/issuers/:issuer/stats"
    );
    expect(boundedRouteLabel("/claims?wallet=GABC")).toBe("unmatched");
    expect(boundedRouteLabel("https://evil.example/steal")).toBe("unmatched");
    expect(boundedRouteLabel(undefined)).toBe("unmatched");
    expect(boundedRouteLabel("/" + "a".repeat(200))).toBe("unmatched");
  });
});

describe("ApiMetrics", () => {
  it("renders request counters and histogram series with bounded labels", () => {
    const metrics = new ApiMetrics();
    metrics.observeRequest(
      { method: "GET", route: "/claims", statusClass: "2xx" },
      0.02
    );
    metrics.observeRequest(
      { method: "GET", route: "/claims", statusClass: "2xx" },
      0.2
    );
    metrics.observeRateLimit("allowed");
    metrics.observeRateLimit("limited");

    const output = metrics.render().join("\n");
    expect(output).toContain(
      'indexer_api_requests_total{method="GET",route="/claims",status_class="2xx"} 2'
    );
    expect(output).toContain(
      'indexer_api_request_duration_seconds_count{method="GET",route="/claims",status_class="2xx"} 2'
    );
    expect(output).toContain(
      `indexer_api_request_duration_seconds_bucket{method="GET",route="/claims",status_class="2xx",le="0.025"} 1`
    );
    expect(output).toContain(
      `indexer_api_request_duration_seconds_bucket{method="GET",route="/claims",status_class="2xx",le="+Inf"} 2`
    );
    expect(output).toContain('indexer_api_rate_limit_total{outcome="allowed"} 1');
    expect(output).toContain('indexer_api_rate_limit_total{outcome="limited"} 1');
    expect(output).toContain(`le="${LATENCY_BUCKETS_SECONDS[0]}"`);
  });
});

describe("apiMetricsMiddleware", () => {
  function appWithRoute() {
    const app = express();
    const metrics = new ApiMetrics();
    app.locals["apiMetrics"] = metrics;
    app.use(apiMetricsMiddleware(metrics));
    app.get("/items/:id", (_req, res) => {
      res.json({ ok: true });
    });
    app.get("/unavailable", (_req, res) => {
      res.status(503).json({ ok: false });
    });
    return { app, metrics };
  }

  it("labels matched requests with the declared route template", async () => {
    const { app } = appWithRoute();
    await request(app).get("/items/GABCDEF123").expect(200);
    await request(app).get("/unavailable").expect(503);

    // Give the finish listeners a tick to run after the response.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("never labels unmatched or rate-limited traffic with the raw path", async () => {
    const app = express();
    const metrics = new ApiMetrics();
    app.use(apiMetricsMiddleware(metrics));
    app.get("/items/:id", (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).get("/items/GSECRETWALLET/extra").expect(404);
    await new Promise((resolve) => setImmediate(resolve));

    const output = metrics.render().join("\n");
    expect(output).toContain('route="unmatched"');
    expect(output).not.toContain("GSECRETWALLET");
  });

  it("resolves a declared route before routing for pre-route rejections", () => {
    const app = express();
    app.get("/items/:id", (_req, res) => {
      res.json({ ok: true });
    });
    const req = {
      route: undefined,
      baseUrl: "",
      path: "/items/GABC",
      app,
    } as unknown as express.Request;

    expect(resolveRouteLabel(req)).toBe("/items/:id");
  });
});
