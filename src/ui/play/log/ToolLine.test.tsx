import '../testing/setup';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useGame } from '@/state/gameStore';
import { sampleMappedCombat } from '@/test/fixtures';
import type { ToolActivityIcon, ToolLogEntry } from '@/types';
import { usePlayView } from '../playView';
import { seedGame } from '../testing/seed';
import { ToolLine } from './ToolLine';

vi.mock('@/dm', () => import('../testing/dmMock'));
vi.mock('@/engine', () => import('../testing/engineMock'));

const STARTED = sampleMappedCombat().startedAt;

function line(tool: string, icon: ToolActivityIcon, summary: string, patch: Partial<ToolLogEntry> = {}): ToolLogEntry {
  return {
    id: `log-${tool}`,
    campaignId: 'camp-1',
    sessionId: 'sess-1',
    seq: 20,
    createdAt: STARTED + 1000,
    kind: 'tool',
    tool,
    icon,
    summary,
    ...patch,
  };
}

describe('ToolLine: battle-map lines', () => {
  it.each([
    ['update_map', 'map', 'Battle map: Dockside warehouse (16×12)', 'lucide-map'],
    ['move_tokens', 'move', 'Bandit 1 moves to C5 · Bandit 2 stands and moves to E4', 'lucide-footprints'],
    ['resolve_area', 'area', 'Fireball: Bandit 1 and Bandit 2 are caught', 'lucide-radius'],
  ] as const)('%s lines show the %s icon', (tool, icon, summary, iconClass) => {
    seedGame({ combat: sampleMappedCombat() });
    const { container } = render(<ToolLine entry={line(tool, icon, summary)} />);
    expect(screen.getByText(summary)).toBeInTheDocument();
    const svg = container.querySelector('svg');
    expect(svg).toHaveClass(iconClass);
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('offers "Show map" on the map setup line while that map is on the table', async () => {
    const user = userEvent.setup();
    seedGame({ combat: sampleMappedCombat() });
    usePlayView.setState({ mapDock: 'collapsed', mobileTab: 'story' });
    render(<ToolLine entry={line('update_map', 'map', 'Battle map: Dockside warehouse (16×12)', { detail: 'The layout.' })} />);

    await user.click(screen.getByRole('button', { name: 'Show map' }));
    // focusMap: desktop opens the dock, phones switch to the Combat tab.
    expect(usePlayView.getState()).toMatchObject({ mapDock: 'normal', mobileTab: 'combat' });

    act(() => useGame.setState({ combat: { ...sampleMappedCombat(), map: undefined } }));
    expect(screen.queryByRole('button', { name: 'Show map' })).not.toBeInTheDocument();
  });

  it('offers it on a combat-start line that set up a map', () => {
    seedGame({ combat: sampleMappedCombat() });
    const start = line('start_combat', 'combat', 'Combat started: Ambush in the warehouse (5 combatants)', {
      detail: 'Round 1 …\n\nBattle map: Dockside warehouse (16×12)',
    });
    render(<ToolLine entry={start} />);
    expect(screen.getByRole('button', { name: 'Show map' })).toBeInTheDocument();
  });

  it('not on map edits, on lines from an earlier fight, or once the fight is over', () => {
    seedGame({ combat: sampleMappedCombat() });
    const { rerender } = render(<ToolLine entry={line('update_map', 'map', 'The office door opens')} />);
    expect(screen.queryByRole('button', { name: 'Show map' })).not.toBeInTheDocument();

    rerender(<ToolLine entry={line('update_map', 'map', 'Battle map: The old mill (10×10)', { createdAt: STARTED - 60_000 })} />);
    expect(screen.queryByRole('button', { name: 'Show map' })).not.toBeInTheDocument();

    act(() => useGame.setState({ combat: null }));
    rerender(<ToolLine entry={line('update_map', 'map', 'Battle map: Dockside warehouse (16×12)')} />);
    expect(screen.queryByRole('button', { name: 'Show map' })).not.toBeInTheDocument();
  });
});
