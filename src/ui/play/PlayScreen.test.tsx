import './testing/setup';
import { StrictMode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { dm } from '@/dm';
import { initialDmStatus, useGame } from '@/state/gameStore';
import { acquireCampaignLock, type CampaignLock } from '@/storage';
import { sampleCampaign } from '@/test/fixtures';
import { PlayScreen } from '@/ui/screens/PlayScreen';
import { resetDmMock } from './testing/dmMock';
import { fixtureState } from './testing/fakeGame';
import { seedGame, type ActionSpies } from './testing/seed';

vi.mock('@/dm', () => import('./testing/dmMock'));
vi.mock('@/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/storage')>()),
  acquireCampaignLock: vi.fn(),
}));
vi.mock('@/engine', () => import('./testing/engineMock'));
vi.mock('@/images', () => import('./testing/imagesMock'));
vi.mock('@/data', () => ({ useRulesIndex: () => null }));
vi.mock('@/ui/sheet/CharacterSheet', () => ({ CharacterSheet: () => <p>Character sheet</p> }));
vi.mock('@/ui/sheet/ShortRestDialog', () => ({ ShortRestDialog: () => null }));
vi.mock('@/ui/sheet/LevelUpDialog', () => ({ LevelUpDialog: () => null }));
vi.mock('@/ui/shell/CampaignSettingsForm', () => ({ CampaignSettingsForm: () => null }));

/** An empty store whose loadCampaign behaves like the real one (loading → loaded). */
function seedUnloaded(): ActionSpies {
  return seedGame({
    campaignId: null,
    campaign: null,
    character: null,
    sessions: [],
    activeSession: null,
    log: [],
    combat: null,
  });
}

function renderAt(path: string, strict = true) {
  const tree = (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/play/:id" element={<PlayScreen />} />
        <Route path="/campaign/:id/character" element={<p>Character builder</p>} />
        <Route path="/" element={<p>Save slots</p>} />
      </Routes>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

/** A campaign lock whose loss (another tab stealing it) the test controls. */
function fakeLock(): { lock: CampaignLock & { release: Mock<() => void> }; lose: () => void } {
  let lose!: () => void;
  const lost = new Promise<void>((resolve) => (lose = resolve));
  return { lock: { release: vi.fn<() => void>(), lost }, lose };
}

const acquire = vi.mocked(acquireCampaignLock);

beforeEach(() => {
  resetDmMock();
  acquire.mockReset().mockImplementation(async () => fakeLock().lock);
});

describe('PlayScreen', () => {
  it('loads the campaign, shows the table and begins the session exactly once (StrictMode)', async () => {
    const spies = seedUnloaded();
    renderAt('/play/camp-1');

    expect(await screen.findByRole('heading', { name: 'The Drowned Lantern' })).toBeInTheDocument();
    expect(spies.loadCampaign).toHaveBeenCalledWith('camp-1');
    await waitFor(() => expect(dm.beginOrResume).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('log', { name: 'Story so far' })).toBeInTheDocument();
  });

  it('titles the tab with the campaign and session', async () => {
    seedUnloaded();
    renderAt('/play/camp-1');
    await screen.findByRole('heading', { name: 'The Drowned Lantern' });
    await waitFor(() => expect(document.title).toBe('The Drowned Lantern · Session 2 · Solo DM'));
  });

  it('unloads the campaign and stops a busy DM when leaving the table', async () => {
    const spies = seedUnloaded();
    const view = renderAt('/play/camp-1', false);
    await screen.findByRole('heading', { name: 'The Drowned Lantern' });
    vi.mocked(dm.isBusy).mockReturnValue(true);

    view.unmount();
    expect(dm.cancel).toHaveBeenCalledTimes(1);
    expect(spies.unloadCampaign).toHaveBeenCalledTimes(1);
  });

  it('waits for a busy DM to finish before beginning', async () => {
    const spies = seedUnloaded();
    const load = spies.loadCampaign.getMockImplementation()!;
    spies.loadCampaign.mockImplementation(async (id) => {
      await load(id);
      useGame.setState({ dm: { ...initialDmStatus, phase: 'streaming' } });
    });
    vi.mocked(dm.isBusy).mockReturnValue(true);
    renderAt('/play/camp-1');
    await screen.findByRole('heading', { name: 'The Drowned Lantern' });
    expect(dm.beginOrResume).not.toHaveBeenCalled();

    vi.mocked(dm.isBusy).mockReturnValue(false);
    act(() => useGame.setState({ dm: initialDmStatus }));
    await waitFor(() => expect(dm.beginOrResume).toHaveBeenCalledTimes(1));
  });

  it('sends players without a character to the character builder', async () => {
    const spies = seedUnloaded();
    spies.loadCampaign.mockImplementation(async (id) => {
      useGame.setState({
        ...fixtureState(),
        campaignId: id,
        campaign: sampleCampaign({ characterId: null }),
        character: null,
      });
    });
    renderAt('/play/camp-1');
    expect(await screen.findByText('Character builder')).toBeInTheDocument();
    expect(dm.beginOrResume).not.toHaveBeenCalled();
  });

  it('explains when the campaign cannot be opened', async () => {
    const spies = seedUnloaded();
    spies.loadCampaign.mockImplementation(async (id) => {
      useGame.setState({
        campaignId: id,
        campaign: null,
        loading: false,
        loadError: 'This campaign could not be found.',
      });
    });
    renderAt('/play/missing');
    expect(await screen.findByText("This campaign couldn't be opened")).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('This campaign could not be found.');
    expect(screen.getByRole('link', { name: 'Back to campaigns' })).toHaveAttribute('href', '/');
  });

  it('shows the loading state while the campaign opens', () => {
    const spies = seedUnloaded();
    spies.loadCampaign.mockImplementation(() => new Promise(() => {}));
    renderAt('/play/camp-1');
    expect(screen.getByText('Opening the campaign…')).toBeInTheDocument();
  });
});

describe('PlayScreen — one tab at a time', () => {
  it('claims the campaign before loading it and lets go after leaving the table', async () => {
    const spies = seedUnloaded();
    const { lock } = fakeLock();
    acquire.mockResolvedValue(lock);
    const view = renderAt('/play/camp-1', false);
    await screen.findByRole('heading', { name: 'The Drowned Lantern' });
    expect(acquire).toHaveBeenCalledWith('camp-1', undefined);
    expect(acquire.mock.invocationCallOrder[0]).toBeLessThan(spies.loadCampaign.mock.invocationCallOrder[0]);

    view.unmount();
    await waitFor(() => expect(lock.release).toHaveBeenCalledTimes(1));
  });

  it('stays out of a campaign another tab has open: no load, no DM, a way to take it over', async () => {
    const spies = seedUnloaded();
    // Another tab holds it: asking gets nothing, taking it over (steal) gets the lock.
    acquire.mockImplementation(async (_id, opts) => (opts?.steal ? fakeLock().lock : null));
    renderAt('/play/camp-1');

    expect(await screen.findByRole('heading', { name: 'This campaign is open in another tab' })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Open in another tab · Solo DM'));
    expect(spies.loadCampaign).not.toHaveBeenCalled();
    expect(dm.beginOrResume).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Back to campaigns' })).toHaveAttribute('href', '/');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Use this tab instead' }));
    expect(await screen.findByRole('heading', { name: 'The Drowned Lantern' })).toBeInTheDocument();
    expect(acquire).toHaveBeenLastCalledWith('camp-1', { steal: true });
    expect(spies.loadCampaign).toHaveBeenCalledWith('camp-1');
    await waitFor(() => expect(dm.beginOrResume).toHaveBeenCalledTimes(1));
  });

  it('stops the DM and steps back when another tab takes the campaign over', async () => {
    const spies = seedUnloaded();
    const taken = fakeLock();
    // Every holder in this tab shares the one lock (StrictMode mounts twice).
    acquire.mockResolvedValue(taken.lock);
    renderAt('/play/camp-1');
    await screen.findByRole('heading', { name: 'The Drowned Lantern' });
    vi.mocked(dm.isBusy).mockReturnValue(true);

    await act(async () => taken.lose());
    expect(await screen.findByRole('heading', { name: 'This campaign moved to another tab' })).toBeInTheDocument();
    expect(dm.cancel).toHaveBeenCalled();
    expect(spies.unloadCampaign).toHaveBeenCalled();
    expect(screen.queryByRole('log', { name: 'Story so far' })).not.toBeInTheDocument();

    // Taking it back reloads the campaign and lets the DM pick up whatever the other tab left.
    vi.mocked(dm.isBusy).mockReturnValue(false);
    acquire.mockResolvedValue(fakeLock().lock);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Use this tab instead' }));
    expect(await screen.findByRole('heading', { name: 'The Drowned Lantern' })).toBeInTheDocument();
    expect(acquire).toHaveBeenLastCalledWith('camp-1', { steal: true });
    await waitFor(() => expect(dm.beginOrResume).toHaveBeenCalledTimes(2));
  });

  it('still opens the campaign if locking itself fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    seedUnloaded();
    acquire.mockRejectedValueOnce(new Error('Web Locks broke'));
    renderAt('/play/camp-1', false);
    expect(await screen.findByRole('heading', { name: 'The Drowned Lantern' })).toBeInTheDocument();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
