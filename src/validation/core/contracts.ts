export const SCENARIO_IDS = [
  "S01",
  "S02",
  "S03",
  "S04",
  "S05",
  "S06",
  "S07",
  "S08",
  "S09",
  "S10",
  "S11",
  "S12",
  "S13",
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];

export type ScenarioFamily =
  | "mechanism"
  | "task"
  | "parser_robustness"
  | "robustness"
  | "core_contract";

export type ValidationProfile = "quick" | "quick_live" | "production";

export type ValidationMode = "deterministic" | "live";
export type ValidationRunMode = ValidationMode | "mixed";

export const FAILURE_CLASSIFICATIONS = [
  "contract_violation",
  "retrieval_miss",
  "parser_violation",
  "policy_rejection",
  "hygiene_leak",
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

export type ScenarioCaseResult = {
  runId: string;
  scenarioId: ScenarioId;
  scenarioName: string;
  mode: ValidationMode;
  passed: boolean;
  classification?: FailureClassification;
  durationMs: number;
  metricSamples: MetricSample[];
  details?: string;
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
};

export type ValidationRunArtifacts = {
  summaryPath: string;
  metricsPath: string;
  scenarioResultsPath: string;
};

export type ValidationRunResult = {
  summary: RunSummary;
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

export type GateVerdict = {
  status: GateStatus;
  generatedAt: string;
  runAId: string;
  runBId: string;
  preconditions: Array<{ name: string; passed: boolean; detail: string }>;
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
  liveOptional?: boolean;
  requiredMetricKeys: string[];
  failureClassification: FailureClassification;
};

export type ScenarioExecutionContext = {
  runId: string;
  mode: ValidationMode;
  profile: ValidationProfile;
  rateWeight: number;
  timeoutMs: number;
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
