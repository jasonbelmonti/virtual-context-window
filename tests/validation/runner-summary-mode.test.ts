import { expect, test } from "bun:test";
import { runValidationProfile } from "../../src/validation/runners";
import {
  restoreLiveProviderEnv,
  unsetLiveProviderEnv,
  withTempReportsRoot,
} from "./test-utils";

test("quick_live summary mode is mixed", async () => {
  const snapshot = unsetLiveProviderEnv();

  try {
    await withTempReportsRoot(async () => {
      const result = await runValidationProfile("quick_live", {
        runId: "quick-live-mode-mixed",
      });
      expect(result.summary.mode).toBe("mixed");
    });
  } finally {
    restoreLiveProviderEnv(snapshot);
  }
});

test("production summary mode is mixed", async () => {
  const snapshot = unsetLiveProviderEnv();

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/tags") {
        return Response.json({ models: [{ name: "stub-model" }] });
      }

      if (url.pathname === "/api/generate") {
        return Response.json({ response: "stub live response", done: true });
      }

      return new Response("not_found", { status: 404 });
    },
  });

  process.env.VCW_OLLAMA_MODEL = "stub-model";
  process.env.VCW_OLLAMA_BASE_URL = `http://127.0.0.1:${server.port}`;
  process.env.VCW_LIVE_PROVIDER = "ollama";

  try {
    await withTempReportsRoot(async () => {
      const result = await runValidationProfile("production", {
        runId: "production-mode-mixed",
      });
      expect(result.summary.mode).toBe("mixed");
    });
  } finally {
    server.stop(true);
    restoreLiveProviderEnv(snapshot);
  }
});
