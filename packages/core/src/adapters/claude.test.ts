import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyClaudeTool,
  summarizeClaudeTool,
  flattenToolResult,
  extractTodos,
  describePermission,
} from './claude.js';

describe('classifyClaudeTool', () => {
  test('maps built-ins to their kind', () => {
    assert.equal(classifyClaudeTool('Bash'), 'command');
    assert.equal(classifyClaudeTool('Edit'), 'file_edit');
    assert.equal(classifyClaudeTool('Read'), 'file_read');
    assert.equal(classifyClaudeTool('Grep'), 'search');
    assert.equal(classifyClaudeTool('WebFetch'), 'web');
    assert.equal(classifyClaudeTool('Task'), 'task');
  });

  test('treats any mcp__ prefix as an MCP tool', () => {
    assert.equal(classifyClaudeTool('mcp__github__create_issue'), 'mcp');
  });

  test('falls back to other for unknown names', () => {
    // Claude Code adds tools between releases; an unknown name must not throw.
    assert.equal(classifyClaudeTool('SomeFutureTool'), 'other');
  });
});

describe('summarizeClaudeTool', () => {
  test('shows the command line for Bash', () => {
    assert.equal(summarizeClaudeTool('Bash', { command: 'npm test' }), 'npm test');
  });

  test('shows the path for file tools', () => {
    assert.equal(summarizeClaudeTool('Edit', { file_path: '/a/b.ts' }), 'Edit /a/b.ts');
  });

  test('marks subagent calls', () => {
    assert.equal(
      summarizeClaudeTool('Bash', { command: 'ls' }, true),
      'subagent · ls',
    );
  });

  test('degrades to a key list for unknown tools', () => {
    assert.equal(summarizeClaudeTool('Weird', { x: 1, y: 2 }), 'Weird(x, y)');
  });

  test('does not crash when the expected field is missing', () => {
    assert.equal(summarizeClaudeTool('Bash', {}), 'Bash');
  });
});

describe('flattenToolResult', () => {
  test('passes a string body through', () => {
    assert.equal(flattenToolResult('done'), 'done');
  });

  test('joins the block-array form', () => {
    assert.equal(
      flattenToolResult([
        { type: 'text', text: 'line 1' },
        { type: 'text', text: 'line 2' },
      ]),
      'line 1\nline 2',
    );
  });

  test('ignores non-text blocks', () => {
    assert.equal(
      flattenToolResult([{ type: 'image' }, { type: 'text', text: 'ok' }]),
      'ok',
    );
  });
});

describe('extractTodos', () => {
  test('reads a TodoWrite payload', () => {
    const items = extractTodos({
      todos: [
        { content: 'first', status: 'completed' },
        { content: 'second', status: 'in_progress' },
        { content: 'third', status: 'pending' },
      ],
    });
    assert.deepEqual(items, [
      { text: 'first', status: 'completed' },
      { text: 'second', status: 'in_progress' },
      { text: 'third', status: 'pending' },
    ]);
  });

  test('maps an unrecognized status to pending rather than dropping the item', () => {
    assert.deepEqual(extractTodos({ todos: [{ content: 'a', status: 'weird' }] }), [
      { text: 'a', status: 'pending' },
    ]);
  });

  test('returns empty for malformed input', () => {
    assert.deepEqual(extractTodos(null), []);
    assert.deepEqual(extractTodos({}), []);
    assert.deepEqual(extractTodos({ todos: 'nope' }), []);
    assert.deepEqual(extractTodos({ todos: [{ nope: true }] }), []);
  });
});

describe('describePermission', () => {
  test('surfaces the command for a Bash approval', () => {
    const { title, detail } = describePermission({
      threadId: 't',
      toolName: 'Bash',
      input: { command: 'rm -rf build' },
      toolUseId: null,
    });
    assert.equal(title, 'Run a shell command');
    // The operator must be able to read the exact command before approving it.
    assert.equal(detail, 'rm -rf build');
  });

  test('names the file for a Write approval', () => {
    const { title } = describePermission({
      threadId: 't',
      toolName: 'Write',
      input: { file_path: '/etc/hosts', content: 'x' },
      toolUseId: null,
    });
    assert.equal(title, 'Write /etc/hosts');
  });

  test('falls back to serialized input for unknown tools', () => {
    const { title, detail } = describePermission({
      threadId: 't',
      toolName: 'mcp__x__y',
      input: { a: 1 },
      toolUseId: null,
    });
    assert.equal(title, 'Use mcp__x__y');
    assert.match(detail, /"a": 1/);
  });
});
