import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { gloamwoodEntries, gloamwoodRecords, gloamwoodSource } from '@/test/structuredFixtures';
import type { RecordStatus, StructuredRecord } from '@/types';
import { autoCleanup, installDialogPolyfill, renderRoute } from '@/ui/shell/testUtils';

vi.mock('@/data', async () => ({
  ...(await import('@/ui/library/structure/testing/mocks')).structuredDataMock(),
  ...(await import('@/ui/library/structure/testing/bookPage')).bookPageDataExtras(),
}));
vi.mock('@/storage', async () => ({
  ...(await import('@/ui/library/structure/testing/mocks')).structuredStorageMock(),
  ...(await import('@/ui/library/structure/testing/bookPage')).bookPageStorageExtras(),
}));
vi.mock('@/state/gameStore', async () => {
  const restore = (await import('@/ui/library/structure/testing/mocks')).gameStoreRestoreMock();
  return { useGame: { getState: () => ({ campaignId: null, ...restore }) }, queueCampaignNotice: vi.fn() };
});
vi.mock('@/dm', async () => (await import('@/ui/library/structure/testing/mocks')).dmMock());

const storage = await import('@/storage');
const data = await import('@/data');
const dm = await import('@/dm');
const { gloamwoodDetection } = await import('./testing/mocks');
const { setViewport } = await import('./testing/bookPage');
const { LibrarySourceScreen } = await import('@/ui/screens/LibrarySourceScreen');
const { useUndoToast } = await import('./UndoToast');
const { resetReviewActionsForTests } = await import('./reviewActions');
const { resetShownBooks } = await import('./detailParts');
const { NameSearch } = await import('./ReviewWorkspace');

autoCleanup();

let stored: StructuredRecord[];
const byName = (name: string) => stored.find((r) => r.name === name) as StructuredRecord;
const replace = (name: string, patch: Partial<StructuredRecord>) => {
  stored = stored.map((r) => (r.name === name ? ({ ...r, ...patch } as StructuredRecord) : r));
  vi.mocked(storage.useRecords).mockReturnValue(stored);
};

const renderPage = (search = '') =>
  renderRoute(<LibrarySourceScreen />, { path: '/library/source/:sourceId', at: `/library/source/gloam${search}` });
const open = (name: string, extra = '') => renderPage(`?c=${encodeURIComponent(byName(name).id)}${extra}`);

beforeEach(() => {
  installDialogPolyfill();
  setViewport(null);
  window.sessionStorage.clear();
  resetShownBooks();
  resetReviewActionsForTests();
  useUndoToast.setState({ item: null });
  stored = gloamwoodRecords();
  vi.mocked(storage.useRecords).mockReturnValue(stored);
  vi.mocked(storage.useLibrarySources).mockReturnValue([gloamwoodSource()]);
  vi.mocked(storage.getSourceEntries).mockResolvedValue(gloamwoodEntries());
  vi.mocked(storage.getRecords).mockImplementation(async (ids: string[]) => ids.map((id) => stored.find((r) => r.id === id)));
  vi.mocked(storage.listRecords).mockImplementation(async () => stored);
  vi.mocked(storage.setRecordStatus)
    .mockReset()
    .mockImplementation(async (ids: string[], _status: RecordStatus) => ids.map((id) => ({ id, status: stored.find((r) => r.id === id)?.status ?? 'pending' })));
  vi.mocked(storage.putRecords).mockReset().mockResolvedValue();
});

afterEach(() => {
  setViewport(null);
});

describe('the review list', () => {
  it('shows filter chips with their counts and filters by them', async () => {
    const user = userEvent.setup();
    const { router } = renderPage();
    const chips = await screen.findByRole('group', { name: 'Show' });
    expect(within(chips).getByRole('button', { name: 'To review 21' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(chips).getByRole('button', { name: 'All 22' })).toBeInTheDocument();
    await user.click(within(chips).getByRole('button', { name: 'Not read yet 1' }));
    expect(router.state.location.search).toBe('?f=unread');
    const list = screen.getByRole('list', { name: 'Not read yet: 1' });
    expect(within(list).getByRole('link', { name: /Goblin Warrior/ })).toBeInTheDocument();
  });

  it('opens a record from its row (a link that pushes ?c=) and moves focus to its heading', async () => {
    const user = userEvent.setup();
    const { router } = renderPage();
    await user.click(await screen.findByRole('link', { name: /Ashen Choir/ }));
    expect(router.state.location.search).toBe(`?c=${encodeURIComponent(byName('Ashen Choir').id)}`);
    const heading = await screen.findByRole('heading', { level: 2, name: 'Ashen Choir' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByRole('link', { name: /Ashen Choir/ })).toHaveAttribute('aria-current', 'true');
  });

  it('accepts every confident entry from a confirm sheet that leaves out classes and subclasses, then undoes', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Accept 17 confident' }));
    const sheet = screen.getByRole('dialog', { name: /Accept 17 entries that were read cleanly/ });
    expect(within(sheet).getByText(/used by the builder, combat and spell lists/)).toBeInTheDocument();
    expect(within(sheet).queryByText(/class/)).toBeInTheDocument(); // the note about classes
    expect(within(sheet).queryByText(/^1 class$/)).not.toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Accept 17' }));

    await waitFor(() => expect(storage.setRecordStatus).toHaveBeenCalledTimes(1));
    const [ids, status] = vi.mocked(storage.setRecordStatus).mock.calls[0];
    expect(status).toBe('accepted');
    expect(ids).toHaveLength(17);
    expect(ids.map((id) => stored.find((r) => r.id === id)?.kind)).not.toContain('class');
    expect(ids.map((id) => stored.find((r) => r.id === id)?.kind)).not.toContain('subclass');

    const undo = await screen.findByRole('button', { name: 'Undo' });
    expect(screen.getByText(/Accepted 17\. They're in the builder, combat and spell lists now\./)).toBeInTheDocument();
    await waitFor(() => expect(undo).toHaveFocus());
    await user.click(undo);
    await waitFor(() => expect(storage.setRecordStatus).toHaveBeenCalledTimes(2));
    expect(vi.mocked(storage.setRecordStatus).mock.calls[1]).toEqual([ids, 'pending']);
  });

  it('U7: a book whose detection found nothing shows "Nothing here to structure" when opened again, not "Not structured yet"', async () => {
    vi.mocked(storage.useLibrarySources).mockReturnValue([{ ...gloamwoodSource(), structure: { detectedAt: 1, parserVersion: 1, counts: {}, needsClaude: 0 } }]);
    vi.mocked(storage.useRecords).mockReturnValue([]);
    renderPage();
    expect(await screen.findByText('Nothing here to structure')).toBeInTheDocument();
    expect(screen.queryByText('Not structured yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All entries' })).toBeInTheDocument();
  });

  it('U3: "Accept N confident" accepts exactly the entries its sheet lists (the name search and kind apply)', async () => {
    const user = userEvent.setup();
    renderPage('?q=ash');
    await user.click(await screen.findByRole('button', { name: 'Accept 1 confident' }));
    const sheet = screen.getByRole('dialog', { name: 'Accept 1 entry that was read cleanly?' });
    expect(within(sheet).getByText('1 spell')).toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Accept 1' }));
    await waitFor(() => expect(storage.setRecordStatus).toHaveBeenCalledTimes(1));
    expect(vi.mocked(storage.setRecordStatus).mock.calls[0]).toEqual([[byName('Ashen Choir').id], 'accepted']);
    expect(await screen.findByText(/^Accepted 1\./)).toBeInTheDocument();
  });

  it('U3: a clean reading whose re-read by Claude failed is listed under "Couldn\'t read" and is not "confident"', async () => {
    replace('Cinder Mote', {
      jobId: 'job:fixture',
      runState: 'failed',
      runError: { code: 'overloaded', message: 'busy', retryable: true },
      warnings: [{ code: 'failed', severity: 'info', message: 'Claude was too busy to read it.' }],
    });
    renderPage('?f=failed');
    expect(await screen.findByRole('link', { name: /Cinder Mote/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nothing confident to accept' })).toBeDisabled();
  });

  it('select mode: checkboxes, "Select all", and a bulk accept that skips what needs a fix', async () => {
    const user = userEvent.setup();
    replace('Cinder Mote', { warnings: [{ code: 'out-of-range', severity: 'block', field: 'rangeText', message: 'Range' }] });
    renderPage('?k=spell&f=all');
    await user.click(await screen.findByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Ashen Choir' }));
    const bar = screen.getByRole('region', { name: 'Selected entries' });
    expect(within(bar).getByText('1 selected')).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: 'Select all 2 in this filter' }));
    expect(within(bar).getByText('2 selected')).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: /Set classes/ })).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(storage.setRecordStatus).toHaveBeenCalledWith([byName('Ashen Choir').id], 'accepted'));
    expect(await screen.findByText(/Accepted 1\..*1 needs a fix first\./)).toBeInTheDocument();
  });
});

describe('after the offline reader improved', () => {
  it('"Re-check" looks through the book again, says what changed, and can undo moving accepted entries back to review', async () => {
    const user = userEvent.setup();
    replace("Moth's Grace", { parserVersion: 1, status: 'accepted' });
    replace('Lantern Bearer', { parserVersion: 1 });
    const grace = byName("Moth's Grace");
    vi.mocked(data.detectStructure).mockResolvedValueOnce({ ...gloamwoodDetection(), removed: { feat: 1 }, doubted: [{ id: grace.id, kind: 'feat', status: 'accepted' }] });
    renderPage();
    const banner = (await screen.findByText('The offline reader improved: re-check 2 entries for free.')).parentElement as HTMLElement;
    await user.click(within(banner).getByRole('button', { name: 'Re-check' }));
    await waitFor(() => expect(data.detectStructure).toHaveBeenCalledWith('gloam', expect.objectContaining({ onProgress: expect.any(Function) })));
    expect(storage.setRecordStatus).toHaveBeenCalledWith([grace.id], 'pending');
    expect(await screen.findByText(/Removed 1 feat an earlier version of the reader found by mistake \(you hadn't reviewed them\)\. 1 entry you had accepted doesn't look like a feat: it's back in To review, with a note\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(storage.setRecordStatus).toHaveBeenLastCalledWith([grace.id], 'accepted'));
  });
});

describe('the name search', () => {
  it('keeps every key typed while the URL catches up, and follows a change made elsewhere', async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    const { rerender } = render(<NameSearch q="" onSearch={onSearch} />);
    const box = screen.getByRole('searchbox', { name: 'Search names' });
    await user.type(box, 'Ashen');
    expect(box).toHaveValue('Ashen');
    expect(onSearch).toHaveBeenLastCalledWith('Ashen');
    rerender(<NameSearch q="As" onSearch={onSearch} />); // the router handing back an earlier key
    expect(box).toHaveValue('Ashen');
    rerender(<NameSearch q="Ashen" onSearch={onSearch} />);
    expect(box).toHaveValue('Ashen');
    rerender(<NameSearch q="Wick" onSearch={onSearch} />); // Back, or a link
    expect(box).toHaveValue('Wick');
  });
});

describe('reads that failed', () => {
  it('"Retry N" on the Couldn\'t read chip opens the consent and retries them in their job', async () => {
    const user = userEvent.setup();
    replace('Ashen Choir', { jobId: 'job:fixture', runState: 'failed', runError: { code: 'invalid-output', message: 'x', retryable: true } });
    replace('Cinder Mote', { jobId: 'job:fixture', runState: 'refused' });
    renderPage('?f=failed');
    await user.click(await screen.findByRole('button', { name: 'Retry 2' }));
    const consent = await screen.findByRole('dialog', { name: 'Read 2 entries with Claude' });
    await within(consent).findByRole('radio', { name: /Claude Opus 5\.5/ }); // the estimates are in
    await user.click(within(consent).getByRole('button', { name: /^Start/ }));
    await waitFor(() =>
      expect(dm.retryRecords).toHaveBeenCalledWith('job:fixture', 'both', 'claude-opus-5-5', {
        ids: [byName('Ashen Choir').id, byName('Cinder Mote').id],
        budgetUsd: 6,
      }),
    );
  });

  it('U1: "Retry N" with the list narrowed to one kind retries only the reads it lists', async () => {
    const user = userEvent.setup();
    replace('Ashen Choir', { jobId: 'job:fixture', runState: 'failed', runError: { code: 'overloaded', message: 'busy', retryable: true } });
    replace('Glimmerwing Drake', { jobId: 'job:fixture', runState: 'failed', runError: { code: 'overloaded', message: 'busy', retryable: true } });
    renderPage('?f=failed&k=monster');
    await user.click(await screen.findByRole('button', { name: 'Retry 1' }));
    const consent = await screen.findByRole('dialog', { name: 'Read “Glimmerwing Drake” with Claude' });
    await within(consent).findByRole('radio', { name: /Claude Opus 5\.5/ });
    expect(within(consent).getByLabelText('Spending limit')).toBeInTheDocument();
    await user.click(within(consent).getByRole('button', { name: /^Start/ }));
    await waitFor(() => expect(dm.retryRecords).toHaveBeenCalledWith('job:fixture', 'both', 'claude-opus-5-5', { ids: [byName('Glimmerwing Drake').id], budgetUsd: 6 }));
  });
});

describe('the record detail', () => {
  it('disables Accept while a problem blocks it, and says why', async () => {
    replace('Ashen Choir', { warnings: [{ code: 'out-of-range', severity: 'block', field: 'areaText', message: 'The area is too large.' }] });
    open('Ashen Choir');
    const accept = await screen.findByRole('button', { name: 'Accept & next' });
    expect(accept).toBeDisabled();
    expect(accept).toHaveAccessibleDescription('Fix 1 problem to accept.');
    expect(screen.getByText('The area is too large.')).toBeInTheDocument();
  });

  it('asks before accepting with things to check', async () => {
    const user = userEvent.setup();
    replace('Ashen Choir', { confidence: 'medium', warnings: [{ code: 'cross-check', severity: 'warn', field: 'levelText', message: 'Level 2 vs "3rd-level".' }] });
    open('Ashen Choir');
    await user.click(await screen.findByRole('button', { name: 'Accept & next' }));
    const confirm = screen.getByRole('dialog', { name: 'Accept with 1 thing to check?' });
    expect(within(confirm).getByText('Level 2 vs "3rd-level".')).toBeInTheDocument();
    expect(storage.setRecordStatus).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Accept anyway' }));
    await waitFor(() => expect(storage.setRecordStatus).toHaveBeenCalledWith([byName('Ashen Choir').id], 'accepted'));
  });

  it('Ctrl+Enter accepts from inside a field, opens the next record, focuses it and says so', async () => {
    const user = userEvent.setup();
    const { router } = open('Ashen Choir', '&k=spell');
    const range = await screen.findByLabelText('Range');
    await user.click(range);
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(storage.setRecordStatus).toHaveBeenCalledWith([byName('Ashen Choir').id], 'accepted'));
    await waitFor(() => expect(router.state.location.search).toContain(encodeURIComponent(byName('Cinder Mote').id)));
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Cinder Mote' })).toHaveFocus());
    await waitFor(() => expect(screen.getByText('Accepted Ashen Choir. Now: Cinder Mote, 1 of 1.')).toBeInTheDocument());
  });

  it('accepting the last record of a filter says so and puts focus on that filter, not the page body', async () => {
    const user = userEvent.setup();
    open('Ashen Choir', '&q=Ashen');
    const range = await screen.findByLabelText('Range');
    await user.click(range);
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(screen.getByText('Accepted Ashen Choir. Nothing else in this list.')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: /^To review/ })).toHaveFocus());
    expect(screen.queryByRole('heading', { level: 2, name: 'Ashen Choir' })).not.toBeInTheDocument();
  });

  it('Alt+↓ / ↑ step through the list from the source text too, and the pager names its shortcuts', async () => {
    const user = userEvent.setup();
    const { router } = open('Ashen Choir', '&k=spell&f=all');
    const excerpts = await screen.findByRole('radio', { name: 'Excerpts' });
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-keyshortcuts', 'Alt+ArrowDown');
    expect(screen.getByRole('button', { name: 'Accept & next' })).toHaveAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter');
    await user.click(excerpts);
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() => expect(router.state.location.search).toContain(encodeURIComponent(byName('Cinder Mote').id)));
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Cinder Mote' })).toHaveFocus());
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Ashen Choir' })).toHaveFocus());
  });

  it('Alt+1 / Alt+2 switch between the fields and the source text on mid widths', async () => {
    setViewport(1100);
    const user = userEvent.setup();
    open('Ashen Choir');
    const fields = await screen.findByRole('radio', { name: 'Fields' });
    expect(screen.getByRole('radio', { name: 'Source text' })).toHaveAttribute('aria-keyshortcuts', 'Alt+2');
    await user.click(screen.getByLabelText('Range'));
    await user.keyboard('{Alt>}2{/Alt}');
    expect(screen.getByRole('radio', { name: 'Source text' })).toBeChecked();
    expect(screen.queryByLabelText('Range')).not.toBeInTheDocument();
    screen.getByRole('radio', { name: 'Source text' }).focus();
    await user.keyboard('{Alt>}1{/Alt}');
    expect(fields).toBeChecked();
    expect(screen.getByLabelText('Range')).toBeInTheDocument();
  });

  it('keeps monster stats behind "Show details" (remembered for the book)', async () => {
    const user = userEvent.setup();
    open('Glimmerwing Drake');
    expect(await screen.findAllByText(/Stats can spoil surprises/)).toHaveLength(2); // the fields and the source text
    expect(screen.queryByLabelText('HP')).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Show details' })[0]);
    expect(screen.getByLabelText('HP')).toHaveValue('52');
    expect(screen.queryByRole('button', { name: 'Show details' })).not.toBeInTheDocument(); // both panes open at once
    expect(window.sessionStorage.getItem('solo-dm:show-stats:gloam')).toBe('1');
    // The button that had focus is gone: focus is on the record's heading, not the page body.
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Glimmerwing Drake' })).toHaveFocus());
  });

  it('compares a newer reading and takes it', async () => {
    const user = userEvent.setup();
    const choir = byName('Ashen Choir');
    replace('Ashen Choir', {
      edited: true,
      proposal: { data: { ...choir.data!, range: 'Self (30-foot cone)' } as never, warnings: [], adaptations: [], excerpts: [], origin: 'claude', createdAt: 2 },
    });
    const { router } = open('Ashen Choir');
    const diff = await screen.findByRole('region', { name: 'A newer reading is waiting' });
    const row = within(diff).getByRole('row', { name: /Range/ });
    expect(within(row).getByText('Self (15-foot cone)')).toBeInTheDocument();
    expect(within(row).getByText('Self (30-foot cone)')).toBeInTheDocument();
    await user.click(within(diff).getByRole('button', { name: 'Use new' }));
    await waitFor(() => expect(storage.putRecords).toHaveBeenCalled());
    const [[saved]] = vi.mocked(storage.putRecords).mock.calls[0];
    expect(saved).toMatchObject({ edited: false, origin: 'claude' });
    expect((saved.data as { range: string }).range).toBe('Self (30-foot cone)');
    expect(saved.proposal).toBeUndefined();
    // The stored record comes back without the proposal: its buttons go, and focus moves to Accept & next.
    replace('Ashen Choir', { ...saved, proposal: undefined, updatedAt: saved.updatedAt + 1 });
    // (useRecords is a plain mock: an unknown query parameter makes the page render again and read it.)
    const { pathname, search } = router.state.location;
    await act(() => router.navigate(`${pathname}${search}&refresh=1`, { replace: true }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'A newer reading is waiting' })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Accept & next' })).toHaveFocus());
  });

  it('says when the text changed, and can keep the fields', async () => {
    const user = userEvent.setup();
    replace('Ashen Choir', { warnings: [{ code: 'stale-text', severity: 'warn', message: 'The text changed since this was read.' }] });
    open('Ashen Choir');
    expect(await screen.findByText('The text changed since this was read.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-read' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep these fields' }));
    await waitFor(() => expect(storage.putRecords).toHaveBeenCalled());
    expect(vi.mocked(storage.putRecords).mock.calls[0][0][0].warnings).toEqual([]);
  });

  it('moves an accepted record back to review', async () => {
    const user = userEvent.setup();
    replace('Ashen Choir', { status: 'accepted' });
    open('Ashen Choir', '&f=used');
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move back to review' }));
    await waitFor(() => expect(storage.setRecordStatus).toHaveBeenCalledWith([byName('Ashen Choir').id], 'pending'));
  });

  it('offers "Fill in yourself" for a record the device could not read', async () => {
    const user = userEvent.setup();
    open('Goblin Warrior', '&f=unread');
    expect(await screen.findByText(/Not read yet\./)).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Fill in yourself' })[0]);
    await user.click(screen.getAllByRole('button', { name: 'Show details' })[0]);
    expect(screen.getByLabelText('AC')).toHaveValue('10');
    expect(screen.getByRole('button', { name: 'Accept & next' })).toBeDisabled();
  });
});

describe('on a phone', () => {
  it('shows the list, then the record full screen, and Back returns to the list', async () => {
    setViewport(390);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('link', { name: /Ashen Choir/ }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Ashen Choir' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Show' })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Fields' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Fields' })).toHaveAttribute('aria-keyshortcuts', 'Alt+1');
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'List' }));
    expect(await screen.findByRole('group', { name: 'Show' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'Ashen Choir' })).not.toBeInTheDocument();
    // Focus comes back to the row it left from, not the page body.
    await waitFor(() => expect(screen.getByRole('link', { name: /Ashen Choir/ })).toHaveFocus());
  });

  it('U6: "List" after Browse\'s "Edit it on the book\'s page" (a pushed deep link) stays on the book page', async () => {
    setViewport(390);
    const router = createMemoryRouter(
      [
        { path: '/library/source/:sourceId', element: <LibrarySourceScreen /> },
        { path: '*', element: <p>elsewhere</p> },
      ],
      { initialEntries: ['/library?tab=browse&entry=lib:gloam:51', `/library/source/gloam?c=${encodeURIComponent(byName('Glimmerwing Drake').id)}&f=all`], initialIndex: 1 },
    );
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'List' }));
    await waitFor(() => expect(router.state.location.search).toBe('?f=all'));
    expect(router.state.location.pathname).toBe('/library/source/gloam');
    expect(await screen.findByRole('group', { name: 'Show' })).toBeInTheDocument();
  });

  it('U6: "List" after All entries › Structure as… (which replaces the URL) stays on the book page', async () => {
    setViewport(390);
    const data = await import('@/data');
    vi.mocked(data.structureEntryAs).mockResolvedValue(byName('Wickwright'));
    const router = createMemoryRouter(
      [
        { path: '/library/source/:sourceId', element: <LibrarySourceScreen /> },
        { path: '*', element: <p>elsewhere</p> },
      ],
      { initialEntries: ['/library?tab=mine', '/library/source/gloam?view=entries'], initialIndex: 1 },
    );
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: /Structure as…/ }))[0]);
    await user.click(await screen.findByRole('menuitem', { name: 'Class' }));
    await waitFor(() => expect(router.state.location.search).toContain('c='));
    await user.click(await screen.findByRole('button', { name: 'List' }));
    await waitFor(() => expect(router.state.location.search).not.toContain('c='));
    expect(router.state.location.pathname).toBe('/library/source/gloam');
  });

  it('U6: a row opened from the list, then Next, still goes Back to that list in one step', async () => {
    setViewport(390);
    const router = createMemoryRouter([{ path: '/library/source/:sourceId', element: <LibrarySourceScreen /> }, { path: '*', element: <p>elsewhere</p> }], {
      initialEntries: ['/library?tab=mine', '/library/source/gloam?k=spell'],
      initialIndex: 1,
    });
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: /Ashen Choir/ }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() => expect(router.state.location.search).toContain(encodeURIComponent(byName('Cinder Mote').id)));
    await user.click(screen.getByRole('button', { name: 'List' }));
    await waitFor(() => expect(router.state.location.search).toBe('?k=spell'));
    expect(router.state.historyAction).toBe('POP');
  });

  it('switches between the fields and the source text', async () => {
    setViewport(390);
    const user = userEvent.setup();
    open('Ashen Choir');
    await user.click(await screen.findByRole('radio', { name: 'Source text' }));
    expect(screen.getByRole('heading', { name: 'Source text' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Range')).not.toBeInTheDocument();
    await act(async () => undefined);
  });
});
