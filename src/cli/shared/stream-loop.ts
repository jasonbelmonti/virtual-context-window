export type StreamTheme = {
  assistant: (text: string) => string;
};

export type StreamAccumulator = {
  onDelta: (delta: string) => void;
  getText: () => string;
  streamToStdout: boolean;
};

export function createStreamAccumulator(options: {
  streamEnabled: boolean;
  printProvided: boolean;
  theme: StreamTheme;
}): StreamAccumulator {
  let streamedText = "";
  const streamToStdout = options.streamEnabled && !options.printProvided;

  return {
    onDelta: (delta: string) => {
      streamedText += delta;
      if (streamToStdout) {
        process.stdout.write(options.theme.assistant(delta));
      }
    },
    getText: () => streamedText,
    streamToStdout,
  };
}

export function renderAssistantFromStream(options: {
  streamEnabled: boolean;
  streamedText: string;
  finalContent: string;
  streamToStdout: boolean;
  theme: StreamTheme;
  writeLine: (text: string) => void;
}): void {
  if (!options.streamEnabled || options.streamedText.length === 0) {
    options.writeLine(options.theme.assistant(options.finalContent));
    return;
  }

  if (!options.streamToStdout) {
    options.writeLine(options.theme.assistant(options.streamedText));
    return;
  }

  process.stdout.write("\n");
}
