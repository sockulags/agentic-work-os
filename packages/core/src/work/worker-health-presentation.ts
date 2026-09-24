import type { WorkerDiagnosticReasonCode } from '@awos/protocol';

/**
 * One sentence per worker reason code.
 *
 * Every worker explanation in the product comes from here, so the reason a row shows and
 * the reason a refusal carries cannot drift apart. Probe output is deliberately absent: it
 * carries vendor text, paths, and occasionally whatever a misconfigured endpoint echoed
 * back, and it belongs next to the sentence as bounded detail rather than inside it.
 */
export function explainWorkerReason(
  code: WorkerDiagnosticReasonCode,
  worker: { label: string; profileId: string; configured: boolean },
): string {
  switch (code) {
    case 'configured':
      return `${worker.label} is configured and its model target is supported.`;
    case 'unsupported':
      return worker.configured
        ? `${worker.label} cannot run its configured model target.`
        : `No worker profile named ${worker.profileId} is configured.`;
    case 'not-checked':
      return `${worker.label} has not been checked yet.`;
    case 'reachable':
      return `${worker.label} answered the last check.`;
    case 'busy':
      return `${worker.label} is working on a turn right now.`;
    case 'unavailable':
      return `${worker.label} did not answer the last check.`;
    case 'stale':
      return `The last check of ${worker.label} is too old to describe it now. Check again.`;
  }
}
