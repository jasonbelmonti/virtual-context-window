import { Chalk } from "chalk";

export type CliTheme = {
  title: (text: string) => string;
  subtitle: (text: string) => string;
  section: (text: string) => string;
  key: (text: string) => string;
  value: (text: string) => string;
  assistant: (text: string) => string;
  prompt: (text: string) => string;
  success: (text: string) => string;
  error: (text: string) => string;
  subtle: (text: string) => string;
};

export function detectColorEnabled(
  output: { isTTY?: boolean } | undefined = process.stdout,
): boolean {
  if (process.env.NO_COLOR) {
    return false;
  }

  return Boolean(output?.isTTY);
}

export function createCliTheme(colorEnabled = detectColorEnabled()): CliTheme {
  const chalk = new Chalk({
    level: colorEnabled ? 3 : 0,
  });

  return {
    title: (text) => chalk.bold.hex("#20c997")(text),
    subtitle: (text) => chalk.hex("#8ce99a")(text),
    section: (text) => chalk.bold.hex("#74c0fc")(text),
    key: (text) => chalk.hex("#94d82d")(text),
    value: (text) => chalk.hex("#e9fac8")(text),
    assistant: (text) => chalk.hex("#ffec99")(text),
    prompt: (text) => chalk.bold.hex("#f59f00")(text),
    success: (text) => chalk.bold.hex("#69db7c")(text),
    error: (text) => chalk.bold.hex("#ff8787")(text),
    subtle: (text) => chalk.hex("#adb5bd")(text),
  };
}
