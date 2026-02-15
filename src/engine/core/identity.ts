import { MissingIdentityError } from "./errors";

export type IdentityContext = {
  threadId?: string;
  sessionId?: string;
  trustedSymbolRefs?: boolean;
};

export function resolveThreadIdentity(context: IdentityContext): string {
  const threadId = context.threadId?.trim();
  if (threadId) {
    return threadId;
  }

  const sessionId = context.sessionId?.trim();
  if (sessionId) {
    return sessionId;
  }

  throw new MissingIdentityError();
}

export function resolveTrustedSymbolRefs(context: IdentityContext): boolean {
  return context.trustedSymbolRefs === true;
}
