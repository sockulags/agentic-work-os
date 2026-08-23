import type { IssueRouteProjection } from '@awos/protocol';

/** Convert structured issue-route state into one plain explanation for a human reader. */
export function explainIssueRoute(projection: IssueRouteProjection): string {
  const { route, action } = projection;

  switch (action.reason) {
    case 'invalid-workspace': {
      const problem = route.workspaceProblems[0];
      return problem
        ? `The workspace declaration needs attention: ${problem.message}`
        : 'This directory is not a declared workspace.';
    }
    case 'not-routed':
      return 'No project action matches this issue’s labels.';
    case 'conflicted-route':
      return `More than one project action matches this issue (${route.matchingRouteIds.join(', ')}), so no action was selected.`;
    case 'refresh-required':
      return `Refresh the issue catalog before taking ${action.projectAction ?? 'this project action'}.`;
    case 'role-required':
      return `Select the ${action.responsibleRole?.label ?? 'required'} role before taking ${action.projectAction ?? 'this project action'}. The current role selection is ${action.roleSelection.status}.`;
    case 'role-mismatch': {
      const selected = action.roleSelection.role?.label ?? action.roleSelection.roleId ?? 'another role';
      return `Select the ${action.responsibleRole?.label ?? 'required'} role instead of ${selected} before taking ${action.projectAction ?? 'this project action'}.`;
    }
    case 'worker-unavailable':
      return `No allowed worker is currently available for the ${action.responsibleRole?.label ?? 'required'} role: ${action.unavailableWorkerProfileIds.join(', ')}.`;
    case 'available':
      return `Ready for ${action.projectAction ?? 'this project action'} as ${action.responsibleRole?.label ?? 'the selected role'}.`;
  }
}
