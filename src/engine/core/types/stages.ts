export type RetrievalStrategy = "lexical_v1" | "hybrid_v2";

export type EngineStage =
  | "ResolveIdentity"
  | "BuildTurnQuery"
  | "InjectContextPack"
  | "EmitPreTelemetry"
  | "InvokeAssistant"
  | "ParseControl"
  | "ApplySymbolEvents"
  | "SanitizeOutput"
  | "EmitPostTelemetry"
  | "ReturnResponse";
