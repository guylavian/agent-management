import { describe, expect, it, beforeEach } from "vitest";
import { incrementMetric, observeDuration, observeInflight, renderMetrics, resetMetrics } from "../src/index.ts";

describe("metrics registry", () => {
  beforeEach(() => resetMetrics());

  it("renders counters, a gauge, and a histogram with correct types", () => {
    incrementMetric("sre_requests_total", 2);
    observeInflight(3);
    observeInflight(-1);
    observeDuration("sre_request_duration_seconds", 0.3);
    observeDuration("sre_request_duration_seconds", 4);
    const output = renderMetrics();
    expect(output).toContain("# TYPE sre_requests_total counter\nsre_requests_total 2");
    expect(output).toContain("# TYPE sre_inflight_requests gauge\nsre_inflight_requests 2");
    expect(output).toContain("# TYPE sre_request_duration_seconds histogram");
    expect(output).toContain('sre_request_duration_seconds_bucket{le="+Inf"} 2');
    expect(output).toContain("sre_request_duration_seconds_count 2");
    // 0.3s falls in the <=0.5 bucket, 4s does not
    expect(output).toMatch(/sre_request_duration_seconds_bucket\{le="0\.5"\} 1/u);
  });

  it("never lets the inflight gauge go negative", () => {
    observeInflight(-5);
    expect(renderMetrics()).toContain("sre_inflight_requests 0");
  });
});
