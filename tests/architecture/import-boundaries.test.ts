import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const WORKSPACE_ROOT = process.cwd();
const SHARED_CLI_DIR = path.join(WORKSPACE_ROOT, "src", "cli", "shared");

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTsFiles(full));
      continue;
    }
    if (entry.isFile() && full.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function extractImportSpecifiers(content: string): string[] {
  const matches = content.matchAll(/\bfrom\s+["']([^"']+)["']/gu);
  return [...matches].map((match) => match[1] ?? "");
}

test("cli/shared does not depend on provider or product-specific CLI layers", async () => {
  const files = await listTsFiles(SHARED_CLI_DIR);
  expect(files.length).toBeGreaterThan(0);

  for (const file of files) {
    const content = await readFile(file, "utf8");
    const specifiers = extractImportSpecifiers(content);

    for (const specifier of specifiers) {
      const normalized = specifier.replace(/\\/gu, "/");
      expect(normalized).not.toContain("/integrations/");
      expect(normalized).not.toContain("/agent-cli/");
      expect(normalized).not.toContain("/chat-cli/");
    }
  }
});
