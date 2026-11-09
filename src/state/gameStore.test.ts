import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeroMoveRequest } from '@/engine/movement';
import type { CombatState, GridPoint, InteractionResponse, LogEntry } from '@/types';
import { importedPlaceholder } from '@/lib/importedContent';
import { sampleCharacter, sampleMappedCombat, sampleSession, sampleSettings, sampleStopCombat, zeroUsage } from '@/test/fixtures';
import { EXPECTED_MERGED, GLOAMWOOD_TITLE } from '@/test/structuredFixtures';
import * as storage from '@/storage';
import { db } from '@/storage/db';
import { emitCampaignChange } from '@/storage/events';
import { resetDatabase, seedCampaign } from '@/storage/testData';
import {
  canUndoHeroMove,
  heroMoveBlock,
  initialDmStatus,
  pendingPlayerStop,
  queueCampaignNotice,
  STREAM_CHECKPOINT_MS,
  useGame,
  whenPersisted,
  type HeroMoveResult,
  type HeroMoveSnapshot,
} from './gameStore';

// Real storage (fake-indexeddb), with some writes wrapped so a test can make one fail or check their order.
vi.mock('@/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/storage')>();
  return {
    ...actual,
    putLog: vi.fn(actual.putLog),
    putTranscript: vi.fn(actual.putTranscript),
    putCombat: vi.fn(actual.putCombat),
    putCharacter: vi.fn(actual.putCharacter),
    isCampaignOpenElsewhere: vi.fn(actual.isCampaignOpenElsewhere),
  };
});

// The store loads @/data lazily for restore (spec §7.4): the real pure restore over this device's "library".
const libraryLookup = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/data', async () => {
  const restore = await import('@/data/structured/restore');
  const fixtures = await import('@/test/structuredFixtures');
  return {
    restoreImportedText: restore.restoreImportedText,
    buildLibraryLookup: async () => {
      libraryLookup.calls += 1;
      return { entriesById: new Map(), sourcesByFingerprint: new Map(), sourcesByTitle: new Map(), builder: fixtures.EXPECTED_MERGED };
    },
  };
});

const game = () => useGame.getState();

async function loadSeeded(tag = 'a', opts?: Parameters<typeof seedCampaign>[1]) {
  const graph = await seedCampaign(tag, opts);
  await game().loadCampaign(graph.campaign.id);
  return graph;
}

beforeEach(async () => {
  game().unloadCampaign();
  await whenPersisted();
  await resetDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
  // Back to the real implementations (restoreAllMocks only undoes vi.spyOn).
  for (const fn of [storage.putLog, storage.putTranscript, storage.putCombat, storage.putCharacter, storage.isCampaignOpenElsewhere]) {
    vi.mocked(fn).mockReset();
  }
});

describe('restoreImportedText (spec §7.4)', () => {
  const placeholder = importedPlaceholder(GLOAMWOOD_TITLE);
  const ember = EXPECTED_MERGED.classes.find((c) => c.id === 'srd:class:fighter')?.subclasses.find((x) => x.name === 'Ember Warden');
  const def = ember?.features[0];
  if (!def?.ref) throw new Error('fixture changed');
  const pulledFeature = { id: 'f-ember', name: 'Ember Ward', source: 'subclass' as const, sourceName: 'Ember Warden 3', description: placeholder, ref: { ...def.ref, redacted: true as const } };

  it('fills book text back after a load and writes the character as is (same updatedAt, campaign row untouched)', async () => {
    const graph = await seedCampaign('a', { character: { features: [...sampleCharacter().features, pulledFeature] } });
    const storedCampaign = await db.campaigns.get('a-camp');
    const storedCharacter = await db.characters.get(graph.character?.id as string);
    await game().loadCampaign('a-camp');
    await vi.waitFor(() => expect(game().character?.features.find((f) => f.id === 'f-ember')?.description).toBe(def.description));
    await whenPersisted();
    const after = await db.characters.get(graph.character?.id as string);
    expect(after?.features.find((f) => f.id === 'f-ember')).toMatchObject({ description: def.description, ref: { entryId: def.ref?.entryId } });
    expect(after?.features.find((f) => f.id === 'f-ember')?.ref?.redacted).toBeUndefined();
    expect(after?.updatedAt).toBe(storedCharacter?.updatedAt);
    expect(game().character?.updatedAt).toBe(storedCharacter?.updatedAt);
    expect(await db.campaigns.get('a-camp')).toEqual(storedCampaign);
    expect(game().campaign?.updatedAt).toBe(storedCampaign?.updatedAt);
    // Run again: nothing left to restore.
    expect(await game().restoreImportedText()).toBeNull();
  });

  it('reports what stays missing and writes nothing', async () => {
    const unknown = { ...pulledFeature, ref: { ...pulledFeature.ref, entryId: 'lib:elsewhere:subclass:x', entryName: 'Unknown Order', part: 'Unknown Gift', textHash: 'ffff' } };
    await loadSeeded('a', { character: { features: [unknown] } });
    vi.mocked(storage.putCharacter).mockClear();
    const report = await game().restoreImportedText();
    expect(report).toEqual({ restored: 0, differs: 0, missing: [{ book: GLOAMWOOD_TITLE, entryName: 'Unknown Order', part: 'Unknown Gift' }] });
    await whenPersisted();
    expect(storage.putCharacter).not.toHaveBeenCalled();
  });

  it('P3: a ruling written over a pulled placeholder drops the stale `redacted`; a write that keeps the placeholder keeps it', async () => {
    // A book this device can't restore from, so the placeholder stays after the load.
    const unknown = { ...pulledFeature, ref: { ...pulledFeature.ref, entryId: 'lib:elsewhere:subclass:x', entryName: 'Unknown Order', part: 'Unknown Gift', textHash: 'ffff' } };
    const graph = await loadSeeded('a', { character: { features: [unknown] } });
    const stored = async () => (await db.characters.get(graph.character?.id as string))?.features.find((f) => f.id === 'f-ember');
    await game().updateCharacter((c) => ({ ...c, heroicInspiration: !c.heroicInspiration }));
    await whenPersisted();
    expect(await stored()).toMatchObject({ description: placeholder, ref: { redacted: true } });
    const ruling = 'DM ruling: once per turn, add 1d4 fire damage.';
    await game().updateCharacter((c) => ({ ...c, features: c.features.map((f) => (f.id === 'f-ember' ? { ...f, description: ruling } : f)) }));
    await whenPersisted();
    const after = await stored();
    expect(after).toMatchObject({ description: ruling, ref: { textCopied: true, entryId: 'lib:elsewhere:subclass:x' } });
    expect(after?.ref?.redacted).toBeUndefined();
  });

  it('P3: leaves a ruling the DM wrote over a pulled placeholder alone (its stale `redacted` asks for nothing)', async () => {
    const ruling = { ...pulledFeature, description: 'DM ruling: once per turn, add 1d4 fire damage.' };
    const before = libraryLookup.calls;
    await loadSeeded('a', { character: { features: [ruling] } });
    expect(await game().restoreImportedText()).toBeNull();
    expect(libraryLookup.calls).toBe(before);
    expect(game().character?.features.find((f) => f.id === 'f-ember')?.description).toBe(ruling.description);
  });

  it('is a no-op (null, the library untouched) without a ref needing it', async () => {
    await loadSeeded('a');
    const before = libraryLookup.calls;
    expect(await game().restoreImportedText()).toBeNull();
    expect(libraryLookup.calls).toBe(before);
    game().unloadCampaign();
    expect(await game().restoreImportedText()).toBeNull();
  });
});

describe('loading', () => {
  it('loads every record and the active session with its transcript', async () => {
    const graph = await loadSeeded('a');
    const s = game();
    expect(s).toMatchObject({ campaignId: 'a-camp', loading: false, loadError: null });
    expect(s.campaign).toEqual(graph.campaign);
    expect(s.character).toEqual(graph.character);
    expect(s.sessions.map((x) => x.id)).toEqual(['a-sess-1', 'a-sess-2']);
    expect(s.activeSession?.id).toBe('a-sess-2');
    expect(s.transcript.map((m) => m.id)).toEqual(['a-t3', 'a-t4', 'a-t5']);
    expect(s.log).toHaveLength(12);
    expect(s.combat?.round).toBe(2);
    expect(s.journal).toHaveLength(4);
    expect(s.quests).toHaveLength(2);
    expect(s.clocks).toHaveLength(2);
    expect(s.homebrew.map((h) => h.name)).toEqual(['Fireblade']);
  });

  it('reports a missing campaign', async () => {
    await game().loadCampaign('missing');
    expect(game()).toMatchObject({ campaign: null, loading: false, loadError: expect.stringMatching(/could not be found/) });
  });

  it('switching campaigns replaces the state and cancels pending interactions', async () => {
    await loadSeeded('a');
    await seedCampaign('b');
    game().queueDmNotice('Player edited the sheet.');
    const pending = game().requestInteraction({ kind: 'confirm', id: 'i1', title: 'Sure?', body: '' });
    const rejected = expect(pending).rejects.toThrow('cancelled');

    await game().loadCampaign('b-camp');

    await rejected;
    expect(game()).toMatchObject({ campaignId: 'b-camp', interaction: null, pendingDmNotices: [] });
    expect(game().log.every((e) => e.campaignId === 'b-camp')).toBe(true);
  });

  it('unloadCampaign clears everything; actions then reject clearly', async () => {
    await loadSeeded('a');
    game().unloadCampaign();
    expect(game()).toMatchObject({ campaignId: null, campaign: null, log: [], character: null });
    await expect(game().appendLog({ kind: 'player', text: 'hi' })).rejects.toThrow('No campaign is loaded.');
  });
});

describe('updateCampaign', () => {
  it('patches or maps the campaign, bumps updatedAt and persists', async () => {
    const graph = await loadSeeded('a');
    const patched = await game().updateCampaign({ name: 'Renamed', id: 'hijack' });
    expect(patched).toMatchObject({ id: 'a-camp', name: 'Renamed' });
    expect(patched.updatedAt).toBeGreaterThan(graph.campaign.updatedAt);

    const mapped = await game().updateCampaign((c) => ({ ...c, tension: c.tension + 1 }));
    expect(mapped.tension).toBe(6);
    expect(mapped.updatedAt).toBeGreaterThan(patched.updatedAt);
    expect(await storage.getCampaign('a-camp')).toEqual(mapped);
    expect(game().campaign).toEqual(mapped);
  });
});

describe('display log', () => {
  it('appendLog assigns seq = last + 1, the active session, and persists', async () => {
    await loadSeeded('a');
    const first = await game().appendLog({ kind: 'player', text: 'I open the door.' });
    const second = await game().appendLog({ kind: 'dm', text: 'It creaks.', streaming: true });

    expect(first).toMatchObject({ seq: 13, campaignId: 'a-camp', sessionId: 'a-sess-2', kind: 'player' });
    expect(second.seq).toBe(14);
    expect(first.id).not.toBe(second.id);
    expect(game().log.at(-1)).toEqual(second);
    expect(await db.log.get(second.id)).toEqual(second);
  });

  it('uses a null sessionId outside a session, and starts at seq 1', async () => {
    const c = await storage.createCampaign({ name: 'Fresh', premise: '', settings: sampleSettings() });
    await game().loadCampaign(c.id);
    const entry = await game().appendLog({ kind: 'system', level: 'info', text: 'Welcome' });
    expect(entry).toMatchObject({ seq: 1, sessionId: null });
  });

  it('keeps seq unique and every entry persisted under rapid, unawaited appends', async () => {
    await loadSeeded('a');
    const writes = Array.from({ length: 25 }, (_, i) => game().appendLog({ kind: 'player', text: `line ${i}` }));
    expect(game().log.slice(-25).map((e) => e.seq)).toEqual(Array.from({ length: 25 }, (_, i) => 13 + i));
    const entries = await Promise.all(writes);
    const stored = await db.log.where('campaignId').equals('a-camp').sortBy('seq');
    expect(stored.slice(-25)).toEqual(entries);
  });

  it('updateLog with persist:false changes memory only; persist:true saves', async () => {
    await loadSeeded('a');
    const entry = await game().appendLog({ kind: 'dm', text: '', streaming: true });

    for (const text of ['The', 'The fog', 'The fog parts.']) {
      await game().updateLog(entry.id, { text }, { persist: false });
    }
    expect(game().log.at(-1)).toMatchObject({ text: 'The fog parts.', streaming: true });
    expect(await db.log.get(entry.id)).toMatchObject({ text: '', streaming: true });

    await game().updateLog(entry.id, { text: 'The fog parts.', streaming: false, seq: 99, id: 'x' } as Partial<LogEntry>);
    const stored = await db.log.get(entry.id);
    expect(stored).toMatchObject({ text: 'The fog parts.', streaming: false, seq: entry.seq, id: entry.id });
    expect(game().log.at(-1)).toEqual(stored);
  });

  it('updateLog ignores unknown entries and removeLog deletes', async () => {
    await loadSeeded('a');
    await expect(game().updateLog('nope', { text: 'x' } as Partial<LogEntry>)).resolves.toBeUndefined();
    const [a, b] = game().log;
    await game().removeLog([a.id, b.id]);
    expect(game().log.map((e) => e.id)).not.toContain(a.id);
    expect(await db.log.bulkGet([a.id, b.id])).toEqual([undefined, undefined]);
  });
});

describe('character', () => {
  it('updateCharacter applies a pure update, bumps updatedAt and persists', async () => {
    const graph = await loadSeeded('a');
    const next = await game().updateCharacter((c) => ({ ...c, hp: { ...c.hp, current: 5 } }));
    expect(next.hp.current).toBe(5);
    expect(next.updatedAt).toBeGreaterThan(graph.character?.updatedAt ?? 0);
    expect(await db.characters.get('a-char')).toEqual(next);
    expect(game().campaign?.updatedAt).toBeGreaterThan(graph.campaign.updatedAt);
  });

  it('serializes rapid updates without losing any', async () => {
    await loadSeeded('a');
    const writes = Array.from({ length: 30 }, () => game().updateCharacter((c) => ({ ...c, xp: c.xp + 10 })));
    await Promise.all(writes);
    expect(game().character?.xp).toBe(900 + 300);
    expect((await db.characters.get('a-char'))?.xp).toBe(1200);
  });

  it('rejects when the campaign has no character yet', async () => {
    const c = await storage.createCampaign({ name: 'Fresh', premise: '', settings: sampleSettings() });
    await game().loadCampaign(c.id);
    await expect(game().updateCharacter((x) => x)).rejects.toThrow(/no character/);
  });

  it('setCharacter links the character and removes the one it replaces', async () => {
    await loadSeeded('a');
    await game().setCharacter(sampleCharacter({ id: 'new-char', campaignId: 'whatever', name: 'Tam' }));
    expect(game().campaign?.characterId).toBe('new-char');
    expect(game().character).toMatchObject({ id: 'new-char', campaignId: 'a-camp' });
    expect(await db.characters.get('a-char')).toBeUndefined();
    expect((await storage.getCampaign('a-camp'))?.characterId).toBe('new-char');
    expect((await storage.loadCampaignRecords('a-camp'))?.character?.name).toBe('Tam');
  });
});

describe('sessions', () => {
  it('startSession and endActiveSession keep the campaign consistent', async () => {
    const c = await storage.createCampaign({ name: 'Fresh', premise: '', settings: sampleSettings() });
    await game().loadCampaign(c.id);

    await game().startSession(sampleSession({ id: 's1', campaignId: c.id, number: 1 }));
    let campaign = await storage.getCampaign(c.id);
    expect(campaign).toMatchObject({ activeSessionId: 's1', sessionCount: 1, status: 'active' });
    expect(campaign?.lastPlayedAt).toEqual(expect.any(Number));
    expect(game().activeSession).toMatchObject({ id: 's1', status: 'active', endedAt: null });

    await game().appendTranscript([{ role: 'user', content: 'Begin.' }]);
    const ended = await game().endActiveSession({ recap: 'We began.' });
    expect(ended).toMatchObject({ id: 's1', status: 'ended', recap: 'We began.' });
    expect(ended?.endedAt).toEqual(expect.any(Number));
    expect(game()).toMatchObject({ activeSession: null, transcript: [] });
    campaign = await storage.getCampaign(c.id);
    expect(campaign).toMatchObject({ activeSessionId: null, sessionCount: 1, status: 'active' });
    expect(await db.sessions.get('s1')).toEqual(ended);
    expect(await game().endActiveSession()).toBeNull();

    await game().startSession(sampleSession({ id: 's2', campaignId: c.id, number: 2 }));
    expect(game().campaign).toMatchObject({ activeSessionId: 's2', sessionCount: 2 });
    expect(game().sessions.map((x) => x.id)).toEqual(['s1', 's2']);
    expect(game().transcript).toEqual([]);
  });

  it('updateSession patches the active session (or one by id)', async () => {
    await loadSeeded('a');
    const updated = await game().updateSession({ contextTokens: 42_000 });
    expect(updated.contextTokens).toBe(42_000);
    expect(game().activeSession).toEqual(updated);
    expect(game().sessions[1]).toEqual(updated);
    await game().updateSession({ recap: 'Edited recap' }, 'a-sess-1');
    expect((await db.sessions.get('a-sess-1'))?.recap).toBe('Edited recap');
    await expect(game().updateSession({}, 'nope')).rejects.toThrow(/not part of this campaign/);
  });
});

describe('transcript', () => {
  it('appends with per-session seq and persists', async () => {
    await loadSeeded('a');
    const added = await game().appendTranscript([
      { role: 'user', content: 'Next turn' },
      { role: 'assistant', content: [{ type: 'text', text: 'Narration' }] },
    ]);
    expect(added.map((m) => m.seq)).toEqual([4, 5]);
    expect(added.every((m) => m.sessionId === 'a-sess-2')).toBe(true);
    expect(game().transcript.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    expect((await storage.getTranscript('a-sess-2')).map((m) => m.id)).toEqual(game().transcript.map((m) => m.id));
  });

  it('requires an active session', async () => {
    await loadSeeded('a', { campaign: { activeSessionId: null } });
    await expect(game().appendTranscript([{ role: 'user', content: 'x' }])).rejects.toThrow(/No active session/);
  });

  it('truncateTranscriptAfter removes only later messages, in memory and storage', async () => {
    await loadSeeded('a');
    await game().appendTranscript([{ role: 'user', content: 'Regenerate me' }]);

    await game().truncateTranscriptAfter(2);

    expect(game().transcript.map((m) => m.seq)).toEqual([1, 2]);
    expect((await storage.getTranscript('a-sess-2')).map((m) => m.seq)).toEqual([1, 2]);
    expect((await storage.getTranscript('a-sess-1')).map((m) => m.seq)).toEqual([1, 2]);
    // Appending continues from the new end.
    const [next] = await game().appendTranscript([{ role: 'user', content: 'Again' }]);
    expect(next.seq).toBe(3);
  });
});

describe('journal, quests and clocks', () => {
  it('upsertJournal merges by kind + name, appends tags without duplicates and tracks sessions', async () => {
    await loadSeeded('a');
    const [tam, newcomer, place] = await game().upsertJournal([
      { kind: 'npc', name: '  old TAM ', status: 'hostile', tags: ['Witness', 'smuggler', 'smuggler'], summary: undefined },
      { kind: 'npc', name: 'Vela', summary: 'A harbor pilot.', tags: ['pilot'] },
      { kind: 'location', name: 'Old Tam', summary: 'The net shed named after him.' },
    ]);

    expect(tam).toMatchObject({
      id: 'a-j-1',
      name: 'Old Tam',
      status: 'hostile',
      summary: 'A one-eyed net mender who saw the lantern light itself.',
      tags: ['dockhand', 'witness', 'smuggler'],
      firstSession: 1,
      lastSession: 2,
    });
    expect(newcomer).toMatchObject({ name: 'Vela', firstSession: 2, lastSession: 2, secret: false, campaignId: 'a-camp' });
    expect(place.id).not.toBe('a-j-1');
    expect(game().journal).toHaveLength(6);
    expect(await db.journal.get('a-j-1')).toEqual(tam);
    expect(await db.journal.get(newcomer.id)).toEqual(newcomer);
  });

  it('does not merge different names that contain no Latin letters', async () => {
    await loadSeeded('a');
    await game().upsertJournal([
      { kind: 'npc', name: 'Иван', summary: 'A ferryman.' },
      { kind: 'npc', name: '龍', summary: 'A dragon.' },
      { kind: 'npc', name: 'иван', status: 'ally' },
    ]);
    const added = game().journal.filter((j) => j.id.length > 10);
    expect(added.map((j) => [j.name, j.summary, j.status])).toEqual([
      ['Иван', 'A ferryman.', 'ally'],
      ['龍', 'A dragon.', undefined],
    ]);
    await game().upsertClock({ name: 'Ярость', segments: 6 });
    await game().upsertClock({ name: 'Ψ', segments: 4, filled: 2 });
    expect(game().clocks.map((c) => c.name)).toEqual(['The tide turns', 'Something stirs below', 'Ярость', 'Ψ']);
  });

  it('upsertJournal renames when matched by id, and uses the session count outside a session', async () => {
    await loadSeeded('a', { campaign: { activeSessionId: null, sessionCount: 4 } });
    const [renamed] = await game().upsertJournal([{ id: 'a-j-1', kind: 'npc', name: 'Tam the Elder' }]);
    expect(renamed).toMatchObject({ id: 'a-j-1', name: 'Tam the Elder', lastSession: 4 });
  });

  it('upsertQuest matches the title case-insensitively and keeps objective ids', async () => {
    await loadSeeded('a');
    const quest = await game().upsertQuest({
      title: 'find keeper halvard',
      status: 'completed',
      objectives: [
        { id: '', text: 'Question Old Tam', done: true },
        { id: '', text: 'Open the lantern room', done: true },
      ],
    });
    expect(quest).toMatchObject({ id: 'a-q-1', title: 'Find Keeper Halvard', status: 'completed', giver: 'Yourself' });
    expect(quest.objectives[0].id).toBe('o-1');
    expect(quest.objectives[1].id).toEqual(expect.any(String));
    expect(await db.quests.get('a-q-1')).toEqual(quest);

    const fresh = await game().upsertQuest({ title: 'Map the drowned ruins' });
    expect(fresh).toMatchObject({ status: 'active', summary: '', objectives: [], campaignId: 'a-camp' });
    expect(game().quests).toHaveLength(3);
  });

  it('keeps objective ids unique and records owned by the loaded campaign', async () => {
    await loadSeeded('a');
    const quest = await game().upsertQuest({
      title: 'Find Keeper Halvard',
      objectives: [
        { id: '', text: 'Question Old Tam', done: true },
        { id: '', text: 'question old tam', done: false },
      ],
    });
    expect(new Set(quest.objectives.map((o) => o.id)).size).toBe(2);

    // A caller spreading a whole record (campaignId included) can't move it to another campaign.
    const [entry] = game().journal;
    const [updated] = await game().upsertJournal([{ ...entry, campaignId: 'elsewhere', summary: 'Edited' } as typeof entry]);
    expect(updated).toMatchObject({ id: entry.id, campaignId: 'a-camp', summary: 'Edited' });
  });

  it('upsertClock clamps filled to 0..segments', async () => {
    await loadSeeded('a');
    expect((await game().upsertClock({ name: 'THE TIDE TURNS', filled: 9 })).filled).toBe(4);
    expect((await game().upsertClock({ name: 'the tide turns', filled: -3 })).filled).toBe(0);
    const shrunk = await game().upsertClock({ name: 'Something stirs below', segments: 1 });
    expect(shrunk).toMatchObject({ id: 'a-clk-2', segments: 1, filled: 1 });
    const created = await game().upsertClock({ name: 'Rival expedition', segments: 6, filled: 8, kind: 'progress' });
    expect(created).toMatchObject({ segments: 6, filled: 6, kind: 'progress', secret: false, resolved: false });
    expect(await db.clocks.get(created.id)).toEqual(created);
    expect(game().clocks).toHaveLength(3);
  });

  it('deletes journal entries, quests and clocks', async () => {
    await loadSeeded('a');
    await game().deleteJournal('a-j-1');
    await game().deleteQuest('a-q-1');
    await game().deleteClock('a-clk-1');
    expect(await db.journal.get('a-j-1')).toBeUndefined();
    expect(await db.quests.get('a-q-1')).toBeUndefined();
    expect(await db.clocks.get('a-clk-1')).toBeUndefined();
    expect(game().journal.map((j) => j.id)).not.toContain('a-j-1');
  });
});

describe('combat, homebrew and usage', () => {
  it('setCombat saves and clears the tracker', async () => {
    await loadSeeded('a');
    await game().setCombat(null);
    expect(game().combat).toBeNull();
    expect(await db.combat.get('a-camp')).toBeUndefined();
  });

  it('saveHomebrew and deleteHomebrew keep the campaign + shared list', async () => {
    await loadSeeded('a');
    const saved = await game().saveHomebrew({
      id: 'hb:shared',
      sourceId: 'homebrew',
      sourceName: 'Homebrew',
      kind: 'boon',
      name: 'Boon of the Tide',
      text: 'Breathe water.',
      campaignId: null,
      origin: 'dm',
      status: 'active',
      createdAt: 0,
      updatedAt: 0,
    });
    expect(saved.createdAt).toBeGreaterThan(0);
    expect(game().homebrew.map((h) => h.name)).toEqual(['Boon of the Tide', 'Fireblade']);
    expect(await db.homebrew.get('hb:shared')).toEqual(saved);
    await game().deleteHomebrew('hb:a-fireblade');
    expect(game().homebrew.map((h) => h.id)).toEqual(['hb:shared']);
    expect(await db.homebrew.get('hb:a-fireblade')).toBeUndefined();
  });

  it('addUsage sums into the campaign and the active session', async () => {
    await loadSeeded('a');
    const delta = { ...zeroUsage(), requests: 1, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 800, estimatedCostUsd: 0.25 };
    await game().addUsage(delta);
    await game().addUsage(delta);
    const expected = { ...zeroUsage(), requests: 2, inputTokens: 2000, outputTokens: 400, cacheReadTokens: 1600, estimatedCostUsd: 0.5 };
    expect(game().campaign?.usage).toEqual(expected);
    expect(game().activeSession?.usage).toEqual(expected);
    expect(game().sessions[1].usage).toEqual(expected);
    expect((await storage.getCampaign('a-camp'))?.usage).toEqual(expected);
    expect((await db.sessions.get('a-sess-2'))?.usage).toEqual(expected);
    expect((await db.sessions.get('a-sess-1'))?.usage).toEqual(zeroUsage());
  });
});

describe('write-through behaviour', () => {
  it('bumps campaign.updatedAt strictly on every persisted change (what cloud sync compares)', async () => {
    await loadSeeded('a');
    const stamps: number[] = [game().campaign?.updatedAt ?? 0];
    const record = () => stamps.push(game().campaign?.updatedAt ?? 0);
    await game().appendLog({ kind: 'player', text: 'a' });
    record();
    await game().upsertJournal([{ kind: 'lore', name: 'Tides' }]);
    record();
    await game().setCombat(null);
    record();
    const entry = game().log.at(-1);
    if (entry) await game().updateLog(entry.id, { text: 'memory only' } as Partial<LogEntry>, { persist: false });
    expect(game().campaign?.updatedAt).toBe(stamps.at(-1));
    for (let i = 1; i < stamps.length; i += 1) expect(stamps[i]).toBeGreaterThan(stamps[i - 1]);
    expect((await storage.getCampaign('a-camp'))?.updatedAt).toBe(stamps.at(-1));
  });

  it('surfaces a failed write as console.error plus a rejected promise, and keeps going', async () => {
    await loadSeeded('a');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(storage.putLog).mockRejectedValueOnce(new Error('QuotaExceededError'));

    await expect(game().appendLog({ kind: 'player', text: 'lost' })).rejects.toThrow("Couldn't save the log: QuotaExceededError");
    expect(consoleError).toHaveBeenCalled();

    const saved = await game().appendLog({ kind: 'player', text: 'kept' });
    expect(await db.log.get(saved.id)).toEqual(saved);
  });

  it('reloads when the loaded campaign is replaced by an import, and unloads when it is deleted', async () => {
    await loadSeeded('a');
    const bundle = await storage.exportCampaignBundle('a-camp');
    await game().updateCampaign({ name: 'Changed after the backup' });

    await storage.importCampaignBundle(bundle, 'replace');
    await vi.waitFor(() => expect(game().campaign?.name).toBe('Campaign a'));
    expect(game().loading).toBe(false);

    await storage.deleteCampaign('a-camp');
    // The id stays, so a table still showing it can explain what happened.
    expect(game()).toMatchObject({ campaignId: 'a-camp', campaign: null, log: [], loadError: 'This campaign has been deleted.' });
  });
});

describe('interactions and DM notices', () => {
  const roll = (id: string) =>
    ({
      kind: 'roll',
      id,
      request: { rollType: 'skill', skill: 'stealth', revealDc: false, advantage: 'normal', reason: 'Sneak past' },
      modifier: 2,
      label: 'Stealth check (DEX)',
    }) as const;
  const response: InteractionResponse = { kind: 'confirm', confirmed: true };

  it('resolves the waiting tool and clears the interaction', async () => {
    const answer = game().requestInteraction(roll('r1'));
    expect(game().interaction).toEqual(roll('r1'));
    game().resolveInteraction('r1', response);
    await expect(answer).resolves.toEqual(response);
    expect(game().interaction).toBeNull();
    // A late duplicate answer is ignored.
    game().resolveInteraction('r1', response);
  });

  it("cancelInteraction rejects with Error('cancelled')", async () => {
    const answer = game().requestInteraction(roll('r1'));
    const rejected = expect(answer).rejects.toThrow(new Error('cancelled'));
    game().cancelInteraction('r1', 'player left');
    await rejected;
    expect(game().interaction).toBeNull();
  });

  it('shows one interaction at a time, in order', async () => {
    const first = game().requestInteraction(roll('r1'));
    const second = game().requestInteraction(roll('r2'));
    expect(game().interaction?.id).toBe('r1');
    game().resolveInteraction('r1', response);
    await first;
    expect(game().interaction?.id).toBe('r2');
    game().resolveInteraction('r2', response);
    await second;
    expect(game().interaction).toBeNull();
  });

  it('queues DM notices (no duplicates) and hands them over once', () => {
    game().queueDmNotice('Player edited HP.');
    game().queueDmNotice('Player edited HP.');
    game().queueDmNotice('  ');
    game().queueDmNotice('Player renamed a quest.');
    expect(game().takeDmNotices()).toEqual(['Player edited HP.', 'Player renamed a quest.']);
    expect(game().takeDmNotices()).toEqual([]);
    expect(game().pendingDmNotices).toEqual([]);
  });

  it('setDmStatus merges', () => {
    game().setDmStatus({ phase: 'thinking', activity: 'The DM is thinking…' });
    game().setDmStatus({ activity: 'Rolling for the goblins…' });
    expect(game().dm).toEqual({ phase: 'thinking', activity: 'Rolling for the goblins…', error: null, retryable: false });
    game().setDmStatus({ phase: 'idle', activity: null });
  });
});

describe('DM notices are saved with the campaign', () => {
  const stored = async (id = 'a-camp') => (await storage.getCampaign(id))?.pendingDmNotices;

  it('survive leaving the table and a reload, and come back with the campaign', async () => {
    await loadSeeded('a');
    game().queueDmNotice('Safety: the player added "spiders" to the lines.');
    game().queueDmNotice('Safety: the player added "spiders" to the lines.');
    await whenPersisted('a-camp');
    expect(await stored()).toEqual(['Safety: the player added "spiders" to the lines.']);

    game().unloadCampaign();
    expect(game().pendingDmNotices).toEqual([]);
    await game().loadCampaign('a-camp');
    expect(game().pendingDmNotices).toEqual(['Safety: the player added "spiders" to the lines.']);
    expect(game().campaign?.pendingDmNotices).toEqual(['Safety: the player added "spiders" to the lines.']);
  });

  it('are cleared from storage by the save that delivers them; a failed append keeps them', async () => {
    await loadSeeded('a');
    game().queueDmNotice('The player edited their HP: 12 → 17.');
    await whenPersisted('a-camp');

    expect(game().takeDmNotices()).toEqual(['The player edited their HP: 12 → 17.']);
    expect(game().pendingDmNotices).toEqual([]);
    expect(await stored()).toEqual(['The player edited their HP: 12 → 17.']);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(storage.putTranscript).mockRejectedValueOnce(new Error('QuotaExceededError'));
    await expect(game().appendTranscript([{ role: 'user', content: 'turn' }])).rejects.toThrow(/QuotaExceededError/);
    expect(await stored()).toEqual(['The player edited their HP: 12 → 17.']);

    await game().appendTranscript([{ role: 'user', content: 'turn, again' }]);
    expect(await stored()).toEqual([]);
  });

  it('queueCampaignNotice saves to a campaign that is not loaded, and goes through the store when it is', async () => {
    const b = await seedCampaign('b');
    await loadSeeded('a');
    const notice = 'The player retired the homebrew “Tidecaller’s Boon” in the Library.';

    await queueCampaignNotice('b-camp', `  ${notice} `);
    await queueCampaignNotice('b-camp', notice);
    expect(await stored('b-camp')).toEqual([notice]);
    expect((await storage.getCampaign('b-camp'))?.updatedAt).toBeGreaterThan(b.campaign.updatedAt);
    expect(game().pendingDmNotices).toEqual([]);

    await queueCampaignNotice('a-camp', 'The player edited the homebrew “Fireblade” in the Library.');
    expect(game().pendingDmNotices).toEqual(['The player edited the homebrew “Fireblade” in the Library.']);
    expect(await stored()).toEqual(['The player edited the homebrew “Fireblade” in the Library.']);

    await game().loadCampaign('b-camp');
    expect(game().pendingDmNotices).toEqual([notice]);

    // A campaign that doesn't exist is ignored, never created.
    await queueCampaignNotice('missing', 'Hello?');
    expect(await storage.getCampaign('missing')).toBeUndefined();
  });

  it('keeps notices queued elsewhere (the Library, another tab) when the store saves, and picks them up', async () => {
    await loadSeeded('a');
    game().queueDmNotice('Mine.');
    await whenPersisted('a-camp');
    await storage.addPendingDmNotice('a-camp', 'From the Library in another tab.');

    await game().appendLog({ kind: 'player', text: 'I look around.' });

    expect(await stored()).toEqual(['Mine.', 'From the Library in another tab.']);
    expect(game().pendingDmNotices).toEqual(['Mine.', 'From the Library in another tab.']);
    expect(game().takeDmNotices()).toEqual(['Mine.', 'From the Library in another tab.']);
    await game().appendTranscript([{ role: 'user', content: 'turn' }]);
    expect(await stored()).toEqual([]);
  });

  it('stay in memory when nothing is loaded', () => {
    game().queueDmNotice('Loose note.');
    expect(game().pendingDmNotices).toEqual(['Loose note.']);
  });
});

describe('one tab at a time', () => {
  it('refuses to write a campaign another tab has open at the table, and leaves storage alone', async () => {
    await loadSeeded('a');
    const { exportedAt: _before, ...before } = await storage.exportCampaignBundle('a-camp');
    vi.mocked(storage.isCampaignOpenElsewhere).mockResolvedValue(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(game().appendLog({ kind: 'player', text: 'from a stale tab' })).rejects.toThrow(storage.OPEN_ELSEWHERE_ERROR);
    await expect(game().updateCharacter((c) => ({ ...c, xp: 0 }))).rejects.toThrow(/open at the table in another tab/);
    await expect(game().appendTranscript([{ role: 'user', content: 'stale' }])).rejects.toThrow(/another tab/);

    expect(warn).toHaveBeenCalled();
    const { exportedAt: _after, ...after } = await storage.exportCampaignBundle('a-camp');
    expect(after).toEqual(before);

    // A note for the DM is only added to the stored record: the tab at the table picks it up.
    game().queueDmNotice('From the stale tab.');
    await whenPersisted('a-camp');
    expect((await storage.getCampaign('a-camp'))?.pendingDmNotices).toEqual(['From the stale tab.']);
  });

  it('drops writes queued before the campaign was replaced (another tab pulled or imported it)', async () => {
    await loadSeeded('a');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const realPutLog = vi.mocked(storage.putLog).getMockImplementation();
    let open = () => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    vi.mocked(storage.putLog).mockImplementationOnce(async (entries) => {
      await gate;
      await realPutLog?.(entries);
    });

    const first = game().appendLog({ kind: 'player', text: 'already saving' });
    const second = game().appendLog({ kind: 'player', text: 'still queued' });
    await vi.waitFor(() => expect(storage.putLog).toHaveBeenCalled());
    emitCampaignChange({ type: 'replaced', campaignId: 'a-camp' });
    open();

    await first;
    await expect(second).rejects.toThrow(/replaced or deleted/);
    const texts = (await db.log.where('campaignId').equals('a-camp').toArray()).flatMap((e) => (e.kind === 'player' ? [e.text] : []));
    expect(texts).toContain('already saving');
    expect(texts).not.toContain('still queued');
    await vi.waitFor(() => expect(game().loading).toBe(false));
  });
});

describe('narration cut off mid-stream', () => {
  it('is settled (no longer streaming) when the campaign is opened fresh, and saved that way', async () => {
    await loadSeeded('a');
    const entry = await game().appendLog({ kind: 'dm', text: 'The cellar door', streaming: true });
    // The tab went away mid-stream: the entry was saved once, still streaming.
    game().unloadCampaign();

    await game().loadCampaign('a-camp');

    expect(game().log.find((e) => e.id === entry.id)).toMatchObject({ text: 'The cellar door', streaming: false });
    await whenPersisted('a-camp');
    expect(await db.log.get(entry.id)).toMatchObject({ text: 'The cellar door', streaming: false });
  });

  it('is left alone by a reload of the campaign this tab shows (it may still be streaming here)', async () => {
    await loadSeeded('a');
    const entry = await game().appendLog({ kind: 'dm', text: 'The cellar door', streaming: true });
    await game().reload();
    expect(game().log.find((e) => e.id === entry.id)).toMatchObject({ streaming: true });
    await game().updateLog(entry.id, { text: 'The cellar door creaks open.', streaming: false } as Partial<LogEntry>);
    expect(await db.log.get(entry.id)).toMatchObject({ text: 'The cellar door creaks open.', streaming: false });
  });

  it('is saved every few seconds while it streams', async () => {
    await loadSeeded('a');
    let clock = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const entry = await game().appendLog({ kind: 'dm', text: 'The', streaming: true });
    const patch = (text: string) => game().updateLog(entry.id, { text } as Partial<LogEntry>, { persist: false });

    await patch('The fog');
    clock += STREAM_CHECKPOINT_MS - 1;
    await patch('The fog parts');
    await whenPersisted('a-camp');
    expect(await db.log.get(entry.id)).toMatchObject({ text: 'The', streaming: true });

    clock += 1;
    await patch('The fog parts, and');
    await whenPersisted('a-camp');
    expect(await db.log.get(entry.id)).toMatchObject({ text: 'The fog parts, and', streaming: true });
    expect((await storage.getCampaign('a-camp'))?.updatedAt).toBe(game().campaign?.updatedAt);
  });
});

// ---------------------------------------------------------------------------
// Battle map (spec §6): updateCombat, loading, the hero's own move and its undo
// ---------------------------------------------------------------------------

const B6 = { x: 1, y: 5 };
const C5 = { x: 2, y: 4 };
const C7 = { x: 2, y: 6 };
const D8 = { x: 3, y: 7 };

const moveTo = (to?: GridPoint, patch: Partial<HeroMoveRequest> = {}): HeroMoveRequest => ({
  to,
  prefer: 'safest',
  dash: false,
  disengage: false,
  standUp: false,
  ...patch,
});

/** Campaign a, loaded, in a fight on the warehouse map (the hero's turn unless the state says otherwise). */
async function loadMapped(combat: CombatState = sampleMappedCombat({ heroTurn: true })) {
  const graph = await seedCampaign('a');
  await db.combat.put({ campaignId: 'a-camp', state: combat });
  await game().loadCampaign('a-camp');
  return graph;
}

/** The fixture with Bandit 1 at C5, next to the hero (B6) and Old Tam (B5): leaving it provokes (M24). */
function banditAdjacent(): CombatState {
  const state = sampleMappedCombat({ heroTurn: true });
  return { ...state, combatants: state.combatants.map((c) => (c.id === 'c-2' ? { ...c, position: C5 } : c)) };
}

/** How many times the store's state is set while `run` runs. */
async function countSets(run: () => Promise<unknown>): Promise<number> {
  let sets = 0;
  const unsubscribe = useGame.subscribe(() => (sets += 1));
  try {
    await run();
  } finally {
    unsubscribe();
  }
  return sets;
}

const heroOf = (c: CombatState | null) => c?.combatants.find((x) => x.isPlayer);
const snapshot = (before: CombatState, after: CombatState, patch: Partial<HeroMoveSnapshot> = {}): HeroMoveSnapshot => ({
  before,
  after,
  stoodUp: false,
  revealedHidden: false,
  ...patch,
});

describe('battle map: updateCombat', () => {
  it('applies a pure update to the latest combat, bumps updatedAt and persists', async () => {
    const graph = await loadMapped();
    const next = await game().updateCombat((c) => ({ ...c, round: c.round + 1 }));
    expect(next.round).toBe(3);
    expect(game().combat).toBe(next);
    expect(game().campaign?.updatedAt).toBeGreaterThan(graph.campaign.updatedAt);
    expect((await db.combat.get('a-camp'))?.state).toEqual(next);
    expect((await storage.getCampaign('a-camp'))?.updatedAt).toBe(game().campaign?.updatedAt);
  });

  it('is functional: unawaited updates each see the one before (a DM write during a player move loses nothing)', async () => {
    await loadMapped();
    const writes = Array.from({ length: 10 }, (_, i) =>
      game().updateCombat((c) => ({ ...c, round: c.round + 1, encounterName: `update ${i}` })),
    );
    expect(game().combat?.round).toBe(12);
    await Promise.all(writes);
    expect((await db.combat.get('a-camp'))?.state).toMatchObject({ round: 12, encounterName: 'update 9' });
  });

  it('skips the write when fn returns the same object', async () => {
    await loadMapped();
    const before = game().combat;
    const updatedAt = game().campaign?.updatedAt;
    vi.mocked(storage.putCombat).mockClear();
    const sets = await countSets(() => game().updateCombat((c) => c));
    expect(sets).toBe(0);
    expect(game().combat).toBe(before);
    expect(game().campaign?.updatedAt).toBe(updatedAt);
    expect(storage.putCombat).not.toHaveBeenCalled();
  });

  it('rejects without a combat or a campaign, and never ends a fight (that is setCombat(null))', async () => {
    await loadSeeded('a');
    await game().setCombat(null);
    await expect(game().updateCombat((c) => c)).rejects.toThrow('There is no combat running.');
    await game().setCombat(sampleMappedCombat());
    await expect(game().updateCombat(() => null as unknown as CombatState)).rejects.toThrow(/setCombat\(null\)/);
    expect(game().combat).toEqual(sampleMappedCombat());
    game().unloadCampaign();
    await expect(game().updateCombat((c) => c)).rejects.toThrow('No campaign is loaded.');
  });
});

describe('battle map: loading a fight', () => {
  it('reads the stored combat leniently and writes nothing back', async () => {
    const graph = await seedCampaign('a');
    const fixture = sampleMappedCombat();
    const [mira, bandit1, ...others] = fixture.combatants;
    const { conditions: _conditions, ...noConditions } = bandit1;
    const stored = {
      ...fixture,
      combatants: [{ ...mira, position: { x: 99, y: 5 } }, noConditions, ...others],
      map: { ...fixture.map, width: 100, terrain: [...(fixture.map?.terrain ?? []), { id: 't40', kind: 'lava', rects: [] }] },
    };
    await db.combat.put({ campaignId: 'a-camp', state: stored as unknown as CombatState });
    vi.mocked(storage.putCombat).mockClear();

    await game().loadCampaign('a-camp');

    const combat = game().combat;
    expect(combat?.map).toMatchObject({ width: 40, height: 12 });
    expect(combat?.map?.terrain).toHaveLength(7);
    expect(heroOf(combat)).not.toHaveProperty('position');
    expect(combat?.combatants[1].conditions).toEqual([]);
    await whenPersisted('a-camp');
    expect(storage.putCombat).not.toHaveBeenCalled();
    expect((await db.combat.get('a-camp'))?.state).toEqual(stored);
    expect((await storage.getCampaign('a-camp'))?.updatedAt).toBe(graph.campaign.updatedAt);
  });

  it('loads an old fight (no map) unchanged', async () => {
    const graph = await loadSeeded('a');
    expect(game().combat).toEqual(graph.combat);
  });
});

describe('battle map: commitHeroMove gates (spec §6.2, checked in this order)', () => {
  const busy = { phase: 'thinking' as const, activity: null, error: null, retryable: false };
  const ask = { kind: 'confirm' as const, id: 'i-1', title: 'Opportunity Attack', body: '…' };

  it('no-map: no fight, a finished fight, or a fight without a map', async () => {
    await loadSeeded('a');
    expect(await game().commitHeroMove(moveTo(C7))).toEqual({ ok: false, block: 'no-map' });
    await game().setCombat({ ...sampleMappedCombat({ heroTurn: true }), active: false });
    expect(await game().commitHeroMove(moveTo(C7))).toEqual({ ok: false, block: 'no-map' });
    await game().setCombat(null);
    expect(await game().commitHeroMove(moveTo(C7))).toEqual({ ok: false, block: 'no-map' });
    game().unloadCampaign();
    expect(await game().commitHeroMove(moveTo(C7))).toEqual({ ok: false, block: 'no-map' });
  });

  it("not-your-turn: on any other creature's turn, a hidden one included (it reads the same), before any other gate", async () => {
    await loadMapped(sampleMappedCombat());
    useGame.setState({ dm: busy, interaction: ask, activeSession: null });
    expect(await game().commitHeroMove(moveTo(C7))).toEqual({ ok: false, block: 'not-your-turn' });
    await game().updateCombat((c) => ({ ...c, turnIndex: 2 })); // the Cutthroat (hidden)
    expect(await game().commitHeroMove(moveTo(C7))).toEqual({ ok: false, block: 'not-your-turn' });
  });

  it('dm-busy, then interaction, then no-session, then unplaced', async () => {
    await loadMapped();
    useGame.setState({ dm: busy, interaction: ask, activeSession: null });
    expect(await game().commitHeroMove(moveTo(C7))).toEqual({ ok: false, block: 'dm-busy' });
    useGame.setState({ dm: initialDmStatus });
    expect(await game().commitHeroMove(moveTo(C7))).toEqual({ ok: false, block: 'interaction' });
    useGame.setState({ interaction: null });
    expect(await game().commitHeroMove(moveTo(C7))).toEqual({ ok: false, block: 'no-session' });
    await game().loadCampaign('a-camp');
    await game().updateCombat((c) => ({ ...c, combatants: c.combatants.map(({ position, ...x }) => (x.isPlayer ? x : { ...x, position })) }));
    expect(await game().commitHeroMove(moveTo(C7))).toEqual({ ok: false, block: 'unplaced' });
    // Nothing was written by a refused move.
    expect(game().heroMoveUndo).toEqual([]);
  });

  it('an errored DM is not busy', async () => {
    await loadMapped();
    useGame.setState({ dm: { ...initialDmStatus, phase: 'error' }, activeSession: null });
    expect(await game().commitHeroMove(moveTo(C7))).toEqual({ ok: false, block: 'no-session' });
  });

  it('stop-pending: a stop by the player blocks until the DM has answered the message that carried it', async () => {
    await loadMapped(sampleStopCombat());
    const pending = await game().commitHeroMove(moveTo({ x: 0, y: 6 }));
    expect(pending).toEqual({ ok: false, block: 'stop-pending' });

    // The player sends: the session stamps the stop with the user message's seq (stampMapTold).
    const [sent] = await game().appendTranscript([{ role: 'user', content: 'I keep moving to A7.' }]);
    await game().updateCombat((c) => ({ ...c, map: c.map && { ...c.map, stop: c.map.stop && { ...c.map.stop, toldSeq: sent.seq } } }));
    expect(await game().commitHeroMove(moveTo({ x: 0, y: 6 }))).toEqual({ ok: false, block: 'stop-pending' });
    // The request failed and the turn was set aside: the stamp points at a message that no longer exists.
    await game().truncateTranscriptAfter(sent.seq - 1);
    await game().appendTranscript([{ role: 'user', content: 'Again: I keep moving to A7.' }]);
    expect(await game().commitHeroMove(moveTo({ x: 0, y: 6 }))).toEqual({ ok: false, block: 'stop-pending' });
  });

  it('a stop from an earlier round is stale and no longer blocks', () => {
    const state = sampleStopCombat();
    const stale = { ...state, round: 4 };
    expect(pendingPlayerStop(state, [])).toBe(state.map?.stop);
    expect(pendingPlayerStop(stale, [])).toBeNull();
  });

  it("refused: the engine's refusal is passed through and nothing changes", async () => {
    await loadMapped();
    const before = game().combat;
    const result = await game().commitHeroMove(moveTo({ x: 15, y: 11 })); // far beyond 30 ft
    expect(result).toMatchObject({ ok: false, block: 'refused', refusal: { code: 'too-far' } });
    expect(game().combat).toBe(before);
    expect(game().heroMoveUndo).toEqual([]);
  });
});

describe('battle map: commitHeroMove writes', () => {
  it('one set and one persist chain per move; the move can be undone', async () => {
    await loadMapped();
    const before = game().combat;
    vi.mocked(storage.putCombat).mockClear();
    vi.mocked(storage.putCharacter).mockClear();
    let result: HeroMoveResult | undefined;
    const sets = await countSets(async () => {
      result = await game().commitHeroMove(moveTo(C7));
    });
    expect(sets).toBe(1);
    expect(result).toMatchObject({ ok: true, outcome: { status: 'moved', move: { by: 'player', from: B6, to: C7, costFt: 5 } } });
    expect(heroOf(game().combat)?.position).toEqual(C7);
    expect(storage.putCombat).toHaveBeenCalledTimes(1);
    expect(storage.putCharacter).not.toHaveBeenCalled();
    expect((await db.combat.get('a-camp'))?.state).toEqual(game().combat);
    expect(game().heroMoveUndo).toEqual([snapshot(before as CombatState, game().combat as CombatState)]);
    expect(canUndoHeroMove(game())).toBe(true);
  });

  it("a move to the square the hero is on writes nothing and adds no undo step (spec §3.10)", async () => {
    await loadMapped();
    const before = game().combat;
    vi.mocked(storage.putCombat).mockClear();
    let result: HeroMoveResult | undefined;
    const sets = await countSets(async () => {
      result = await game().commitHeroMove(moveTo(B6));
    });
    expect(result).toMatchObject({ ok: true, outcome: { status: 'moved', move: { path: [] } } });
    expect(sets).toBe(0);
    expect(game().combat).toBe(before);
    expect(storage.putCombat).not.toHaveBeenCalled();
    expect(game().heroMoveUndo).toEqual([]);
  });

  it('standing up writes the Character (Prone removed) before the combat', async () => {
    await loadMapped();
    await game().updateCharacter((c) => ({ ...c, conditions: [{ id: 'prone' }] }));
    vi.mocked(storage.putCombat).mockClear();
    vi.mocked(storage.putCharacter).mockClear();

    const result = await game().commitHeroMove(moveTo(undefined, { standUp: true }));

    expect(result).toMatchObject({ ok: true, outcome: { heroStoodUp: true } });
    expect(game().character?.conditions).toEqual([]);
    expect(storage.putCharacter).toHaveBeenCalledTimes(1);
    expect(storage.putCombat).toHaveBeenCalledTimes(1);
    expect(vi.mocked(storage.putCharacter).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(storage.putCombat).mock.invocationCallOrder[0]);
    expect((await db.characters.get('a-char'))?.conditions).toEqual([]);
    expect(game().heroMoveUndo.at(-1)?.stoodUp).toBe(true);
  });

  it("a move that leaves an enemy's reach stops there, and the next one waits for the DM's reply", async () => {
    await loadMapped(banditAdjacent());
    const first = await game().commitHeroMove(moveTo(D8));
    expect(first).toMatchObject({
      ok: true,
      outcome: { status: 'stopped', stoppedFor: { kind: 'opportunity-attack', reactorIds: ['c-2'] } },
    });
    expect(heroOf(game().combat)?.position).toEqual(B6);
    expect(game().combat?.map?.stop).toMatchObject({ by: 'player', moverId: 'c-1', destination: D8 });
    expect(await game().commitHeroMove(moveTo(D8))).toEqual({ ok: false, block: 'stop-pending' });

    const [sent] = await game().appendTranscript([{ role: 'user', content: 'I keep moving to D8.' }]);
    await game().updateCombat((c) => ({ ...c, map: c.map && { ...c.map, stop: c.map.stop && { ...c.map.stop, toldSeq: sent.seq } } }));
    expect(await game().commitHeroMove(moveTo(D8))).toEqual({ ok: false, block: 'stop-pending' });
    await game().appendTranscript([{ role: 'assistant', content: [{ type: 'text', text: 'The bandit lunges and misses.' }] }]);

    const second = await game().commitHeroMove(moveTo(D8));
    expect(second).toMatchObject({ ok: true, outcome: { status: 'moved', move: { from: B6, to: D8, costFt: 10 } } });
    expect(game().combat?.combatants.find((c) => c.id === 'c-2')?.reactionUsed).toBe(true);
  });
});

describe('battle map: undoHeroMove', () => {
  it('restores the combat from before the move by identity, newest first, one move per call', async () => {
    await loadMapped();
    const c0 = game().combat as CombatState;
    const c1 = { ...c0, round: 5 };
    const c2 = { ...c1, round: 6 };
    useGame.setState({ combat: c2, heroMoveUndo: [snapshot(c0, c1), snapshot(c1, c2)] });

    expect(await game().undoHeroMove()).toBe(true);
    expect(game().combat).toBe(c1);
    expect(game().heroMoveUndo).toEqual([snapshot(c0, c1)]);
    expect(canUndoHeroMove(game())).toBe(true);
    expect(await game().undoHeroMove()).toBe(true);
    expect(game().combat).toBe(c0);
    expect((await db.combat.get('a-camp'))?.state).toEqual(c0);
    expect(game().heroMoveUndo).toEqual([]);
    expect(canUndoHeroMove(game())).toBe(false);
    expect(await game().undoHeroMove()).toBe(false);
  });

  it('re-adds Prone after undoing a stand-up without overwriting a later sheet edit (Character first)', async () => {
    await loadMapped();
    const c0 = game().combat as CombatState;
    const c1 = { ...c0, round: 5 };
    useGame.setState({ combat: c1, heroMoveUndo: [snapshot(c0, c1, { stoodUp: true })] });
    await game().updateCharacter((c) => ({ ...c, hp: { ...c.hp, current: 3 } }));
    vi.mocked(storage.putCombat).mockClear();
    vi.mocked(storage.putCharacter).mockClear();

    expect(await game().undoHeroMove()).toBe(true);

    expect(game().character?.conditions.map((c) => c.id)).toEqual(['prone']);
    expect(game().character?.hp.current).toBe(3);
    expect(vi.mocked(storage.putCharacter).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(storage.putCombat).mock.invocationCallOrder[0]);
    expect((await db.characters.get('a-char'))?.conditions.map((c) => c.id)).toEqual(['prone']);
  });

  it('is refused once anything else wrote the combat (the <game_state> stamp at send, a DM tool)', async () => {
    await loadMapped();
    const c0 = game().combat as CombatState;
    const c1 = { ...c0, round: 5 };
    useGame.setState({ combat: c1, heroMoveUndo: [snapshot(c0, c1)] });
    await game().updateCombat((c) => ({ ...c, map: c.map && { ...c.map } })); // the stamp
    expect(canUndoHeroMove(game())).toBe(false);
    expect(await game().undoHeroMove()).toBe(false);

    useGame.setState({ combat: c1, heroMoveUndo: [snapshot(c0, c1)] });
    await game().setCombat({ ...c1, round: 6 }); // a DM tool
    expect(await game().undoHeroMove()).toBe(false);
    expect(game().combat?.round).toBe(6);
  });

  it('is refused while the DM is busy or asks something, and for a move that ran into something hidden', async () => {
    await loadMapped();
    const c0 = game().combat as CombatState;
    const c1 = { ...c0, round: 5 };
    useGame.setState({ combat: c1, heroMoveUndo: [snapshot(c0, c1)], dm: { ...initialDmStatus, phase: 'tool' } });
    expect(await game().undoHeroMove()).toBe(false);
    useGame.setState({ dm: initialDmStatus, interaction: { kind: 'confirm', id: 'i-1', title: 'Opportunity Attack', body: '…' } });
    expect(await game().undoHeroMove()).toBe(false);
    useGame.setState({ interaction: null, heroMoveUndo: [snapshot(c0, c1, { revealedHidden: true })] });
    expect(canUndoHeroMove(game())).toBe(false);
    expect(await game().undoHeroMove()).toBe(false);
    expect(game().combat).toBe(c1);
  });

  it("can't undo a move that ran into something hidden, so moving and undoing can't probe (C24, D49)", async () => {
    const state = sampleMappedCombat({ heroTurn: true });
    // The Cutthroat (hidden) stands on C6, in the way of the route the player sees: B6 → C6 → D6.
    await loadMapped({ ...state, combatants: state.combatants.map((c) => (c.id === 'c-5' ? { ...c, position: { x: 2, y: 5 } } : c)) });

    const result = await game().commitHeroMove(moveTo({ x: 3, y: 5 }));

    expect(result).toMatchObject({ ok: true, outcome: { status: 'stopped', stoppedFor: { kind: 'unseen' }, revealedHidden: true } });
    expect(heroOf(game().combat)?.position).toEqual(B6);
    expect(game().heroMoveUndo.at(-1)?.revealedHidden).toBe(true);
    expect(canUndoHeroMove(game())).toBe(false);
    expect(await game().undoHeroMove()).toBe(false);
  });

  it('undoes a real move, and a new move after an outside write starts a fresh stack', async () => {
    await loadMapped();
    const start = game().combat;
    await game().commitHeroMove(moveTo(C7));
    expect(await game().undoHeroMove()).toBe(true);
    expect(game().combat).toBe(start);
    expect(heroOf(game().combat)?.position).toEqual(B6);

    await game().commitHeroMove(moveTo(C7));
    await game().updateCombat((c) => ({ ...c })); // stamped at send
    await game().commitHeroMove(moveTo(D8));
    expect(game().heroMoveUndo).toHaveLength(1);
    expect(await game().undoHeroMove()).toBe(true);
    expect(await game().undoHeroMove()).toBe(false);
    expect(heroOf(game().combat)?.position).toEqual(C7);
  });
});

describe('battle map: hero move undo stack', () => {
  it('starts empty and clears on load, on unload and when a DM run starts (a busy setDmStatus)', async () => {
    expect(game().heroMoveUndo).toEqual([]);
    await loadMapped();
    expect(game().heroMoveUndo).toEqual([]);
    const c0 = game().combat as CombatState;
    const stack = [snapshot(c0, { ...c0 })];

    useGame.setState({ heroMoveUndo: stack });
    game().setDmStatus({ phase: 'idle', activity: null });
    game().setDmStatus({ phase: 'error', error: 'Overloaded' });
    expect(game().heroMoveUndo).toBe(stack);
    game().setDmStatus({ phase: 'thinking', activity: 'The DM is thinking…' });
    expect(game().heroMoveUndo).toEqual([]);
    game().setDmStatus({ phase: 'idle', activity: null, error: null });

    useGame.setState({ heroMoveUndo: stack });
    await game().reload();
    expect(game().heroMoveUndo).toEqual([]);

    useGame.setState({ heroMoveUndo: stack });
    game().unloadCampaign();
    expect(game().heroMoveUndo).toEqual([]);
  });

  it('canUndoHeroMove: only while the newest move is still the combat, the DM is idle and nothing is asked', () => {
    const before = sampleMappedCombat({ heroTurn: true });
    const after = sampleMappedCombat({ heroTurn: true });
    const idle = { ...game(), combat: after, heroMoveUndo: [snapshot(before, after)] };
    expect(canUndoHeroMove({ ...idle, heroMoveUndo: [] })).toBe(false);
    expect(canUndoHeroMove(idle)).toBe(true);
    expect(canUndoHeroMove({ ...idle, dm: { ...idle.dm, phase: 'error' } })).toBe(true);
    // Any later write (the <game_state> stamp at send, a DM tool) replaces the combat object.
    expect(canUndoHeroMove({ ...idle, combat: sampleMappedCombat({ heroTurn: true }) })).toBe(false);
    expect(canUndoHeroMove({ ...idle, dm: { ...idle.dm, phase: 'thinking' } })).toBe(false);
    expect(canUndoHeroMove({ ...idle, interaction: { kind: 'confirm', id: 'i-1', title: 'Opportunity Attack', body: '…' } })).toBe(false);
    expect(canUndoHeroMove({ ...idle, heroMoveUndo: [snapshot(before, after, { revealedHidden: true })] })).toBe(false);
  });

  it('heroMoveBlock mirrors the gates for display (the UI never needs to guess)', async () => {
    await loadMapped();
    expect(heroMoveBlock(game())).toBeNull();
    useGame.setState({ dm: { ...initialDmStatus, phase: 'streaming' } });
    expect(heroMoveBlock(game())).toBe('dm-busy');
  });
});
