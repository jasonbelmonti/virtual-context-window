import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveBaselinePair } from "../../src/validation/reports";
import { withTempReportsRoot } from "./test-utils";

test("baseline pair auto-selects latest two production runs", async () => {
  await withTempReportsRoot(async (reportsRoot) => {
    await mkdir(path.join(reportsRoot, "production-2026-02-13T10-00-00-000Z"), {
      recursive: true,
    });
    await mkdir(path.join(reportsRoot, "production-2026-02-13T11-00-00-000Z"), {
      recursive: true,
    });
    await mkdir(path.join(reportsRoot, "production-2026-02-13T12-00-00-000Z"), {
      recursive: true,
    });

    const pair = await resolveBaselinePair();
    expect(pair.runAId).toBe("production-2026-02-13T11-00-00-000Z");
    expect(pair.runBId).toBe("production-2026-02-13T12-00-00-000Z");
  });
});

test("baseline pair honors explicit run overrides", async () => {
  const pair = await resolveBaselinePair({
    runA: "production-a",
    runB: "production-b",
  });

  expect(pair.runAId).toBe("production-a");
  expect(pair.runBId).toBe("production-b");
});
