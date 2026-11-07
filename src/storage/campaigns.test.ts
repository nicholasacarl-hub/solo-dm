import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sampleSettings } from '@/test/fixtures';
import {
  createCampaign,
  deleteCampaign,
  duplicateCampaign,
  exportCampaignBundle,
  getCampaign,
  importCampaignBundle,
  listCampaigns,
  OPEN_ELSEWHERE_ERROR,
  putHomebrew,
} from '@/storage';
import { db } from './db';
import { allIds, campaignGraph, resetDatabase, seedCampaign, sharedHomebrew } from './testData';

beforeEach(resetDatabase);

describe('createCampaign', () => {
  it('creates a save slot with the documented defaults', async () => {
    const before = Date.now();
    const c = await createCampaign({
      name: '  The Drowned Lantern ',
      premise: 'A lighthouse keeper vanished.',
      settings: sampleSettings(),
      coverEmoji: '🏮',
    });
    expect(c).toMatchObject({
      name: 'The Drowned Lantern',
      premise: 'A lighthouse keeper vanished.',
      status: 'setup',
      scene: { location: 'Unknown' },
      tension: 5,
      sessionCount: 0,
      activeSessionId: null,
      characterId: null,
      lastPlayedAt: null,
      coverEmoji: '🏮',
      settings: sampleSettings(),
      usage: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 },
    });
    expect(c.id).toMatch(/[0-9a-f-]{36}/);
    expect(c.createdAt).toBeGreaterThanOrEqual(before);
    expect(c.updatedAt).toBe(c.createdAt);
    expect('coverColor' in c).toBe(false);
    expect(await getCampaign(c.id)).toEqual(c);
  });

  it('names an unnamed campaign', async () => {
    const c = await createCampaign({ name: '   ', premise: '', settings: sampleSettings() });
    expect(c.name).toBe('Untitled campaign');
  });

  it('getCampaign resolves undefined for unknown ids', async () => {
    expect(await getCampaign('nope')).toBeUndefined();
  });
});

describe('listCampaigns', () => {
  it('sorts by last played (never played last), then newest created, and joins the character', async () => {
    await seedCampaign('a', {
      campaign: { lastPlayedAt: 1000, createdAt: 10 },
      character: {
        classes: [
          { classId: 'srd:class:wizard', name: 'Wizard', level: 3, hitDie: 6, casterType: 'full' },
          { classId: 'srd:class:fighter', name: 'Fighter', level: 2, hitDie: 10, casterType: 'none' },
        ],
      },
    });
    await seedCampaign('b', { campaign: { lastPlayedAt: 3000, createdAt: 20 } });
    await seedCampaign('c', { campaign: { lastPlayedAt: null, createdAt: 50 } });
    await seedCampaign('d', { campaign: { lastPlayedAt: null, createdAt: 60 } });
    await seedCampaign('e', { campaign: { lastPlayedAt: 3000, createdAt: 40 } });
    const fresh = await createCampaign({ name: 'Fresh', premise: '', settings: sampleSettings() });

    const list = await listCampaigns();

    expect(list.map((s) => s.campaign.id)).toEqual(['e-camp', 'b-camp', 'a-camp', fresh.id, 'd-camp', 'c-camp']);
    const a = list.find((s) => s.campaign.id === 'a-camp');
    expect(a?.level).toBe(5);
    expect(a?.character).toEqual({
      id: 'a-char',
      name: 'Mira Voss',
      species: 'Elf (High Elf lineage)',
      classes: expect.any(Array),
      portrait: '🧝‍♀️',
      hp: { max: 17, current: 12, temp: 0 },
      xp: 900,
    });
    expect(list.find((s) => s.campaign.id === 'b-camp')?.level).toBe(3);
    const empty = list.find((s) => s.campaign.id === fresh.id);
    expect(empty).toMatchObject({ character: null, level: 0 });
  });

  it('treats a dangling character link as no character', async () => {
    await seedCampaign('a');
    await db.characters.delete('a-char');
    const [summary] = await listCampaigns();
    expect(summary).toMatchObject({ character: null, level: 0 });
  });
});

describe('deleteCampaign', () => {
  it('cascades to every table and leaves other campaigns and shared homebrew alone', async () => {
    const a = await seedCampaign('a');
    const b = await seedCampaign('b');
    await putHomebrew(sharedHomebrew());

    await deleteCampaign('a-camp');

    expect(await getCampaign('a-camp')).toBeUndefined();
    const remaining = new Set<string>();
    for (const table of db.tables) {
      const keys = await table.toCollection().primaryKeys();
      for (const key of keys) remaining.add(String(key));
    }
    for (const id of allIds(a)) expect(remaining.has(id), id).toBe(false);
    expect(await db.combat.get('a-camp')).toBeUndefined();
    for (const id of allIds(b)) expect(remaining.has(id), id).toBe(true);
    expect(await db.combat.get('b-camp')).toBeDefined();
    expect(remaining.has(sharedHomebrew().id)).toBe(true);
  });
});

describe('duplicateCampaign', () => {
  it('deep-copies with fresh ids and remaps every reference', async () => {
    const source = await seedCampaign('a');

    const copy = await duplicateCampaign('a-camp');
    const data = await exportCampaignBundle(copy.id);

    expect(copy.name).toBe('Campaign a (copy)');
    expect(data.campaign).toEqual(copy);
    // Nothing shares an id with the original.
    const originalIds = new Set(allIds(source));
    for (const id of allIds(data)) expect(originalIds.has(id), id).toBe(false);

    // Campaign-level links.
    expect(data.character?.campaignId).toBe(copy.id);
    expect(copy.characterId).toBe(data.character?.id);
    const [copyS1, copyS2] = data.sessions;
    expect(copyS1.number).toBe(1);
    expect(copy.activeSessionId).toBe(copyS2.id);
    expect(data.sessions.every((s) => s.campaignId === copy.id)).toBe(true);

    // Transcript and log entries follow their own session.
    const sessionMap = new Map([
      ['a-sess-1', copyS1.id],
      ['a-sess-2', copyS2.id],
    ]);
    expect(data.transcript.map((m) => m.sessionId)).toEqual(source.transcript.map((m) => sessionMap.get(m.sessionId)));
    expect(data.transcript.map((m) => m.param)).toEqual(source.transcript.map((m) => m.param));
    expect(data.log.map((e) => e.sessionId)).toEqual(source.log.map((e) => (e.sessionId ? sessionMap.get(e.sessionId) : null)));
    expect(data.log.map((e) => e.seq)).toEqual(source.log.map((e) => e.seq));
    for (const rows of [data.log, data.journal, data.quests, data.clocks, data.homebrew]) {
      expect(rows.every((r) => r.campaignId === copy.id)).toBe(true);
    }
    // Ties in createdAt are ordered by id, so compare as sets.
    expect(data.journal.map((j) => j.name).sort()).toEqual(source.journal.map((j) => j.name).sort());

    // Homebrew ids are fresh (still "hb:") and the sheet / tracker point at the copies.
    const [hb] = data.homebrew;
    expect(hb.id).toMatch(/^hb:/);
    expect(data.character?.features.find((f) => f.name === 'Fireblade Training')?.homebrewId).toBe(hb.id);
    const item = data.character?.inventory.find((i) => i.name === 'Fireblade');
    expect(item).toMatchObject({ homebrewId: hb.id, compendiumId: hb.id });
    expect(data.combat?.combatants.find((c) => c.name === 'Bandit 1')?.statBlockId).toBe(hb.id);
    // References to SRD content are untouched.
    expect(data.character?.spellcasting?.spells.map((s) => s.id)).toEqual(source.character?.spellcasting?.spells.map((s) => s.id));

    // The original is unchanged.
    const original = await exportCampaignBundle('a-camp');
    const { exportedAt: _e, format: _f, version: _v, ...originalData } = original;
    expect(originalData).toEqual(campaignGraph('a'));
  });

  it('uses the given name', async () => {
    await seedCampaign('a');
    const copy = await duplicateCampaign('a-camp', '  Branch: before the duel ');
    expect(copy.name).toBe('Branch: before the duel');
    expect((await listCampaigns()).length).toBe(2);
  });

  it('rejects for a missing campaign', async () => {
    await expect(duplicateCampaign('missing')).rejects.toThrow(/no longer exists/);
  });
});

describe('a campaign open at the table in another tab', () => {
  beforeEach(() => {
    // Another tab holds the campaign's Web Lock.
    Object.defineProperty(window.navigator, 'locks', {
      configurable: true,
      value: {
        request: () => new Promise(() => {}),
        query: async () => ({ held: [{ name: 'solo-dm:campaign:a-camp', mode: 'exclusive' }], pending: [] }),
      },
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(window.navigator, 'locks');
  });

  it('is not deleted or replaced from here (that tab would write it back); copies and other campaigns are fine', async () => {
    await seedCampaign('a');
    await seedCampaign('b');
    const bundle = await exportCampaignBundle('a-camp');

    await expect(deleteCampaign('a-camp')).rejects.toThrow(OPEN_ELSEWHERE_ERROR);
    await expect(importCampaignBundle(bundle, 'replace')).rejects.toThrow(OPEN_ELSEWHERE_ERROR);
    expect(await getCampaign('a-camp')).toEqual(bundle.campaign);

    const copy = await importCampaignBundle(bundle, 'copy');
    expect(copy.id).not.toBe('a-camp');
    await deleteCampaign('b-camp');
    expect(await getCampaign('b-camp')).toBeUndefined();
  });
});
