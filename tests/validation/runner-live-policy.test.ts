import { expect, test } from "bun:test";
import { runValidationProfile } from "../../src/validation/runners";
import {
  restoreLiveProviderEnv,
  unsetLiveProviderEnv,
  withTempReportsRoot,
} from "./test-utils";

test("quick_live falls back to mock provider when live provider is unavailable", async () => {
  const snapshot = unsetLiveProviderEnv();

  try {
    await withTempReportsRoot(async () => {
      const result = await runValidationProfile("quick_live", {
        runId: "quick-live-fallback",
      });

      expect(result.summary.provider).toBe("mock_live");
      expect(result.summary.warningFlags).toContain("live_provider_fallback");
    });
  } finally {
    restoreLiveProviderEnv(snapshot);
  }
});

test("production fails without VCW_OLLAMA_MODEL", async () => {
  const snapshot = unsetLiveProviderEnv();

  try {
    await withTempReportsRoot(async () => {
      await expect(
        runValidationProfile("production", {
          runId: "production-missing-provider",
        }),
      ).rejects.toThrow("missing_env:VCW_OLLAMA_MODEL");
    });
  } finally {
    restoreLiveProviderEnv(snapshot);
  }
});
