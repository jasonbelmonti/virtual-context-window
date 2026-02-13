import { runValidateQuick } from "../src/validation";

try {
  process.exitCode = await runValidateQuick();
} catch (error) {
  console.error("[validate:quick] failed", error);
  process.exitCode = 1;
}
