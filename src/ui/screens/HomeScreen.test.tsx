import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { sampleCampaign, sampleCharacter } from '@/test/fixtures';
import { useSettings } from '@/state/settingsStore';
import type { CampaignBundle, CampaignSummary } from '@/storage';
import { autoCleanup, installDialogPolyfill, renderRoute } from '@/ui/shell/testUtils';
import { HomeScreen } from './HomeScreen';

vi.mock('@/storage', () => ({
  useCampaignList: vi.fn(),
  deleteCampaign: vi.fn(),
  duplicateCampaign: vi.fn(),
  downloadCampaign: vi.fn(),
  getCampaign: vi.fn(),
  parseCampaignBundle: vi.fn(),
  importCampaignBundle: vi.fn(),
  requestPersistentStorage: vi.fn(),
}));
vi.mock('@/state/gameStore', () => ({
  useGame: { getState: () => ({ campaignId: null, unloadCampaign: vi.fn() }) },
}));

const storage = await import('@/storage');

autoCleanup();

const DAY = 86_400_000;

function summary(overrides: Partial<CampaignSummary['campaign']> = {}, withCharacter = true): CampaignSummary {
  const campaign = sampleCampaign({ lastPlayedAt: Date.now() - 2 * DAY, sessionCount: 3, ...overrides });
  const character = withCharacter ? sampleCharacter({ campaignId: campaign.id }) : null;
  return { campaign: { ...campaign, characterId: character?.id ?? null }, character, level: character ? 3 : 0 };
}

const renderHome = () => renderRoute(<HomeScreen />, { path: '/' });

describe('HomeScreen', () => {
  beforeEach(() => {
    installDialogPolyfill();
    localStorage.clear();
    useSettings.getState().reset();
    vi.mocked(storage.useCampaignList).mockReset();
    vi.mocked(storage.deleteCampaign).mockReset().mockResolvedValue();
    vi.mocked(storage.getCampaign).mockReset();
    vi.mocked(storage.parseCampaignBundle).mockReset();
    vi.mocked(storage.importCampaignBundle).mockReset();
    vi.mocked(storage.requestPersistentStorage).mockReset().mockResolvedValue(false);
  });

  afterEach(() => {
    Reflect.deleteProperty(window.navigator, 'storage');
  });

  it('welcomes a first-time player and can switch on the demo DM', async () => {
    vi.mocked(storage.useCampaignList).mockReturnValue([]);
    const user = userEvent.setup();
    renderHome();

    expect(screen.getByRole('heading', { name: 'Welcome to the table' })).toBeInTheDocument();
    expect(screen.getByText('Claude is your DM')).toBeInTheDocument();
    expect(screen.getByText('Everything stays in this browser')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Set up my API key/ })).toHaveAttribute('href', '/settings');

    await user.click(screen.getByRole('button', { name: 'Try the demo DM (no key needed)' }));
    expect(useSettings.getState().mockMode).toBe(true);
    expect(await screen.findByTestId('location')).toHaveTextContent('/new');
  });

  it('shows a save-slot card per campaign', () => {
    vi.mocked(storage.useCampaignList).mockReturnValue([
      summary(),
      summary({ id: 'camp-2', name: 'The Salt Choir', status: 'setup', sessionCount: 0, lastPlayedAt: null }, false),
    ]);
    renderHome();

    const lantern = screen.getByRole('article', { name: 'The Drowned Lantern' });
    expect(within(lantern).getByText('Mira Voss · Elf · Wizard 3')).toBeInTheDocument();
    expect(within(lantern).getByText('3 sessions')).toBeInTheDocument();
    expect(within(lantern).getByText('Last played 2 days ago')).toBeInTheDocument();
    expect(within(lantern).getByRole('link', { name: 'Continue The Drowned Lantern' })).toHaveAttribute(
      'href',
      '/play/camp-1',
    );

    const choir = screen.getByRole('article', { name: 'The Salt Choir' });
    expect(within(choir).getByText('Setting up')).toBeInTheDocument();
    expect(within(choir).getByText('No character yet')).toBeInTheDocument();
    expect(within(choir).getByRole('link', { name: 'Continue The Salt Choir' })).toHaveAttribute(
      'href',
      '/campaign/camp-2/character',
    );
  });

  it('asks the browser to keep saves when the player continues a campaign', async () => {
    vi.mocked(storage.useCampaignList).mockReturnValue([summary()]);
    const user = userEvent.setup();
    renderHome();
    await user.click(screen.getByRole('link', { name: 'Continue The Drowned Lantern' }));
    expect(storage.requestPersistentStorage).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('location')).toHaveTextContent('/play/camp-1');
  });

  it('suggests a backup while the browser may clear saves and nothing syncs them', async () => {
    Object.defineProperty(window.navigator, 'storage', {
      configurable: true,
      value: { persisted: async () => false, persist: async () => false },
    });
    vi.mocked(storage.useCampaignList).mockReturnValue([summary()]);
    const { unmount } = renderHome();
    expect(await screen.findByText(/Saves live in this browser only/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'cloud saves in Settings' })).toHaveAttribute('href', '/settings');
    unmount();

    useSettings.getState().updateGithubSync({ enabled: true, token: 'github_pat_x', owner: 'me', repo: 'saves' });
    renderHome();
    await waitFor(() => expect(screen.getByRole('article', { name: 'The Drowned Lantern' })).toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(/Saves live in this browser only/)).not.toBeInTheDocument();
  });

  it('nudges for an API key only when play would fail', async () => {
    vi.mocked(storage.useCampaignList).mockReturnValue([summary()]);
    const user = userEvent.setup();
    renderHome();
    expect(screen.getByText('Add your Anthropic API key to play.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try demo' }));
    expect(screen.getByText('Demo DM is on.')).toBeInTheDocument();
    expect(screen.queryByText('Add your Anthropic API key to play.')).not.toBeInTheDocument();
  });

  it('confirms before deleting a campaign', async () => {
    vi.mocked(storage.useCampaignList).mockReturnValue([summary()]);
    const user = userEvent.setup();
    renderHome();

    await user.click(screen.getByRole('button', { name: 'Delete The Drowned Lantern' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/can’t be undone/)).toBeInTheDocument();
    expect(storage.deleteCampaign).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Delete campaign' }));
    await waitFor(() => expect(storage.deleteCampaign).toHaveBeenCalledWith('camp-1'));
  });

  it('asks whether to replace or copy when an imported save already exists', async () => {
    vi.mocked(storage.useCampaignList).mockReturnValue([summary()]);
    const bundle = { campaign: sampleCampaign(), exportedAt: Date.now() - DAY } as CampaignBundle;
    vi.mocked(storage.parseCampaignBundle).mockReturnValue(bundle);
    vi.mocked(storage.getCampaign).mockResolvedValue(sampleCampaign());
    vi.mocked(storage.importCampaignBundle).mockResolvedValue(sampleCampaign({ id: 'camp-copy' }));
    const user = userEvent.setup();
    const { container } = renderHome();

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(input, new File(['{"format":"solo-dm-campaign"}'], 'lantern.solodm.json', { type: 'application/json' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/already on this device/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Import as copy' }));
    await waitFor(() => expect(storage.importCampaignBundle).toHaveBeenCalledWith(bundle, 'copy'));
  });

  it('imports a new save straight away', async () => {
    vi.mocked(storage.useCampaignList).mockReturnValue([]);
    const bundle = { campaign: sampleCampaign({ id: 'fresh' }), exportedAt: Date.now() } as CampaignBundle;
    vi.mocked(storage.parseCampaignBundle).mockReturnValue(bundle);
    vi.mocked(storage.getCampaign).mockResolvedValue(undefined);
    vi.mocked(storage.importCampaignBundle).mockResolvedValue(bundle.campaign);
    const user = userEvent.setup();
    const { container } = renderHome();

    await user.upload(
      container.querySelector<HTMLInputElement>('input[type="file"]')!,
      new File(['{}'], 'fresh.solodm.json', { type: 'application/json' }),
    );
    await waitFor(() => expect(storage.importCampaignBundle).toHaveBeenCalledWith(bundle, undefined));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the page usable when the campaign list fails', () => {
    vi.mocked(storage.useCampaignList).mockImplementation(() => {
      throw new Error('IndexedDB is unavailable');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderHome();
    expect(screen.getByRole('alert')).toHaveTextContent('Your campaigns couldn’t load.');
    expect(screen.getByRole('link', { name: /New campaign/ })).toBeInTheDocument();
  });
});
