/**
 * The job runner (spec §3.10) on fake-indexeddb with FakeExtractionClient and a fake clock: cache
 * lanes and warm-ups, concurrency, back-off, retries, the spending limit, pause, cancel, holds, one
 * running job app-wide, the Web Lock, startup recovery, offline resume and re-run proposals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APIUserAbortError } from '@anthropic-ai/sdk';
import { detectStructure } from '@/data';
import { chunkDocument } from '@/data/chunk';
import { getJob, getRecords, listRecords, putJob, putRecords, saveLibrarySource } from '@/storage';
import { resetDatabase } from '@/storage/testData';
import { EXPECTED_DATA, SCRIPTED_WIRE, extractionJob, gloamwoodEntries, gloamwoodRecords, gloamwoodSource } from '@/test/structuredFixtures';
import { DEFAULT_SETTINGS, type AppSettings, type ExtractionJob, type StructuredRecord } from '@/types';
import { FakeExtractionClient, type ExtractionStep } from '../testing/fakeExtractionClient';
import { resetExtractionDeps, setExtractionDeps } from './deps';
import { ExtractionUnavailableError } from './errors';
import { cancelJob, estimateModels, pauseJob, recoverJobsOnStartup, resumeJob, retryRecords, startJob, type JobChoices } from './jobs';
import { CONTROL_CHANNEL, LANE_COLD_MS, OFFLINE_LOCK_PREFIX, RUNNER_LOCK, emptyCounts, resetRunner, runnerIdle, runnerSnapshot } from './runner';

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

/**
 * navigator.locks, one exclusive lock per name: a FIFO queue, ifAvailable, AbortSignal. holdElsewhere() plays
 * another tab holding the runner lock; `held` and `grants` are the runner lock's.
 */
class Locks {
  private readonly names = new Map<string, { held: boolean; queue: (() => void)[] }>();
  grants = 0;
  private releaseOther: (() => void) | null = null;
  get held(): boolean {
    return this.lock(RUNNER_LOCK).held;
  }
  /** Whether some page holds this lock now. */
  isHeld(name: string): boolean {
    return this.lock(name).held;
  }
  /** Another tab takes the lock (now, or once it comes free) and keeps it until releaseElsewhere(). */
  holdElsewhere(): void {
    void this.request(RUNNER_LOCK, {}, () => new Promise<void>((r) => (this.releaseOther = r)));
  }
  /** That tab lets go (it finished, or it was closed). */
  releaseElsewhere(): void {
    this.releaseOther?.();
    this.releaseOther = null;
  }
  private lock(name: string) {
    let state = this.names.get(name);
    if (!state) this.names.set(name, (state = { held: false, queue: [] }));
    return state;
  }
  async request(name: string, opts: { ifAvailable?: boolean; signal?: AbortSignal }, cb: (lock: { name: string } | null) => unknown): Promise<unknown> {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const state = this.lock(name);
    if (state.held || state.queue.length) {
      if (opts.ifAvailable) return cb(null);
      await new Promise<void>((resolve, reject) => {
        const grant = () => resolve();
        state.queue.push(grant);
        opts.signal?.addEventListener('abort', () => {
          state.queue = state.queue.filter((g) => g !== grant);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    } else state.held = true;
    if (name === RUNNER_LOCK) this.grants += 1;
    try {
      return await cb({ name });
    } finally {
      const next = state.queue.shift();
      if (next) next();
      else state.held = false;
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

  it('X2: retries an overloaded error sent mid-stream like a 529, and counts the usage that stream reported', async () => {
    await seed(['Bramble Hound', 'Glimmerwing Drake']);
    // The SDK's real shapes after a 200: an `event: error` (plain APIError, no status), then a dropped connection.
    fake.script('Bramble Hound', { type: 'error', status: 529, atEvent: 1 }, { type: 'network', atEvent: 2 });
    const started = await startJob(SOURCE, choices({ concurrency: 1 }));
    await until('done', finished(started.id), { advance: 1000 });
    const hound = fake.requestsFor('Bramble Hound');
    expect(hound).toHaveLength(3);
    // 2 s, then 8 s, after each failure (the transient waits).
    expect(hound[1].at - (hound[0].endedAt ?? 0)).toBeGreaterThanOrEqual(2000);
    expect(hound[2].at - (hound[1].endedAt ?? 0)).toBeGreaterThanOrEqual(8000);
    expect(await byName('Bramble Hound')).toMatchObject({ runState: 'done', runAttempts: 3 });
    const done = await job(started.id);
    expect(done).toMatchObject({ status: 'done', counts: { done: 2, failed: 0 } });
    // The two failed streams' input tokens are in the ledger beside the answers' (4 requests, 2 answers).
    const answers = (await Promise.all(['Bramble Hound', 'Glimmerwing Drake'].map((n) => byName(n)))).map((r) => r.extraction!.usage);
    expect(done.usage.requests).toBe(4);
    expect(done.usage.inputTokens).toBeGreaterThan(answers[0].inputTokens + answers[1].inputTokens);
    expect(done.usage.estimatedCostUsd).toBeGreaterThan(answers[0].estimatedCostUsd + answers[1].estimatedCostUsd);
  });

  it('X8: a section too long for one request keeps the left-out features from the offline scan, with a warning', async () => {
    // An invented subclass whose kept-whole feature blocks (they mention spells) pass the 60,000-character cap.
    const levels = [3, 3, 7, 10, 15, 18];
    const rite = `Each night the knight trims the lamp and studies the spells of the road. ${'The rite is long in the telling. '.repeat(400)}`;
    const book = ['# Options', '## Fighter Subclass: Lamp Knight', 'Knights of the lamp keep watch where old spells linger.', ...levels.flatMap((lvl, i) => [`### Level ${lvl}: Rite ${i + 1}`, rite])].join('\n\n');
    await saveLibrarySource({ ...gloamwoodSource('lamp'), title: 'Lamp Book' }, chunkDocument(book, { sourceId: 'lamp', sourceName: 'Lamp Book' }));
    await detectStructure('lamp');
    const knight = (await listRecords('lamp')).find((r) => r.kind === 'subclass')!;
    expect(knight.data).not.toBeNull();
    // Claude reads what it was sent: the first feature block (B2) is surely among them.
    fake.script('Fighter Subclass: Lamp Knight', {
      type: 'answer',
      wire: {
        matchesKind: true, name: 'Lamp Knight', format: '2024', parentClassText: 'Fighter', taglineText: '',
        features: [{ level: 3, name: 'Rite 1', text: { block: 'B2', from: 1, to: 1 } }],
        casterType: 'none', spellcastingAbility: 'none', alwaysPreparedSpells: [], notes: '',
      },
    });
    const started = await startJob('lamp', choices({ claudeFor: 'selection', recordIds: [knight.id] }));
    await until('done', finished(started.id));
    const sent = fake.requestsFor('Fighter Subclass: Lamp Knight')[0];
    expect(JSON.stringify(sent.params.messages)).toContain('Rite 1');
    expect(JSON.stringify(sent.params.messages)).not.toContain('Rite 6');
    const read = (await getRecords([knight.id]))[0]!;
    expect(read).toMatchObject({ origin: 'claude', runState: 'done' });
    const features = (read.data as { features: { level: number; name: string }[] }).features;
    expect(features[0]).toMatchObject({ level: 3, name: 'Rite 1' });
    expect(features.at(-1)).toMatchObject({ level: 18, name: 'Rite 6' }); // never sent: from the offline heading scan
    expect(read.warnings).toContainEqual(expect.objectContaining({ code: 'missing', severity: 'warn', message: expect.stringMatching(/too long to send to Claude whole/) }));
  });

  it('X2: pauses offline when the connection drops mid-stream while the browser is offline', async () => {
    await seed(['Bramble Hound']);
    flags.online = false;
    fake.failNext({ type: 'network', atEvent: 2 });
    const started = await startJob(SOURCE, choices());
    await until('paused', finished(started.id));
    expect(await job(started.id)).toMatchObject({ status: 'paused', pauseReason: 'offline' });
    expect((await byName('Bramble Hound')).runState).toBe('queued');
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

  it('runs one job app-wide: a second book waits queued and starts when the first ends, on the same lock', async () => {
    await seed(['Bramble Hound']);
    await seed(['Glimmerwing Drake'], 'other');
    fake.script('Bramble Hound', { type: 'answer', delayMs: 2000 });
    const first = await startJob(SOURCE, choices());
    const second = await startJob('other', choices());
    expect(second.status).toBe('queued');
    await until('both done', async () => (await job(first.id)).status === 'done' && (await job(second.id)).status === 'done', { advance: 500 });
    expect(fake.requests.map((r) => r.title)).toEqual(['Bramble Hound', 'Glimmerwing Drake']);
    // The lock passed from the first job to the second without a gap another tab could take, then was let go.
    await settle();
    expect(locks.grants).toBe(1);
    expect(locks.held).toBe(false);
  });

  it('holds a job up while another tab runs structuring, then runs it here once that tab lets go', async () => {
    await seed(['Bramble Hound']);
    locks.holdElsewhere();
    const started = await startJob(SOURCE, choices());
    expect(await job(started.id)).toMatchObject({ status: 'paused', pauseReason: 'other-tab', pauseMessage: 'Structuring is running in another tab.' });
    await clock.advance(5000);
    expect(clientFactory).not.toHaveBeenCalled();
    locks.releaseElsewhere();
    await until('done', async () => (await job(started.id)).status === 'done');
    expect(fake.requests.map((r) => r.title)).toEqual(['Bramble Hound']);
  });

  it('when a closed tab lets the lock go, pauses what it left behind and runs only what was asked for here', async () => {
    await seed(['Bramble Hound']);
    await seed(['Glimmerwing Drake'], 'other');
    const drake = await byName('Glimmerwing Drake', 'other');
    await putRecords([{ ...drake, jobId: 'job:left', runState: 'running' }]);
    await putJob(extractionJob({ id: 'job:left', sourceId: 'other', status: 'running', counts: { ...emptyCounts(), running: 1 } }));
    await putJob(extractionJob({ id: 'job:queued-there', sourceId: 'other', status: 'queued' }));
    locks.holdElsewhere();
    const mine = await startJob(SOURCE, choices());
    expect((await job(mine.id)).pauseReason).toBe('other-tab');
    locks.releaseElsewhere(); // the other tab was closed mid-job
    await until('mine done', async () => (await job(mine.id)).status === 'done');
    expect(await job('job:left')).toMatchObject({ status: 'paused', pauseReason: 'reload', interrupted: 1, counts: { queued: 1, running: 0 } });
    expect(await job('job:queued-there')).toMatchObject({ status: 'paused', pauseReason: 'reload' });
    expect((await byName('Glimmerwing Drake', 'other')).runState).toBe('queued');
    expect(fake.requests.map((r) => r.title)).toEqual(['Bramble Hound']);
  });

  it('keeps a held-up job paused once the player pauses it', async () => {
    await seed(['Bramble Hound']);
    locks.holdElsewhere();
    const started = await startJob(SOURCE, choices());
    await pauseJob(started.id);
    expect(await job(started.id)).toMatchObject({ status: 'paused', pauseReason: 'player' });
    locks.releaseElsewhere();
    await clock.advance(5000);
    expect(fake.requests).toHaveLength(0);
    expect((await job(started.id)).status).toBe('paused');
  });

  it('answers pause and cancel sent by another tab', async () => {
    await seed(['Bramble Hound', 'Glimmerwing Drake', 'Goblin Warrior']);
    for (const t of ['Bramble Hound', 'Glimmerwing Drake', 'Goblin Warrior']) fake.script(t, { type: 'answer', delayMs: 1000 }, { type: 'stall' });
    const otherTab = new BroadcastChannel(CONTROL_CHANNEL);
    try {
      const started = await startJob(SOURCE, choices({ concurrency: 1 }));
      await until('in flight', () => runnerSnapshot().inFlight.length === 1);
      otherTab.postMessage({ type: 'pause', jobId: started.id });
      await until('paused', finished(started.id), { advance: 500 });
      expect(await job(started.id)).toMatchObject({ status: 'paused', pauseReason: 'player', counts: { done: 1, queued: 2 } });
      await resumeJob(started.id);
      await until('in flight again', () => runnerSnapshot().inFlight.length === 1);
      otherTab.postMessage({ type: 'cancel', jobId: started.id });
      await until('cancelled', async () => (await job(started.id)).status === 'cancelled', { advance: 100 });
      expect(await job(started.id)).toMatchObject({ interrupted: 1, counts: { done: 1, skipped: 2, queued: 0, running: 0 } });
    } finally {
      otherTab.close();
    }
  });

  it('asks the tab that runs a job to pause or cancel it, and changes nothing itself', async () => {
    await seed(['Bramble Hound']);
    await putJob(extractionJob({ id: 'job:elsewhere', sourceId: SOURCE, status: 'running' }));
    locks.holdElsewhere();
    const heard: unknown[] = [];
    const runningTab = new BroadcastChannel(CONTROL_CHANNEL);
    runningTab.onmessage = (event) => heard.push(event.data);
    try {
      await pauseJob('job:elsewhere');
      await cancelJob('job:elsewhere');
      await until('heard', () => heard.length === 2);
      expect(heard).toEqual([{ type: 'pause', jobId: 'job:elsewhere' }, { type: 'cancel', jobId: 'job:elsewhere' }]);
      expect((await job('job:elsewhere')).status).toBe('running');
    } finally {
      runningTab.close();
    }
  });

  it('pauses or cancels here a job a closed page left running, when no tab runs structuring', async () => {
    await seed(['Bramble Hound', 'Glimmerwing Drake']);
    const [hound, drake] = [await byName('Bramble Hound'), await byName('Glimmerwing Drake')];
    await putRecords([{ ...hound, jobId: 'job:left', runState: 'running' }, { ...drake, jobId: 'job:left', runState: 'queued' }]);
    await putJob(extractionJob({ id: 'job:left', sourceId: SOURCE, status: 'running', counts: { ...emptyCounts(), running: 1, queued: 1 } }));
    await pauseJob('job:left');
    expect(await job('job:left')).toMatchObject({ status: 'paused', pauseReason: 'player', interrupted: 1, counts: { queued: 2, running: 0 } });
    expect((await byName('Bramble Hound')).runState).toBe('queued');

    await putJob({ ...(await job('job:left')), status: 'running' });
    await putRecords([{ ...(await byName('Bramble Hound')), runState: 'running' }]);
    await cancelJob('job:left');
    expect(await job('job:left')).toMatchObject({ status: 'cancelled', interrupted: 2, counts: { skipped: 2, queued: 0, running: 0 } });
    expect((await job('job:left')).pauseReason).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
  });

  it('recovers jobs a closed page left only when it can take the lock, and never resumes one', async () => {
    await seed(['Bramble Hound']);
    await seed(['Glimmerwing Drake'], 'other');
    await putRecords([{ ...(await byName('Bramble Hound')), jobId: 'job:a', runState: 'running' }]);
    await putJob(extractionJob({ id: 'job:a', sourceId: SOURCE, status: 'running', counts: { ...emptyCounts(), running: 1 } }));
    await putJob(extractionJob({ id: 'job:b', sourceId: SOURCE, status: 'queued' }));
    await putJob(extractionJob({ id: 'job:c', sourceId: SOURCE, status: 'paused', pauseReason: 'offline' }));
    await putJob(extractionJob({ id: 'job:d', sourceId: SOURCE, status: 'paused', pauseReason: 'other-tab' }));
    await putJob(extractionJob({ id: 'job:e', sourceId: SOURCE, status: 'paused', pauseReason: 'budget' }));

    locks.holdElsewhere();
    await recoverJobsOnStartup();
    expect((await job('job:a')).status).toBe('running');
    locks.releaseElsewhere();
    await settle();

    await recoverJobsOnStartup();
    for (const id of ['job:a', 'job:b', 'job:c', 'job:d']) {
      expect(await job(id), id).toMatchObject({ status: 'paused', pauseReason: 'reload', pauseMessage: 'Paused when the page closed.' });
    }
    expect(await job('job:a')).toMatchObject({ interrupted: 1, counts: { queued: 1, running: 0 } });
    expect((await byName('Bramble Hound')).runState).toBe('queued');
    expect((await job('job:e')).pauseReason).toBe('budget');
    await clock.advance(60_000);
    expect(fake.requests).toHaveLength(0);
    expect(clientFactory).not.toHaveBeenCalled();

    // Starting another book's job runs that job alone.
    const other = await startJob('other', choices());
    await until('other done', finished(other.id));
    expect(fake.requests.map((r) => r.title)).toEqual(['Glimmerwing Drake']);
    expect((await job('job:a')).status).toBe('paused');
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

  it('X10: a page opened while offline leaves a job paused offline to the tab waiting for the connection', async () => {
    await seed(['Bramble Hound']);
    flags.online = false;
    fake.failNext({ type: 'network' });
    const started = await startJob(SOURCE, choices());
    await until('paused', finished(started.id));
    await runnerIdle();
    await settle();
    const offlineLock = `${OFFLINE_LOCK_PREFIX}${started.id}`;
    expect(locks.isHeld(offlineLock)).toBe(true);
    expect(locks.held).toBe(false); // the runner lock is free: the other page's startup recovery gets to run
    // Another page: fresh copies of the modules, sharing the database and the locks. It finds the runner lock free.
    vi.resetModules();
    const otherDeps = await import('./deps');
    const otherJobs = await import('./jobs');
    const otherRunner = await import('./runner');
    try {
      otherDeps.setExtractionDeps({ client: () => fake, settings: () => currentSettings, now: clock.now, sleep: clock.sleep, online: () => flags.online, locks: locks as unknown as LockManager, keepSaves: () => undefined });
      await otherJobs.recoverJobsOnStartup();
      expect(await job(started.id)).toMatchObject({ status: 'paused', pauseReason: 'offline' });
      flags.online = true;
      window.dispatchEvent(new Event('online'));
      await until('done', async () => (await job(started.id)).status === 'done');
      await settle();
      expect(locks.isHeld(offlineLock)).toBe(false);
    } finally {
      otherRunner.resetRunner();
    }
  });

  it('X10: startup recovery pauses an offline job as reload once no page waits for its connection', async () => {
    await seed(['Bramble Hound']);
    flags.online = false;
    fake.failNext({ type: 'network' });
    const started = await startJob(SOURCE, choices());
    await until('paused', finished(started.id));
    resetRunner(); // the page that paused it closes: its online listener and offline lock go with it
    await settle();
    expect(locks.isHeld(`${OFFLINE_LOCK_PREFIX}${started.id}`)).toBe(false);
    expect(locks.held).toBe(false);
    await recoverJobsOnStartup();
    expect(await job(started.id)).toMatchObject({ status: 'paused', pauseReason: 'reload' });
  });

  it('X9: when the tab that took over a job started here closes, the job is paused (reload), not left running', async () => {
    await seed(['Bramble Hound', 'Glimmerwing Drake']);
    locks.holdElsewhere(); // tab A runs structuring
    const started = await startJob(SOURCE, choices());
    expect(await job(started.id)).toMatchObject({ status: 'paused', pauseReason: 'other-tab' });
    // Tab A finishes its own job and takes this one over: what its startRun and dispatch write.
    const held = await job(started.id);
    await putJob({ ...held, status: 'running', pauseReason: undefined, pauseMessage: undefined, startedAt: clock.now() });
    await putRecords([{ ...(await byName('Bramble Hound')), runState: 'running' }]);
    locks.releaseElsewhere(); // tab A is closed mid-job; this tab is granted the lock
    await until('recovered', async () => (await job(started.id)).status !== 'running', { advance: 1000 });
    await runnerIdle();
    expect(await job(started.id)).toMatchObject({ status: 'paused', pauseReason: 'reload', interrupted: 1, counts: { queued: 2, running: 0 } });
    expect((await byName('Bramble Hound')).runState).toBe('queued');
    expect(fake.requests).toHaveLength(0);
    expect(locks.held).toBe(false);
    // A job started here now runs at once (nothing is left marked as running).
    await seed(['Ashen Choir'], 'other');
    const next = await startJob('other', choices());
    await until('next done', finished(next.id));
    expect(fake.requests.map((r) => r.title)).toEqual(['Ashen Choir']);
  });

  it('asks before the page closes while a request is in flight, and not otherwise', async () => {
    await seed(['Bramble Hound']);
    fake.script('Bramble Hound', { type: 'answer', delayMs: 1000 });
    const closing = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(closing()).toBe(false);
    const started = await startJob(SOURCE, choices());
    await until('in flight', () => runnerSnapshot().inFlight.length === 1);
    expect(closing()).toBe(true);
    await until('done', finished(started.id), { advance: 500 });
    expect(closing()).toBe(false);
  });

  it('sends nothing more once demo mode is switched on mid-job; a queued job then waits without calling the client', async () => {
    await seed(['Bramble Hound', 'Glimmerwing Drake', 'Goblin Warrior']);
    await seed(['Ashen Choir'], 'other');
    for (const t of ['Bramble Hound', 'Glimmerwing Drake', 'Goblin Warrior']) fake.script(t, { type: 'answer', delayMs: 1000 });
    const started = await startJob(SOURCE, choices({ concurrency: 1 }));
    const queued = await startJob('other', choices());
    await until('in flight', () => runnerSnapshot().inFlight.length === 1);
    currentSettings = settings({ mockMode: true });
    await until('both paused', async () => (await job(started.id)).status === 'paused' && (await job(queued.id)).status === 'paused', { advance: 500 });
    const demo = 'Demo mode makes no API calls. Turn it off in Settings to have Claude read entries.';
    expect(await job(started.id)).toMatchObject({ pauseReason: 'auth', pauseMessage: demo, counts: { done: 1, queued: 2 } });
    expect(await job(queued.id)).toMatchObject({ pauseReason: 'auth', pauseMessage: demo });
    expect(fake.requests).toHaveLength(1);
    expect(clientFactory).toHaveBeenCalledTimes(1);
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
    const sameJob = await retryRecords(first.id, 'refused', 'claude-opus-5-5');
    expect(sameJob).toBe(first.id);
    await until('done again', async () => (await job(first.id)).status === 'done' && (await byName('Bramble Hound')).runState === 'done');
    fake.script('Bramble Hound', { type: 'refusal' });
    await putRecords([{ ...(await byName('Bramble Hound')), runState: 'refused' }]);
    const other = await retryRecords(first.id, 'both', 'claude-sonnet-5-5');
    expect(other).not.toBe(first.id);
    await until('other done', finished(other));
    expect(fake.requests.at(-1)?.params.model).toBe('claude-sonnet-5-5');
  });

  it('retries records of a job still being read in a new job that waits for it', async () => {
    await seed(['Ashen Choir', 'Bramble Hound']);
    // Spells are read before monsters: the spell is refused while the hound is still in flight.
    fake.script('Ashen Choir', { type: 'refusal' }).script('Bramble Hound', { type: 'answer', delayMs: 5000 });
    const started = await startJob(SOURCE, choices({ concurrency: 1 }));
    await until('refused', async () => (await byName('Ashen Choir')).runState === 'refused');
    await until('hound in flight', () => runnerSnapshot().inFlight.length === 1);
    const retry = await retryRecords(started.id, 'refused', 'claude-opus-5-5');
    expect(retry).not.toBe(started.id);
    expect((await job(retry)).status).toBe('queued');
    await until('both done', async () => (await job(started.id)).status === 'done' && (await job(retry)).status === 'done', { advance: 500 });
    expect(fake.requestsFor('Ashen Choir')).toHaveLength(2);
    expect(await byName('Ashen Choir')).toMatchObject({ runState: 'done', jobId: retry });
  });

  it('X1: retrying a paused job’s failure reads only that record, in a new job under the consent’s limit; the rest stays paused', async () => {
    await seed(['Ashen Choir', 'Cinder Mote', 'Mothsilk Cloak', 'Bramble Hound', 'Glimmerwing Drake']);
    fake.script('Ashen Choir', { type: 'error', status: 413 });
    for (const t of ['Cinder Mote', 'Mothsilk Cloak', 'Bramble Hound', 'Glimmerwing Drake']) fake.script(t, { type: 'answer', delayMs: 10_000 });
    const started = await startJob(SOURCE, choices({ concurrency: 1 }));
    await until('failed', async () => (await byName('Ashen Choir')).runState === 'failed', { advance: 100 });
    await pauseJob(started.id);
    await until('paused', finished(started.id), { advance: 1000 });
    const paused = await job(started.id);
    expect(paused).toMatchObject({ status: 'paused', pauseReason: 'player', counts: { failed: 1, queued: 3 } });
    const before = fake.requests.length;
    const ashen = await byName('Ashen Choir');

    const retryId = await retryRecords(started.id, 'both', 'claude-opus-5-5', { ids: [ashen.id], budgetUsd: 1 });
    expect(retryId).not.toBe(started.id);
    expect(await job(retryId)).toMatchObject({ budgetUsd: 1, scope: { claudeFor: 'selection', recordIds: [ashen.id] }, estimate: { requests: 1 } });
    await until('retry done', async () => (await job(retryId)).status === 'done', { advance: 1000 });
    await clock.advance(60_000);
    expect(fake.requests.slice(before).map((r) => r.title)).toEqual(['Ashen Choir']);
    expect(await byName('Ashen Choir')).toMatchObject({ runState: 'done', jobId: retryId });
    // The paused job's other records were never resumed.
    expect(await job(started.id)).toMatchObject({ status: 'paused', pauseReason: 'player' });
    for (const name of ['Mothsilk Cloak', 'Bramble Hound', 'Glimmerwing Drake']) expect(await byName(name), name).toMatchObject({ runState: 'queued', jobId: started.id });
  });

  it('X1: retrying part of a finished job’s failures reads them in a job of their own; the rest of them, in that job under the consent’s limit', async () => {
    await seed(['Bramble Hound', 'Glimmerwing Drake', 'Goblin Warrior']);
    for (const t of ['Bramble Hound', 'Glimmerwing Drake', 'Goblin Warrior']) fake.script(t, { type: 'refusal' });
    const first = await startJob(SOURCE, choices({ budgetUsd: null }));
    await until('done', finished(first.id));
    const [hound, drake, goblin] = [await byName('Bramble Hound'), await byName('Glimmerwing Drake'), await byName('Goblin Warrior')];
    // The Goblin Warrior was kept as text since: no retry reads it unless its id is given.
    await putRecords([{ ...goblin, status: 'rejected' }]);
    const before = fake.requests.length;

    // The list was narrowed to the hound: exactly that record, in a job of its own at the consent's limit.
    const own = await retryRecords(first.id, 'refused', 'claude-opus-5-5', { ids: [hound.id], budgetUsd: 1 });
    expect(own).not.toBe(first.id);
    expect(await job(own)).toMatchObject({ budgetUsd: 1, scope: { claudeFor: 'selection', recordIds: [hound.id] }, estimate: { requests: 1 } });
    await until('own done', async () => (await job(own)).status === 'done');
    expect(fake.requests.slice(before).map((r) => r.title)).toEqual(['Bramble Hound']);
    expect((await byName('Glimmerwing Drake')).runState).toBe('refused');

    // All that is left to retry (the drake; the goblin is kept as text): queued again in the finished job.
    const spent = (await job(first.id)).usage.estimatedCostUsd;
    const same = await retryRecords(first.id, 'refused', 'claude-opus-5-5', { ids: [drake.id], budgetUsd: 1 });
    expect(same).toBe(first.id);
    await until('done again', async () => (await job(first.id)).status === 'done' && (await byName('Glimmerwing Drake')).runState === 'done');
    expect(fake.requests.slice(before).map((r) => r.title)).toEqual(['Bramble Hound', 'Glimmerwing Drake']);
    expect((await job(first.id)).budgetUsd).toBe(Math.ceil((spent + 1) * 100) / 100);
    expect((await byName('Goblin Warrior')).runState).toBe('refused');
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

  it('prices the rest at the new model when a job resumes with another model', async () => {
    await seed(['Ashen Choir', 'Bramble Hound']);
    fake.script('Ashen Choir', { type: 'answer', delayMs: 1000 });
    const started = await startJob(SOURCE, choices({ model: 'claude-haiku-5-5', concurrency: 1 }));
    const haikuPerMonster = started.estimate.byKind.monster!.usd;
    await until('in flight', () => runnerSnapshot().inFlight.length === 1);
    await pauseJob(started.id);
    await until('paused', finished(started.id), { advance: 500 });
    await resumeJob(started.id, { model: 'claude-opus-5-5' });
    await until('done', async () => (await job(started.id)).status === 'done', { advance: 500 });
    const resumed = await job(started.id);
    expect(resumed).toMatchObject({ model: 'claude-opus-5-5', estimate: { model: 'claude-opus-5-5', requests: 1 } });
    expect(resumed.estimate.byKind.monster!.usd).toBeGreaterThan(10 * haikuPerMonster);
    expect(fake.requestsFor('Bramble Hound')[0].params.model).toBe('claude-opus-5-5');
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
