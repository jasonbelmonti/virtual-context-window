import { expect, test } from "bun:test";
import {
  containsExactTokenIgnoreCase,
  scoreAnswer,
} from "../../scripts/demo-showdown-scenario";

test("scoreAnswer passes when expected token appears with case-insensitive exact token match", () => {
  const expected = "VCW-CODE-ABC123";
  const answer = "final answer: vcw-code-abc123";

  expect(scoreAnswer(answer, expected)).toBe(true);
});

test("scoreAnswer fails on partial token matches", () => {
  const expected = "VCW-CODE-ABC123";
  const answer = "I think it is VCW-CODE-ABC1234";

  expect(scoreAnswer(answer, expected)).toBe(false);
});

test("containsExactTokenIgnoreCase handles punctuation boundaries", () => {
  const expected = "VCW-CODE-ZYX987";
  const answer = "Token => [vcw-code-zyx987].";

  expect(containsExactTokenIgnoreCase(answer, expected)).toBe(true);
});
