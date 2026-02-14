import {
  formatChatCliUsage,
  parseChatCliArgs,
  runInteractiveChatCli,
} from "../src/chat-cli";

try {
  const parsed = parseChatCliArgs(process.argv.slice(2));

  if (parsed.help) {
    console.log(formatChatCliUsage());
    process.exitCode = 0;
  } else {
    process.exitCode = await runInteractiveChatCli(parsed);
  }
} catch (error) {
  console.error("[chat] failed", error);
  process.exitCode = 1;
}
