import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownArtifact } from './MarkdownArtifact';

describe('MarkdownArtifact images', () => {
  test('renders only data and relative sources as images', () => {
    const remote = 'https://images.example.test/worker-output.png';
    const data = 'data:image/png;base64,ZmFrZQ==';
    const relative = './worker-output.png';

    render(
      <MarkdownArtifact
        content={`![remote](${remote})\n\n![data](${data})\n\n![relative](${relative})`}
      />,
    );

    expect(screen.queryByRole('img', { name: 'remote' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: remote })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'data' })).toHaveAttribute('src', data);
    expect(screen.getByRole('img', { name: 'relative' })).toHaveAttribute('src', relative);
  });
});
