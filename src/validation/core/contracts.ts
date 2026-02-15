export const SCENARIO_IDS = [
  "P01",
  "P02",
  "P03",
  "P04",
  "P05",
  "P06",
  "P07",
  "P08",
  "P09",
  "P10",
  "P11",
  "P12",
  "P13",
  "P14",
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];

export const VALIDATION_LANES = ["history_only_window", "passive_sliding_window"] as const;
export type ValidationLane = (typeof VALIDATION_LANES)[number];

export type ScenarioFamily = "memory" | "mechanism" | "robustness" | "core_contract";

export type ValidationProfile = "quick" | "quick_live" | "production";

export type ValidationMode = "deterministic" | "live";
export type ValidationRunMode = ValidationMode | "mixed";

export const FAILURE_CLASSIFICATIONS = [
  "contract_violation",
  "retrieval_miss",
  "policy_rejection",
  "isolation_leak",
  "timeout_or_latency",
  "provider_failure",
] as const;

export type FailureClassification = (typeof FAILURE_CLASSIFICATIONS)[number];

export type MetricKind = "rate" | "count" | "latency_p95";

export type RateMetricSample = {
  key: string;
  kind: "rate";
  numerator: number;
  denominator: number;
};

export type CountMetricSample = {
  key: string;
  kind: "count";
  value: number;
};

export type LatencyP95MetricSample = {
  key: string;
  kind: "latency_p95";
  samples: number[];
};

export type MetricSample =
  | RateMetricSample
  | CountMetricSample
  | LatencyP95MetricSample;

export type ScenarioAssertion = {
  requiredFactsTotal: number;
  requiredFactsCorrect: number;
  latestMismatchFields: string[];
  expectedValues: Record<string, string>;
  actualValues: Record<string, string>;
};

export type ScenarioDiagnosticsSnapshot = {
  pressurePeak?: number;
  pressureFinal?: number;
  compactionTriggered?: boolean;
  compactionJobsTriggered?: number;
  fallbackCommitUsed?: boolean;
  hydratedSymbolsCount?: number;
  retrievalDegraded?: boolean;
  vectorCandidateCount?: number;
  generationCallCount?: number;
  streamEquivalent?: boolean;
};

export type ScenarioCaseResult = {
  runId: string;
  scenarioId: ScenarioId;
  scenarioName: string;
  mode: ValidationMode;
  lane: ValidationLane;
  seed: string;
  sampleIndex: number;
  sampleCount: number;
  passed: boolean;
  classification?: FailureClassification;
  durationMs: number;
  metricSamples: MetricSample[];
  details?: string;
  assertions?: ScenarioAssertion;
  diagnosticsSnapshot?: ScenarioDiagnosticsSnapshot;
  metadata?: Record<string, unknown>;
};

export type ConfidenceInterval95 = {
  low: number;
  high: number;
};

export type MetricAggregate = {
  key: string;
  kind: MetricKind;
  numerator?: number;
  denominator?: number;
  rate?: number;
  value?: number;
  p95?: number;
  sampleCount?: number;
  ci95?: ConfidenceInterval95;
};

export type ThresholdStatus = "PASS" | "WARN" | "FAIL" | "N/A";

export type ThresholdEvaluation = {
  metricKey: string;
  status: ThresholdStatus;
  reason?: string;
};

export type RunSummary = {
  runId: string;
  profile: ValidationProfile;
  mode: ValidationRunMode;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  scenarioCount: number;
  passCount: number;
  failCount: number;
  warningFlags: string[];
  provider: string;
  runsPerScenario: number;
  sampleFloorApplied: number;
};

export type ValidationRunArtifacts = {
  summaryPath: string;
  metricsPath: string;
  scenarioResultsPath: string;
};

export type ValidationRunResult = {
  schemaVersion: "passive_validation_v1";
  summary: RunSummary;
  aggregate: {
    runsPerScenario: number;
    sampleFloorApplied: number;
    passiveWinRate: number;
  };
  scenarioResults: ScenarioCaseResult[];
  metrics: Record<string, MetricAggregate>;
  thresholdEvaluations: Record<string, ThresholdEvaluation>;
  artifacts: ValidationRunArtifacts;
};

export type GateStatus = "PASS" | "FAIL";

export type DriftCheckResult = {
  metricKey: string;
  passed: boolean;
  detail: string;
};

export type GateDimensionVerdict = {
  status: GateStatus;
  reasons: string[];
};

export type GateVerdict = {
  schemaVersion: "passive_gate_v1";
  status: GateStatus;
  generatedAt: string;
  runAId: string;
  runBId: string;
  preconditions: Array<{ name: string; passed: boolean; detail: string }>;
  memoryGate: GateDimensionVerdict;
  mechanismGate: GateDimensionVerdict;
  latencyGate: GateDimensionVerdict;
  metricStatuses: Record<string, ThresholdEvaluation>;
  driftChecks: DriftCheckResult[];
  reportConsistencyPassed: boolean;
  reasons: string[];
  warnings: string[];
  gatePathMarkdown?: string;
  gatePathJson?: string;
};

export type ValidationScenarioDefinition = {
  id: ScenarioId;
  name: string;
  family: ScenarioFamily;
  supportedModes: ValidationMode[];
  supportedProfiles: ValidationProfile[];
  requiredMetricKeys: string[];
  failureClassification: FailureClassification;
};

export type ScenarioExecutionContext = {
  runId: string;
  mode: ValidationMode;
  profile: ValidationProfile;
  timeoutMs: number;
  sampleIndex: number;
  sampleCount: number;
  runSeed: string;
  liveProvider?: LiveAssistantProvider;
};

export interface LiveAssistantProvider {
  readonly name: string;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
  generate(prompt: string, options?: { signal?: AbortSignal }): Promise<string>;
}

export type BaselinePairSelection = {
  runAId: string;
  runBId: string;
};
