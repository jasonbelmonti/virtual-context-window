export class EngineContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EngineContractError";
    this.code = code;
  }
}

export class MissingIdentityError extends EngineContractError {
  constructor() {
    super(
      "ERR_MISSING_IDENTITY",
      "VirtualContextEngine requires request.threadId or request.sessionId.",
    );
    this.name = "MissingIdentityError";
  }
}

export class SecondGenerationCallError extends EngineContractError {
  constructor() {
    super(
      "ERR_SECOND_GENERATION_CALL",
      "VirtualContextEngine invariant violation: second assistant-generation call attempted in a single turn.",
    );
    this.name = "SecondGenerationCallError";
  }
}

export class GenerationCallInvariantError extends EngineContractError {
  constructor(actualCount: number) {
    super(
      "ERR_GENERATION_CALL_INVARIANT",
      `VirtualContextEngine invariant violation: generationCallCount must equal 1, got ${actualCount}.`,
    );
    this.name = "GenerationCallInvariantError";
  }
}
