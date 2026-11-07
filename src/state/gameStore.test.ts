import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InteractionResponse, LogEntry } from '@/types';
import { sampleCharacter, sampleSession, sampleSettings, zeroUsage } from '@/test/fixtures';
import * as storage from '@/storage';
import { db } from '@/storage/db';
import { emitCampaignChange } from '@/storage/events';
import { resetDatabase, seedCampaign } from '@/storage/testData';
import { queueCampaignNotice, STREAM_CHECKPOINT_MS, useGame, whenPersisted } from './gameStore';

// Real storage (fake-indexeddb), with putLog wrapped so a test can make one write fail.
vi.mock('@/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/storage')>();
  return {
    ...actual,
    putLog: vi.fn(actual.putLog),
    putTranscript: vi.fn(actual.putTranscript),
    isCampaignOpenElsewhere: vi.fn(actual.isCampaignOpenElsewhere),
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
