import { expect, test } from "bun:test";
import { executeScenario } from "../../src/validation/scenarios";
import { getScenarioById } from "../../src/validation/scenario-catalog";
import type { LiveAssistantProvider } from "../../src/validation/contracts";

test("live provider failures are classified as provider_failure", async () => {
  const scenario = getScenarioById("S01");
  expect(scenario).toBeDefined();

  const failingProvider: LiveAssistantProvider = {
    name: "failing_provider",
    async healthCheck() {
      return { ok: true, detail: "ok" };
    },
    async generate() {
      throw new Error("ollama_generate_http_404");
    },
  };

  const result = await executeScenario(scenario!, {
    runId: "provider-classification",
    mode: "live",
    profile: "production",
    rateWeight: 1,
    timeoutMs: 50,
    liveProvider: failingProvider,
  });

  expect(result.passed).toBe(false);
  expect(result.classification).toBe("provider_failure");
  const timeoutMetric = result.metricSamples.find((sample) => sample.key === "step_timeout_rate");
  expect(timeoutMetric).toBeDefined();
  expect(timeoutMetric?.kind).toBe("rate");
  if (timeoutMetric?.kind === "rate") {
    expect(timeoutMetric.numerator).toBe(0);
    expect(timeoutMetric.denominator).toBe(1);
  }
});

test("scenario timeout aborts active live provider request", async () => {
  const scenario = getScenarioById("S01");
  expect(scenario).toBeDefined();

  let aborted = false;
  const blockingProvider: LiveAssistantProvider = {
    name: "blocking_provider",
    async healthCheck() {
      return { ok: true, detail: "ok" };
    },
    async generate(_prompt, options) {
      return new Promise<string>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted_by_signal"));
        });
      });
    },
  };

  const result = await executeScenario(scenario!, {
    runId: "timeout-abort",
    mode: "live",
    profile: "production",
    rateWeight: 1,
    timeoutMs: 5,
    liveProvider: blockingProvider,
  });

  expect(result.passed).toBe(false);
  expect(result.classification).toBe("timeout_or_latency");
  expect(result.details).toBe("scenario_timeout");
  expect(aborted).toBe(true);
  const timeoutMetric = result.metricSamples.find((sample) => sample.key === "step_timeout_rate");
  expect(timeoutMetric).toBeDefined();
  expect(timeoutMetric?.kind).toBe("rate");
  if (timeoutMetric?.kind === "rate") {
    expect(timeoutMetric.numerator).toBe(1);
    expect(timeoutMetric.denominator).toBe(1);
  }
});
