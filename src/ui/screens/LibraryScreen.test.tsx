import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { sampleCampaign } from '@/test/fixtures';
import { EXPECTED_DATA, extractionJob, gloamwoodRecords, gloamwoodSource } from '@/test/structuredFixtures';
import type { CompendiumEntry, HomebrewEntry, LibrarySource, StructuredRecord } from '@/types';
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

// Structured imports: every new name of @/data, @/storage, the game store and @/dm (shared factories).
vi.mock('@/data', async () => ({
  ...(await import('@/ui/library/structure/testing/mocks')).structuredDataMock(),
  SRD_ATTRIBUTION:
    'This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.',
  useRulesIndexState: vi.fn(),
  invalidateRulesIndex: vi.fn(),
  importLibraryDocument: vi.fn(),
  loadSrdManifest: () => Promise.reject(new Error('offline')),
}));
vi.mock('@/storage', async () => ({
  ...(await import('@/ui/library/structure/testing/mocks')).structuredStorageMock(),
  useHomebrewList: vi.fn(),
  useCampaignList: () => [],
  useLibrarySources: vi.fn(() => []),
  listLibrarySources: vi.fn(async () => []),
  listCampaigns: vi.fn(async () => []),
  putHomebrew: vi.fn(),
  deleteHomebrewRecord: vi.fn(),
  setLibrarySourceEnabled: vi.fn(),
  deleteLibrarySource: vi.fn(),
}));
vi.mock('@/state/gameStore', async () => {
  const restore = (await import('@/ui/library/structure/testing/mocks')).gameStoreRestoreMock();
  return {
    useGame: { getState: () => ({ campaignId: null, ...restore }) },
    queueCampaignNotice: vi.fn(),
  };
});
vi.mock('@/dm', async () => (await import('@/ui/library/structure/testing/mocks')).dmMock());

const data = await import('@/data');
const storage = await import('@/storage');
const dm = await import('@/dm');
const { queueCampaignNotice } = await import('@/state/gameStore');
const { useSettings } = await import('@/state/settingsStore');

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

// ---------------------------------------------------------------------------
// Structured imports: My library rows, the used-by notices, the import's done page, reviewed stats
// ---------------------------------------------------------------------------

const book = (id: string, overrides: Partial<LibrarySource> = {}): LibrarySource => ({ ...gloamwoodSource(id), id, title: `Book ${id}`, ...overrides });
const rowOf = (title: string) => screen.getByRole('link', { name: title }).closest('li') as HTMLElement;

describe('My library rows', () => {
  beforeEach(() => {
    installDialogPolyfill();
    vi.mocked(data.useRulesIndexState).mockReturnValue({ index, loading: false, error: null });
    vi.mocked(storage.useJobs).mockReturnValue([]);
    vi.mocked(storage.charactersUsingSource).mockResolvedValue([]);
    vi.mocked(storage.setLibrarySourceEnabled).mockReset().mockResolvedValue();
    vi.mocked(storage.deleteLibrarySource).mockReset().mockResolvedValue();
    vi.mocked(storage.listCampaigns).mockResolvedValue([]);
    vi.mocked(queueCampaignNotice).mockClear();
  });

  it('show each book\'s structuring status and link to its page', () => {
    const structured = book('b', {
      structure: { detectedAt: 1, parserVersion: 1, counts: { spell: { pending: 190, accepted: 300, rejected: 18 } }, needsClaude: 149 },
    });
    const running = book('c', { structure: structured.structure });
    const paused = book('d', { structure: structured.structure });
    const off = book('e', { enabled: false, structure: structured.structure });
    vi.mocked(storage.useLibrarySources).mockReturnValue([book('a'), structured, running, paused, off]);
    const counts = { queued: 133, running: 3, done: 60, failed: 2, refused: 1, skipped: 0 };
    vi.mocked(storage.useJobs).mockReturnValue([
      extractionJob({ id: 'job:c', sourceId: 'c', status: 'running', counts }),
      extractionJob({ id: 'job:d', sourceId: 'd', status: 'paused', pauseReason: 'budget', counts }),
    ]);
    renderLibrary('/library?tab=mine');

    expect(within(rowOf('Book a')).getByText('Not structured yet')).toBeInTheDocument();
    expect(within(rowOf('Book a')).getByRole('button', { name: 'Structure this book' })).toBeInTheDocument();
    expect(within(rowOf('Book b')).getByText('508 found · 41 to review · 149 not read yet')).toBeInTheDocument();
    expect(within(rowOf('Book b')).getByRole('link', { name: 'Review Book b' })).toHaveAttribute('href', '/library/source/b');
    expect(screen.getByRole('link', { name: 'Book b' })).toHaveAttribute('href', '/library/source/b');
    expect(within(rowOf('Book c')).getByText('Claude is reading: 63 of 199')).toBeInTheDocument();
    expect(within(rowOf('Book c')).getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(within(rowOf('Book d')).getByText('Paused: it reached your spending limit')).toBeInTheDocument();
    expect(within(rowOf('Book d')).getByRole('link', { name: 'Resume on the book page' })).toHaveAttribute('href', '/library/source/d');
    expect(within(rowOf('Book e')).getByText("Switched off: accepted entries aren't used")).toBeInTheDocument();
  });

  it('U7: a book whose detection found nothing says so, not "Not structured yet"', () => {
    const empty = book('n', { structure: { detectedAt: 1, parserVersion: 1, counts: {}, needsClaude: 0 } });
    vi.mocked(storage.useLibrarySources).mockReturnValue([empty]);
    renderLibrary('/library?tab=mine');
    expect(within(rowOf('Book n')).getByText('Nothing found to structure')).toBeInTheDocument();
    expect(within(rowOf('Book n')).queryByText('Not structured yet')).not.toBeInTheDocument();
    expect(within(rowOf('Book n')).queryByRole('button', { name: 'Structure this book' })).not.toBeInTheDocument();
  });

  it('U10: a pause the row can\'t resolve (limit, model, format) sends the player to the book page instead of resuming as it is', async () => {
    const user = userEvent.setup();
    vi.mocked(dm.resumeJob).mockClear();
    vi.mocked(storage.useLibrarySources).mockReturnValue([book('b'), book('m'), book('f'), book('p')]);
    vi.mocked(storage.useJobs).mockReturnValue([
      extractionJob({ id: 'job:b', sourceId: 'b', status: 'paused', pauseReason: 'budget' }),
      extractionJob({ id: 'job:m', sourceId: 'm', status: 'paused', pauseReason: 'model' }),
      extractionJob({ id: 'job:f', sourceId: 'f', status: 'paused', pauseReason: 'format' }),
      extractionJob({ id: 'job:p', sourceId: 'p', status: 'paused', pauseReason: 'player' }),
    ]);
    renderLibrary('/library?tab=mine');
    for (const id of ['b', 'm', 'f']) {
      expect(within(rowOf(`Book ${id}`)).getByRole('link', { name: 'Resume on the book page' })).toHaveAttribute('href', `/library/source/${id}`);
      expect(within(rowOf(`Book ${id}`)).queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
    }
    await user.click(within(rowOf('Book p')).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(dm.resumeJob).toHaveBeenCalledWith('job:p'));
    expect(dm.resumeJob).toHaveBeenCalledTimes(1);
  });

  it('pause and resume from the row (resuming only on a tap)', async () => {
    const user = userEvent.setup();
    vi.mocked(storage.useLibrarySources).mockReturnValue([book('c'), book('d')]);
    vi.mocked(storage.useJobs).mockReturnValue([
      extractionJob({ id: 'job:c', sourceId: 'c', status: 'running' }),
      extractionJob({ id: 'job:d', sourceId: 'd', status: 'paused', pauseReason: 'player' }),
    ]);
    renderLibrary('/library?tab=mine');
    expect(dm.resumeJob).not.toHaveBeenCalled();
    await user.click(within(rowOf('Book c')).getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(dm.pauseJob).toHaveBeenCalledWith('job:c'));
    await user.click(within(rowOf('Book d')).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(dm.resumeJob).toHaveBeenCalledWith('job:d'));
  });

  it('switching a used book off says who uses it, then tells the DMs in session', async () => {
    const user = userEvent.setup();
    const gloam = gloamwoodSource();
    vi.mocked(storage.useLibrarySources).mockReturnValue([gloam]);
    vi.mocked(storage.charactersUsingSource).mockResolvedValue([{ campaignId: 'c1', campaignName: 'The Drowned Lantern', characterName: 'Ember' }]);
    vi.mocked(storage.listCampaigns).mockResolvedValue([
      { campaign: sampleCampaign({ id: 'c1', activeSessionId: 's1' }), character: null, level: 0 },
      { campaign: sampleCampaign({ id: 'c2', activeSessionId: null }), character: null, level: 0 },
    ]);
    renderLibrary('/library?tab=mine');
    await user.click(within(rowOf(gloam.title)).getByRole('switch', { name: 'Use in rules search' }));
    const dialog = await screen.findByRole('dialog', { name: 'Switch this book off?' });
    expect(
      await within(dialog).findByText("Used by Ember (The Drowned Lantern): the sheet keeps its text; level-up and combat lose this book's data until it's back."),
    ).toBeInTheDocument();
    expect(storage.setLibrarySourceEnabled).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Switch off' }));
    await waitFor(() => expect(storage.setLibrarySourceEnabled).toHaveBeenCalledWith(gloam.id, false));
    await waitFor(() => expect(queueCampaignNotice).toHaveBeenCalledTimes(1));
    expect(vi.mocked(queueCampaignNotice).mock.calls[0]).toEqual(['c1', expect.stringContaining('switched off their book “The Gloamwood Almanac”')]);
  });

  it('a book nobody uses switches off at once; deleting still says who uses it', async () => {
    const user = userEvent.setup();
    const gloam = gloamwoodSource();
    vi.mocked(storage.useLibrarySources).mockReturnValue([gloam]);
    renderLibrary('/library?tab=mine');
    await user.click(within(rowOf(gloam.title)).getByRole('switch', { name: 'Use in rules search' }));
    await waitFor(() => expect(storage.setLibrarySourceEnabled).toHaveBeenCalledWith(gloam.id, false));

    vi.mocked(storage.charactersUsingSource).mockResolvedValue([{ campaignId: 'c1', campaignName: 'The Drowned Lantern', characterName: 'Ember' }]);
    await user.click(screen.getByRole('button', { name: `Delete ${gloam.title}` }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this import?' });
    expect(await within(dialog).findByText(/Used by Ember \(The Drowned Lantern\)/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(storage.deleteLibrarySource).toHaveBeenCalledWith(gloam.id));
  });
});

describe('the import dialog', () => {
  const imported = gloamwoodSource();

  async function importPasted(user: ReturnType<typeof userEvent.setup>) {
    vi.mocked(storage.useLibrarySources).mockReturnValue([]);
    const utils = renderLibrary('/library?tab=mine');
    await user.click(screen.getAllByRole('button', { name: /Import/ })[0]);
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Title'), 'The Gloamwood Almanac');
    await user.type(within(dialog).getByLabelText('Text'), '## Ashen Choir');
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));
    return utils;
  }

  beforeEach(() => {
    installDialogPolyfill();
    vi.mocked(data.useRulesIndexState).mockReturnValue({ index, loading: false, error: null });
    vi.mocked(data.importLibraryDocument).mockReset().mockResolvedValue(imported);
    vi.mocked(storage.listRecords).mockResolvedValue(gloamwoodRecords());
    vi.mocked(storage.findSourcesByFingerprint).mockResolvedValue([]);
  });
  afterEach(() => useSettings.setState({ mockMode: false }));

  it('looks for structured entries, then shows what it found and links to the book page', async () => {
    const user = userEvent.setup();
    const { router } = await importPasted(user);
    const done = await screen.findByRole('dialog', { name: 'Imported' });
    expect(
      within(done).getByText(
        'Imported 52 entries from “The Gloamwood Almanac”. Found 22 things the app can use: 1 class, 3 subclasses, 2 species, 2 backgrounds, 4 feats, 2 spells, 3 magic items, 2 pieces of gear, 3 monsters. 21 were read on this device; 1 needs Claude.',
      ),
    ).toBeInTheDocument();
    expect(data.detectStructure).toHaveBeenCalledWith('gloam', expect.anything());
    // The progress view's button is gone: focus is on the summary, inside the dialog.
    await waitFor(() => expect(within(done).getByText(/^Imported 52 entries from/)).toHaveFocus());
    await user.click(within(done).getByRole('button', { name: 'Review and set up' }));
    expect(router.state.location.pathname).toBe('/library/source/gloam');
    expect(router.state.location.search).toBe('?setup=1');
  });

  it('warns when the same book is already in the library', async () => {
    const user = userEvent.setup();
    const detected = await vi.mocked(data.detectStructure).getMockImplementation()!('gloam');
    vi.mocked(data.detectStructure).mockResolvedValueOnce({ ...detected, duplicateOf: { id: 'old', title: 'Gloamwood (old copy)' } });
    await importPasted(user);
    expect(await screen.findByText('This looks like the same book as “Gloamwood (old copy)”.')).toBeInTheDocument();
  });

  it('offers a pack\'s confident entries in one tap, and the ones accepted elsewhere only when ticked', async () => {
    const user = userEvent.setup();
    const pack: StructuredRecord[] = gloamwoodRecords().map((r) => ({
      ...r,
      origin: 'pack',
      ...(r.name === 'Wickwright' || r.name === 'Ashen Choir' ? { reviewedElsewhere: true as const } : {}),
    }));
    vi.mocked(storage.listRecords).mockResolvedValue(pack);
    vi.mocked(storage.setRecordStatus).mockReset().mockImplementation(async (ids: string[]) => ids.map((id) => ({ id, status: 'pending' as const })));
    await importPasted(user);
    const done = await screen.findByRole('dialog', { name: 'Imported' });
    expect(data.detectStructure).not.toHaveBeenCalledWith(imported.id, expect.anything());
    const also = within(done).getByRole('checkbox', { name: 'Also accept the 2 entries you accepted on your other device' });
    expect(also).not.toBeChecked();
    expect(within(done).getByRole('button', { name: 'Accept the 17 confident' })).toBeInTheDocument();
    await user.click(also);
    await user.click(within(done).getByRole('button', { name: 'Accept 18' }));
    await waitFor(() => expect(storage.setRecordStatus).toHaveBeenCalled());
    const [ids] = vi.mocked(storage.setRecordStatus).mock.calls[0];
    expect(ids).toContain(pack.find((r) => r.name === 'Wickwright')!.id);
    expect(ids).toHaveLength(18);
  });

  it('U14: accepting a pack\'s entries from the done page has a 10-second Undo, with focus on it', async () => {
    const user = userEvent.setup();
    const pack: StructuredRecord[] = gloamwoodRecords().map((r) => ({ ...r, origin: 'pack' }));
    vi.mocked(storage.listRecords).mockResolvedValue(pack);
    vi.mocked(storage.getRecords).mockImplementation(async (ids: string[]) => ids.map((id) => pack.find((r) => r.id === id)));
    vi.mocked(storage.setRecordStatus).mockReset().mockImplementation(async (ids: string[]) => ids.map((id) => ({ id, status: 'pending' as const })));
    await importPasted(user);
    const done = await screen.findByRole('dialog', { name: 'Imported' });
    await user.click(within(done).getByRole('button', { name: 'Accept the 17 confident' }));
    const undo = await within(done).findByRole('button', { name: 'Undo' });
    expect(within(done).getByText('Accepted 17.')).toBeInTheDocument();
    await waitFor(() => expect(undo).toHaveFocus());
    await user.click(undo);
    await waitFor(() => expect(storage.setRecordStatus).toHaveBeenCalledTimes(2));
    expect(vi.mocked(storage.setRecordStatus).mock.calls[1][1]).toBe('pending');
    // Undone: the offer is back.
    expect(await within(done).findByRole('button', { name: 'Accept the 17 confident' })).toBeInTheDocument();
  });

  it('refuses photos in demo mode', async () => {
    useSettings.setState({ mockMode: true, apiKey: 'sk-test' });
    const user = userEvent.setup();
    vi.mocked(storage.useLibrarySources).mockReturnValue([]);
    renderLibrary('/library?tab=mine');
    await user.click(screen.getAllByRole('button', { name: /Import/ })[0]);
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: /Photos/ }));
    expect(within(dialog).getByText('Demo mode makes no API calls. Turn it off in Settings to transcribe photos.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Title'), 'Pages');
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Demo mode makes no API calls. Turn it off in Settings to transcribe photos.');
    expect(data.importLibraryDocument).not.toHaveBeenCalled();
  });

  it('says where text goes, in the promises\' words', async () => {
    const user = userEvent.setup();
    vi.mocked(storage.useLibrarySources).mockReturnValue([]);
    renderLibrary('/library?tab=mine');
    await user.click(screen.getAllByRole('button', { name: /Import/ })[0]);
    expect(screen.getByText(/Text goes to Anthropic, with your API key, only when you ask: photos to transcribe, entries to structure/)).toBeInTheDocument();
    expect(screen.getByText(/Your book stays on this device\. Nothing changes your game until you've checked it\./)).toBeInTheDocument();
  });
});

describe('reviewed entries and the promises', () => {
  beforeEach(() => installDialogPolyfill());

  it("shows an accepted entry's reviewed stats with a link to its book page", () => {
    const drake: CompendiumEntry = {
      id: 'lib:gloam:47',
      sourceId: 'gloam',
      sourceName: 'The Gloamwood Almanac',
      kind: 'monster',
      name: 'Glimmerwing Drake',
      text: 'A drake.',
      data: { ...(EXPECTED_DATA['Glimmerwing Drake'] as unknown as Record<string, unknown>), recordId: 'rec:gloam:monster:glimmerwing-drake', adaptations: [] },
    };
    vi.mocked(data.useRulesIndexState).mockReturnValue({ index: { ...index, get: (id: string) => (id === drake.id ? drake : undefined) }, loading: false, error: null });
    renderLibrary(`/library?entry=${encodeURIComponent(drake.id)}`);
    const card = screen.getByRole('region', { name: 'Reviewed stats' });
    expect(within(card).getByText(/Large Dragon/)).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: "Edit it on the book's page" })).toHaveAttribute(
      'href',
      '/library/source/gloam?c=rec%3Agloam%3Amonster%3Aglimmerwing-drake&f=all',
    );
  });

  it('keeps the three promises on the About tab', async () => {
    const user = userEvent.setup();
    vi.mocked(data.useRulesIndexState).mockReturnValue({ index, loading: false, error: null });
    renderLibrary();
    await user.click(screen.getByRole('tab', { name: /About/ }));
    expect(screen.getByRole('heading', { name: 'How your books stay private' })).toBeInTheDocument();
    for (const title of ['Your book stays on this device.', "Nothing changes your game until you've checked it.", "Your campaign saves never carry your book's text."]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
  });
});
