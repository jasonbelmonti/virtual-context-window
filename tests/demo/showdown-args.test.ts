import { expect, test } from "bun:test";
import path from "node:path";
import { parseShowdownArgs, resolveOutputDir } from "../../scripts/demo-showdown";

test("parseShowdownArgs applies upgraded defaults", () => {
  const parsed = parseShowdownArgs([]);

  expect(parsed.provider).toBe("ollama");
  expect(parsed.historyLimit).toBe(1);
  expect(parsed.distractorTurns).toBe(6);
  expect(parsed.stream).toBe(false);
  expect(parsed.scenario).toBe("incident_response");
  expect(parsed.maxRetries).toBe(2);
  expect(parsed.seed).toBeUndefined();
  expect(parsed.outputDir).toBeUndefined();
});

test("parseShowdownArgs parses explicit overrides", () => {
  const parsed = parseShowdownArgs([
    "--provider",
    "openai_responses",
    "--history-limit",
    "3",
    "--distractor-turns",
    "7",
    "--stream",
    "on",
    "--scenario",
    "incident_response",
    "--max-retries",
    "4",
    "--seed",
    "seed-123",
    "--output-dir",
    "/tmp/demo-dir",
  ]);

  expect(parsed.provider).toBe("openai_responses");
  expect(parsed.historyLimit).toBe(3);
  expect(parsed.distractorTurns).toBe(7);
  expect(parsed.stream).toBe(true);
  expect(parsed.scenario).toBe("incident_response");
  expect(parsed.maxRetries).toBe(4);
  expect(parsed.seed).toBe("seed-123");
  expect(parsed.outputDir).toBe("/tmp/demo-dir");
});

test("resolveOutputDir returns deterministic default format", () => {
  const now = new Date("2026-02-14T05:06:07.890Z");
  const resolved = resolveOutputDir("/repo", undefined, now);

  expect(resolved).toBe(
    path.resolve(
      "/repo",
      "reports",
      "demo-showdown",
      "2026-02-14T05-06-07-890Z",
    ),
  );
});

test("resolveOutputDir resolves relative explicit path against cwd", () => {
  const resolved = resolveOutputDir("/repo", "custom/output");
  expect(resolved).toBe(path.resolve("/repo", "custom/output"));
});
