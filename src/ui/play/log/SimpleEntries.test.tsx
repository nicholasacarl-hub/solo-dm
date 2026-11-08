import '../testing/setup';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PlayerLogEntry } from '@/types';
import { PlayerEntry } from './SimpleEntries';

vi.mock('@/dm', () => import('../testing/dmMock'));
vi.mock('@/engine', () => import('../testing/engineMock'));

const entry = (patch: Partial<PlayerLogEntry> = {}): PlayerLogEntry => ({
  id: 'log-1',
  campaignId: 'camp-1',
  sessionId: 'sess-1',
  seq: 12,
  createdAt: 1,
  kind: 'player',
  text: 'I duck behind the crates.',
  ...patch,
});

describe('PlayerEntry', () => {
  it("shows the hero's battle-map moves under the bubble (D51)", () => {
    const { container } = render(<PlayerEntry entry={entry({ mapNote: 'Moved B6 → C7 → D8 · 10 ft · Disengaged' })} />);
    const chip = screen.getByText('Moved B6 → C7 → D8 · 10 ft · Disengaged').closest('p');
    expect(chip).toHaveTextContent('On the battle map: Moved B6 → C7 → D8 · 10 ft · Disengaged');
    expect(chip?.querySelector('svg.lucide-footprints')).toHaveAttribute('aria-hidden', 'true');
    // The chip sits under the player's words, not inside the bubble.
    expect(screen.getByText('I duck behind the crates.').contains(chip)).toBe(false);
    expect(container).toHaveTextContent('You: I duck behind the crates.');
  });

  it('shows no chip without map moves', () => {
    render(<PlayerEntry entry={entry()} />);
    expect(screen.queryByText(/On the battle map/)).not.toBeInTheDocument();
  });
});
