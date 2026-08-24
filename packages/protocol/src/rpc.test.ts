import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasVisualEvidencePayload, type ClientRequest } from './rpc.js';
import { isTrustedVisualEventKind, type WorkerAdapterEvent } from './events.js';

const ordinaryEvidenceRequest: ClientRequest = {
  type: 'evidence.record',
  threadId: 'thread-a',
  runId: 'run-a',
  evidenceKind: 'artifact',
  ref: { eventId: 'artifact-event', url: null, label: 'visual artifact' },
  summary: 'ordinary evidence',
};

const workerEvidenceEvent: WorkerAdapterEvent = {
  kind: 'evidence.recorded',
  evidenceId: 'evidence-a',
  runId: null,
  workItemId: null,
  evidenceKind: 'note',
  ref: { eventId: null, url: null, label: 'note' },
  summary: 'ordinary worker evidence',
  state: { commit: null, tree: null, dirty: false },
  check: null,
};

// @ts-expect-error Ordinary evidence writes cannot carry adapter-produced visual authority.
const forgedVisualRequest: ClientRequest = { ...ordinaryEvidenceRequest, visual: {} };
// @ts-expect-error Worker adapters cannot emit adapter-produced visual authority.
const forgedWorkerVisualEvent: WorkerAdapterEvent = { ...workerEvidenceEvent, visual: {} };
const forgedWorkerSourceEvent: WorkerAdapterEvent = {
  // @ts-expect-error Worker adapters cannot publish trusted immutable visual source events.
  kind: 'visual.artifact.recorded',
  role: 'reference',
  artifactId: 'reference',
  locator: 'artifact://reference',
  revision: '1',
  digest: 'digest',
  capture: null,
};
void forgedVisualRequest;
void forgedWorkerVisualEvent;
void forgedWorkerSourceEvent;

test('ordinary evidence requests have no visual authority field', () => {
  assert.equal(hasVisualEvidencePayload(ordinaryEvidenceRequest), false);
  assert.equal(hasVisualEvidencePayload({ ...ordinaryEvidenceRequest, visual: null }), true);
  assert.equal(isTrustedVisualEventKind('visual.artifact.recorded'), true);
  assert.equal(isTrustedVisualEventKind('artifact.updated'), false);
});
