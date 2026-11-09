import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import userEvent from '@testing-library/user-event';
import { extractionJob, gloamwoodRecords, gloamwoodSource } from '@/test/structuredFixtures';
import type { ExtractionJob, LibrarySource, PauseReason, StructuredRecord } from '@/types';
import { autoCleanup, installDialogPolyfill, renderRoute } from '@/ui/shell/testUtils';
import type { Availability } from './RecordDetail';

vi.mock('@/dm', async () => (await import('@/ui/library/structure/testing/mocks')).dmMock());

const dm = await import('@/dm');
const { IDLE_RUNNER_SNAPSHOT: IDLE_RUNNER } = await import('./testing/mocks');
const { StructureStatusCard, pausedKind } = await import('./StructureStatusCard');

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

  it('in demo mode it can not resume', () => {
    renderCard(paused('player'), { availability: { ok: false, reason: 'demo', message: 'Demo mode makes no API calls.' } });
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
    expect(screen.getByText('Demo mode makes no API calls.')).toBeInTheDocument();
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
});
