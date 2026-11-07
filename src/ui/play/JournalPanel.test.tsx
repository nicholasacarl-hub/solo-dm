import './testing/setup';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useGame } from '@/state/gameStore';
import { JournalPanel } from './JournalPanel';
import { seedGame } from './testing/seed';

vi.mock('@/dm', () => import('./testing/dmMock'));

function setup() {
  const spies = seedGame();
  render(<JournalPanel />);
  return { spies, user: userEvent.setup() };
}

describe('JournalPanel', () => {
  it('groups quests by status and lets the player tick objectives (the DM is told)', async () => {
    const { spies, user } = setup();
    expect(screen.getByRole('heading', { name: 'Active' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Rumors' })).toBeInTheDocument();

    const objective = screen.getByRole('checkbox', { name: 'Reach the lighthouse at low tide' });
    expect(objective).not.toBeChecked();
    await user.click(objective);

    expect(spies.upsertQuest).toHaveBeenCalledWith({
      id: 'q-1',
      title: 'Find Keeper Halvard',
      objectives: [
        { id: 'o-1', text: 'Question Old Tam', done: true },
        { id: 'o-2', text: 'Reach the lighthouse at low tide', done: true },
      ],
    });
    expect(spies.queueDmNotice).toHaveBeenCalledWith(
      'The player marked the objective "Reach the lighthouse at low tide" of the quest "Find Keeper Halvard" as done.',
    );
    expect(screen.getByRole('checkbox', { name: 'Reach the lighthouse at low tide' })).toBeChecked();
  });

  it('hides secret journal entries until spoilers are on, and lists rulings as house rules', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('tab', { name: 'Journal' }));
    const panel = screen.getByRole('tabpanel');

    expect(within(panel).getByRole('heading', { name: 'House rules' })).toBeInTheDocument();
    expect(within(panel).getByText('Climbing wet stone')).toBeInTheDocument();
    expect(within(panel).getByText('Old Tam')).toBeInTheDocument();
    expect(within(panel).queryByText('Keeper Halvard')).not.toBeInTheDocument();
    expect(within(panel).getByText(/1 secret entry hidden/)).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Show DM secrets (spoilers)' }));
    expect(within(panel).getByText('Keeper Halvard')).toBeInTheDocument();
    expect(within(panel).getByText('DM secret')).toBeInTheDocument();
  });

  it('filters the journal', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('tab', { name: 'Journal' }));
    await user.type(screen.getByRole('searchbox', { name: 'Filter the journal' }), 'lighthouse');
    expect(screen.getByText('The Drowned Lantern')).toBeInTheDocument();
    expect(screen.queryByText('Old Tam')).not.toBeInTheDocument();
  });

  it('draws clocks and hides secret ones unless spoilers are on', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('tab', { name: 'Clocks' }));
    expect(screen.getByRole('img', { name: 'The tide turns: 1 of 4 segments filled' })).toBeInTheDocument();
    expect(screen.queryByText('Something stirs below')).not.toBeInTheDocument();
    expect(screen.getByText(/1 secret clock hidden/)).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Show DM secrets (spoilers)' }));
    expect(screen.getByRole('img', { name: 'Something stirs below: 2 of 6 segments filled' })).toBeInTheDocument();
  });

  it("lists this campaign's homebrew and opens it in a viewer", async () => {
    const { spies, user } = setup();
    await user.click(screen.getByRole('tab', { name: 'Homebrew' }));
    await user.click(screen.getByRole('button', { name: /Tidecaller's Mark/ }));
    const viewer = screen.getByRole('heading', { name: "Tidecaller's Mark" }).closest('dialog')!;
    expect(within(viewer).getByText('Water Breathing')).toBeInTheDocument();
    await user.click(within(viewer).getByRole('button', { name: 'Veto' }));
    expect(spies.queueDmNotice).toHaveBeenCalledWith(
      'The player vetoed homebrew "Tidecaller\'s Mark". Retire or rework it.',
    );
  });

  it("keeps the ended sessions' recaps in the chronicle", async () => {
    const { user } = setup();
    await user.click(screen.getByRole('tab', { name: 'Chronicle' }));
    expect(screen.getByText('Session 1')).toBeInTheDocument();
    expect(screen.getByText(/Old Tam swore he saw a figure/)).toBeInTheDocument();
    expect(screen.queryByText(/Halvard is alive/)).not.toBeInTheDocument();
  });

  it('moves between tabs with the arrow keys', async () => {
    const { user } = setup();
    screen.getByRole('tab', { name: 'Quests' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Journal' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Journal' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Chronicle' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows empty states for a brand-new campaign', () => {
    seedGame({ quests: [], journal: [], clocks: [], homebrew: [] });
    useGame.setState({ sessions: [] });
    render(<JournalPanel />);
    expect(screen.getByText('No quests yet')).toBeInTheDocument();
  });
});
