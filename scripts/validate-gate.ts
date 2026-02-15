import { runValidateGate } from "../src/validation";

try {
  process.exitCode = await runValidateGate(process.argv.slice(2));
} catch (error) {
  console.error("[validate:gate] failed", error);
  process.exitCode = 1;
}
