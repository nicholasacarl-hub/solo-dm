import './testing/setup';
import { StrictMode } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dm } from '@/dm';
import { initialDmStatus, useGame } from '@/state/gameStore';
import { sampleCampaign } from '@/test/fixtures';
import { PlayScreen } from '@/ui/screens/PlayScreen';
import { resetDmMock } from './testing/dmMock';
import { fixtureState } from './testing/fakeGame';
import { seedGame, type ActionSpies } from './testing/seed';

vi.mock('@/dm', () => import('./testing/dmMock'));
vi.mock('@/engine', () => import('./testing/engineMock'));
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

beforeEach(() => {
  resetDmMock();
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
