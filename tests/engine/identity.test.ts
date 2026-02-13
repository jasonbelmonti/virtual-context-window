import { expect, test } from "bun:test";
import {
  createVirtualContextEngine,
  MissingIdentityError,
  resolveThreadIdentity,
} from "../../src/engine";

test("resolveThreadIdentity prefers threadId over sessionId", () => {
  const resolved = resolveThreadIdentity({
    threadId: "thread-123",
    sessionId: "session-456",
  });

  expect(resolved).toBe("thread-123");
});

test("resolveThreadIdentity falls back to sessionId", () => {
  const resolved = resolveThreadIdentity({
    sessionId: "session-456",
  });

  expect(resolved).toBe("session-456");
});

test("processTurn throws explicit contract error when identity is missing", async () => {
  const engine = createVirtualContextEngine({
    assistantGenerate: async () => "ok",
  });

  await expect(
    engine.processTurn({
      messages: [{ role: "user", content: "hello" }],
    }),
  ).rejects.toBeInstanceOf(MissingIdentityError);
});
