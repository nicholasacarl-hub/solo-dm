import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { gloamwoodEntries, gloamwoodRecords } from '@/test/structuredFixtures';
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
const { setViewport } = await import('./testing/bookPage');
const { LibrarySourceScreen } = await import('@/ui/screens/LibrarySourceScreen');
const { useUndoToast } = await import('./UndoToast');
const { resetReviewActionsForTests } = await import('./reviewActions');
const { resetShownBooks } = await import('./detailParts');

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

  it('keeps monster stats behind "Show details" (remembered for the book)', async () => {
    const user = userEvent.setup();
    open('Glimmerwing Drake');
    expect(await screen.findAllByText(/Stats can spoil surprises/)).toHaveLength(2); // the fields and the source text
    expect(screen.queryByLabelText('HP')).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Show details' })[0]);
    expect(screen.getByLabelText('HP')).toHaveValue('52');
    expect(screen.queryByRole('button', { name: 'Show details' })).not.toBeInTheDocument(); // both panes open at once
    expect(window.sessionStorage.getItem('solo-dm:show-stats:gloam')).toBe('1');
  });

  it('compares a newer reading and takes it', async () => {
    const user = userEvent.setup();
    const choir = byName('Ashen Choir');
    replace('Ashen Choir', {
      edited: true,
      proposal: { data: { ...choir.data!, range: 'Self (30-foot cone)' } as never, warnings: [], adaptations: [], excerpts: [], origin: 'claude', createdAt: 2 },
    });
    open('Ashen Choir');
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
    expect(screen.getByRole('radio', { name: 'Fields' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'List' }));
    expect(await screen.findByRole('group', { name: 'Show' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'Ashen Choir' })).not.toBeInTheDocument();
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
