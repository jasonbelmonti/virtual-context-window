import OpenAI from "openai";
import type { EmbeddingProvider } from "../core/types";
import { InMemoryEmbeddingCache } from "../symbols/embedding-cache";
import type { SymbolRecordKind, SymbolStore } from "./passive-contracts";
import type {
  CompressionExtractor,
  CompressionExtractorInput,
  CompressionProposal,
  FactClaimPlannerCandidate,
  FactClaimPlannerExtractionInput,
  FactClaimPlannerExtractor,
  PlannerHydrator,
  PlannerHydrationInput,
  PlannerHydrationOutput,
  PassiveCommitPolicyResult,
} from "./passive-contracts";

type ExtractorProvider = "ollama" | "openai_responses";

type ExtractorConfig = {
  provider: ExtractorProvider;
  env?: Record<string, string | undefined>;
};

type PlannerConfig = {
  provider: ExtractorProvider;
  env?: Record<string, string | undefined>;
};

const SECRET_PATTERN =
  /(?:password|passcode|api[ _-]?key|private[ _-]?key|secret|token)\s*(?:is|=|:)/iu;
const LOW_SIGNAL_CHATTER_PATTERNS = [
  /^(?:thanks|thank you|got it|great|awesome|sounds (?:good|great)|understood|sure)\b/iu,
  /\b(?:let me know|if you'd like|how can i help|anything else|happy to help)\b/iu,
  /\b(?:nice to meet you|glad to help|feel free to ask)\b/iu,
];
const DURABLE_SIGNAL_PATTERNS = [
  /\b[A-Z]{2,}-\d{2,}\b/u,
  /\b(?:incident|owner|service|timeline|token|code|plan|runbook|escalation)\b/iu,
  /\b(?:name is|works at|work at|my [a-z]+ is|our [a-z]+ is)\b/iu,
];

const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;
const DEFAULT_MAX_PROPOSALS = 4;
const DEFAULT_MAX_EVENTS = 8;
const DEFAULT_MAX_CONTENT_CHARS = 4_000;
const DEFAULT_EMBED_TIMEOUT_MS = 120;

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeForComparison(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}

function toKind(value: unknown): SymbolRecordKind {
  if (value === "memory" || value === "fact" || value === "plan" || value === "note") {
    return value;
  }
  return "note";
}

function truncateSummary(content: string, maxChars = 120): string {
  const normalized = content.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  if (maxChars <= 3) {
    return normalized.slice(0, maxChars);
  }
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function normalizeContent(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function hasDurableSignal(content: string): boolean {
  const normalized = normalizeContent(content);
  if (normalized.length < 12) {
    return false;
  }
  if (/\d/u.test(normalized) && normalized.length >= 18) {
    return true;
  }
  return DURABLE_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isLikelyLowSignalChatter(content: string): boolean {
  const normalized = normalizeContent(content);
  if (!normalized) {
    return true;
  }
  if (LOW_SIGNAL_CHATTER_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  // Questions and social pleasantries are rarely durable checkpoints.
  if (normalized.endsWith("?")) {
    return true;
  }
  return false;
}

function fallbackEntryScore(entry: CompressionExtractorInput["entries"][number]): number {
  const normalized = normalizeContent(entry.content);
  if (normalized.length < 8) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 0;
  if (entry.role === "user") {
    score += 3;
  } else {
    score -= 1;
  }
  if (hasDurableSignal(normalized)) {
    score += 3;
  }
  if (normalized.length >= 24 && normalized.length <= 280) {
    score += 1;
  }
  if (isLikelyLowSignalChatter(normalized)) {
    score -= 4;
  }
  return score;
}

function validateEvidenceSpans(value: unknown): CompressionProposal["evidenceSpans"] {
  if (!Array.isArray(value)) {
    return [];
  }

  const spans: CompressionProposal["evidenceSpans"] = [];
  for (const item of value) {
    const record = asObject(item);
    if (!record) {
      continue;
    }

    const entryId = typeof record.entryId === "string" ? record.entryId : "";
    const startOffset = typeof record.startOffset === "number" ? record.startOffset : NaN;
    const endOffset = typeof record.endOffset === "number" ? record.endOffset : NaN;

    if (!entryId || !Number.isFinite(startOffset) || !Number.isFinite(endOffset)) {
      continue;
    }

    spans.push({
      entryId,
      startOffset,
      endOffset,
    });
  }

  return spans;
}

function parseExtractorOutput(rawText: string): CompressionProposal[] {
  const parsed = JSON.parse(rawText);
  const root = asObject(parsed);
  if (!root) {
    return [];
  }

  const rawProposals = root.proposals;
  if (!Array.isArray(rawProposals)) {
    return [];
  }

  const proposals: CompressionProposal[] = [];
  for (const proposal of rawProposals) {
    const item = asObject(proposal);
    if (!item) {
      continue;
    }

    const summary = typeof item.summary === "string" ? item.summary.trim() : "";
    const content = typeof item.content === "string" ? item.content.trim() : "";
    const confidence = typeof item.confidence === "number" ? item.confidence : 0;
    if (!content || !Number.isFinite(confidence)) {
      continue;
    }

    proposals.push({
      summary: summary || truncateSummary(content),
      content,
      kind: toKind(item.kind),
      confidence: Math.max(0, Math.min(1, confidence)),
      evidenceSpans: validateEvidenceSpans(item.evidenceSpans),
    });
  }

  return proposals;
}

function buildExtractorPrompt(input: CompressionExtractorInput): string {
  const entryText = input.entries
    .map(
      (entry) =>
        `entryId=${entry.entryId} role=${entry.role} start=${entry.offsetStart} end=${entry.offsetEnd}\n${entry.content}`,
    )
    .join("\n\n");

  return [
    "You are a symbolic compression extractor.",
    "Return ONLY valid JSON.",
    "Schema: {\"proposals\":[{\"summary\":string,\"content\":string,\"kind\":\"memory\"|\"fact\"|\"plan\"|\"note\",\"confidence\":number,\"evidenceSpans\":[{\"entryId\":string,\"startOffset\":number,\"endOffset\":number}]}]}",
    `Generate at most ${input.maxProposals} proposals.`,
    "Prefer durable facts/plans. Skip transient chatter.",
    "Confidence should be between 0 and 1.",
    `User query context: ${input.queryText || "(empty)"}`,
    "Entries:",
    entryText || "(none)",
  ].join("\n\n");
}

function buildPlannerPrompt(input: PlannerHydrationInput): string {
  const facts = input.factCandidates
    .map((fact) => `${fact.claimId} ${fact.attribute}=${fact.value} confidence=${fact.confidence.toFixed(2)}`)
    .join("\n");
  const episodes = input.episodeCandidateIds.join(", ");
  const required = input.requiredAttributes.join(", ");

  return [
    "You are a memory hydration planner.",
    "Return ONLY valid JSON.",
    "Schema: {\"requiredAttributes\":string[],\"focusedFactIds\":string[],\"focusedEpisodeIds\":string[],\"reasoningTags\":string[]}",
    `Max focused fact ids: ${input.maxFocusedFacts}`,
    `Max focused episode ids: ${input.maxFocusedEpisodes}`,
    "Do not invent IDs. Only return IDs from candidates.",
    `Query: ${input.queryText || "(empty)"}`,
    `Pressure ratio hint: ${input.pressureRatioHint.toFixed(3)}`,
    `Required attributes hint: ${required || "(none)"}`,
    `Fact candidates:\n${facts || "(none)"}`,
    `Episode candidate IDs: ${episodes || "(none)"}`,
  ].join("\n\n");
}

function buildFactClaimPlannerPrompt(input: FactClaimPlannerExtractionInput): string {
  const entries = input.entries
    .map(
      (entry) =>
        `entryId=${entry.entryId} role=${entry.role} start=${entry.offsetStart} end=${entry.offsetEnd}\n${entry.content}`,
    )
    .join("\n\n");
  const requiredAttributes = input.requiredAttributes.join(", ");

  return [
    "You are a fact claim extractor for long-horizon memory.",
    "Return ONLY valid JSON.",
    "Schema: {\"claims\":[{\"attribute\":string,\"value\":string,\"confidence\":number,\"sourceEntryIds\":string[]}]}",
    `Generate at most ${input.maxClaims} claims.`,
    "Use normalized snake_case attributes.",
    "Only extract durable claims grounded in supplied entries.",
    "Do not infer unseen facts.",
    `Query: ${input.queryText || "(empty)"}`,
    `Pressure ratio hint: ${input.pressureRatioHint.toFixed(3)}`,
    `Required attributes hint: ${requiredAttributes || "(none)"}`,
    "Entries:",
    entries || "(none)",
  ].join("\n\n");
}

function readOpenAIText(response: unknown): string {
  const root = asObject(response);
  if (!root) {
    return "";
  }

  if (typeof root.output_text === "string") {
    return root.output_text;
  }

  const output = root.output;
  if (!Array.isArray(output)) {
    return "";
  }

  const fragments: string[] = [];
  for (const item of output) {
    const node = asObject(item);
    if (!node) {
      continue;
    }

    if (Array.isArray(node.content)) {
      for (const contentNode of node.content) {
        const contentRecord = asObject(contentNode);
        if (!contentRecord) {
          continue;
        }
        if (typeof contentRecord.text === "string") {
          fragments.push(contentRecord.text);
        }
      }
    }
  }

  return fragments.join("\n");
}

export function createProviderCompressionExtractor(
  config: ExtractorConfig,
): CompressionExtractor {
  if (config.provider === "openai_responses") {
    return {
      async extract(input) {
        const env = config.env ?? process.env;
        const apiKey = env.OPENAI_API_KEY;
        const model = env.VCW_OPENAI_MODEL;
        if (!apiKey || !model) {
          return [];
        }

        const client = new OpenAI({
          apiKey,
          baseURL: env.VCW_OPENAI_BASE_URL,
        });

        const response = await client.responses.create({
          model,
          input: buildExtractorPrompt(input),
          temperature: 0,
          stream: false,
        });

        const text = readOpenAIText(response);
        if (!text.trim()) {
          return [];
        }

        return parseExtractorOutput(text).slice(0, input.maxProposals);
      },
    };
  }

  return {
    async extract(input) {
      const env = config.env ?? process.env;
      const model = env.VCW_OLLAMA_MODEL;
      const baseUrl = env.VCW_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
      if (!model) {
        return [];
      }

      const response = await fetch(`${baseUrl.replace(/\/$/u, "")}/api/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          stream: false,
          format: "json",
          messages: [
            {
              role: "system",
              content: "You extract compact durable symbolic candidates from text. Output JSON only.",
            },
            {
              role: "user",
              content: buildExtractorPrompt(input),
            },
          ],
          options: {
            temperature: 0,
          },
        }),
      });

      if (!response.ok) {
        return [];
      }

      const payload = (await response.json()) as Record<string, unknown>;
      const message = asObject(payload.message);
      const text =
        (typeof message?.content === "string" ? message.content : "") ||
        (typeof payload.response === "string" ? String(payload.response) : "");
      if (!text.trim()) {
        return [];
      }

      return parseExtractorOutput(text).slice(0, input.maxProposals);
    },
  };
}

function parsePlannerOutput(rawText: string): PlannerHydrationOutput {
  const parsed = JSON.parse(rawText);
  const root = asObject(parsed);
  if (!root) {
    return {
      requiredAttributes: [],
      focusedFactIds: [],
      focusedEpisodeIds: [],
      reasoningTags: [],
    };
  }

  const asStringArray = (value: unknown): string[] => {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);
  };

  return {
    requiredAttributes: asStringArray(root.requiredAttributes),
    focusedFactIds: asStringArray(root.focusedFactIds),
    focusedEpisodeIds: asStringArray(root.focusedEpisodeIds),
    reasoningTags: asStringArray(root.reasoningTags),
  };
}

function parseFactClaimPlannerOutput(rawText: string): FactClaimPlannerCandidate[] {
  const parsed = JSON.parse(rawText);
  const root = asObject(parsed);
  if (!root) {
    return [];
  }

  const claimsRaw = root.claims;
  if (!Array.isArray(claimsRaw)) {
    return [];
  }

  const claims: FactClaimPlannerCandidate[] = [];
  for (const claimRaw of claimsRaw) {
    const claim = asObject(claimRaw);
    if (!claim) {
      continue;
    }

    const attribute = typeof claim.attribute === "string"
      ? claim.attribute.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "")
      : "";
    const value = typeof claim.value === "string" ? claim.value.trim() : "";
    const confidence = typeof claim.confidence === "number"
      ? Math.max(0, Math.min(1, claim.confidence))
      : 0;
    const sourceEntryIds = Array.isArray(claim.sourceEntryIds)
      ? claim.sourceEntryIds.filter((entryId): entryId is string => typeof entryId === "string" && entryId.trim().length > 0)
      : [];

    if (!attribute || !value || confidence <= 0 || sourceEntryIds.length === 0) {
      continue;
    }

    claims.push({
      attribute,
      value,
      confidence,
      source: "planner_model",
      sourceEntryIds,
    });
  }

  return claims;
}

export function createProviderHydrationPlanner(
  config: PlannerConfig,
): PlannerHydrator {
  if (config.provider === "openai_responses") {
    return {
      async plan(input) {
        const env = config.env ?? process.env;
        const apiKey = env.OPENAI_API_KEY;
        const model = env.VCW_OPENAI_MODEL;
        if (!apiKey || !model) {
          return {
            requiredAttributes: [],
            focusedFactIds: [],
            focusedEpisodeIds: [],
            reasoningTags: [],
          };
        }

        const client = new OpenAI({
          apiKey,
          baseURL: env.VCW_OPENAI_BASE_URL,
        });

        const response = await client.responses.create({
          model,
          input: buildPlannerPrompt(input),
          temperature: 0,
          stream: false,
        });

        const text = readOpenAIText(response);
        if (!text.trim()) {
          return {
            requiredAttributes: [],
            focusedFactIds: [],
            focusedEpisodeIds: [],
            reasoningTags: [],
          };
        }

        return parsePlannerOutput(text);
      },
    };
  }

  return {
    async plan(input) {
      const env = config.env ?? process.env;
      const model = env.VCW_OLLAMA_MODEL;
      const baseUrl = env.VCW_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
      if (!model) {
        return {
          requiredAttributes: [],
          focusedFactIds: [],
          focusedEpisodeIds: [],
          reasoningTags: [],
        };
      }

      const response = await fetch(`${baseUrl.replace(/\/$/u, "")}/api/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          stream: false,
          format: "json",
          messages: [
            {
              role: "system",
              content: "You plan memory hydration from candidate IDs. Return strict JSON only.",
            },
            {
              role: "user",
              content: buildPlannerPrompt(input),
            },
          ],
          options: {
            temperature: 0,
          },
        }),
      });

      if (!response.ok) {
        return {
          requiredAttributes: [],
          focusedFactIds: [],
          focusedEpisodeIds: [],
          reasoningTags: [],
        };
      }

      const payload = (await response.json()) as Record<string, unknown>;
      const message = asObject(payload.message);
      const text =
        (typeof message?.content === "string" ? message.content : "") ||
        (typeof payload.response === "string" ? String(payload.response) : "");
      if (!text.trim()) {
        return {
          requiredAttributes: [],
          focusedFactIds: [],
          focusedEpisodeIds: [],
          reasoningTags: [],
        };
      }

      return parsePlannerOutput(text);
    },
  };
}

export function createProviderFactClaimExtractor(
  config: PlannerConfig,
): FactClaimPlannerExtractor {
  if (config.provider === "openai_responses") {
    const env = config.env ?? process.env;
    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("missing_env:OPENAI_API_KEY");
    }
    const baseUrl = env.VCW_OPENAI_BASE_URL;
    const model = env.VCW_OPENAI_MODEL;
    if (!model) {
      throw new Error("missing_env:VCW_OPENAI_MODEL");
    }
    const client = new OpenAI({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });

    return {
      async extract(input) {
        const response = await client.responses.create({
          model,
          input: buildFactClaimPlannerPrompt(input),
          temperature: 0,
        });

        const text = readOpenAIText(response).trim();
        if (!text) {
          return [];
        }
        return parseFactClaimPlannerOutput(text);
      },
    };
  }

  const env = config.env ?? process.env;
  const baseUrl = env.VCW_OLLAMA_BASE_URL ?? "http://localhost:11434";
  const model = env.VCW_OLLAMA_MODEL;
  if (!model) {
    throw new Error("missing_env:VCW_OLLAMA_MODEL");
  }

  return {
    async extract(input) {
      const response = await fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          prompt: buildFactClaimPlannerPrompt(input),
          stream: false,
          options: {
            temperature: 0,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`ollama_fact_planner_http_${response.status}`);
      }

      const payload = asObject(await response.json());
      const text = typeof payload?.response === "string" ? payload.response.trim() : "";
      if (!text) {
        return [];
      }
      return parseFactClaimPlannerOutput(text);
    },
  };
}

export async function runExtractorWithTimeout(options: {
  extractor: CompressionExtractor;
  input: CompressionExtractorInput;
  timeoutMs: number;
}): Promise<{ proposals: CompressionProposal[]; timeout: boolean; failed: boolean }> {
  const timeoutMs = Math.max(1, options.timeoutMs);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{
    type: "timeout";
  }>((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ type: "timeout" }), timeoutMs);
  });

  try {
    const result = await Promise.race([
      options.extractor.extract(options.input).then((proposals) => ({
        type: "value" as const,
        proposals,
      })),
      timeoutPromise,
    ]);

    if (result.type === "timeout") {
      return {
        proposals: [],
        timeout: true,
        failed: false,
      };
    }

    return {
      proposals: result.proposals,
      timeout: false,
      failed: false,
    };
  } catch {
    return {
      proposals: [],
      timeout: false,
      failed: true,
    };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export async function applyPassiveCommitPolicy(options: {
  threadId: string;
  store: SymbolStore;
  proposals: CompressionProposal[];
  confidenceThreshold?: number;
  maxProposals?: number;
  maxContentChars?: number;
  embeddingProvider?: EmbeddingProvider;
  embeddingCache?: InMemoryEmbeddingCache;
  embeddingModel?: string;
  candidateEntries?: Array<{
    entryId: string;
    offsetStart: number;
    offsetEnd: number;
    role?: "user" | "assistant";
    content?: string;
  }>;
}): Promise<PassiveCommitPolicyResult> {
  const confidenceThreshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const maxProposals = options.maxProposals ?? DEFAULT_MAX_EVENTS;
  const maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const candidateEntryMap = new Map(
    (options.candidateEntries ?? []).map((entry) => [
      entry.entryId,
      {
        start: entry.offsetStart,
        end: entry.offsetEnd,
        role: entry.role,
        content: entry.content,
      },
    ]),
  );

  const existing = await options.store.list(options.threadId);
  const existingContentHashes = new Set<string>();
  for (const item of existing) {
    const record = await options.store.get(options.threadId, item.symbolId);
    if (!record) {
      continue;
    }
    existingContentHashes.add(normalizeForComparison(record.content));
  }

  const committedSymbolIds: string[] = [];
  const committedRecords: PassiveCommitPolicyResult["committedRecords"] = [];
  let rejectedCount = 0;

  for (const proposal of options.proposals.slice(0, maxProposals)) {
    const normalizedContent = normalizeForComparison(proposal.content);

    if (proposal.confidence < confidenceThreshold) {
      rejectedCount += 1;
      continue;
    }

    if (proposal.evidenceSpans.length === 0) {
      rejectedCount += 1;
      continue;
    }

    if (candidateEntryMap.size > 0) {
      const spansAreGrounded = proposal.evidenceSpans.every((span) => {
        const bounds = candidateEntryMap.get(span.entryId);
        if (!bounds) {
          return false;
        }

        if (span.startOffset > span.endOffset) {
          return false;
        }

        return (
          span.startOffset >= bounds.start &&
          span.endOffset <= bounds.end
        );
      });
      if (!spansAreGrounded) {
        rejectedCount += 1;
        continue;
      }
    }

    const evidenceEntries = proposal.evidenceSpans
      .map((span) => candidateEntryMap.get(span.entryId))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    const hasUserEvidence = evidenceEntries.some((entry) => entry.role === "user");
    const hasAssistantEvidence = evidenceEntries.some((entry) => entry.role === "assistant");

    if (isLikelyLowSignalChatter(proposal.content) && !hasDurableSignal(proposal.content)) {
      rejectedCount += 1;
      continue;
    }

    // Assistant-only evidence must still look durable; this removes most polite echo churn.
    if (hasAssistantEvidence && !hasUserEvidence && !hasDurableSignal(proposal.content)) {
      rejectedCount += 1;
      continue;
    }

    if (proposal.content.length > maxContentChars || proposal.content.trim().length === 0) {
      rejectedCount += 1;
      continue;
    }

    if (SECRET_PATTERN.test(proposal.content)) {
      rejectedCount += 1;
      continue;
    }

    if (existingContentHashes.has(normalizedContent)) {
      rejectedCount += 1;
      continue;
    }

    const upsert = await options.store.upsert(options.threadId, {
      summary: proposal.summary || truncateSummary(proposal.content),
      content: proposal.content,
      kind: proposal.kind,
      meta: {
        source: "passive_compressor",
        keyHint: `passive:${proposal.kind}`,
      },
    });

    if (options.embeddingProvider) {
      const embeddingModel = options.embeddingModel ?? "";
      const cacheKey = InMemoryEmbeddingCache.symbolKey({
        threadId: options.threadId,
        model: embeddingModel || "(default)",
        symbolId: upsert.symbolId,
        version: normalizeForComparison(proposal.content),
      });
      let embeddingVector = options.embeddingCache?.get(cacheKey);
      let resolvedEmbeddingModel = embeddingModel;

      if (!embeddingVector || embeddingVector.length === 0) {
        try {
          const embedded = await Promise.race([
            options.embeddingProvider.embed({
              model: embeddingModel,
              input: proposal.content,
              traceId: `${options.threadId}:${upsert.symbolId}`,
            }),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error("embedding_timeout")), DEFAULT_EMBED_TIMEOUT_MS);
            }),
          ]);
          if (embedded.vector.length > 0) {
            embeddingVector = embedded.vector;
            resolvedEmbeddingModel = embedded.model || embeddingModel;
            options.embeddingCache?.set(cacheKey, embedded.vector);
          }
        } catch {
          // Fail-open; lexical retrieval remains available.
        }
      }

      if (embeddingVector && embeddingVector.length > 0) {
        await options.store.upsert(options.threadId, {
          symbolId: upsert.symbolId,
          summary: proposal.summary || truncateSummary(proposal.content),
          content: proposal.content,
          kind: proposal.kind,
          meta: {
            source: "passive_compressor",
            keyHint: `passive:${proposal.kind}`,
          },
          embeddingModel: resolvedEmbeddingModel || undefined,
          embeddingVector,
        });
      }
    }

    committedSymbolIds.push(upsert.symbolId);
    committedRecords.push({
      symbolId: upsert.symbolId,
      evidenceSpans: proposal.evidenceSpans,
    });
    existingContentHashes.add(normalizedContent);
  }

  return {
    committedSymbolIds,
    committedRecords,
    proposalsCount: options.proposals.length,
    committedSymbolsCount: committedSymbolIds.length,
    rejectedCount,
  };
}

export function createDeterministicFallbackExtractor(): CompressionExtractor {
  return {
    async extract(input) {
      const proposals: CompressionProposal[] = [];
      const max = Math.max(1, Math.min(DEFAULT_MAX_PROPOSALS, input.maxProposals));
      const rankedEntries = input.entries
        .map((entry) => ({
          entry,
          score: fallbackEntryScore(entry),
        }))
        .filter((item) => Number.isFinite(item.score) && item.score > 0)
        .sort((left, right) =>
          right.score - left.score ||
          left.entry.offsetStart - right.entry.offsetStart
        );

      for (const item of rankedEntries) {
        const entry = item.entry;
        const content = normalizeContent(entry.content);
        if (!content || isLikelyLowSignalChatter(content)) {
          continue;
        }

        proposals.push({
          summary: truncateSummary(content),
          content,
          kind: "note",
          confidence: 0.82,
          evidenceSpans: [
            {
              entryId: entry.entryId,
              startOffset: entry.offsetStart,
              endOffset: entry.offsetEnd,
            },
          ],
        });

        if (proposals.length >= max) {
          break;
        }
      }

      if (proposals.length > 0) {
        return proposals;
      }

      // Last-resort: keep user-authored entries to avoid complete durability starvation.
      for (const entry of input.entries) {
        if (entry.role !== "user") {
          continue;
        }
        const content = normalizeContent(entry.content);
        if (content.length < 8 || isLikelyLowSignalChatter(content)) {
          continue;
        }
        proposals.push({
          summary: truncateSummary(content),
          content,
          kind: "note",
          confidence: 0.8,
          evidenceSpans: [
            {
              entryId: entry.entryId,
              startOffset: entry.offsetStart,
              endOffset: entry.offsetEnd,
            },
          ],
        });
        if (proposals.length >= max) {
          break;
        }
      }

      return proposals;
    },
  };
}
