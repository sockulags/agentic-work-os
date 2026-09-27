import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { LineDecoder, readJsonLines } from './jsonl.js';

describe('LineDecoder', () => {
  test('emits complete lines and holds partials', () => {
    const decoder = new LineDecoder();
    assert.deepEqual(decoder.push('{"a":1}\n{"b":'), ['{"a":1}']);
    assert.deepEqual(decoder.push('2}\n'), ['{"b":2}']);
  });

  test('handles a message split across many chunks', () => {
    const decoder = new LineDecoder();
    // A large tool result really does arrive like this.
    assert.deepEqual(decoder.push('{"long":"'), []);
    assert.deepEqual(decoder.push('a'.repeat(100)), []);
    assert.deepEqual(decoder.push('"}\n'), [`{"long":"${'a'.repeat(100)}"}`]);
  });

  test('strips CR so Windows pipes parse', () => {
    const decoder = new LineDecoder();
    assert.deepEqual(decoder.push('{"a":1}\r\n'), ['{"a":1}']);
  });

  test('drops blank lines rather than emitting empty strings', () => {
    const decoder = new LineDecoder();
    assert.deepEqual(decoder.push('\n\n{"a":1}\n\n'), ['{"a":1}']);
  });

  test('flush returns trailing content from a process that died mid-line', () => {
    const decoder = new LineDecoder();
    decoder.push('{"partial":true}');
    assert.equal(decoder.flush(), '{"partial":true}');
    assert.equal(decoder.flush(), null);
  });

  test('several messages in one chunk stay in order', () => {
    const decoder = new LineDecoder();
    assert.deepEqual(decoder.push('{"n":1}\n{"n":2}\n{"n":3}\n'), [
      '{"n":1}',
      '{"n":2}',
      '{"n":3}',
    ]);
  });
});

/**
 * A stream failure is not a bad line.
 *
 * `onUnparseable` recovers from one line a CLI got wrong. An `error` on the stream ends
 * the conversation instead, and an `error` event with no listener at all is thrown by Node
 * as an uncaught exception — which here means one worker's broken pipe taking the whole
 * daemon with it.
 *
 * The events are raised directly rather than driven through a pipe: the reader is defined
 * entirely by the three events it subscribes to, and raising them is what makes the order
 * of a failure against a half-written line something a case decides rather than observes.
 */
describe('readJsonLines stream failure', () => {
  const stream = (): PassThrough => new PassThrough();

  test('an error on the stream reaches the caller instead of the uncaught path', () => {
    const source = stream();
    const seen: Error[] = [];
    readJsonLines<unknown>(source, { onMessage: () => {}, onError: (err) => seen.push(err) });

    const boom = new Error('EIO');
    // With no listener registered this call throws. That is the failure being guarded.
    assert.doesNotThrow(() => source.emit('error', boom));
    assert.deepEqual(seen, [boom]);
  });

  test('a caller that supplies no onError still survives the failure', () => {
    const source = stream();
    readJsonLines<unknown>(source, { onMessage: () => {} });
    // The listener is registered whether or not the caller has anything to settle.
    assert.doesNotThrow(() => source.emit('error', new Error('EIO')));
  });

  test('lines framed before the error are delivered, the error after them', () => {
    const source = stream();
    const seen: string[] = [];
    readJsonLines<{ n: number }>(source, {
      onMessage: (msg) => seen.push(`msg ${msg.n}`),
      onError: (err) => seen.push(`error ${err.message}`),
    });

    source.emit('data', '{"n":1}\n{"n":2}\n');
    source.emit('error', new Error('EIO'));

    assert.deepEqual(seen, ['msg 1', 'msg 2', 'error EIO']);
  });

  test('the partial line held when the error arrives is discarded, not flushed', () => {
    const source = stream();
    const messages: unknown[] = [];
    const unparseable: string[] = [];
    readJsonLines<unknown>(source, {
      onMessage: (msg) => messages.push(msg),
      onUnparseable: (line) => unparseable.push(line),
      onError: () => {},
    });

    // Valid JSON, but only because the stream died mid-object: `{"n":1}` is a prefix of
    // `{"n":1234}`. Flushing it would deliver half a message as a whole one.
    source.emit('data', '{"n":1');
    source.emit('error', new Error('EIO'));

    assert.deepEqual(messages, []);
    assert.deepEqual(unparseable, []);
  });

  test('a repeat error, and an end after one, handle nothing twice', () => {
    const source = stream();
    const errors: Error[] = [];
    const messages: unknown[] = [];
    readJsonLines<unknown>(source, {
      onMessage: (msg) => messages.push(msg),
      onError: (err) => errors.push(err),
    });

    source.emit('data', '{"n":1}');
    source.emit('error', new Error('EIO'));
    // A failed stream can fail again, and the second one is as unhandled as the first was.
    assert.doesNotThrow(() => source.emit('error', new Error('again')));
    source.emit('end');
    source.emit('data', '{"n":2}\n');

    assert.deepEqual(
      errors.map((err) => err.message),
      ['EIO'],
    );
    assert.deepEqual(messages, []);
  });

  test('detaching removes the error listener along with the others', () => {
    const source = stream();
    const errors: Error[] = [];
    const detach = readJsonLines<unknown>(source, {
      onMessage: () => {},
      onError: (err) => errors.push(err),
    });

    detach();
    assert.equal(source.listenerCount('data'), 0);
    assert.equal(source.listenerCount('end'), 0);
    assert.equal(source.listenerCount('error'), 0);

    // Detaching twice must not put a listener back, and a failure afterwards belongs to
    // whoever took the stream over rather than to a reader that stopped listening.
    detach();
    assert.equal(source.listenerCount('error'), 0);
    assert.deepEqual(errors, []);
  });

  test('a clean end still flushes the trailing line', () => {
    const source = stream();
    const messages: unknown[] = [];
    readJsonLines<unknown>(source, {
      onMessage: (msg) => messages.push(msg),
      onError: () => {},
    });

    // The writer finished and only the newline is missing, which is a different fact from
    // a stream that broke, and the reason the two terminal paths differ.
    source.emit('data', '{"n":1}');
    source.emit('end');

    assert.deepEqual(messages, [{ n: 1 }]);
  });
});
