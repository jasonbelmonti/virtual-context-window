import { runValidateProduction } from "../src/validation";

try {
  process.exitCode = await runValidateProduction();
} catch (error) {
  console.error("[validate:production] failed", error);
  process.exitCode = 1;
}
