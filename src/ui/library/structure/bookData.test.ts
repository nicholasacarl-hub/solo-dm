import { describe, expect, it } from 'vitest';
import { extractionJob, gloamwoodEntries, gloamwoodRecords, structuredRecord } from '@/test/structuredFixtures';
import { PARSER_VERSION, type CompendiumEntry, type StructuredRecord } from '@/types';
import {
  acceptBlocker,
  blocksFor,
  compareForReview,
  currentJob,
  defaultBudget,
  entryOrdinal,
  filterRecords,
  hiddenTableIds,
  isConfident,
  jobProgress,
  lookThroughMessage,
  matchesFilter,
  needsRecheck,
  raisedBudget,
  remainingUsd,
  reviewCounts,
  reviewable,
} from './bookData';

const records = gloamwoodRecords();
const byName = (name: string) => records.find((r) => r.name === name) as StructuredRecord;

describe('review order', () => {
  it('reads ordinals numerically, not as strings', () => {
    expect(entryOrdinal('lib:gloam:10')).toBe(10);
    expect(entryOrdinal('lib:gloam:2')).toBeLessThan(entryOrdinal('lib:gloam:10'));
    expect(entryOrdinal('lib:gloam:class:wickwright')).toBe(Number.POSITIVE_INFINITY);
  });

  it('puts character options first, then reading order, then table rows', () => {
    const sorted = reviewable(records).map((r) => r.kind);
    expect(sorted.indexOf('class')).toBeLessThan(sorted.indexOf('spell'));
    expect(sorted.lastIndexOf('feat')).toBeLessThan(sorted.indexOf('monster'));
    const a = structuredRecord('item', 'Row B', { span: 'row', rowIndex: 1, entryIds: ['lib:gloam:3'] });
    const b = structuredRecord('item', 'Row A', { span: 'row', rowIndex: 0, entryIds: ['lib:gloam:3'] });
    expect([a, b].sort(compareForReview).map((r) => r.name)).toEqual(['Row A', 'Row B']);
  });
});

describe('blocks', () => {
  const entry = (id: string, name: string, path: string[] = []): CompendiumEntry => ({
    id, sourceId: 'gloam', sourceName: 'Gloamwood', kind: 'rule', name, path, text: `${name} first.\n\n${name} second.`,
  });

  it('joins a "(part N)" chain into one block and numbers blocks B1, B2…', () => {
    const entries = [entry('lib:gloam:1', 'Lantern Lore'), entry('lib:gloam:2', 'Lantern Lore (part 2)'), entry('lib:gloam:3', 'Wicks', ['Lantern Lore'])];
    const blocks = blocksFor(entries.map((e) => e.id), new Map(entries.map((e) => [e.id, e])));
    expect(blocks.map((b) => [b.id, b.title, b.entryIds])).toEqual([
      ['B1', 'Lantern Lore', ['lib:gloam:1', 'lib:gloam:2']],
      ['B2', 'Wicks', ['lib:gloam:3']],
    ]);
    expect(blocks[0].paragraphs).toHaveLength(4);
  });

  it('builds the blocks of a fixture record from the book', () => {
    const entries = gloamwoodEntries();
    const mothkin = byName('Mothkin');
    const blocks = blocksFor(mothkin.entryIds, new Map(entries.map((e) => [e.id, e])));
    expect(blocks.map((b) => b.title)).toEqual(['Mothkin', 'Mothkin Lineages']);
    expect(blocks[0].paragraphs.length).toBeGreaterThanOrEqual(10);
  });
});

describe('filters and counts', () => {
  it('hides a gear table whose rows exist', () => {
    const table = byName('Gloamwood Arms');
    expect(hiddenTableIds(records)).toEqual(new Set([table.id]));
    expect(reviewable(records).some((r) => r.id === table.id)).toBe(false);
  });

  it('counts the chips the way the states read', () => {
    const counts = reviewCounts(reviewable(records), true);
    expect(counts.unread).toBe(1); // the Goblin Warrior: no data (its ability scores aren't printed)
    expect(counts.review).toBe(counts.all - 1);
    expect(counts.used + counts.text + counts.fix + counts.failed).toBe(0);
    const blocked = { ...byName('Glimmerwing Drake'), warnings: [{ code: 'out-of-range' as const, severity: 'block' as const, field: 'acText', message: 'AC 45' }] };
    expect(reviewCounts([blocked], true).fix).toBe(1);
  });

  it('shows a newer reading of an accepted entry under "To review" too', () => {
    const accepted = { ...byName('Ashen Choir'), status: 'accepted' as const };
    expect(matchesFilter(accepted, 'review', true)).toBe(false);
    const withProposal = { ...accepted, proposal: { data: accepted.data!, warnings: [], adaptations: [], excerpts: [], origin: 'claude' as const, createdAt: 1 } };
    expect(matchesFilter(withProposal, 'review', true)).toBe(true);
    expect(matchesFilter(withProposal, 'used', true)).toBe(true);
    expect(reviewCounts([withProposal], true)).toMatchObject({ review: 1, used: 1, all: 1 });
  });

  it('filters by chip, kind and name', () => {
    const list = reviewable(records);
    expect(filterRecords(list, { filter: 'unread', kind: null, q: '' }, true).map((r) => r.name)).toEqual(['Goblin Warrior']);
    expect(filterRecords(list, { filter: 'all', kind: 'spell', q: '' }, true).map((r) => r.name)).toEqual(['Ashen Choir', 'Cinder Mote']);
    expect(filterRecords(list, { filter: 'all', kind: null, q: 'drake' }, true).map((r) => r.name)).toEqual(['Glimmerwing Drake']);
  });
});

describe('what may be accepted', () => {
  it('"Accept N confident" takes clean reads only, never classes or subclasses (D22)', () => {
    expect(isConfident(byName('Hookstaff'))).toBe(true);
    expect(isConfident(byName('Bramble Hound'))).toBe(true); // an info note doesn't lower confidence
    expect(isConfident(byName('Wickwright'))).toBe(false);
    expect(isConfident({ ...byName('Ember Warden'), confidence: 'high' })).toBe(false);
    expect(isConfident(byName('Goblin Warrior'))).toBe(false);
    const drake = byName('Glimmerwing Drake');
    expect(isConfident({ ...drake, warnings: [{ code: 'cross-check', severity: 'warn', field: 'hpText', message: 'HP' }] })).toBe(false);
    expect(isConfident({ ...drake, warnings: [{ code: 'name-collision', severity: 'info', message: 'SRD has one' }] })).toBe(false);
    expect(isConfident({ ...drake, status: 'accepted' })).toBe(false);
    expect(isConfident({ ...drake, runState: 'running' })).toBe(false);
    expect(isConfident({ ...drake, schemaVersion: 99 })).toBe(false);
  });

  it('says why a record can not be accepted', () => {
    expect(acceptBlocker(byName('Ashen Choir'))).toBeNull();
    expect(acceptBlocker(byName('Goblin Warrior'))).toMatch(/Not read yet|Fix 1 problem/);
    expect(acceptBlocker({ ...byName('Glimmerwing Drake'), warnings: [{ code: 'out-of-range', severity: 'block', field: 'acText', message: 'AC 45' }] })).toBe(
      'Fix 1 problem to accept.',
    );
    const { parentClassId: _p, ...noParent } = byName('Ember Warden');
    expect(acceptBlocker(noParent as StructuredRecord)).toBe('Choose the class it attaches to.');
    expect(acceptBlocker({ ...byName('Ashen Choir'), schemaVersion: 2 })).toMatch(/newer version/);
  });
});

describe('jobs', () => {
  const counts = { queued: 130, running: 3, done: 60, failed: 2, refused: 1, skipped: 0 };
  const usage = { requests: 63, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 1.05 };

  it('counts what is read and what is left', () => {
    expect(jobProgress({ counts })).toEqual({ finished: 63, total: 196, left: 133, done: 60, failed: 2, refused: 1, inFlight: 3 });
  });

  it('projects the rest from the measured mean once five requests are in', () => {
    const job = extractionJob({ counts, usage, estimate: { ...extractionJob().estimate, requests: 199, usd: 3.2 } });
    expect(remainingUsd(job)).toBeCloseTo(133 * (1.05 / 63));
    const early = extractionJob({ counts, usage: { ...usage, requests: 3 }, estimate: { ...job.estimate } });
    expect(remainingUsd(early)).toBeCloseTo(133 * (3.2 / 199));
  });

  it('offers a raised limit that covers the rest, and a default limit of the high estimate rounded up', () => {
    const job = extractionJob({ counts, usage: { ...usage, estimatedCostUsd: 5.97 }, budgetUsd: 6, estimate: { ...extractionJob().estimate, requests: 199, usd: 3.2 } });
    expect(raisedBudget(job)).toBeGreaterThan(6);
    expect(Number.isInteger(raisedBudget(job))).toBe(true);
    expect(defaultBudget(5.1)).toBe(6);
    expect(defaultBudget(0.13)).toBe(1);
  });

  it("finds the book's live job, else its latest one", () => {
    const old = extractionJob({ id: 'job:old', status: 'done', createdAt: 1 });
    const paused = extractionJob({ id: 'job:paused', status: 'paused', createdAt: 2 });
    const other = extractionJob({ id: 'job:other', sourceId: 'elsewhere', status: 'running', createdAt: 3 });
    expect(currentJob([old, paused, other], 'gloam')).toEqual({ live: paused, last: null });
    expect(currentJob([old, other], 'gloam')).toEqual({ live: null, last: old });
    expect(currentJob(undefined, 'gloam')).toEqual({ live: null, last: null });
  });
});

describe('looking through the book again', () => {
  const found = { total: 22, readyOffline: 20, needClaude: 2, removed: {}, doubted: [] };
  const doubt = (id: string, status: StructuredRecord['status'], kind: StructuredRecord['kind'] = 'feat') => ({ id, kind, status });

  it('says what it found', () => {
    expect(lookThroughMessage(found, 0)).toBe('Found 22: 20 read on this device, 2 need Claude.');
    expect(lookThroughMessage({ ...found, total: 0, readyOffline: 0, needClaude: 0 }, 0)).toBe(
      'Nothing here looks like something the app can use. All entries › Structure as… marks it by hand.',
    );
  });

  it("names what an earlier version found by mistake and nobody had reviewed", () => {
    expect(lookThroughMessage({ ...found, removed: { feat: 17, spell: 1 } }, 0)).toBe(
      "Found 22: 20 read on this device, 2 need Claude. Removed 17 feats and 1 spell an earlier version of the reader found by mistake (you hadn't reviewed them).",
    );
  });

  it('says where the reviewed ones went', () => {
    expect(lookThroughMessage({ ...found, doubted: [doubt('a', 'accepted'), doubt('b', 'accepted')] }, 2)).toBe(
      "Found 22: 20 read on this device, 2 need Claude. 2 entries you had accepted don't look like feats: they're back in To review, with a note.",
    );
    expect(lookThroughMessage({ ...found, doubted: [doubt('a', 'accepted')] }, 1)).toMatch(/ 1 entry you had accepted doesn't look like a feat: it's back in To review, with a note\.$/);
    expect(lookThroughMessage({ ...found, doubted: [doubt('a', 'pending')] }, 0)).toMatch(/ 1 entry you had edited doesn't look like a feat: it has a note in To review\.$/);
    expect(lookThroughMessage({ ...found, doubted: [doubt('a', 'accepted'), doubt('b', 'pending', 'spell')] }, 1)).toMatch(
      / 2 entries you had reviewed may have been misread: they're in To review, with a note\.$/,
    );
  });
});

describe('what "Re-check" looks at', () => {
  const old = (patch: Partial<StructuredRecord> = {}) => ({ ...byName('Lantern Bearer'), origin: 'parser' as const, parserVersion: 1, ...patch });
  it('counts records an earlier offline reader made, except those kept as text, being read or from a newer app', () => {
    expect(needsRecheck(old())).toBe(true);
    expect(needsRecheck(old({ status: 'accepted' }))).toBe(true);
    expect(needsRecheck(old({ parserVersion: undefined }))).toBe(true);
    expect(needsRecheck(old({ parserVersion: PARSER_VERSION }))).toBe(false);
    expect(needsRecheck(old({ status: 'rejected' }))).toBe(false);
    expect(needsRecheck(old({ runState: 'queued' }))).toBe(false);
    expect(needsRecheck(old({ runState: 'running' }))).toBe(false);
    expect(needsRecheck(old({ origin: 'claude' }))).toBe(false);
    expect(needsRecheck(old({ schemaVersion: 99 }))).toBe(false);
  });
});
