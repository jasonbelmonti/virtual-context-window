import { expect, test } from "bun:test";
import { defaultQueryBuilder } from "../../src/engine/core/hooks";

test("defaultQueryBuilder uses recent user turns and biases latest turn", () => {
  const query = defaultQueryBuilder({
    trustedSymbolRefsEnabled: false,
    messages: [
      { role: "user", content: "first request" },
      { role: "assistant", content: "ack 1" },
      { role: "user", content: "second request" },
      { role: "assistant", content: "ack 2" },
      { role: "user", content: "third request" },
    ],
  });

  expect(query.turnsUsed).toBe(3);
  expect(query.queryText).toBe(
    [
      "third request",
      "third request",
      "second request",
      "first request",
    ].join("\n"),
  );
  expect(query.queryTokens).toEqual([
    "third",
    "request",
    "third",
    "request",
    "second",
    "request",
    "first",
    "request",
  ]);
});

test("defaultQueryBuilder limits turns to last three user turns", () => {
  const query = defaultQueryBuilder({
    trustedSymbolRefsEnabled: false,
    messages: [
      { role: "user", content: "turn one" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "turn two" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "turn three" },
      { role: "assistant", content: "a3" },
      { role: "user", content: "turn four" },
    ],
  });

  expect(query.turnsUsed).toBe(3);
  expect(query.queryText).not.toContain("turn one");
  expect(query.queryText).toContain("turn four");
  expect(query.queryText).toContain("turn three");
  expect(query.queryText).toContain("turn two");
});

test("defaultQueryBuilder enforces query char and token caps", () => {
  const tokenBurst = Array.from({ length: 200 }, (_, index) => `token${index}`).join(" ");
  const longTurn = `${"x".repeat(700)} ${tokenBurst}`;

  const query = defaultQueryBuilder({
    trustedSymbolRefsEnabled: false,
    messages: [{ role: "user", content: longTurn }],
  });

  expect(query.queryText.length).toBeLessThanOrEqual(600);
  expect(query.queryTokens.length).toBeLessThanOrEqual(80);
});

