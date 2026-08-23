import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { Badge } from './badge';
import { Button } from './button';
import { Textarea } from './textarea';

describe('design-system primitives', () => {
  test('Button uses the shared focus and density contract', () => {
    render(<Button disabled>Send</Button>);

    const button = screen.getByRole('button', { name: 'Send' });
    expect(button).toHaveClass('awos-focus-ring', 'h-[var(--density-control-height)]');
    expect(button).toBeDisabled();
  });

  test('Badge state variants use semantic operational tokens', () => {
    render(
      <>
        <Badge variant="success">Passed</Badge>
        <Badge variant="warning">Stale</Badge>
      </>,
    );

    expect(screen.getByText('Passed')).toHaveClass('bg-state-passed-surface', 'text-state-passed');
    expect(screen.getByText('Stale')).toHaveClass('bg-state-stale-surface', 'text-state-stale');
  });

  test('Textarea keeps the shared focus, elevation, and density contract', () => {
    render(<Textarea aria-label="Message" />);

    const textarea = screen.getByRole('textbox', { name: 'Message' });
    expect(textarea).toHaveClass(
      'awos-focus-ring',
      'min-h-[var(--density-textarea-min-height)]',
      'shadow-awos-control',
    );
  });
});
