/**
 * The job runner (spec §3.10) on fake-indexeddb with FakeExtractionClient and a fake clock: cache
 * lanes and warm-ups, concurrency, back-off, retries, the spending limit, pause, cancel, holds, one
 * running job app-wide, the Web Lock, startup recovery, offline resume and re-run proposals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APIUserAbortError } from '@anthropic-ai/sdk';
import { getJob, getRecords, listRecords, putRecords, saveLibrarySource } from '@/storage';
import { resetDatabase } from '@/storage/testData';
import { EXPECTED_DATA, SCRIPTED_WIRE, gloamwoodEntries, gloamwoodRecords, gloamwoodSource } from '@/test/structuredFixtures';
import { DEFAULT_SETTINGS, type AppSettings, type ExtractionJob, type StructuredRecord } from '@/types';
import { FakeExtractionClient, type ExtractionStep } from '../testing/fakeExtractionClient';
import { resetExtractionDeps, setExtractionDeps } from './deps';
import { ExtractionUnavailableError } from './errors';
import { cancelJob, estimateModels, pauseJob, recoverJobsOnStartup, resumeJob, retryRecords, startJob, type JobChoices } from './jobs';
import { LANE_COLD_MS, resetRunner, runnerSnapshot } from './runner';

vi.mock('@/data/rulesIndexStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/rulesIndexStore')>();
  const { createRulesIndex } = await import('@/data/search');
  return { ...actual, getRulesIndex: async () => createRulesIndex([]) };
});

// ---------------------------------------------------------------------------
// Harness: a fake clock, fake locks, the fixture book with chosen records unread
// ---------------------------------------------------------------------------

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function settle(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

class Clock {
  t = 1_700_000_000_000;
  private timers: { at: number; resolve: () => void }[] = [];
  now = () => this.t;
  sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new APIUserAbortError());
      const timer = { at: this.t + ms, resolve };
      this.timers.push(timer);
      signal?.addEventListener('abort', () => {
        this.timers = this.timers.filter((t) => t !== timer);
        reject(new APIUserAbortError());
      }, { once: true });
    });
  /** Move time forward, firing due timers in order and letting the runner react to each. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await settle(8);
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.t = Math.max(this.t, due.at);
      due.resolve();
    }
    this.t = end;
    await settle(8);
  }
}

class Locks {
  heldElsewhere = false;
  held = 0;
  async request(_name: string, opts: { ifAvailable?: boolean }, cb: (lock: { name: string } | null) => Promise<unknown>): Promise<unknown> {
    if (this.heldElsewhere || (this.held > 0 && opts.ifAvailable)) return cb(null);
    this.held += 1;
    try {
      return await cb({ name: _name });
    } finally {
      this.held -= 1;
    }
  }
}

const SOURCE = 'gloam';
let clock: Clock;
let fake: FakeExtractionClient;
let locks: Locks;
let flags: { busy: boolean; hidden: boolean; online: boolean };
let keepSaves: ReturnType<typeof vi.fn>;
let clientFactory: ReturnType<typeof vi.fn>;
const settings = (patch: Partial<AppSettings> = {}): AppSettings => ({ ...DEFAULT_SETTINGS, apiKey: 'sk-ant-test', ...patch });
let currentSettings: AppSettings;

/** The book, with every record read except the named ones (data null: they need Claude). The Goblin Warrior, unreadable, is kept as text unless named. */
async function seed(unread: readonly string[], sourceId = SOURCE): Promise<StructuredRecord[]> {
  await saveLibrarySource(gloamwoodSource(sourceId), gloamwoodEntries(sourceId));
  const records = gloamwoodRecords(sourceId).map((r) =>
    unread.includes(r.name) ? { ...r, data: null, confidence: 'low' as const } : r.name === 'Goblin Warrior' ? { ...r, status: 'rejected' as const } : r,
  );
  await putRecords(records);
  return records;
}
const byName = async (name: string, sourceId = SOURCE) => (await listRecords(sourceId)).find((r) => r.name === name)!;
const job = async (id: string) => (await getJob(id)) as ExtractionJob;
async function until(what: string, cond: () => boolean | Promise<boolean>, opts: { advance?: number; rounds?: number } = {}): Promise<void> {
  for (let i = 0; i < (opts.rounds ?? 300); i++) {
    if (await cond()) return;
    if (opts.advance) await clock.advance(opts.advance);
    else await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}
const finished = (id: string) => async () => ['done', 'paused', 'cancelled'].includes((await job(id)).status);
const choices = (patch: Partial<JobChoices> = {}): JobChoices => ({ model: 'claude-opus-5-5', claudeFor: 'misses', ...patch });

beforeEach(async () => {
  await resetDatabase();
  resetRunner();
  clock = new Clock();
  fake = new FakeExtractionClient({ now: clock.now, sleep: clock.sleep });
  locks = new Locks();
  flags = { busy: false, hidden: false, online: true };
  keepSaves = vi.fn();
  currentSettings = settings();
  clientFactory = vi.fn(() => fake);
  setExtractionDeps({
    client: clientFactory as () => FakeExtractionClient,
    settings: () => currentSettings,
    now: clock.now,
    sleep: clock.sleep,
    online: () => flags.online,
    dmBusy: () => flags.busy,
    pageHidden: () => flags.hidden,
    locks: locks as unknown as LockManager,
    keepSaves: keepSaves as () => void,
  });
});

afterEach(() => {
  resetRunner();
  resetExtractionDeps();
});

// ---------------------------------------------------------------------------

describe('a job from start to finish', () => {
  it('reads the misses with Claude, writes their records and the job ledger, and asks to keep saves once', async () => {
    await seed(['Glimmerwing Drake', 'Wickwright', 'Mothkin']);
    const started = await startJob(SOURCE, choices());
    expect(started.status).toBe('running');
    await until('done', finished(started.id));
    const done = await job(started.id);
    expect(done).toMatchObject({ status: 'done', counts: { done: 3, queued: 0, running: 0 } });
    expect(done.usage.requests).toBe(3);
    expect(done.usage.estimatedCostUsd).toBeGreaterThan(0);
    const drake = await byName('Glimmerwing Drake');
    expect(drake).toMatchObject({ origin: 'claude', runState: 'done', jobId: started.id, data: { ...EXPECTED_DATA['Glimmerwing Drake'], hp: 58 } });
    expect(drake.extraction).toMatchObject({ model: 'claude-opus-5-5', requestedModel: 'claude-opus-5-5', promptVersion: 1 });
    expect((await byName('Wickwright')).data).toMatchObject({ hitDie: 8, casterType: 'half' });
    expect(fake.requests.map((r) => r.title).sort()).toEqual(['Glimmerwing Drake', 'Mothkin', 'Wickwright']);
    expect(fake.requests.every((r) => r.options.maxRetries === 0)).toBe(true);
    expect(keepSaves).toHaveBeenCalledTimes(1);
    expect(runnerSnapshot().activeJobId).toBeNull();
  });

  it('sends the book’s text but never its title, and only the record’s own blocks', async () => {
    await seed(['Glimmerwing Drake']);
    const started = await startJob(SOURCE, choices());
    await until('done', finished(started.id));
    const body = JSON.stringify(fake.requests[0].params);
    expect(body).not.toContain('The Gloamwood Almanac');
    expect(body).toContain('Glimmerwing Drake');
    expect(body).not.toContain('Bramble Hound');
  });
});

describe('cache lanes and concurrency', () => {
  it('holds a kind’s second request until the warm-up’s first event; other kinds warm in parallel', async () => {
    await seed(['Ashen Choir', 'Cinder Mote', 'Bramble Hound', 'Glimmerwing Drake']);
    fake.script('Ashen Choir', { type: 'answer', delayMs: 5000 }).script('Bramble Hound', { type: 'answer', delayMs: 5000 });
    const started = await startJob(SOURCE, choices({ concurrency: 4 }));
    await until('two warm-ups', () => fake.requests.length >= 2);
    await settle();
    expect(fake.requests.map((r) => r.title)).toEqual(['Ashen Choir', 'Bramble Hound']);
    await clock.advance(5000);
    await until('done', finished(started.id), { advance: 100 });
    const [choir, hound, mote, drake] = ['Ashen Choir', 'Bramble Hound', 'Cinder Mote', 'Glimmerwing Drake'].map((t) => fake.requestsFor(t)[0]);
    expect(mote.at).toBeGreaterThanOrEqual(choir.firstEventAt!);
    expect(drake.at).toBeGreaterThanOrEqual(hound.firstEventAt!);
  });

  it('lets a lane go cold again 270 s after its last request started (the next request warms it up again)', async () => {
    await seed(['Bramble Hound', 'Glimmerwing Drake', 'Goblin Warrior']);
    // The hound warms the lane; the drake then meets a 429 asking for 300 s, which outlasts the cache
    // (the goblin's first try fails too, so it is still queued when the back-off ends).
    fake.script('Glimmerwing Drake', { type: 'error', status: 429, retryAfter: 300 }, { type: 'answer', delayMs: 5000 });
    fake.script('Goblin Warrior', { type: 'error', status: 529 }, { type: 'answer' });
    const started = await startJob(SOURCE, choices({ concurrency: 3 }));
    await until('back-off', () => runnerSnapshot().waitingUntil !== null && fake.requestsFor('Goblin Warrior').length === 1);
    await clock.advance(300_000);
    await until('warm-up again', () => fake.requestsFor('Glimmerwing Drake').length === 2);
    await settle();
    expect(fake.requestsFor('Goblin Warrior')).toHaveLength(1);
    await clock.advance(5000);
    await until('done', finished(started.id), { advance: 500 });
    const warmup = fake.requestsFor('Glimmerwing Drake')[1];
    expect(fake.requestsFor('Goblin Warrior')[1].at).toBeGreaterThanOrEqual(warmup.firstEventAt!);
    expect(warmup.at - fake.requestsFor('Bramble Hound')[0].at).toBeGreaterThan(LANE_COLD_MS);
  });

  it('never has more requests in flight than the concurrency', async () => {
    await seed(['Bramble Hound', 'Glimmerwing Drake', 'Goblin Warrior', 'Ashen Choir', 'Cinder Mote']);
    for (const t of ['Bramble Hound', 'Glimmerwing Drake', 'Goblin Warrior', 'Ashen Choir', 'Cinder Mote']) fake.script(t, { type: 'answer', delayMs: 1000 });
    let max = 0;
    const started = await startJob(SOURCE, choices({ concurrency: 2 }));
    await until('done', async () => {
      max = Math.max(max, runnerSnapshot().inFlight.length);
      return finished(started.id)();
    }, { advance: 250 });
    expect(max).toBe(2);
  });
});

describe('errors and retries', () => {
  it('waits out a 429 for every lane, lowers concurrency, and pauses after five back-offs in a row', async () => {
    await seed(['Bramble Hound', 'Glimmerwing Drake']);
    fake.failNext({ type: 'error', status: 429, retryAfter: 40 });
    const started = await startJob(SOURCE, choices({ concurrency: 3 }));
    await until('back-off', () => runnerSnapshot().waitingUntil !== null);
    expect(runnerSnapshot()).toMatchObject({ effectiveConcurrency: 2, waitingUntil: clock.t + 40_000 });
    const before = fake.requests.length;
    await clock.advance(39_000);
    expect(fake.requests.length).toBe(before);
    await until('done', finished(started.id), { advance: 2000 });
    expect((await job(started.id)).status).toBe('done');

    await resetDatabase();
    resetRunner();
    await seed(['Bramble Hound']);
    fake.failNext(...Array.from({ length: 5 }, () => ({ type: 'error', status: 429 }) as ExtractionStep));
    const limited = await startJob(SOURCE, choices());
    await until('paused', finished(limited.id), { advance: 30_000 });
    expect(await job(limited.id)).toMatchObject({ status: 'paused', pauseReason: 'rate-limit' });
    expect((await byName('Bramble Hound')).runState).toBe('queued');
  });

  it('restores concurrency after 20 successes', async () => {
    const records = await seed([]);
    // 21 monster requests: re-read everything of the kind ('all'), on a copy of one record.
    const hound = records.find((r) => r.name === 'Bramble Hound')!;
    await putRecords(Array.from({ length: 21 }, (_, i) => ({ ...hound, id: `rec:gloam:monster:copy-${i}`, candidateKey: `${hound.candidateKey}`, publicId: `lib:gloam:monster:copy-${i}`, data: null })));
    fake.failNext({ type: 'error', status: 429, retryAfter: 1 });
    fake.script('Bramble Hound', ...Array.from({ length: 22 }, () => ({ type: 'answer', delayMs: 1000 }) as ExtractionStep));
    const started = await startJob(SOURCE, choices({ concurrency: 2, kinds: ['monster'] }));
    await until('lowered', () => runnerSnapshot().effectiveConcurrency === 1);
    let raised = false;
    await until('done', async () => {
      raised ||= runnerSnapshot().effectiveConcurrency === 2;
      return finished(started.id)();
    }, { advance: 1000, rounds: 600 });
    expect(raised).toBe(true);
  });

  it('retries a transient error three times, then fails the record as retryable', async () => {
    await seed(['Bramble Hound']);
    fake.script('Bramble Hound', { type: 'error', status: 529 }, { type: 'error', status: 500 }, { type: 'network' });
    const started = await startJob(SOURCE, choices());
    await until('done', finished(started.id), { advance: 1000 });
    expect(fake.requestsFor('Bramble Hound')).toHaveLength(3);
    expect(await byName('Bramble Hound')).toMatchObject({ runState: 'failed', runAttempts: 3, runError: { code: 'network', retryable: true } });
  });

  it('pauses on a rejected key, and on a first-of-kind 400 (format); a later 400 fails the record', async () => {
    await seed(['Bramble Hound']);
    fake.failNext({ type: 'error', status: 401 });
    const auth = await startJob(SOURCE, choices());
    await until('paused', finished(auth.id));
    expect(await job(auth.id)).toMatchObject({ status: 'paused', pauseReason: 'auth', pauseMessage: 'Claude rejected your API key. Fix it in Settings, then resume.' });
    expect((await byName('Bramble Hound')).runState).toBe('queued');

    await cancelJob(auth.id);
    fake.failNext({ type: 'error', status: 400, message: 'Schema is too complex' });
    const format = await startJob(SOURCE, choices());
    await until('paused', finished(format.id));
    expect(await job(format.id)).toMatchObject({ pauseReason: 'format', pauseMessage: "Claude couldn't use the reading format for monsters: Schema is too complex" });

    await cancelJob(format.id);
    await seed(['Bramble Hound', 'Glimmerwing Drake']);
    fake.script('Glimmerwing Drake', { type: 'error', status: 400, message: 'Bad image' });
    const later = await startJob(SOURCE, choices({ concurrency: 1 }));
    await until('done', finished(later.id));
    expect(await job(later.id)).toMatchObject({ status: 'done' });
    expect(await byName('Glimmerwing Drake')).toMatchObject({ runState: 'failed', runError: { code: 'bad-request', retryable: false } });
  });

  it('retries a max_tokens stop once at twice the budget, and fails a second one', async () => {
    await seed(['Glimmerwing Drake', 'Bramble Hound']);
    fake.script('Glimmerwing Drake', { type: 'max_tokens' }).script('Bramble Hound', { type: 'max_tokens' }, { type: 'max_tokens' });
    const started = await startJob(SOURCE, choices());
    await until('done', finished(started.id));
    expect(fake.requestsFor('Glimmerwing Drake').map((r) => r.params.max_tokens)).toEqual([6000, 12000]);
    expect(await byName('Glimmerwing Drake')).toMatchObject({ runState: 'done', runMaxTokens: 12000 });
    expect(await byName('Bramble Hound')).toMatchObject({ runState: 'failed', runError: { code: 'truncated', retryable: false } });
  });

  it('retries an invalid answer once', async () => {
    await seed(['Glimmerwing Drake', 'Bramble Hound']);
    fake.script('Glimmerwing Drake', { type: 'answer', text: 'not json' }).script('Bramble Hound', { type: 'answer', text: '{}' }, { type: 'answer', text: '{}' });
    const started = await startJob(SOURCE, choices());
    await until('done', finished(started.id));
    expect((await byName('Glimmerwing Drake')).runState).toBe('done');
    expect(await byName('Bramble Hound')).toMatchObject({ runState: 'failed', runError: { code: 'invalid-output' } });
  });

  it('does not retry a refusal and keeps the offline data', async () => {
    await seed([]);
    fake.script('Bramble Hound', { type: 'refusal', category: 'general_harms' });
    const started = await startJob(SOURCE, choices({ claudeFor: 'selection', recordIds: ['rec:gloam:monster:bramble-hound'] }));
    await until('done', finished(started.id));
    const hound = await byName('Bramble Hound');
    expect(hound).toMatchObject({ runState: 'refused', data: EXPECTED_DATA['Bramble Hound'], extraction: { refusal: 'general_harms' } });
    expect(hound.warnings).toContainEqual(expect.objectContaining({ code: 'refused', severity: 'info' }));
    expect(fake.requestsFor('Bramble Hound')).toHaveLength(1);
  });
});

describe('the spending limit, pause and cancel', () => {
  it('stops before the request that could pass the limit, counting requests in flight, then pauses', async () => {
    await seed(['Bramble Hound', 'Glimmerwing Drake', 'Goblin Warrior']);
    const estimate = (await estimateModels(SOURCE, { claudeFor: 'misses' }))[0];
    const perRequest = estimate.byKind.monster!.usd / estimate.byKind.monster!.requests;
    for (const t of ['Bramble Hound', 'Glimmerwing Drake', 'Goblin Warrior']) fake.script(t, { type: 'answer', delayMs: 1000 });
    // Room for two requests at the estimate's high end (1.6×), not three.
    const started = await startJob(SOURCE, choices({ concurrency: 3, budgetUsd: perRequest * 1.6 * 2.5 }));
    await until('paused', finished(started.id), { advance: 500 });
    expect(await job(started.id)).toMatchObject({ status: 'paused', pauseReason: 'budget' });
    expect(fake.requests).toHaveLength(2);
  });

  it('pauses gracefully: requests in flight finish and are kept', async () => {
    await seed(['Bramble Hound', 'Glimmerwing Drake', 'Goblin Warrior']);
    for (const t of ['Bramble Hound', 'Glimmerwing Drake', 'Goblin Warrior']) fake.script(t, { type: 'answer', delayMs: 1000 });
    const started = await startJob(SOURCE, choices({ concurrency: 1 }));
    await until('in flight', () => runnerSnapshot().inFlight.length === 1);
    await pauseJob(started.id);
    expect((await job(started.id)).status).toBe('pausing');
    await until('paused', finished(started.id), { advance: 500 });
    expect(await job(started.id)).toMatchObject({ status: 'paused', pauseReason: 'player', counts: { done: 1, queued: 2 } });
    expect(fake.requests).toHaveLength(1);
  });

  it('cancels at once: aborts what is in flight (interrupted) and skips the rest', async () => {
    await seed(['Bramble Hound', 'Glimmerwing Drake', 'Goblin Warrior']);
    fake.failNext({ type: 'stall' });
    const started = await startJob(SOURCE, choices({ concurrency: 1 }));
    await until('in flight', () => runnerSnapshot().inFlight.length === 1);
    await cancelJob(started.id);
    const cancelled = await job(started.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', interrupted: 1, counts: { skipped: 3, queued: 0, running: 0 } });
    expect((await listRecords(SOURCE)).filter((r) => r.jobId === started.id).every((r) => r.runState === 'skipped')).toBe(true);
  });
});

describe('holds, one job at a time, tabs and reloads', () => {
  it('holds dispatch while the DM is replying and while a phone page is hidden, then goes on', async () => {
    await seed(['Bramble Hound']);
    flags.busy = true;
    const started = await startJob(SOURCE, choices());
    await clock.advance(3000);
    expect(runnerSnapshot().hold).toBe('dm-turn');
    expect(fake.requests).toHaveLength(0);
    flags.busy = false;
    flags.hidden = true;
    await clock.advance(2000);
    expect(runnerSnapshot().hold).toBe('hidden');
    flags.hidden = false;
    await until('done', finished(started.id), { advance: 1000 });
    expect(fake.requests).toHaveLength(1);
  });

  it('runs one job app-wide: a second book waits queued and starts when the first ends', async () => {
    await seed(['Bramble Hound']);
    await seed(['Glimmerwing Drake'], 'other');
    fake.script('Bramble Hound', { type: 'answer', delayMs: 2000 });
    const first = await startJob(SOURCE, choices());
    const second = await startJob('other', choices());
    expect(second.status).toBe('queued');
    await until('both done', async () => (await job(first.id)).status === 'done' && (await job(second.id)).status === 'done', { advance: 500 });
    expect(fake.requests.map((r) => r.title)).toEqual(['Bramble Hound', 'Glimmerwing Drake']);
  });

  it('pauses with other-tab when another tab holds the runner lock', async () => {
    await seed(['Bramble Hound']);
    locks.heldElsewhere = true;
    const started = await startJob(SOURCE, choices());
    expect(await job(started.id)).toMatchObject({ status: 'paused', pauseReason: 'other-tab', pauseMessage: 'Structuring is running in another tab.' });
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('recovers a job a closed page left running only when it can take the lock', async () => {
    await seed(['Bramble Hound']);
    const records = await listRecords(SOURCE);
    const hound = records.find((r) => r.name === 'Bramble Hound')!;
    const left: ExtractionJob = {
      ...(await startJob(SOURCE, choices())),
    };
    await until('done', finished(left.id));
    await putRecords([{ ...hound, jobId: left.id, runState: 'running' }]);
    const { putJob } = await import('@/storage');
    await putJob({ ...left, status: 'running', counts: { ...left.counts, running: 1, done: 0 } });
    locks.heldElsewhere = true;
    await recoverJobsOnStartup();
    expect((await job(left.id)).status).toBe('running');
    locks.heldElsewhere = false;
    await recoverJobsOnStartup();
    expect(await job(left.id)).toMatchObject({ status: 'paused', pauseReason: 'reload', interrupted: 1 });
    expect((await byName('Bramble Hound')).runState).toBe('queued');
  });

  it('pauses when offline and resumes on the online event', async () => {
    await seed(['Bramble Hound']);
    flags.online = false;
    fake.failNext({ type: 'network' });
    const started = await startJob(SOURCE, choices());
    await until('paused', finished(started.id));
    expect(await job(started.id)).toMatchObject({ status: 'paused', pauseReason: 'offline' });
    flags.online = true;
    window.dispatchEvent(new Event('online'));
    await until('done', async () => (await job(started.id)).status === 'done');
  });
});

describe('re-runs and the job API', () => {
  it('writes a proposal over edited and accepted records, and replaces pending ones', async () => {
    const records = await seed([]);
    const hound = records.find((r) => r.name === 'Bramble Hound')!;
    const drake = records.find((r) => r.name === 'Glimmerwing Drake')!;
    const goblin = records.find((r) => r.name === 'Goblin Warrior')!;
    await putRecords([{ ...hound, edited: true, data: { ...hound.data!, hp: 30 } as StructuredRecord['data'] }, { ...drake, status: 'accepted' }]);
    const started = await startJob(SOURCE, choices({ claudeFor: 'selection', recordIds: [hound.id, drake.id, goblin.id] }));
    await until('done', finished(started.id));
    expect(await byName('Bramble Hound')).toMatchObject({ edited: true, data: { hp: 30 }, proposal: { origin: 'claude', data: { hp: 22 } } });
    expect(await byName('Glimmerwing Drake')).toMatchObject({ status: 'accepted', data: { hp: 52 }, proposal: { data: { hp: 58 } } });
    expect(await byName('Goblin Warrior')).toMatchObject({ origin: 'claude', runState: 'done' });
  });

  it('retries failed records in the same job, or in a new job with another model', async () => {
    await seed(['Bramble Hound']);
    fake.script('Bramble Hound', { type: 'refusal' });
    const first = await startJob(SOURCE, choices());
    await until('done', finished(first.id));
    expect((await byName('Bramble Hound')).runState).toBe('refused');
    const sameJob = await retryRecords(first.id, 'refused');
    expect(sameJob).toBe(first.id);
    await until('done again', async () => (await job(first.id)).status === 'done' && (await byName('Bramble Hound')).runState === 'done');
    fake.script('Bramble Hound', { type: 'refusal' });
    await putRecords([{ ...(await byName('Bramble Hound')), runState: 'refused' }]);
    const other = await retryRecords(first.id, 'both', 'claude-sonnet-5-5');
    expect(other).not.toBe(first.id);
    await until('other done', finished(other));
    expect(fake.requests.at(-1)?.params.model).toBe('claude-sonnet-5-5');
  });

  it('resumes a paused job (player only), applying a new limit or skipping a kind', async () => {
    await seed(['Bramble Hound', 'Ashen Choir']);
    fake.script('Ashen Choir', { type: 'answer', delayMs: 1000 });
    const started = await startJob(SOURCE, choices({ concurrency: 1 }));
    await pauseJob(started.id);
    await until('paused', finished(started.id), { advance: 500 });
    await resumeJob(started.id, { budgetUsd: null, skipKinds: ['monster'] });
    await until('done', async () => (await job(started.id)).status === 'done', { advance: 500 });
    expect(await job(started.id)).toMatchObject({ budgetUsd: null, scope: { kinds: ['spell'] } });
    expect((await byName('Bramble Hound')).runState).toBe('skipped');
  });

  it('estimates the Settings model first, then the cheaper ones', async () => {
    await seed(['Bramble Hound', 'Wickwright']);
    expect((await estimateModels(SOURCE, { claudeFor: 'misses' })).map((e) => e.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    currentSettings = settings({ model: 'claude-sonnet-5-5' });
    const [sonnet, haiku] = await estimateModels(SOURCE, { claudeFor: 'misses' });
    expect([sonnet.model, haiku.model]).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(sonnet.requests).toBe(2);
  });

  it('refuses in demo mode and without a key, before creating anything or calling the client', async () => {
    await seed(['Bramble Hound']);
    for (const s of [settings({ mockMode: true }), settings({ apiKey: '' })]) {
      currentSettings = s;
      await expect(startJob(SOURCE, choices())).rejects.toBeInstanceOf(ExtractionUnavailableError);
    }
    expect(clientFactory).not.toHaveBeenCalled();
    expect((await getRecords(['rec:gloam:monster:bramble-hound']))[0]?.jobId).toBeUndefined();
  });

  it('uses the scripted answers for the fixture book (SCRIPTED_WIRE) by default', () => {
    expect(SCRIPTED_WIRE['Bramble Hound'].kind).toBe('monster');
  });
});
