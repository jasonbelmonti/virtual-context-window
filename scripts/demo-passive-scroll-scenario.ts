export type PassiveScrollLane = "baseline_v1" | "passive_v2";

export type PassiveScrollScenario = {
  runId: string;
  seed: string;
  expectedToken: string;
  seedPrompt: string;
  distractorPrompts: string[];
  finalQuestion: string;
};

function xmur3(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let index = 0; index < seed.length; index += 1) {
    h = Math.imul(h ^ seed.charCodeAt(index), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(seedValue: number): () => number {
  let t = seedValue >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let result = Math.imul(t ^ (t >>> 15), t | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function randomToken(random: () => number, length: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = "";
  for (let index = 0; index < length; index += 1) {
    const offset = Math.floor(random() * alphabet.length);
    value += alphabet[offset] ?? "X";
  }
  return value;
}

export function createPassiveScrollScenario(options?: {
  seed?: string;
  distractorTurns?: number;
  now?: Date;
}): PassiveScrollScenario {
  const seed = options?.seed ?? `passive-${Date.now().toString(36)}`;
  const seedHash = xmur3(seed)();
  const random = mulberry32(seedHash);
  const now = options?.now ?? new Date();
  const distractorTurns = Math.max(1, options?.distractorTurns ?? 10);

  const expectedToken = `VCW-CODE-${randomToken(random, 12)}`;
  const runId = `demo-passive-scroll-${now.toISOString().replace(/[.:]/gu, "-")}`;

  const distractorPrompts = Array.from({ length: distractorTurns }, (_, index) => {
    const ticket = `INC-${Math.floor(random() * 9000 + 1000)}`;
    return [
      `Turn ${index + 1}: summarize noisy telemetry for ${ticket}.`,
      `Mention host ${randomToken(random, 6).toLowerCase()} and shard ${Math.floor(random() * 24)}.`,
      "No need to persist any memory from this message.",
    ].join(" ");
  });

  return {
    runId,
    seed,
    expectedToken,
    seedPrompt: [
      "Incident note for future recall:",
      `unlock code is ${expectedToken}`,
      "This may be needed after many unrelated turns.",
    ].join(" "),
    distractorPrompts,
    finalQuestion: "What is the exact unlock code? Reply with only the exact token.",
  };
}
