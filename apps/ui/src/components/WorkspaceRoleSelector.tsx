import type { WorkspaceRole, WorkspaceRoleSelection } from '@awos/protocol';
import type { WorkspaceRoleSave } from '@/hooks/useHarness';
import { cn } from '@/lib/utils';

export interface WorkspaceRoleSelectorProps {
  roles: WorkspaceRole[];
  selection: WorkspaceRoleSelection;
  save: WorkspaceRoleSave;
  error: string | null;
  onChange: (roleId: string | null) => void;
  label?: string;
  layout?: 'panel' | 'inline';
  className?: string;
}

/** A small native selector for the local role preference. */
export function WorkspaceRoleSelector({
  roles,
  selection,
  save,
  error,
  onChange,
  label = 'Project role',
  layout = 'panel',
  className,
}: WorkspaceRoleSelectorProps): React.JSX.Element {
  const value = selection.status === 'selected' ? selection.roleId ?? '' : '';
  const inline = layout === 'inline';

  return (
    <div className={cn(inline ? 'flex min-w-0 items-center gap-2' : 'space-y-1.5 border-t border-border pt-2', className)}>
      <label id="workspace-role-label" htmlFor="workspace-role" className={cn('font-medium', inline && 'shrink-0 text-xs text-muted-foreground')}>
        {label}
      </label>
      <select
        id="workspace-role"
        aria-describedby="workspace-role-state workspace-role-save"
        value={value}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
        disabled={save === 'saving'}
        className={cn(
          'awos-focus-ring rounded-md border border-input bg-background px-2 py-1.5 text-xs',
          inline ? 'min-w-0' : 'w-full',
        )}
      >
        <option value="">
          {selection.status === 'stale'
            ? `Saved role “${selection.roleId}” is stale`
            : 'Choose a project role…'}
        </option>
        {roles.map((role) => (
          <option key={role.id} value={role.id}>
            {role.label}
          </option>
        ))}
      </select>

      <p id="workspace-role-state" className="text-muted-foreground">
        {selection.status === 'needs-selection' && 'No role selected yet. Choose one for this workspace.'}
        {selection.status === 'selected' && `Selected: ${selection.role?.label ?? selection.roleId}`}
        {selection.status === 'stale' && 'The saved role is no longer declared. Choose a new role.'}
      </p>
      <p id="workspace-role-save" role={save === 'failed' || error !== null ? 'alert' : 'status'} className="text-muted-foreground">
        {save === 'saving' && 'Saving…'}
        {save === 'saved' && error === null && 'Saved locally for this workspace.'}
        {save === 'failed' && (error ?? 'Could not save the role preference.')}
        {save !== 'failed' && error !== null && error}
      </p>
    </div>
  );
}
