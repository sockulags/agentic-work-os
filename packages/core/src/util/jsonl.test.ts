import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LineDecoder } from './jsonl.js';

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
