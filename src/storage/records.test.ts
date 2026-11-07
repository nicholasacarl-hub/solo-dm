import { beforeEach, describe, expect, it } from 'vitest';
import type { CompendiumEntry, LibrarySource } from '@/types';
import { sampleCombat } from '@/test/fixtures';
import {
  deleteHomebrewRecord,
  deleteLibrarySource,
  deleteTranscriptAfter,
  getCampaign,
  getLibraryEntries,
  getTranscript,
  listHomebrew,
  listLibrarySources,
  loadCampaignRecords,
  putCombat,
  putHomebrew,
  saveLibrarySource,
  setLibrarySourceEnabled,
} from '@/storage';
import { db } from './db';
import { resetDatabase, seedCampaign, sharedHomebrew } from './testData';

beforeEach(resetDatabase);

describe('loadCampaignRecords', () => {
  it('returns null for an unknown campaign', async () => {
    expect(await loadCampaignRecords('missing')).toBeNull();
  });

  it('loads everything in order, with only the active session transcript', async () => {
    const graph = await seedCampaign('a');
    await seedCampaign('b');
    await putHomebrew(sharedHomebrew());
    // Store rows out of order to prove the indexes order them.
    await db.log.bulkPut([...graph.log].reverse());

    const records = await loadCampaignRecords('a-camp');

    expect(records?.campaign.id).toBe('a-camp');
    expect(records?.character?.id).toBe('a-char');
    expect(records?.sessions.map((s) => s.number)).toEqual([1, 2]);
    expect(records?.transcript.map((m) => m.id)).toEqual(['a-t3', 'a-t4', 'a-t5']);
    expect(records?.log.map((e) => e.seq)).toEqual(graph.log.map((e) => e.seq));
    expect(records?.log.every((e) => e.campaignId === 'a-camp')).toBe(true);
    expect(records?.combat).toEqual(graph.combat);
    expect(records?.journal.map((j) => j.id)).toEqual(['a-j-1', 'a-j-2', 'a-j-3', 'a-j-4']);
    expect(records?.quests).toHaveLength(2);
    expect(records?.clocks).toHaveLength(2);
    expect(records?.homebrew.map((h) => h.name)).toEqual(['Fireblade', 'Lantern Oil']);
  });

  it('has no transcript without an active session', async () => {
    await seedCampaign('a', { campaign: { activeSessionId: null } });
    expect((await loadCampaignRecords('a-camp'))?.transcript).toEqual([]);
  });
});

describe('transcript records', () => {
  it('getTranscript orders by seq and deleteTranscriptAfter only trims later messages of that session', async () => {
    await seedCampaign('a');
    expect((await getTranscript('a-sess-2')).map((m) => m.seq)).toEqual([1, 2, 3]);

    await deleteTranscriptAfter('a-sess-2', 1);

    expect((await getTranscript('a-sess-2')).map((m) => m.id)).toEqual(['a-t3']);
    expect((await getTranscript('a-sess-1')).map((m) => m.id)).toEqual(['a-t1', 'a-t2']);
  });
});

describe('putCombat', () => {
  it('stores the tracker and removes it with null', async () => {
    await putCombat('x', sampleCombat());
    expect((await db.combat.get('x'))?.state.round).toBe(2);
    await putCombat('x', null);
    expect(await db.combat.get('x')).toBeUndefined();
  });
});

describe('homebrew', () => {
  it('lists all, shared only, or a campaign plus shared', async () => {
    await seedCampaign('a');
    await seedCampaign('b');
    await putHomebrew(sharedHomebrew('Lantern Oil'));
    await putHomebrew(sharedHomebrew('Amber Ward'));

    expect((await listHomebrew()).map((h) => h.name)).toEqual(['Amber Ward', 'Fireblade', 'Fireblade', 'Lantern Oil']);
    expect((await listHomebrew(null)).map((h) => h.name)).toEqual(['Amber Ward', 'Lantern Oil']);
    expect((await listHomebrew('a-camp')).map((h) => h.id)).toEqual([
      'hb:shared-Amber Ward',
      'hb:a-fireblade',
      'hb:shared-Lantern Oil',
    ]);
  });

  it('bumps the owning campaign so cloud sync notices edits made in the Library', async () => {
    const graph = await seedCampaign('a', { campaign: { updatedAt: 1000 } });
    await putHomebrew({ ...graph.homebrew[0], text: 'Now on fire.' });
    const afterPut = (await getCampaign('a-camp'))?.updatedAt ?? 0;
    expect(afterPut).toBeGreaterThan(1000);

    await deleteHomebrewRecord(graph.homebrew[0].id);
    expect((await getCampaign('a-camp'))?.updatedAt).toBeGreaterThan(afterPut);
    expect(await listHomebrew('a-camp')).toEqual([]);
  });
});

describe('library', () => {
  const source = (id: string, overrides: Partial<LibrarySource> = {}): LibrarySource => ({
    id,
    title: `Source ${id}`,
    kind: 'import',
    format: 'markdown',
    enabled: true,
    entryCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });
  const entry = (sourceId: string, n: number): CompendiumEntry => ({
    id: `lib:${sourceId}:${n}`,
    sourceId,
    sourceName: `Source ${sourceId}`,
    kind: 'rule',
    name: `Rule ${n}`,
    text: `Text ${n}`,
  });

  it('saves a source, replaces its entries, toggles and deletes it', async () => {
    await saveLibrarySource(source('notes'), [entry('notes', 1), entry('notes', 2), entry('notes', 3)]);
    await saveLibrarySource(source('notes', { title: 'My notes' }), [entry('notes', 4)]);

    const [saved] = await listLibrarySources();
    expect(saved).toMatchObject({ id: 'notes', title: 'My notes', entryCount: 1 });
    expect((await getLibraryEntries(['notes'])).map((e) => e.id)).toEqual(['lib:notes:4']);

    await setLibrarySourceEnabled('notes', false);
    expect((await listLibrarySources())[0].enabled).toBe(false);
    await expect(setLibrarySourceEnabled('missing', true)).rejects.toThrow(/no longer exists/);

    await deleteLibrarySource('notes');
    expect(await listLibrarySources()).toEqual([]);
    expect(await db.libraryEntries.count()).toBe(0);
  });

  it('defaults to entries of enabled imported sources, and sorts built-in sources first', async () => {
    await saveLibrarySource(source('b-on'), [entry('b-on', 1)]);
    await saveLibrarySource(source('a-off', { enabled: false }), [entry('a-off', 1)]);
    await saveLibrarySource(source('srd', { kind: 'builtin', title: 'SRD 5.2.1' }), [entry('srd', 1)]);

    expect((await getLibraryEntries()).map((e) => e.id)).toEqual(['lib:b-on:1']);
    expect((await getLibraryEntries(['a-off', 'srd'])).map((e) => e.sourceId).sort()).toEqual(['a-off', 'srd']);
    expect(await getLibraryEntries([])).toEqual([]);
    expect((await listLibrarySources()).map((s) => s.id)).toEqual(['srd', 'a-off', 'b-on']);
  });
});
