import { runValidateBaselineV2 } from "../src/validation";

try {
  process.exitCode = await runValidateBaselineV2(process.argv.slice(2));
} catch (error) {
  console.error("[validate:baseline-v2] failed", error);
  process.exitCode = 1;
}
