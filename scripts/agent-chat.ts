import {
  formatAgentCliUsage,
  parseAgentCliArgs,
  runInteractiveAgentCli,
} from "../src/agent-cli";

try {
  const parsed = parseAgentCliArgs(process.argv.slice(2));

  if (parsed.help) {
    console.log(formatAgentCliUsage());
    process.exitCode = 0;
  } else {
    process.exitCode = await runInteractiveAgentCli(parsed);
  }
} catch (error) {
  console.error("[agent] failed", error);
  process.exitCode = 1;
}
