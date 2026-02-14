import { runValidateQuickLive } from "../src/validation";

try {
  process.exitCode = await runValidateQuickLive();
} catch (error) {
  console.error("[validate:quick:live] failed", error);
  process.exitCode = 1;
}
