import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function withTempReportsRoot<T>(
  work: (reportsRoot: string) => Promise<T>,
): Promise<T> {
  const previous = process.env.VCW_REPORTS_ROOT;
  const root = await mkdtemp(path.join(os.tmpdir(), "vcw-reports-"));
  process.env.VCW_REPORTS_ROOT = root;

  try {
    return await work(root);
  } finally {
    if (previous === undefined) {
      delete process.env.VCW_REPORTS_ROOT;
    } else {
      process.env.VCW_REPORTS_ROOT = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
}

export function unsetLiveProviderEnv(): {
  VCW_OLLAMA_MODEL: string | undefined;
  VCW_OLLAMA_BASE_URL: string | undefined;
  VCW_LIVE_PROVIDER: string | undefined;
} {
  const snapshot = {
    VCW_OLLAMA_MODEL: process.env.VCW_OLLAMA_MODEL,
    VCW_OLLAMA_BASE_URL: process.env.VCW_OLLAMA_BASE_URL,
    VCW_LIVE_PROVIDER: process.env.VCW_LIVE_PROVIDER,
  };

  delete process.env.VCW_OLLAMA_MODEL;
  delete process.env.VCW_OLLAMA_BASE_URL;
  delete process.env.VCW_LIVE_PROVIDER;

  return snapshot;
}

export function restoreLiveProviderEnv(snapshot: {
  VCW_OLLAMA_MODEL: string | undefined;
  VCW_OLLAMA_BASE_URL: string | undefined;
  VCW_LIVE_PROVIDER: string | undefined;
}): void {
  if (snapshot.VCW_OLLAMA_MODEL === undefined) {
    delete process.env.VCW_OLLAMA_MODEL;
  } else {
    process.env.VCW_OLLAMA_MODEL = snapshot.VCW_OLLAMA_MODEL;
  }

  if (snapshot.VCW_OLLAMA_BASE_URL === undefined) {
    delete process.env.VCW_OLLAMA_BASE_URL;
  } else {
    process.env.VCW_OLLAMA_BASE_URL = snapshot.VCW_OLLAMA_BASE_URL;
  }

  if (snapshot.VCW_LIVE_PROVIDER === undefined) {
    delete process.env.VCW_LIVE_PROVIDER;
  } else {
    process.env.VCW_LIVE_PROVIDER = snapshot.VCW_LIVE_PROVIDER;
  }
}
