import { runPhase5Certification } from "../src/validation";

try {
  const result = await runPhase5Certification();
  console.log(`[validate:phase5] status=${result.report.finalVerdict}`);
  console.log(
    `[validate:phase5] run_a=${result.report.steps.productionRunA.runId ?? "n/a"} run_b=${result.report.steps.productionRunB.runId ?? "n/a"}`,
  );
  console.log(
    `[validate:phase5] baseline=${result.report.steps.baseline.gateMarkdownPath ?? "n/a"}`,
  );
  console.log(
    `[validate:phase5] stability=${result.report.steps.stability.gateMarkdownPath ?? "n/a"}`,
  );
  console.log(`[validate:phase5] report=${result.artifacts.markdownPath}`);
  process.exitCode = result.exitCode;
} catch (error) {
  console.error("[validate:phase5] failed", error);
  process.exitCode = 1;
}
