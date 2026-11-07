import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CompendiumEntry, HomebrewEntry } from '@/types';
import { autoCleanup, installDialogPolyfill, renderRoute } from '@/ui/shell/testUtils';
import { LibraryScreen } from './LibraryScreen';

const ATTRIBUTION =
  'This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.';

const fireball: CompendiumEntry = {
  id: 'srd:spell:fireball',
  sourceId: 'srd-5.2.1',
  sourceName: 'SRD 5.2.1',
  kind: 'spell',
  name: 'Fireball',
  summary: 'Level 3 Evocation',
  text: 'A bright streak flashes from you.',
};

vi.mock('@/data', () => ({
  SRD_ATTRIBUTION:
    'This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.',
  useRulesIndexState: vi.fn(),
  invalidateRulesIndex: vi.fn(),
  importLibraryDocument: vi.fn(),
  loadSrdManifest: () => Promise.reject(new Error('offline')),
}));
vi.mock('@/storage', () => ({
  useHomebrewList: vi.fn(),
  useCampaignList: () => [],
  useLibrarySources: () => [],
  listCampaigns: vi.fn(async () => []),
  putHomebrew: vi.fn(),
  deleteHomebrewRecord: vi.fn(),
  setLibrarySourceEnabled: vi.fn(),
  deleteLibrarySource: vi.fn(),
}));
vi.mock('@/state/gameStore', () => ({
  useGame: { getState: () => ({ campaignId: null }) },
  queueCampaignNotice: vi.fn(),
}));

const data = await import('@/data');
const storage = await import('@/storage');

autoCleanup();

const index = {
  search: () => [{ entry: fireball, score: 1, snippet: 'bright streak' }],
  get: (id: string) => (id === fireball.id ? fireball : undefined),
  findByName: () => undefined,
  list: (opts?: { kind?: string }) => (!opts?.kind || opts.kind === 'spell' ? [fireball] : []),
  sources: () => [{ id: 'srd-5.2.1', name: 'SRD 5.2.1', count: 1 }],
};

const renderLibrary = (at = '/library') => renderRoute(<LibraryScreen />, { path: '/library', at });

describe('LibraryScreen', () => {
  beforeEach(() => {
    installDialogPolyfill();
    vi.mocked(data.useRulesIndexState).mockReturnValue({ index, loading: false, error: null });
    vi.mocked(storage.useHomebrewList).mockReturnValue([]);
    vi.mocked(storage.putHomebrew).mockReset().mockResolvedValue();
  });

  it('shows the SRD attribution verbatim on the About tab', async () => {
    const user = userEvent.setup();
    renderLibrary();
    await user.click(screen.getByRole('tab', { name: /About/ }));

    const panel = screen.getByRole('tabpanel');
    expect(panel.querySelector('blockquote')?.textContent).toBe(ATTRIBUTION);
    expect(within(panel).getByText(/compatible with fifth edition/)).toBeInTheDocument();
    expect(within(panel).getByText(/not affiliated with, endorsed, sponsored or approved by Wizards/)).toBeInTheDocument();
    expect(within(panel).getByText(/converted to JSON and/)).toBeInTheDocument();
  });

  it('opens an entry from search and deep-links it with ?entry=', async () => {
    const user = userEvent.setup();
    const { router } = renderLibrary();
    await user.type(screen.getByLabelText('Search the rules'), 'fire');
    await user.click(await screen.findByRole('link', { name: /Fireball/ }));

    expect(router.state.location.search).toContain('entry=srd%3Aspell%3Afireball');
    expect(screen.getByRole('heading', { name: 'Fireball' })).toBeInTheDocument();
    expect(screen.getByText('A bright streak flashes from you.')).toBeInTheDocument();
  });

  it('shows a build error with a retry', async () => {
    vi.mocked(data.useRulesIndexState).mockReturnValue({ index: null, loading: false, error: 'SRD file missing' });
    const user = userEvent.setup();
    renderLibrary();
    expect(screen.getByText('SRD file missing')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(data.invalidateRulesIndex).toHaveBeenCalled();
  });

  it('writes new player homebrew and refreshes the rules index', async () => {
    const user = userEvent.setup();
    renderLibrary('/library?tab=homebrew');
    await user.click(screen.getByRole('button', { name: 'New homebrew' }));

    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Ember Lance');
    await user.type(within(dialog).getByLabelText('Rules text'), 'A lance of ember light.');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(storage.putHomebrew).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(storage.putHomebrew).mock.calls[0][0] as HomebrewEntry;
    expect(saved).toMatchObject({
      name: 'Ember Lance',
      kind: 'spell',
      text: 'A lance of ember light.',
      origin: 'player',
      status: 'active',
      sourceId: 'homebrew',
      campaignId: null,
    });
    expect(saved.id).toMatch(/^hb:/);
    expect(data.invalidateRulesIndex).toHaveBeenCalled();
  });
});
