import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import userEvent from '@testing-library/user-event';
import { extractionJob, gloamwoodRecords, gloamwoodSource } from '@/test/structuredFixtures';
import type { ExtractionJob, LibrarySource, PauseReason, StructuredRecord } from '@/types';
import { autoCleanup, installDialogPolyfill, renderRoute } from '@/ui/shell/testUtils';
import type { Availability } from './RecordDetail';

vi.mock('@/dm', async () => (await import('@/ui/library/structure/testing/mocks')).dmMock());

const dm = await import('@/dm');
const { IDLE_RUNNER_SNAPSHOT: IDLE_RUNNER } = await import('./testing/mocks');
const { StructureAnnouncer, StructureStatusCard, nextCheaperModel, pausedKind } = await import('./StructureStatusCard');
const { currentJob } = await import('./bookData');

autoCleanup();

const source = gloamwoodSource();
const bookA: LibrarySource = { ...gloamwoodSource('book-a'), id: 'book-a', title: 'Book A' };
const records = gloamwoodRecords();
const ids = (...names: string[]) => names.map((n) => (records.find((r) => r.name === n) as StructuredRecord).id);
const usage = (usd: number, requests = 63) => ({ requests, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: usd });
const counts = { queued: 133, running: 3, done: 60, failed: 2, refused: 1, skipped: 0 };
const estimate = { ...extractionJob().estimate, requests: 199, usd: 3.2, usdLow: 1.92, usdHigh: 5.12 };
const ok: Availability = { ok: true };

function renderCard(job: ExtractionJob, opts: { runner?: Partial<typeof IDLE_RUNNER>; jobs?: ExtractionJob[]; availability?: Availability; onRetry?: () => void } = {}) {
  const runner = { ...IDLE_RUNNER, ...opts.runner };
  const props = {
    source,
    jobs: opts.jobs ?? [job],
    runner,
    records,
    sources: [source, bookA],
    availability: opts.availability ?? ok,
    onRetry: opts.onRetry ?? vi.fn(),
    onReview: vi.fn(),
  };
  const utils = render(
    <MemoryRouter>
      <StructureStatusCard {...props} />
    </MemoryRouter>,
  );
  const rerender = (patch: Partial<typeof props>) =>
    utils.rerender(
      <MemoryRouter>
        <StructureStatusCard {...props} {...patch} />
      </MemoryRouter>,
    );
  return { ...utils, rerender, props };
}

beforeEach(() => {
  installDialogPolyfill();
  window.localStorage.clear();
  for (const fn of [dm.pauseJob, dm.resumeJob, dm.cancelJob]) vi.mocked(fn).mockClear();
});

afterEach(() => vi.useRealTimers());

describe('while Claude reads', () => {
  const running = extractionJob({ status: 'running', counts, usage: usage(1.05), estimate });
  const live = { activeJobId: running.id, spentUsd: 1.05, projectedUsd: 3.2, etaMinutes: 9, inFlight: ids('Ember Warden', 'Mothkin', 'Ashen Choir') };

  it('says how far it is, what it costs and what is being read', () => {
    renderCard(running, { runner: live });
    expect(screen.getByText('Reading with Claude Opus 5.5 · 63 of 199 · $1.05 so far · about $3.20 in all · about 9 minutes left')).toBeInTheDocument();
    expect(screen.getByText('Now reading: Ember Warden, Mothkin, Ashen Choir')).toBeInTheDocument();
    expect(screen.getByText(/nothing is used until you accept it/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Structuring progress' })).toHaveAttribute('aria-valuetext', '63 of 199 read');
  });

  it('says why it is holding', () => {
    const { unmount } = renderCard(running, { runner: { ...live, hold: 'dm-turn' } });
    expect(screen.getByText('Waiting while the DM replies.')).toBeInTheDocument();
    unmount();
    const second = renderCard(running, { runner: { ...live, hold: 'hidden' } });
    expect(screen.getByText('Paused while this tab is in the background.')).toBeInTheDocument();
    second.unmount();
    renderCard(running, { runner: { ...live, waitingUntil: Date.now() + 40_000, cacheWarnings: ['spell'] } });
    expect(screen.getByText(/Claude asked us to slow down\. Continuing in (40|39) s\./)).toBeInTheDocument();
    expect(screen.getByText("Caching isn't working for spells; this may cost more than estimated.")).toBeInTheDocument();
  });

  it('announces progress politely, at most every 15 s or 25 records', () => {
    vi.useFakeTimers();
    const { rerender } = renderCard(running, { runner: live });
    const region = () => screen.getByRole('status').textContent;
    expect(region()).toBe('63 of 199 read.');
    const at = (done: number) => ({ ...running, counts: { ...counts, done, queued: counts.queued - (done - 60) } });
    rerender({ jobs: [at(70)] });
    expect(region()).toBe('63 of 199 read.');
    act(() => vi.advanceTimersByTime(16_000));
    rerender({ jobs: [at(71)] });
    expect(region()).toBe('74 of 199 read.');
    rerender({ jobs: [at(99)] });
    expect(region()).toBe('102 of 199 read.');
  });

  it('pauses, and asks before cancelling', async () => {
    const user = userEvent.setup();
    renderCard(running, { runner: live });
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(dm.pauseJob).toHaveBeenCalledWith(running.id);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const confirm = screen.getByRole('dialog', { name: 'Stop now?' });
    expect(within(confirm).getByText(/3 entries being read will be stopped, and you may still be charged for them\. Everything already read is kept\./)).toBeInTheDocument();
    expect(dm.cancelJob).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Stop' }));
    expect(dm.cancelJob).toHaveBeenCalledWith(running.id);
  });

  it('says it is pausing while in-flight entries finish', () => {
    renderCard({ ...running, status: 'pausing' }, { runner: live });
    expect(screen.getByText('Pausing… finishing 3 entries already being read.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
  });
});

describe('when paused', () => {
  const paused = (pauseReason: PauseReason, patch: Partial<ExtractionJob> = {}) =>
    extractionJob({ status: 'paused', pauseReason, counts: { ...counts, running: 0, queued: 136 }, usage: usage(1.05), estimate, budgetUsd: 6, ...patch });

  it('by the player: resume or cancel', async () => {
    const user = userEvent.setup();
    renderCard(paused('player'));
    expect(screen.getByText(/^Paused\. \$1\.05 spent · 136 entries left, about \$2\.27 more\.$/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(dm.resumeJob).toHaveBeenCalledWith('job:fixture', undefined);
  });

  it('at the spending limit: raise it, drop it, or stop', async () => {
    const user = userEvent.setup();
    renderCard(paused('budget', { usage: usage(5.97) }));
    expect(screen.getByText(/^Paused at your \$6 limit\. \$5\.97 spent · 136 left/)).toBeInTheDocument();
    const raise = screen.getByRole('button', { name: /^Raise the limit to \$\d+ and resume$/ });
    await user.click(raise);
    const budget = Number(/\$(\d+)/.exec(raise.textContent ?? '')?.[1]);
    expect(dm.resumeJob).toHaveBeenLastCalledWith('job:fixture', { budgetUsd: budget });
    expect(budget).toBeGreaterThan(6);
    await user.click(screen.getByRole('button', { name: 'Resume without a limit' }));
    expect(dm.resumeJob).toHaveBeenLastCalledWith('job:fixture', { budgetUsd: null });
    await user.click(screen.getByRole('button', { name: 'Stop here' }));
    expect(dm.cancelJob).toHaveBeenCalledWith('job:fixture');
  });

  it.each([
    ['reload', /^Paused when the page closed\. 1 entry that was being read was lost; its cost isn't counted\./, ['Resume', 'Stop here']],
    ['offline', /^You're offline\. Structuring continues when you're back online\.$/, ['Stop here']],
    ['rate-limit', /^Claude kept asking us to slow down\.$/, ['Resume', 'Resume with this model', 'Stop here']],
    ['auth', /^Claude rejected your API key\. Fix it in Settings, then resume\.$/, ['Resume']],
    ['storage', /^This browser is out of storage space for Solo DM\. Free some space, then resume\.$/, ['Resume']],
    ['other-tab', /^Structuring is running in another tab\.$/, []],
  ] as const)('because of %s: says so and offers what helps', (reason, text, buttons) => {
    renderCard(paused(reason, reason === 'reload' ? { interrupted: 1 } : {}));
    expect(screen.getByText(text)).toBeInTheDocument();
    for (const b of buttons) expect(screen.getByRole('button', { name: b })).toBeInTheDocument();
    if (reason === 'auth') expect(screen.getByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', '/settings');
    if (reason === 'other-tab') expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
  });

  it("because the key can't use the model: resume with another", async () => {
    const user = userEvent.setup();
    renderCard(paused('model', { pauseMessage: 'Not available on your plan.' }));
    expect(screen.getByText("Your key can't use Claude Opus 5.5. Not available on your plan.")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'claude-haiku-5-5');
    await user.click(screen.getByRole('button', { name: 'Resume with this model' }));
    expect(dm.resumeJob).toHaveBeenCalledWith('job:fixture', { model: 'claude-haiku-5-5' });
  });

  it('because a reading format was refused: skip that kind', async () => {
    const user = userEvent.setup();
    renderCard(paused('format', { pauseMessage: "Claude couldn't use the reading format for spells: schema too complex." }));
    expect(screen.getByText("Claude couldn't use the reading format for spells: schema too complex.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Skip spells and resume' }));
    expect(dm.resumeJob).toHaveBeenCalledWith('job:fixture', { skipKinds: ['spell'] });
    expect(pausedKind('the reading format for magic items: x')).toBe('magic-item');
    expect(pausedKind(undefined)).toBeNull();
  });

  it('U11: "Resume with this model" starts at a cheaper model and shows what the rest costs there', async () => {
    const user = userEvent.setup();
    vi.mocked(dm.estimateJob).mockClear();
    const queued = records.filter((r) => r.name === 'Mothkin' || r.name === 'Wickwright').map((r) => ({ ...r, jobId: 'job:fixture', runState: 'queued' as const }));
    const withQueued = records.map((r) => queued.find((q) => q.id === r.id) ?? r);
    const job = paused('model', { model: 'claude-sonnet-5-5' });
    render(
      <MemoryRouter>
        <StructureStatusCard source={source} jobs={[job]} runner={IDLE_RUNNER} records={withQueued} sources={[source]} availability={ok} onRetry={vi.fn()} onReview={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('claude-haiku-5-5');
    expect(await screen.findByText('about $3.20 for the 136 left')).toBeInTheDocument();
    expect(dm.estimateJob).toHaveBeenLastCalledWith('gloam', { claudeFor: 'selection', recordIds: queued.map((r) => r.id), model: 'claude-haiku-5-5', concurrency: 3 });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'claude-opus-5-5');
    await waitFor(() => expect(dm.estimateJob).toHaveBeenLastCalledWith('gloam', expect.objectContaining({ model: 'claude-opus-5-5' })));
    expect(nextCheaperModel('claude-opus-5-5')).toBe('claude-sonnet-5-5');
    expect(nextCheaperModel('claude-haiku-5-5')).toBe('claude-sonnet-5-5'); // nothing is cheaper: the cheapest other one
    expect(nextCheaperModel('claude-opus-5')).toBe('claude-sonnet-5-5'); // a custom id is priced at Opus rates
  });

  it('U12: "Skip … and resume" reads the kind from the app\'s words, not from the API message', () => {
    expect(pausedKind("Claude couldn't use the reading format for spells: output_config.format.schema: properties.classesText: unsupported keyword")).toBe('spell');
    expect(pausedKind("Claude couldn't use the reading format for pieces of gear: x")).toBe('item');
    expect(pausedKind('Something else about classes.')).toBeNull();
  });

  it('in demo mode it can not resume', () => {
    renderCard(paused('player'), { availability: { ok: false, reason: 'demo', message: 'Demo mode makes no API calls.' } });
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
    expect(screen.getByText('Demo mode makes no API calls.')).toBeInTheDocument();
  });
});

describe('several jobs of one book', () => {
  it('U5: the job being read keeps its card, Pause and Cancel while a newer one of the same book waits', async () => {
    const user = userEvent.setup();
    const reading = extractionJob({ id: 'job:A', status: 'running', counts: { ...counts, queued: 6, running: 0, done: 4, failed: 0, refused: 0 }, createdAt: 1000 });
    const waiting = extractionJob({ id: 'job:B', status: 'queued', createdAt: 2000 });
    expect(currentJob([reading, waiting], 'gloam').live?.id).toBe('job:A');
    expect(currentJob([waiting, extractionJob({ id: 'job:C', status: 'paused', createdAt: 3000 })], 'gloam').live?.id).toBe('job:B');
    renderCard(reading, { jobs: [reading, waiting], runner: { activeJobId: 'job:A' } });
    const [first, second] = screen.getAllByRole('region', { name: 'Structuring' });
    expect(within(first).getByText(/^Reading with Claude Opus 5\.5 · 4 of 10/)).toBeInTheDocument();
    await user.click(within(first).getByRole('button', { name: 'Pause' }));
    expect(dm.pauseJob).toHaveBeenCalledWith('job:A');
    // The waiting one is still listed, and can still be cancelled on its own.
    expect(within(second).getByText("Waiting for this book's current reading to finish (4/10).")).toBeInTheDocument();
    await user.click(within(first).getByRole('button', { name: 'Cancel' }));
    const confirm = screen.getByRole('dialog', { name: 'Stop now?' });
    await user.click(within(confirm).getByRole('button', { name: 'Stop' }));
    expect(dm.cancelJob).toHaveBeenCalledWith('job:A');
  });
});

describe('the status announcement', () => {
  const announcer = (jobs: ExtractionJob[]) => <StructureAnnouncer sourceId="gloam" jobs={jobs} />;
  const region = () => screen.getByRole('status');

  it('U8: says when a job pauses, finishes or stops, and nothing on first render', async () => {
    const running = extractionJob({ status: 'running', counts, usage: usage(1.05), estimate, budgetUsd: 6 });
    const { rerender } = render(announcer([running]));
    expect(region()).toHaveTextContent('');
    rerender(announcer([{ ...running, counts: { ...counts, done: 61 } }]));
    expect(region()).toHaveTextContent('');
    rerender(announcer([{ ...running, status: 'paused', pauseReason: 'budget' }]));
    await waitFor(() => expect(region()).toHaveTextContent('Structuring paused at your $6 limit.'));
    rerender(announcer([{ ...running, status: 'running' }]));
    rerender(announcer([{ ...running, status: 'done', counts: { ...counts, queued: 0, running: 0, done: 196 } }]));
    await waitFor(() => expect(region()).toHaveTextContent("Structuring finished: 199 read, 3 couldn't be read."));
    // Another book's jobs are not this page's news.
    rerender(announcer([{ ...running, status: 'done', counts: { ...counts, queued: 0, running: 0, done: 196 } }, extractionJob({ id: 'job:x', sourceId: 'book-a', status: 'cancelled' })]));
    expect(region()).toHaveTextContent("Structuring finished: 199 read, 3 couldn't be read.");
  });

  it('U8: works without the cards (a phone hides them while a record is open): a pause the player made', async () => {
    const { rerender } = render(announcer([extractionJob({ status: 'running', counts })]));
    rerender(announcer([extractionJob({ status: 'paused', pauseReason: 'player', counts })]));
    await waitFor(() => expect(region()).toHaveTextContent('Structuring paused: you paused it.'));
  });
});

describe('waiting and done', () => {
  it('waits behind another book', async () => {
    const user = userEvent.setup();
    const mine = extractionJob({ status: 'queued' });
    const other = extractionJob({ id: 'job:a', sourceId: 'book-a', status: 'running', counts });
    renderCard(mine, { jobs: [mine, other] });
    expect(screen.getByText('Waiting for “Book A” to finish (63/199).')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(dm.cancelJob).toHaveBeenCalledWith(mine.id);
  });

  it('collapses to one line with what is left to do', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const done = extractionJob({ id: 'job:done', status: 'done', counts: { ...counts, queued: 0, running: 0, done: 196 } });
    const failed = records.find((r) => r.name === 'Mothkin') as StructuredRecord;
    const withFailure = records.map((r) => (r.id === failed.id ? { ...r, jobId: 'job:done', runState: 'failed' as const } : r));
    renderRoute(
      <StructureStatusCard source={source} jobs={[done]} runner={IDLE_RUNNER} records={withFailure} sources={[source]} availability={ok} onRetry={onRetry} onReview={vi.fn()} />,
    );
    expect(screen.getByText(/^Done: 199 read\. \d+ to review, 1 couldn't be read\.$/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry 1' }));
    expect(onRetry).toHaveBeenCalledWith('job:done', [failed.id]);
    await user.click(screen.getByRole('button', { name: 'Hide this' }));
    expect(screen.queryByText(/^Done:/)).not.toBeInTheDocument();
  });

  it('U1: "Retry N" counts only the reads still listed as couldn\'t be read (not those kept as text or accepted)', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const done = extractionJob({ id: 'job:done', status: 'done', counts: { ...counts, queued: 0, running: 0, done: 196 } });
    const failedIn = (r: StructuredRecord, status: StructuredRecord['status'] = r.status) => ({ ...r, status, jobId: 'job:done', runState: 'failed' as const });
    const withFailures = records.map((r) =>
      r.name === 'Mothkin' ? failedIn(r) : r.name === 'Ashen Choir' ? failedIn(r, 'rejected') : r.name === 'Cinder Mote' ? failedIn(r, 'accepted') : r,
    );
    renderRoute(
      <StructureStatusCard source={source} jobs={[done]} runner={IDLE_RUNNER} records={withFailures} sources={[source]} availability={ok} onRetry={onRetry} onReview={vi.fn()} />,
    );
    expect(screen.getByText(/1 couldn't be read\.$/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry 1' }));
    expect(onRetry).toHaveBeenCalledWith('job:done', ids('Mothkin'));
  });
});
