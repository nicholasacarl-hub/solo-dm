import './testing/setup';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGame } from '@/state/gameStore';
import { sampleClocks, sampleJournal, sampleQuests } from '@/test/fixtures';
import type { Clock, Quest } from '@/types';
import { JournalPanel } from './JournalPanel';
import { resetImagesMock, withImages } from './testing/imagesMock';
import { fakePicture, resetPictures, seedPictures } from './testing/imageStorageMock';
import { seedGame } from './testing/seed';

vi.mock('@/dm', () => import('./testing/dmMock'));
vi.mock('@/images', () => import('./testing/imagesMock'));
vi.mock('@/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/storage')>()),
  ...(await import('./testing/imageStorageMock')).imageStorage,
}));

beforeEach(() => {
  resetImagesMock();
  resetPictures();
});

function setup() {
  const spies = seedGame();
  render(
    <MemoryRouter>
      <JournalPanel />
    </MemoryRouter>,
  );
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

  it('shows the empty journal, not "Nothing matches", when every entry is a DM secret', async () => {
    seedGame({ journal: sampleJournal().filter((e) => e.secret) });
    render(<JournalPanel />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Journal' }));
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText('The journal is empty')).toBeInTheDocument();
    expect(within(panel).getByText(/1 secret entry hidden/)).toBeInTheDocument();
    expect(within(panel).queryByText(/Nothing matches/)).not.toBeInTheDocument();
    expect(within(panel).queryByRole('searchbox')).not.toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Show DM secrets (spoilers)' }));
    expect(within(panel).getByText('Keeper Halvard')).toBeInTheDocument();
  });

  it('says "Nothing matches" only for a filter that matches nothing', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('tab', { name: 'Journal' }));
    await user.type(screen.getByRole('searchbox', { name: 'Filter the journal' }), 'kraken');
    expect(screen.getByText('Nothing matches “kraken”.')).toBeInTheDocument();
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
    expect(screen.getByRole('tab', { name: 'Gallery' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows empty states for a brand-new campaign', () => {
    seedGame({ quests: [], journal: [], clocks: [], homebrew: [] });
    useGame.setState({ sessions: [] });
    render(<JournalPanel />);
    expect(screen.getByText('No quests yet')).toBeInTheDocument();
  });
});

const ambition = (overrides: Partial<Quest> = {}): Quest => ({
  id: 'q-guild',
  campaignId: 'camp-1',
  title: "Found a thieves' guild",
  status: 'active',
  summary: 'Saltmarsh has fences and cutpurses, but no one runs them. Yet.',
  objectives: [],
  ambition: true,
  createdAt: 2,
  updatedAt: 2,
  ...overrides,
});

const guildClock = (overrides: Partial<Clock> = {}): Clock => ({
  id: 'clk-guild',
  campaignId: 'camp-1',
  name: 'Found a thieves’ guild',
  segments: 8,
  filled: 3,
  kind: 'progress',
  secret: false,
  resolved: false,
  createdAt: 2,
  updatedAt: 2,
  ...overrides,
});

describe('JournalPanel — ambitions', () => {
  it('shows ambitions first, in their own group, with the progress clock that shares their name', () => {
    seedGame({ quests: [...sampleQuests(), ambition()], clocks: [...sampleClocks(), guildClock()] });
    render(<JournalPanel />);
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['Ambitions', 'Active', 'Rumors']);

    const card = screen.getByRole('article', { name: "Ambition: Found a thieves' guild" });
    expect(within(card).getByRole('img', { name: 'Found a thieves’ guild: 3 of 8 segments filled' })).toBeInTheDocument();
    expect(within(card).getByText('Progress 3 of 8')).toBeInTheDocument();
    // An ordinary quest is not an ambition, and the ambition isn't listed again with the active quests.
    expect(screen.queryByRole('article', { name: /Ambition: Find Keeper Halvard/ })).not.toBeInTheDocument();
    expect(screen.getAllByText("Found a thieves' guild")).toHaveLength(1);
  });

  it('lists only the steps the hero identified, and the player can tick them', async () => {
    const user = userEvent.setup();
    const spies = seedGame({
      quests: [ambition({ objectives: [{ id: 'o-fence', text: 'Win over Nell the fence', done: false }] })],
      clocks: [],
    });
    render(<JournalPanel />);
    const card = screen.getByRole('article', { name: /^Ambition:/ });
    expect(within(card).getByText('Steps you’ve identified')).toBeInTheDocument();
    // No clock yet: no progress shown rather than a made-up one.
    expect(within(card).queryByRole('img')).not.toBeInTheDocument();
    await user.click(within(card).getByRole('checkbox', { name: 'Win over Nell the fence' }));
    expect(spies.upsertQuest).toHaveBeenCalledWith({
      id: 'q-guild',
      title: "Found a thieves' guild",
      objectives: [{ id: 'o-fence', text: 'Win over Nell the fence', done: true }],
    });
  });

  it('keeps a secret clock hidden until spoilers are on, and marks how finished ambitions ended', async () => {
    const user = userEvent.setup();
    seedGame({
      quests: [ambition(), ambition({ id: 'q-crown', title: 'Take the Saltmarsh seat', status: 'failed' })],
      clocks: [guildClock({ secret: true })],
    });
    render(<JournalPanel />);
    const guild = screen.getByRole('article', { name: "Ambition: Found a thieves' guild" });
    expect(within(guild).queryByRole('img')).not.toBeInTheDocument();
    const crown = screen.getByRole('article', { name: 'Ambition: Take the Saltmarsh seat' });
    expect(within(crown).getByText('Failed')).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Show DM secrets (spoilers)' }));
    expect(within(guild).getByRole('img', { name: /3 of 8 segments filled/ })).toBeInTheDocument();
  });
});

describe('JournalPanel — gallery', () => {
  function renderGallery() {
    seedGame();
    render(
      <MemoryRouter>
        <JournalPanel />
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    return { user, open: () => user.click(screen.getByRole('tab', { name: 'Gallery' })) };
  }

  it('explains how pictures appear and links to the settings when they are off', async () => {
    const { open } = renderGallery();
    await open();
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText('No pictures yet')).toBeInTheDocument();
    expect(within(panel).getByText('Illustrations need your own OpenAI API key, added in Settings.')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Open Settings' })).toHaveAttribute(
      'href',
      '/settings#settings-section-images',
    );
  });

  it('tells the player how to ask for pictures once they can be made', async () => {
    withImages('moments');
    const { open } = renderGallery();
    await open();
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText(/choose “Show me the scene” in the \+ menu/)).toBeInTheDocument();
    expect(within(panel).getByText(/The DM also paints big moments as they happen/)).toBeInTheDocument();
    expect(within(panel).queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows the pictures newest first and steps through them in the lightbox', async () => {
    seedPictures([
      fakePicture({ id: 'img-old', title: 'Old Tam mending nets', subject: 'npc', createdAt: 1, mime: 'image/jpeg' }),
      fakePicture({ id: 'img-new', title: 'The drowned lantern at dusk', createdAt: 2 }),
    ]);
    const { user, open } = renderGallery();
    await open();
    const grid = screen.getByRole('list', { name: 'Pictures' });
    const thumbs = within(grid).getAllByRole('button');
    expect(thumbs.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Open picture: The drowned lantern at dusk',
      'Open picture: Old Tam mending nets',
    ]);
    expect(screen.getByText('2 pictures, newest first. Kept in this browser only.')).toBeInTheDocument();

    await user.click(thumbs[0]);
    let dialog = screen.getByRole('dialog', { name: 'The drowned lantern at dusk' });
    expect(within(dialog).getByRole('link', { name: 'Save' })).toHaveAttribute('download', 'the-drowned-lantern-at-dusk.webp');

    await user.click(within(dialog).getByRole('button', { name: 'Next picture' }));
    dialog = screen.getByRole('dialog', { name: 'Old Tam mending nets' });
    expect(within(dialog).getByText('Character')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Save' })).toHaveAttribute('download', 'old-tam-mending-nets.jpg');

    // Arrow keys step too, wrapping around.
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('dialog', { name: 'The drowned lantern at dusk' })).toBeInTheDocument();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('dialog', { name: 'Old Tam mending nets' })).toBeInTheDocument();
  });

  it('waits for the gallery to load', async () => {
    seedPictures([], { loaded: false });
    const { open } = renderGallery();
    await open();
    expect(screen.getByRole('status', { name: 'Loading the gallery' })).toBeInTheDocument();
  });
});
