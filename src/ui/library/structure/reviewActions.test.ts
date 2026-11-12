import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleCampaign } from '@/test/fixtures';
import { EXPECTED_DATA, gloamwoodEntries, gloamwoodRecords, gloamwoodSource } from '@/test/structuredFixtures';
import type { CampaignSummary } from '@/storage';
import type { MonsterData, RecordStatus, StructuredRecord } from '@/types';

vi.mock('@/data', async () => ({
  ...(await import('@/ui/library/structure/testing/mocks')).structuredDataMock(),
  invalidateRulesIndex: vi.fn(),
}));
vi.mock('@/storage', async () => ({
  ...(await import('@/ui/library/structure/testing/mocks')).structuredStorageMock(),
  listCampaigns: vi.fn(),
  listLibrarySources: vi.fn(),
}));
const game = { campaignId: null as string | null, restoreImportedText: vi.fn(async () => null) };
vi.mock('@/state/gameStore', () => ({ useGame: { getState: () => game }, queueCampaignNotice: vi.fn(async () => undefined) }));

const storage = await import('@/storage');
const data = await import('@/data');
const { queueCampaignNotice } = await import('@/state/gameStore');
const actions = await import('./reviewActions');
const { gloamwoodDetection } = await import('@/ui/library/structure/testing/mocks');

let stored: StructuredRecord[];
const byName = (name: string) => stored.find((r) => r.name === name) as StructuredRecord;
const slot = (id: string, activeSessionId: string | null): CampaignSummary => ({
  campaign: sampleCampaign({ id, name: id, activeSessionId }),
  character: null,
  level: 0,
});

beforeEach(() => {
  vi.useFakeTimers();
  stored = gloamwoodRecords();
  actions.resetReviewActionsForTests();
  game.campaignId = null;
  game.restoreImportedText.mockClear();
  vi.mocked(storage.getRecords).mockImplementation(async (ids: string[]) => ids.map((id) => stored.find((r) => r.id === id)));
  vi.mocked(storage.listRecords).mockImplementation(async () => stored);
  vi.mocked(storage.setRecordStatus).mockReset().mockImplementation(async (ids: string[], status: RecordStatus) => {
    const before = ids.map((id) => ({ id, status: stored.find((r) => r.id === id)?.status ?? 'pending' }));
    stored = stored.map((r) => (ids.includes(r.id) ? { ...r, status } : r));
    return before;
  });
  vi.mocked(storage.putRecords).mockReset().mockImplementation(async (next: StructuredRecord[]) => {
    stored = stored.map((r) => next.find((n) => n.id === r.id) ?? r);
  });
  vi.mocked(storage.getSourceEntries).mockResolvedValue(gloamwoodEntries());
  vi.mocked(storage.listCampaigns).mockResolvedValue([slot('camp-a', 'sess-1'), slot('camp-b', null), slot('camp-c', 'sess-9')]);
  vi.mocked(storage.listLibrarySources).mockResolvedValue([gloamwoodSource()]);
  vi.mocked(queueCampaignNotice).mockClear();
  vi.mocked(data.invalidateRulesIndex).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the DM notice (pure)', () => {
  it('names counts and what changes, never book text', () => {
    expect(actions.structureNotice({ title: 'The Gloamwood Almanac' }, { spell: 12, monster: 20, feat: 9 })).toBe(
      'The player reviewed 41 entries from their book “The Gloamwood Almanac” (12 spells, 20 monsters, 9 feats). Reviewed stat blocks now supply size, speed, reach, AC, HP and initiative in combat, and new character options are available. Look entries up with get_entry when they come up.',
    );
    expect(actions.structureNotice({ title: 'Notes' }, { spell: 1 })).toBe(
      'The player reviewed 1 entry from their book “Notes” (1 spell). Reviewed spells are in the spell lists. Look entries up with get_entry when they come up.',
    );
  });

  it('says when a book is switched off or deleted', () => {
    expect(actions.bookGoneNotice({ title: 'The Gloamwood Almanac' }, 'off')).toMatch(/^The player switched off their book “The Gloamwood Almanac”\./);
    expect(actions.bookGoneNotice({ title: 'The Gloamwood Almanac' }, 'deleted')).toMatch(/^The player deleted their book/);
  });
});

describe('accepting', () => {
  it('accepts what it can and says why it skipped the rest', async () => {
    const ids = ['Ashen Choir', 'Goblin Warrior', 'Hookstaff'].map((n) => byName(n).id);
    const result = await actions.acceptRecords(ids);
    expect(result.accepted).toBe(2);
    expect(result.skipped).toEqual([{ id: byName('Goblin Warrior').id, reason: 'Not read yet: fill it in or read it with Claude first.' }]);
    expect(storage.setRecordStatus).toHaveBeenCalledWith([byName('Ashen Choir').id, byName('Hookstaff').id], 'accepted');
  });

  it('refreshes the index once per batch, then restores the loaded hero', async () => {
    game.campaignId = 'camp-a';
    await actions.acceptRecords([byName('Ashen Choir').id]);
    await actions.acceptRecords([byName('Cinder Mote').id]);
    expect(data.invalidateRulesIndex).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(data.invalidateRulesIndex).toHaveBeenCalledTimes(1);
    expect(game.restoreImportedText).toHaveBeenCalledTimes(1);
  });

  it('undoes to the previous statuses', async () => {
    const id = byName('Ashen Choir').id;
    stored = stored.map((r) => (r.id === id ? { ...r, status: 'rejected' } : r));
    const result = await actions.acceptRecords([id]);
    expect(byName('Ashen Choir').status).toBe('accepted');
    await result.undo();
    expect(byName('Ashen Choir').status).toBe('rejected');
  });

  it('"Accept N confident" never takes a class or a subclass', async () => {
    const result = await actions.acceptConfident('gloam');
    const accepted = vi.mocked(storage.setRecordStatus).mock.calls[0][0] as string[];
    const kinds = new Set(accepted.map((id) => stored.find((r) => r.id === id)?.kind));
    expect(kinds.has('class')).toBe(false);
    expect(kinds.has('subclass')).toBe(false);
    expect(result.accepted).toBe(accepted.length);
    expect(accepted).not.toContain(byName('Goblin Warrior').id);
  });

  it('tells each campaign in session once the Undo window has passed, and not at all after an undo', async () => {
    await actions.acceptRecords([byName('Ashen Choir').id, byName('Glimmerwing Drake').id]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(queueCampaignNotice).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(actions.NOTICE_DELAY_MS);
    expect(vi.mocked(queueCampaignNotice).mock.calls.map(([id]) => id).sort()).toEqual(['camp-a', 'camp-c']);
    expect(vi.mocked(queueCampaignNotice).mock.calls[0][1]).toContain('(1 spell, 1 monster)');

    vi.mocked(queueCampaignNotice).mockClear();
    const again = await actions.acceptRecords([byName('Cinder Mote').id]);
    await again.undo();
    await vi.advanceTimersByTimeAsync(actions.NOTICE_DELAY_MS + 1000);
    expect(queueCampaignNotice).not.toHaveBeenCalled();
  });

  it('waits to tell the DM while an Undo is still on offer (a longer window, or the pointer on the toast)', async () => {
    const { showUndo, useUndoToast } = await import('./UndoToast');
    const result = await actions.acceptRecords([byName('Cinder Mote').id]);
    showUndo('Accepted Cinder Mote.', result.undo);
    useUndoToast.getState().pause(useUndoToast.getState().item!.id);
    await vi.advanceTimersByTimeAsync(actions.NOTICE_DELAY_MS + 20_000);
    expect(queueCampaignNotice).not.toHaveBeenCalled();
    // Undone after all: nothing to tell.
    await result.undo();
    useUndoToast.getState().dismiss();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(queueCampaignNotice).not.toHaveBeenCalled();
  });

  it('never lets a move back to review hide another entry’s accept', async () => {
    const choir = byName('Ashen Choir');
    stored = stored.map((r) => (r.id === choir.id ? { ...r, status: 'accepted' } : r));
    // An entry accepted long ago goes back to review, then another spell is accepted.
    await actions.setRecordsStatus([choir.id], 'pending');
    await actions.acceptRecords([byName('Cinder Mote').id]);
    await vi.advanceTimersByTimeAsync(actions.NOTICE_DELAY_MS + 1000);
    expect(vi.mocked(queueCampaignNotice).mock.calls[0]?.[1]).toContain('(1 spell)');
  });

  it('stays quiet for a book that is switched off', async () => {
    vi.mocked(storage.listLibrarySources).mockResolvedValue([gloamwoodSource('gloam', 'md', { enabled: false })]);
    await actions.acceptRecords([byName('Ashen Choir').id]);
    await actions.flushAcceptNotices();
    expect(queueCampaignNotice).not.toHaveBeenCalled();
  });
});

describe('edits', () => {
  it('refuses fields DATA_SCHEMAS rejects', async () => {
    const drake = byName('Glimmerwing Drake');
    await expect(actions.saveRecordEdit(drake, { ...(drake.data as MonsterData), ac: 45 })).rejects.toThrow(/fixing/);
    expect(storage.putRecords).not.toHaveBeenCalled();
  });

  it('saves an edit as edited, keeping notices about untouched fields', async () => {
    const drake = {
      ...byName('Glimmerwing Drake'),
      data: { ...(EXPECTED_DATA['Glimmerwing Drake'] as MonsterData), hp: 58 },
      warnings: [
        { code: 'ungrounded' as const, severity: 'warn' as const, field: 'hpText', message: 'HP excerpt not found' },
        { code: 'ungrounded' as const, severity: 'warn' as const, field: 'acText', message: 'AC excerpt not found' },
      ],
    };
    stored = stored.map((r) => (r.id === drake.id ? drake : r));
    const saved = await actions.saveRecordEdit(drake, { ...drake.data, hp: 52 });
    expect(saved.edited).toBe(true);
    expect((saved.data as MonsterData).hp).toBe(52);
    expect(saved.warnings.map((w) => w.field)).toEqual(['acText']);
    expect(storage.putRecords).toHaveBeenCalledWith([saved]);
  });

  it('S2: measures an edit against the stored record, even when the record passed in already holds the new fields', async () => {
    const drake = {
      ...byName('Glimmerwing Drake'),
      data: { ...(EXPECTED_DATA['Glimmerwing Drake'] as MonsterData), hp: 58 },
      warnings: [
        { code: 'cross-check' as const, severity: 'warn' as const, field: 'hp', message: "HP 58 isn't near the average of 8d10 + 8 (52)." },
        { code: 'ungrounded' as const, severity: 'warn' as const, field: 'acText', message: 'AC excerpt not found' },
      ],
    };
    stored = stored.map((r) => (r.id === drake.id ? drake : r));
    const fixed = { ...drake.data, hp: 52 };
    // What the review form saves: recordFromDraft(), whose data is already the draft's.
    const saved = await actions.saveRecordEdit({ ...drake, data: fixed, edited: true }, fixed);
    expect(saved.warnings.map((w) => w.field)).toEqual(['acText']);
  });

  it('S2: a record filled in from nothing loses the reading\'s field problems; Claude\'s note stays', async () => {
    const goblin = {
      ...byName('Goblin Warrior'),
      origin: 'claude' as const,
      warnings: [
        { code: 'model-note' as const, severity: 'info' as const, message: 'Claude left a note about this entry.' },
        { code: 'missing' as const, severity: 'block' as const, field: 'abilities', message: "The ability scores weren't found." },
      ],
    };
    stored = stored.map((r) => (r.id === goblin.id ? goblin : r));
    const filled = { ...(EXPECTED_DATA['Glimmerwing Drake'] as MonsterData), type: 'Fey' };
    const saved = await actions.saveRecordEdit({ ...goblin, data: filled, origin: 'manual' }, filled);
    expect(saved.warnings.map((w) => w.code)).toEqual(['model-note']);
    expect(saved.origin).toBe('manual');
  });

  it('a record the player filled in after a failed read is no longer "couldn\'t read"', async () => {
    const failed = { ...byName('Goblin Warrior'), runState: 'failed' as const, runError: { code: 'invalid-output' as const, message: 'x', retryable: true } };
    const saved = await actions.saveRecordEdit(failed, { ...(EXPECTED_DATA['Glimmerwing Drake'] as MonsterData), type: 'Fey' });
    expect(saved.runState).toBeUndefined();
    expect(saved.runError).toBeUndefined();
    expect(saved.data).not.toBeNull();
  });

  it('takes or drops a newer reading', async () => {
    const choir = byName('Ashen Choir');
    const proposal = { data: { ...choir.data!, range: 'Self (30-foot cone)' }, warnings: [], adaptations: [], excerpts: [], origin: 'claude' as const, createdAt: 2 };
    stored = stored.map((r) => (r.id === choir.id ? { ...r, edited: true, proposal } : r));
    await actions.resolveProposal(choir.id, 'new');
    expect(byName('Ashen Choir')).toMatchObject({ edited: false, origin: 'claude', data: proposal.data });
    expect(byName('Ashen Choir').proposal).toBeUndefined();
  });

  it("sets a subclass's parent and drops the parent problem", async () => {
    const warden = {
      ...byName('Ember Warden'),
      warnings: [{ code: 'unresolved-ref' as const, severity: 'block' as const, field: 'parentClassText', message: 'No Fighter here' }],
    };
    stored = stored.map((r) => (r.id === warden.id ? warden : r));
    await actions.setParentClass(warden.id, 'srd:class:fighter');
    expect(byName('Ember Warden')).toMatchObject({ parentClassId: 'srd:class:fighter', warnings: [] });
  });

  it('sets the classes of several spells', async () => {
    await actions.setSpellClasses([byName('Ashen Choir').id, byName('Cinder Mote').id, byName('Hookstaff').id], ['Wizard']);
    expect((byName('Ashen Choir').data as { classes: string[] }).classes).toEqual(['Wizard']);
    expect((byName('Cinder Mote').data as { classes: string[] }).classes).toEqual(['Wizard']);
    expect(byName('Hookstaff').edited).toBe(false);
  });
});

describe('re-reading on this device', () => {
  it('moves an accepted misreading that got the note back to review, as Re-check does, with Undo', async () => {
    const grace = byName("Moth's Grace");
    stored = stored.map((r) => (r.id === grace.id ? { ...r, status: 'accepted' } : r));
    vi.mocked(data.rereadOffline).mockResolvedValueOnce({ doubted: 1, accepted: [grace.id], alreadyNoted: 0, busy: 0 });
    const result = await actions.rereadHere([grace.id]);
    expect(result).toMatchObject({ doubted: 1, movedBack: 1, alreadyNoted: 0, busy: 0 });
    expect(storage.setRecordStatus).toHaveBeenCalledWith([grace.id], 'pending');
    await result.undo?.();
    expect(byName("Moth's Grace").status).toBe('accepted');
  });

  it('moves nothing when nothing accepted got the note', async () => {
    vi.mocked(data.rereadOffline).mockResolvedValueOnce({ doubted: 0, accepted: [], alreadyNoted: 1, busy: 0 });
    const result = await actions.rereadHere([byName("Moth's Grace").id]);
    expect(result).toMatchObject({ movedBack: 0, alreadyNoted: 1 });
    expect(result.undo).toBeUndefined();
    expect(storage.setRecordStatus).not.toHaveBeenCalled();
  });
});

describe('looking through the book again', () => {
  it('moves the accepted entries the improved reader no longer finds back to review; Undo restores them and what it removed', async () => {
    const grace = byName("Moth's Grace");
    const bearer = byName('Lantern Bearer');
    const removedRoom = { ...byName('Hooked Reach'), id: 'rec:gloam:feat:glowworm-gallery', name: 'Glowworm Gallery' };
    stored = stored.map((r) => (r.id === grace.id ? { ...r, status: 'accepted' } : r));
    vi.mocked(data.detectStructure).mockResolvedValueOnce({
      ...gloamwoodDetection(),
      removed: { feat: 1 },
      removedNames: ['Glowworm Gallery'],
      removedRecords: [removedRoom],
      doubted: [{ id: grace.id, kind: 'feat', status: 'accepted', edited: false }, { id: bearer.id, kind: 'feat', status: 'pending', edited: false }],
    });
    const result = await actions.lookThroughBook('gloam');
    expect(result.movedBack).toBe(1);
    expect(storage.setRecordStatus).toHaveBeenCalledWith([grace.id], 'pending');
    expect(byName("Moth's Grace").status).toBe('pending');
    await vi.advanceTimersByTimeAsync(600);
    expect(data.invalidateRulesIndex).toHaveBeenCalledTimes(1);
    await result.undo?.();
    expect(byName("Moth's Grace").status).toBe('accepted');
    // Put back with the improved reader's note (a later look leaves it), and only where nothing took its place.
    expect(data.doubted).toHaveBeenCalledWith(removedRoom, expect.any(Number));
    expect(storage.commitRecords).toHaveBeenCalledWith([expect.objectContaining({ id: removedRoom.id })], [], new Map([[removedRoom.id, null]]));
  });

  it('offers Undo for removals alone, and nothing when nothing changed', async () => {
    const removedRoom = { ...byName('Hooked Reach'), id: 'rec:gloam:feat:glowworm-gallery', name: 'Glowworm Gallery' };
    vi.mocked(data.detectStructure).mockResolvedValueOnce({ ...gloamwoodDetection(), removed: { feat: 1 }, removedNames: ['Glowworm Gallery'], removedRecords: [removedRoom] });
    const removal = await actions.lookThroughBook('gloam');
    expect(removal.movedBack).toBe(0);
    expect(storage.setRecordStatus).not.toHaveBeenCalled();
    await removal.undo?.();
    expect(storage.commitRecords).toHaveBeenCalledWith([expect.objectContaining({ id: removedRoom.id })], [], new Map([[removedRoom.id, null]]));

    vi.mocked(data.detectStructure).mockResolvedValueOnce({ ...gloamwoodDetection(), doubted: [{ id: byName('Lantern Bearer').id, kind: 'feat', status: 'pending', edited: false }] });
    const quiet = await actions.lookThroughBook('gloam');
    expect(quiet.undo).toBeUndefined();
    await vi.advanceTimersByTimeAsync(600);
    expect(data.invalidateRulesIndex).not.toHaveBeenCalled();
  });

  it('tells the DM nothing when an entry goes back to review and Undo accepts it again', async () => {
    vi.mocked(storage.listCampaigns).mockResolvedValue([slot('camp-a', 'sess-1')]);
    const grace = byName("Moth's Grace");
    stored = stored.map((r) => (r.id === grace.id ? { ...r, status: 'accepted' } : r));
    vi.mocked(data.detectStructure).mockResolvedValueOnce({ ...gloamwoodDetection(), doubted: [{ id: grace.id, kind: 'feat', status: 'accepted', edited: false }] });
    const result = await actions.lookThroughBook('gloam');
    await vi.advanceTimersByTimeAsync(3000);
    await result.undo?.();
    await vi.advanceTimersByTimeAsync(actions.NOTICE_DELAY_MS + 1000);
    expect(queueCampaignNotice).not.toHaveBeenCalled();
  });
});

describe('keeping the fields after the text changed', () => {
  it('drops the note and takes the text as it is now, so the next look doesn’t note it again', async () => {
    const choir = { ...byName('Ashen Choir'), warnings: [{ code: 'stale-text' as const, severity: 'warn' as const, message: 'The text changed since this was read.' }], textHash: 'old' };
    stored = stored.map((r) => (r.id === choir.id ? choir : r));
    const entries = gloamwoodEntries();
    vi.mocked(storage.getSourceEntries).mockResolvedValue(entries);
    await actions.keepFields(choir.id);
    const saved = byName('Ashen Choir');
    expect(saved.warnings).toEqual([]);
    const { textFingerprint } = await import('@/lib/importedContent');
    expect(saved.textHash).toBe(textFingerprint(choir.entryIds.map((id) => entries.find((e) => e.id === id)!.text).join('\n\n')));
  });
});
