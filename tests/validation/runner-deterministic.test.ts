import { expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { runValidationProfile } from "../../src/validation/runners";
import { withTempReportsRoot } from "./test-utils";

test("deterministic quick profile writes required artifacts", async () => {
  await withTempReportsRoot(async (reportsRoot) => {
    const result = await runValidationProfile("quick", {
      runId: "quick-test-run",
    });

    expect(result.summary.profile).toBe("quick");
    expect(result.summary.scenarioCount).toBeGreaterThanOrEqual(13);
    expect(result.metrics.step_timeout_rate).toBeDefined();

    await access(result.artifacts.summaryPath);
    await access(result.artifacts.metricsPath);
    await access(result.artifacts.scenarioResultsPath);

    const metricsPayloadRaw = await readFile(
      path.join(reportsRoot, "quick-test-run", "metrics.json"),
      "utf8",
    );
    const metricsPayload = JSON.parse(metricsPayloadRaw) as { metrics: Record<string, unknown> };
    expect(metricsPayload.metrics).toBeDefined();
  });
});
