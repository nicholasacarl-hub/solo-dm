import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { extractionJob, gloamwoodRecords, gloamwoodSource } from '@/test/structuredFixtures';
import type { LibrarySource, StructuredRecord } from '@/types';
import { autoCleanup, installDialogPolyfill, renderRoute } from '@/ui/shell/testUtils';
import type { Availability } from './RecordDetail';

vi.mock('@/dm', async () => (await import('@/ui/library/structure/testing/mocks')).dmMock());
vi.mock('@/storage', async () => (await import('@/ui/library/structure/testing/mocks')).structuredStorageMock());

const dm = await import('@/dm');
const { useSettings } = await import('@/state/settingsStore');
const { ConsentDialog, needsClaude, readHere } = await import('./ConsentDialog');
const { reviewable } = await import('./bookData');

autoCleanup();

const NEED_CLAUDE = new Set(['Wickwright', 'Glimmerwing Drake', 'Mothkin']);
// As the book page passes them: reviewable() (a gear table whose rows were read is left out).
const records: StructuredRecord[] = reviewable(
  gloamwoodRecords().map((r) =>
    NEED_CLAUDE.has(r.name) ? { ...r, data: null, warnings: [{ code: 'needs-claude', severity: 'block', message: 'Not read yet' }] } : r,
  ),
);
const idsOf = (rs: readonly StructuredRecord[]) => rs.map((r) => r.id);
/** The misses in review order: Wickwright (class), Mothkin (species), Glimmerwing Drake and Goblin Warrior (monsters). */
const misses = records.filter((r) => needsClaude(r));
const here = records.filter((r) => readHere(r));
const source = gloamwoodSource();
const otherBook: LibrarySource = { ...gloamwoodSource('book-a'), id: 'book-a', title: 'Book A' };
const ok: Availability = { ok: true };

function renderConsent(opts: { availability?: Availability; jobs?: ReturnType<typeof extractionJob>[]; scope?: Parameters<typeof ConsentDialog>[0]['scope'] } = {}) {
  const onClose = vi.fn();
  const utils = renderRoute(
    <ConsentDialog
      open
      onClose={onClose}
      source={source}
      records={records}
      jobs={opts.jobs ?? []}
      sources={[source, otherBook]}
      scope={opts.scope ?? { kind: 'all' }}
      availability={opts.availability ?? ok}
    />,
    { path: '/library/source/:sourceId', at: '/library/source/gloam' },
  );
  return { ...utils, onClose };
}

beforeEach(() => {
  installDialogPolyfill();
  useSettings.setState({ model: 'claude-opus-5-5' });
  vi.mocked(dm.estimateModels).mockClear();
  vi.mocked(dm.startJob).mockClear();
});

describe('the consent', () => {
  it('lists what will be read, with three models priced and the Settings model preselected', async () => {
    renderConsent();
    const dialog = screen.getByRole('dialog', { name: 'Read 4 entries with Claude' });
    expect(within(dialog).getByText(/Turn the rest of “The Gloamwood Almanac” into options/)).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'Monsters 2' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Feats none found' })).toBeDisabled();
    const opus = await within(dialog).findByRole('radio', { name: /Claude Opus 5\.5 · your Settings model/ });
    expect(opus).toBeChecked();
    expect(within(dialog).getByText('about $3.20 ($1.92–$5.12)')).toBeInTheDocument();
    expect(within(dialog).getByText('about $1.60 ($0.96–$2.56)')).toBeInTheDocument();
    expect(within(dialog).getByText('about $0.08 ($0.05–$0.13)')).toBeInTheDocument();
    expect(within(dialog).getByText(/Cheapest\. Check its readings more closely\./)).toBeInTheDocument();
  });

  it('suggests the high estimate rounded up as the spending limit, and shows the lifetime spend', async () => {
    renderConsent();
    await screen.findByRole('radio', { name: /Claude Opus 5\.5/ });
    expect(screen.getByLabelText('Spending limit')).toHaveValue('6');
    expect(screen.getByText(/You've spent \$4\.12 on structuring so far\./)).toBeInTheDocument();
    expect(screen.getByText(/each entry's text, one at a time, to Anthropic with your API key/)).toBeInTheDocument();
  });

  it('re-estimates when the kinds change (the ticked kinds\' entries, by id)', async () => {
    const user = userEvent.setup();
    renderConsent();
    await screen.findByRole('radio', { name: /Claude Opus 5\.5/ });
    await user.click(screen.getByRole('checkbox', { name: 'Monsters 2' }));
    await waitFor(() =>
      expect(dm.estimateModels).toHaveBeenCalledWith('gloam', { claudeFor: 'selection', recordIds: idsOf(misses.filter((r) => r.kind !== 'monster')), concurrency: 3 }),
    );
  });

  it('starts the job with the choices', async () => {
    const user = userEvent.setup();
    const { onClose } = renderConsent();
    await user.click(await screen.findByRole('radio', { name: /Claude Sonnet 5\.5/ }));
    await user.click(screen.getByRole('button', { name: /Start · about \$1\.60/ }));
    await waitFor(() => expect(dm.startJob).toHaveBeenCalledTimes(1));
    expect(dm.startJob).toHaveBeenCalledWith('gloam', {
      claudeFor: 'selection',
      recordIds: idsOf(misses),
      concurrency: 3,
      model: 'claude-sonnet-5-5',
      budgetUsd: 3,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('can also have Claude re-read what this device read, and run without a limit', async () => {
    const user = userEvent.setup();
    renderConsent();
    await screen.findByRole('radio', { name: /Claude Opus 5\.5/ });
    await user.click(screen.getByRole('checkbox', { name: /Also have Claude re-read the \d+ entries read on this device/ }));
    await user.click(screen.getByRole('checkbox', { name: 'No limit' }));
    await user.click(screen.getByRole('button', { name: /^Start/ }));
    await waitFor(() =>
      expect(dm.startJob).toHaveBeenCalledWith('gloam', expect.objectContaining({ claudeFor: 'selection', recordIds: [...idsOf(misses), ...idsOf(here)], budgetUsd: null })),
    );
  });

  it('U4: "Also re-read" covers every entry read on this device, of any kind, and prices exactly those', async () => {
    const user = userEvent.setup();
    renderConsent();
    await screen.findByRole('radio', { name: /Claude Opus 5\.5/ });
    const box = screen.getByRole('checkbox', { name: new RegExp(`Also have Claude re-read the ${here.length} entries read on this device`) });
    // Offline readings of kinds with nothing unread (spells, feats, backgrounds…) are counted and sent too.
    expect(here.some((r) => r.kind === 'spell')).toBe(true);
    await waitFor(() =>
      expect(dm.estimateModels).toHaveBeenCalledWith('gloam', { claudeFor: 'selection', recordIds: [...idsOf(misses), ...idsOf(here)], concurrency: 3 }),
    );
    // Every kind unticked: only the re-reads are left, by id; no empty kinds list reaches the job API.
    for (const name of ['Classes 1', 'Species 1', 'Monsters 2']) await user.click(screen.getByRole('checkbox', { name }));
    expect(screen.getByRole('button', { name: /^Start/ })).toBeDisabled();
    await user.click(box);
    await user.click(screen.getByRole('button', { name: /^Start/ }));
    await waitFor(() => expect(dm.startJob).toHaveBeenCalledTimes(1));
    const [, choices] = vi.mocked(dm.startJob).mock.calls[0];
    expect(choices).toMatchObject({ claudeFor: 'selection', recordIds: idsOf(here) });
    expect(choices).not.toHaveProperty('kinds');
  });

  it('U5: queues behind a reading of this same book that is under way', async () => {
    renderConsent({ jobs: [extractionJob({ id: 'job:a', sourceId: 'gloam', status: 'running' })] });
    await screen.findByRole('radio', { name: /Claude Opus 5\.5/ });
    expect(screen.getByText('Claude is still reading other entries of this book. This one starts when that finishes.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Queue it' })).toBeInTheDocument();
  });

  it('S3: "the rest" leaves out an entry Claude read without data (it needs a fix, not another paid reading)', async () => {
    const goblin = records.find((r) => r.name === 'Goblin Warrior')!;
    expect(needsClaude(goblin)).toBe(true);
    expect(needsClaude({ ...goblin, origin: 'claude', runState: 'done' })).toBe(false);
  });

  it('queues behind another book that is being structured', async () => {
    renderConsent({ jobs: [extractionJob({ id: 'job:a', sourceId: 'book-a', status: 'running' })] });
    await screen.findByRole('radio', { name: /Claude Opus 5\.5/ });
    expect(screen.getByText('Structuring “Book A” is still running. This one starts when it finishes.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Queue it' })).toBeInTheDocument();
  });

  it('explains demo mode and offers Settings instead of Start', async () => {
    renderConsent({ availability: { ok: false, reason: 'demo', message: 'Demo mode makes no API calls.' } });
    expect(screen.getByText(/Demo mode makes no API calls\. \d+ entries were read on this device; the other 4 can be filled in by hand\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Start/ })).not.toBeInTheDocument();
  });

  it('explains a missing key', () => {
    renderConsent({ availability: { ok: false, reason: 'no-key', message: 'Add an Anthropic API key in Settings to have Claude read the rest.' } });
    expect(screen.getByText('Add an Anthropic API key in Settings to have Claude read the rest.')).toBeInTheDocument();
  });

  it('reads a chosen record, with a model preselected', async () => {
    const user = userEvent.setup();
    const drake = records.find((r) => r.name === 'Glimmerwing Drake')!;
    renderConsent({ scope: { kind: 'ids', ids: [drake.id], title: 'Glimmerwing Drake', model: 'claude-haiku-5-5' } });
    expect(screen.getByRole('dialog', { name: 'Read “Glimmerwing Drake” with Claude' })).toBeInTheDocument();
    expect(await screen.findByRole('radio', { name: /Claude Haiku 5\.5/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: /^Start/ }));
    await waitFor(() =>
      expect(dm.startJob).toHaveBeenCalledWith('gloam', expect.objectContaining({ claudeFor: 'selection', recordIds: [drake.id], model: 'claude-haiku-5-5' })),
    );
  });

  it('U1: retries exactly the listed reads, under the spending limit it shows', async () => {
    const user = userEvent.setup();
    vi.mocked(dm.retryRecords).mockClear();
    renderConsent({ scope: { kind: 'ids', ids: ['rec:a', 'rec:b'], title: '2 monsters', retryJobId: 'job:fixture' } });
    await screen.findByRole('radio', { name: /Claude Opus 5\.5/ });
    expect(dm.estimateModels).toHaveBeenCalledWith('gloam', { claudeFor: 'selection', recordIds: ['rec:a', 'rec:b'], concurrency: 3 });
    const limit = screen.getByLabelText('Spending limit');
    expect(limit).toHaveValue('6');
    await user.clear(limit);
    await user.type(limit, '2');
    await user.click(screen.getByRole('button', { name: /^Start/ }));
    await waitFor(() => expect(dm.retryRecords).toHaveBeenCalledWith('job:fixture', 'both', 'claude-opus-5-5', { ids: ['rec:a', 'rec:b'], budgetUsd: 2 }));
  });
});
