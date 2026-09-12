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
  /**
   * Called when the stream itself fails, rather than a line on it.
   *
   * A bad line is a parsing problem the reader recovers from; a bad stream is the end of
   * the conversation, and only the caller knows what it was holding open on the other
   * side of it. Optional so a caller with nothing to settle stays as it is — but the
   * listener is registered either way, because an `error` event with no listener at all
   * is thrown as an uncaught exception and would take the whole daemon down.
   */
  onError?: (error: Error) => void;
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

  /**
   * Whether this reader has already reached its end, however it got there.
   *
   * A stream can end after it errored, error twice, or be detached from after either, and
   * the caller is told exactly once regardless: a second telling would settle a turn or a
   * request that the first one already settled.
   */
  let finished = false;

  const stopFraming = (): void => {
    stream.off('data', onData);
    stream.off('end', onEnd);
  };

  function onEnd(): void {
    stopFraming();
    if (finished) return;
    finished = true;
    const rest = decoder.flush();
    if (rest !== null) handleLine(rest);
  }

  function onError(err: Error): void {
    // Framing stops, but the `error` listener deliberately stays on: a stream that failed
    // once can fail again, and the second unheard event is the same uncaught exception as
    // the first would have been. Only `detach` takes it off, and that is the caller saying
    // it has taken the stream over.
    stopFraming();
    if (finished) return;
    finished = true;
    // Buffered content is discarded, not flushed. What the decoder holds is by definition
    // a line whose newline never arrived, and on a broken stream it never will: parsing a
    // truncated line either fails as noise or, worse, succeeds on a prefix that happens to
    // be valid JSON and delivers half a message as a whole one. A clean `end` flushes
    // because the writer finished; an error says nothing of the sort.
    decoder.flush();
    handlers.onError?.(err);
  }

  stream.on('data', onData);
  stream.on('end', onEnd);
  stream.on('error', onError);

  return () => {
    finished = true;
    stopFraming();
    stream.off('error', onError);
  };
}

/** Serialize one message as a JSONL line. */
export function encodeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
