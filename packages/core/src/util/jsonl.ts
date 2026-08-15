import type { Readable } from 'node:stream';

/**
 * Newline-delimited JSON framing, shared by both adapters and the permission MCP.
 *
 * Written by hand rather than pulled from a library because the failure modes matter:
 * a single unparseable line from a CLI must not kill the session, and a partial line at
 * the end of a chunk must be held rather than dropped. Both agents can emit lines well
 * past any default buffer size (a large tool result, a full diff), so there is no line
 * length cap here — backpressure is the stream's job.
 */
export class LineDecoder {
  #buffer = '';

  /** Feed a chunk, get back whatever complete lines it produced. */
  push(chunk: string): string[] {
    this.#buffer += chunk;
    const parts = this.#buffer.split('\n');
    // The last element is either '' (chunk ended on a newline) or a partial line.
    this.#buffer = parts.pop() ?? '';
    return parts.map((line) => line.replace(/\r$/, '')).filter((line) => line.length > 0);
  }

  /** Any trailing content held back, e.g. a process that exited without a final newline. */
  flush(): string | null {
    const rest = this.#buffer.trim();
    this.#buffer = '';
    return rest.length > 0 ? rest : null;
  }
}

export interface JsonLineHandlers<T> {
  onMessage: (msg: T) => void;
  /** Called for lines that aren't valid JSON — CLIs sometimes interleave plain text. */
  onUnparseable?: (line: string, error: Error) => void;
}

/**
 * Attach a JSONL reader to a stream. Returns a detach function.
 */
export function readJsonLines<T>(
  stream: Readable,
  handlers: JsonLineHandlers<T>,
): () => void {
  const decoder = new LineDecoder();
  stream.setEncoding('utf8');

  const handleLine = (line: string): void => {
    let parsed: T;
    try {
      parsed = JSON.parse(line) as T;
    } catch (err) {
      handlers.onUnparseable?.(line, err as Error);
      return;
    }
    handlers.onMessage(parsed);
  };

  const onData = (chunk: string): void => {
    for (const line of decoder.push(chunk)) handleLine(line);
  };

  const onEnd = (): void => {
    const rest = decoder.flush();
    if (rest !== null) handleLine(rest);
  };

  stream.on('data', onData);
  stream.on('end', onEnd);

  return () => {
    stream.off('data', onData);
    stream.off('end', onEnd);
  };
}

/** Serialize one message as a JSONL line. */
export function encodeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
