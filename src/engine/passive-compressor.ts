import OpenAI from "openai";
import type { SymbolRecordKind, SymbolStore } from "./passive-contracts";
import type {
  CompressionExtractor,
  CompressionExtractorInput,
  CompressionProposal,
  PassiveCommitPolicyResult,
} from "./passive-contracts";

type ExtractorProvider = "ollama" | "openai_responses";

type ExtractorConfig = {
  provider: ExtractorProvider;
  env?: Record<string, string | undefined>;
};

const SECRET_PATTERN =
  /(?:password|passcode|api[ _-]?key|private[ _-]?key|secret|token)\s*(?:is|=|:)/iu;

const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;
const DEFAULT_MAX_PROPOSALS = 4;
const DEFAULT_MAX_EVENTS = 8;
const DEFAULT_MAX_CONTENT_CHARS = 4_000;

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
  candidateEntries?: Array<{
    entryId: string;
    offsetStart: number;
    offsetEnd: number;
  }>;
}): Promise<PassiveCommitPolicyResult> {
  const confidenceThreshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const maxProposals = options.maxProposals ?? DEFAULT_MAX_EVENTS;
  const maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const candidateSpanBounds = new Map(
    (options.candidateEntries ?? []).map((entry) => [
      entry.entryId,
      {
        start: entry.offsetStart,
        end: entry.offsetEnd,
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

    if (candidateSpanBounds.size > 0) {
      const spansAreGrounded = proposal.evidenceSpans.every((span) => {
        const bounds = candidateSpanBounds.get(span.entryId);
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
      for (const entry of input.entries) {
        const content = entry.content.replace(/\s+/gu, " ").trim();
        if (content.length < 8) {
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

        if (proposals.length >= Math.max(1, Math.min(DEFAULT_MAX_PROPOSALS, input.maxProposals))) {
          break;
        }
      }

      return proposals;
    },
  };
}
