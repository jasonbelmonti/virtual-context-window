import { runValidateStability } from "../src/validation";

try {
  process.exitCode = await runValidateStability();
} catch (error) {
  console.error("[validate:stability] failed", error);
  process.exitCode = 1;
}
