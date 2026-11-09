/**
 * The record detail's accept and save paths on the real book page (fixture records, mocked storage that
 * keeps what is written): a subclass's "Attaches to" (S1/U2), the warnings a saved edit keeps (S2), and
 * an entry Claude read without data (S3).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { gloamwoodEntries, gloamwoodRecords } from '@/test/structuredFixtures';
import type { MonsterData, RecordStatus, StructuredRecord, SubclassData } from '@/types';
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
/** The record as detection and the runner write a subclass: no parentClassId (only packs carry one). */
const withoutParent = (name: string) => {
  stored = stored.map((r) => {
    if (r.name !== name) return r;
    const { parentClassId: _none, ...rest } = r;
    return rest as StructuredRecord;
  });
  vi.mocked(storage.useRecords).mockReturnValue(stored);
};
/** The last version of a record written through putRecords. */
const written = (id: string): StructuredRecord | undefined =>
  vi.mocked(storage.putRecords).mock.calls.flatMap(([records]) => records).filter((r) => r.id === id).at(-1);

const renderPage = (search = '') =>
  renderRoute(<LibrarySourceScreen />, { path: '/library/source/:sourceId', at: `/library/source/gloam${search}` });
const open = (name: string, extra = '') => renderPage(`?c=${encodeURIComponent(byName(name).id)}${extra}`);

/** The Goblin Warrior as Claude's job leaves it: read, but its answer had no ability scores, so no data. */
const READ_WITHOUT_DATA: Partial<StructuredRecord> = {
  origin: 'claude',
  jobId: 'job:fixture',
  runState: 'done',
  modelNote: 'The stat block prints no ability scores.',
  extraction: {
    model: 'claude-opus-5-5',
    requestedModel: 'claude-opus-5-5',
    promptVersion: 1,
    at: 1,
    usage: { requests: 1, inputTokens: 900, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0.02 },
  },
  warnings: [
    { code: 'model-note', severity: 'info', message: 'Claude left a note about this entry.' },
    { code: 'missing', severity: 'block', field: 'abilities', message: "The ability scores weren't found." },
  ],
};

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
  // Storage keeps what is written, so accepting reads the saved record back.
  vi.mocked(storage.putRecords)
    .mockReset()
    .mockImplementation(async (next: StructuredRecord[]) => {
      stored = stored.map((r) => next.find((n) => n.id === r.id) ?? r);
    });
});

describe('a subclass\'s "Attaches to"', () => {
  it('S1/U2: Accept saves the pre-selected parent of a subclass stored without one, and accepts it', async () => {
    const user = userEvent.setup();
    withoutParent('Ember Warden');
    const id = byName('Ember Warden').id;
    open('Ember Warden');
    const select = await screen.findByRole('combobox', { name: /Attaches to/ });
    expect(select).toHaveValue('srd:class:fighter');
    expect(screen.getByText(/Matched the SRD Fighter\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept & next' }));
    await waitFor(() => expect(storage.setRecordStatus).toHaveBeenCalledWith([id], 'accepted'));
    // Confirming the suggestion is not an edit of the reading.
    expect(written(id)).toMatchObject({ parentClassId: 'srd:class:fighter', edited: false });
    expect(screen.queryByText('Choose the class it attaches to.')).not.toBeInTheDocument();
  });

  it('S1/U2: choosing another class and then the suggested one again still accepts it', async () => {
    const user = userEvent.setup();
    withoutParent('Order of the Long Wick');
    const order = byName('Order of the Long Wick');
    const wickwright = byName('Wickwright').publicId;
    open('Order of the Long Wick');
    const select = await screen.findByRole('combobox', { name: /Attaches to/ });
    expect(select).toHaveValue(wickwright);
    await user.selectOptions(select, 'srd:class:fighter');
    await user.selectOptions(select, wickwright);
    await user.click(screen.getByRole('button', { name: 'Accept & next' }));
    await waitFor(() => expect(storage.setRecordStatus).toHaveBeenCalledWith([order.id], 'accepted'));
    expect(written(order.id)?.parentClassId).toBe(wickwright);
  });

  it('U2: a subclass whose class the book doesn\'t name can be accepted once the player chooses it', async () => {
    const user = userEvent.setup();
    withoutParent('Ember Warden');
    const warden = byName('Ember Warden');
    replace('Ember Warden', {
      data: { ...(warden.data as SubclassData), parentClass: '' },
      warnings: [{ code: 'unresolved-ref', severity: 'block', field: 'parentClass', message: "The class this subclass belongs to isn't named: choose it." }],
    });
    open('Ember Warden');
    const accept = await screen.findByRole('button', { name: 'Accept & next' });
    expect(accept).toBeDisabled();
    expect(screen.getByText(/isn't named: choose it\./)).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: /Attaches to/ }), 'srd:class:fighter');
    await waitFor(() => expect(accept).toBeEnabled());
    expect(screen.queryByText(/isn't named: choose it\./)).not.toBeInTheDocument();
    await user.click(accept);
    await waitFor(() => expect(storage.setRecordStatus).toHaveBeenCalledWith([warden.id], 'accepted'));
    const saved = written(warden.id);
    expect(saved?.parentClassId).toBe('srd:class:fighter');
    expect(saved?.warnings.some((w) => w.code === 'unresolved-ref')).toBe(false);
  });
});

describe('the source text', () => {
  it('U13: marks a value read from a heading there, once, and says where else the words appear', async () => {
    replace('Ember Warden', { excerpts: [{ field: 'parentClassText', text: 'Fighter', grounded: true }] });
    open('Ember Warden');
    const pane = await screen.findByRole('complementary', { name: 'Source text' });
    await waitFor(() => expect(pane.querySelectorAll('mark')).toHaveLength(1));
    const mark = pane.querySelector('mark') as HTMLElement;
    expect(mark.closest('h4')).toHaveTextContent(/^Fighter.*Subclass: Ember Warden$/);
    expect(within(pane).getByText(/Used by: .* — “Fighter” \(found in 2 places; the first is marked\)/)).toBeInTheDocument();
  });
});

describe('saving an edit', () => {
  it("S2: saving a fixed HP drops the HP warnings the form stopped showing (they aren't back when it is opened again)", async () => {
    const user = userEvent.setup();
    const drake = byName('Glimmerwing Drake');
    replace('Glimmerwing Drake', {
      confidence: 'medium',
      data: { ...(drake.data as MonsterData), hp: 58 },
      warnings: [
        { code: 'ungrounded', severity: 'warn', field: 'hp', message: '“58 (8d10 + 8)” isn’t in the entry’s text: check this value.' },
        { code: 'cross-check', severity: 'warn', field: 'hp', message: "HP 58 isn't near the average of 8d10 + 8 (52)." },
      ],
    });
    open('Glimmerwing Drake');
    await user.click((await screen.findAllByRole('button', { name: 'Show details' }))[0]);
    expect(screen.getByText(/HP 58 isn't near the average/)).toBeInTheDocument();
    const hp = document.getElementById('rf-hp') as HTMLInputElement;
    await user.clear(hp);
    await user.type(hp, '52');
    await waitFor(() => expect(screen.queryByText(/HP 58 isn't near the average/)).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Accept & next' }));
    await waitFor(() => expect(storage.setRecordStatus).toHaveBeenCalledWith([drake.id], 'accepted'));
    const saved = written(drake.id);
    expect((saved?.data as MonsterData).hp).toBe(52);
    expect(saved?.edited).toBe(true);
    expect(saved?.warnings.filter((w) => w.field === 'hp')).toEqual([]);
  });

  it('S2: a monster filled in by hand after Claude could not complete it is saved without the old problem and accepted', async () => {
    const user = userEvent.setup();
    replace('Goblin Warrior', READ_WITHOUT_DATA);
    const goblin = byName('Goblin Warrior');
    open('Goblin Warrior', '&f=fix');
    await user.click(await screen.findByRole('button', { name: 'Fill in yourself' }));
    await user.click(screen.getAllByRole('button', { name: 'Show details' })[0]);
    await user.type(document.getElementById('rf-type') as HTMLInputElement, 'Fey (Goblinoid)');
    const ac = document.getElementById('rf-ac') as HTMLInputElement;
    await user.clear(ac);
    await user.type(ac, '15');
    const hp = document.getElementById('rf-hp') as HTMLInputElement;
    await user.clear(hp);
    await user.type(hp, '10');
    const accept = screen.getByRole('button', { name: 'Accept & next' });
    await waitFor(() => expect(accept).toBeEnabled());
    await user.click(accept);
    const confirm = screen.queryByRole('dialog', { name: /^Accept with/ });
    if (confirm) await user.click(within(confirm).getByRole('button', { name: 'Accept anyway' }));
    await waitFor(() => expect(storage.setRecordStatus).toHaveBeenCalledWith([goblin.id], 'accepted'));
    const saved = written(goblin.id);
    expect(saved).toMatchObject({ origin: 'manual', edited: true });
    expect(saved?.warnings.filter((w) => w.severity === 'block')).toEqual([]);
    expect(screen.queryByText('Fix 1 problem to accept.')).not.toBeInTheDocument();
  });
});

describe('an entry Claude read without data', () => {
  it('S3: is "Needs a fix" (not "Not read yet") and is not offered for another paid reading', async () => {
    const user = userEvent.setup();
    replace('Goblin Warrior', READ_WITHOUT_DATA);
    renderPage();
    const chips = await screen.findByRole('group', { name: 'Show' });
    expect(within(chips).getByRole('button', { name: 'Needs a fix 1' })).toBeInTheDocument();
    expect(within(chips).queryByRole('button', { name: /^Not read yet/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Read the rest with Claude…' })).not.toBeInTheDocument();
    expect(screen.queryByText(/not read yet/i)).not.toBeInTheDocument();

    await user.click(within(chips).getByRole('button', { name: 'Needs a fix 1' }));
    const row = screen.getByRole('link', { name: /Goblin Warrior/ });
    expect(row).toHaveTextContent('Monster · Needs a fix');
    await user.click(row);
    const article = await screen.findByRole('article', { name: 'Goblin Warrior' });
    expect(within(article).getByText(/Read by Claude Opus 5\.5/)).toBeInTheDocument();
    expect(within(article).queryByText(/Not read yet/)).not.toBeInTheDocument();
    expect(within(article).queryByText(/couldn't read it on its own/)).not.toBeInTheDocument();
    expect(within(article).getByText(/its answer is missing fields the app needs/)).toBeInTheDocument();
    expect(within(article).getByRole('button', { name: 'Fill in yourself' })).toBeInTheDocument();
    expect(within(article).getByRole('button', { name: 'Try another model' })).toBeInTheDocument();
    expect(within(article).queryByRole('button', { name: /^Read with Claude/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept & next' })).toHaveAccessibleDescription(/fill it in yourself first/);

    // Claude's note is said once, not also as "Claude left a note about this entry.".
    await user.click(within(article).getAllByRole('button', { name: 'Show details' })[0]);
    expect(within(article).getByText(/The stat block prints no ability scores\./)).toBeInTheDocument();
    expect(within(article).queryByText('Claude left a note about this entry.')).not.toBeInTheDocument();
  });
});
