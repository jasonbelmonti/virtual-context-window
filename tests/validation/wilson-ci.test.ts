import { expect, test } from "bun:test";
import { computeWilsonCi95 } from "../../src/validation/wilson-ci";

test("wilson ci95 handles zero denominator", () => {
  const ci = computeWilsonCi95(0, 0);
  expect(ci.low).toBe(0);
  expect(ci.high).toBe(0);
});

test("wilson ci95 returns stable bounds for 5/10", () => {
  const ci = computeWilsonCi95(5, 10);
  expect(ci.low).toBeCloseTo(0.237, 3);
  expect(ci.high).toBeCloseTo(0.763, 3);
});
