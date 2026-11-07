import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown } from './Markdown';

describe('Markdown', () => {
  it('never loads a remote image: it becomes a link the player can choose to open', () => {
    const { container } = render(
      <Markdown>{'The lantern flickers. ![tracking pixel](https://tracker.example/p.png?log=campaign-notes)'}</Markdown>,
    );
    expect(container.querySelector('img')).toBeNull();
    const link = screen.getByRole('link', { name: 'tracking pixel' });
    expect(link).toHaveAttribute('href', 'https://tracker.example/p.png?log=campaign-notes');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });

  it('keeps images embedded in the text itself', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const { container } = render(<Markdown>{`![map of the cove](${dataUrl})`}</Markdown>);
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', dataUrl);
    expect(img).toHaveAttribute('alt', 'map of the cove');
  });

  it('shows only the alt text for relative or unsafe image sources', () => {
    const { container } = render(<Markdown>{'![cove map](maps/cove.png) ![bad](javascript:alert(1))'}</Markdown>);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(container).toHaveTextContent('cove map');
    expect(container).toHaveTextContent('bad');
  });

  it('still opens ordinary links in a new tab', () => {
    render(<Markdown>{'See [the SRD](https://example.com/srd).'}</Markdown>);
    const link = screen.getByRole('link', { name: 'the SRD' });
    expect(link).toHaveAttribute('href', 'https://example.com/srd');
    expect(link).toHaveAttribute('target', '_blank');
  });
});
