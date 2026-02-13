import { expect, test } from "bun:test";
import { aggregateMetrics, metricsEquivalent } from "../../src/validation/metrics";
import { loadRunArtifacts } from "../../src/validation/reports";
import { runValidationProfile } from "../../src/validation/runners";
import { withTempReportsRoot } from "./test-utils";

test("recompute consistency matches primary metrics output", async () => {
  await withTempReportsRoot(async () => {
    await runValidationProfile("quick", {
      runId: "quick-recompute",
    });

    const loaded = await loadRunArtifacts("quick-recompute");
    const recomputed = aggregateMetrics(loaded.scenarioResults);

    expect(metricsEquivalent(loaded.metrics, recomputed)).toBe(true);
  });
});

test("recompute consistency detects mismatched metric payloads", () => {
  const base = {
    opaque_memory_reuse_rate: {
      key: "opaque_memory_reuse_rate",
      kind: "rate" as const,
      numerator: 8,
      denominator: 8,
      rate: 1,
      ci95: {
        low: 0.6,
        high: 1,
      },
    },
  };

  const altered = {
    opaque_memory_reuse_rate: {
      ...base.opaque_memory_reuse_rate,
      numerator: 7,
      rate: 0.875,
    },
  };

  expect(metricsEquivalent(base, altered)).toBe(false);
});

test("recompute consistency detects ci95 payload drift", () => {
  const base = {
    opaque_memory_reuse_rate: {
      key: "opaque_memory_reuse_rate",
      kind: "rate" as const,
      numerator: 8,
      denominator: 8,
      rate: 1,
      ci95: {
        low: 0.6,
        high: 1,
      },
    },
  };

  const altered = {
    opaque_memory_reuse_rate: {
      ...base.opaque_memory_reuse_rate,
      ci95: {
        low: 0.55,
        high: 0.99,
      },
    },
  };

  expect(metricsEquivalent(base, altered)).toBe(false);
});

test("recompute consistency detects latency sample-count drift", () => {
  const base = {
    end_to_end_turn_ms_p95: {
      key: "end_to_end_turn_ms_p95",
      kind: "latency_p95" as const,
      p95: 180,
      value: 10,
    },
  };

  const altered = {
    end_to_end_turn_ms_p95: {
      ...base.end_to_end_turn_ms_p95,
      value: 9,
    },
  };

  expect(metricsEquivalent(base, altered)).toBe(false);
});
