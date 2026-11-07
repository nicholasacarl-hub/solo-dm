import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadCampaign,
  exportCampaignBundle,
  getCampaign,
  importCampaignBundle,
  listCampaigns,
  loadCampaignRecords,
  parseCampaignBundle,
  putHomebrew,
  saveLibrarySource,
  type CampaignBundle,
} from '@/storage';
import { db } from './db';
import { serializeBundle } from './backup';
import { onCampaignChange, type CampaignChange } from './events';
import { allIds, campaignGraph, resetDatabase, seedCampaign, sharedHomebrew } from './testData';

beforeEach(resetDatabase);

/** A bundle as it would come back from a file: serialized and parsed again. */
function roundTrip(bundle: CampaignBundle): unknown {
  return JSON.parse(serializeBundle(bundle)) as unknown;
}

describe('exportCampaignBundle', () => {
  it('holds one campaign with every session transcript, its own homebrew only, and no library content', async () => {
    await seedCampaign('a');
    await seedCampaign('b');
    await putHomebrew(sharedHomebrew());
    await saveLibrarySource(
      { id: 'phb', title: 'My book', kind: 'import', enabled: true, entryCount: 0, createdAt: 1, updatedAt: 1 },
      [{ id: 'lib:phb:1', sourceId: 'phb', sourceName: 'My book', kind: 'rule', name: 'Secret rule', text: 'COPYRIGHTED TEXT' }],
    );

    const bundle = await exportCampaignBundle('a-camp');

    expect(bundle).toMatchObject({ format: 'solo-dm-campaign', version: 1 });
    expect(bundle.exportedAt).toBeGreaterThan(0);
    expect(bundle.transcript.map((m) => m.id)).toEqual(['a-t1', 'a-t2', 'a-t3', 'a-t4', 'a-t5']);
    expect(bundle.homebrew.map((h) => h.id)).toEqual(['hb:a-fireblade']);
    const text = serializeBundle(bundle);
    expect(text).not.toContain('COPYRIGHTED TEXT');
    expect(text).not.toContain('b-camp');
    expect(Object.keys(bundle).sort()).toEqual(
      ['campaign', 'character', 'clocks', 'combat', 'exportedAt', 'format', 'homebrew', 'journal', 'log', 'quests', 'sessions', 'transcript', 'version'],
    );
  });

  it('rejects for a missing campaign', async () => {
    await expect(exportCampaignBundle('missing')).rejects.toThrow(/no longer exists/);
  });
});

describe('importCampaignBundle', () => {
  let changes: CampaignChange[] = [];
  let unsubscribe = () => {};
  beforeEach(() => {
    changes = [];
    unsubscribe = onCampaignChange((c) => changes.push(c));
  });
  afterEach(() => unsubscribe());

  it("round-trips in 'replace' mode: same ids, and records missing from the file are removed", async () => {
    const graph = await seedCampaign('a');
    const bundle = parseCampaignBundle(roundTrip(await exportCampaignBundle('a-camp')));
    // Play on after the backup was made.
    await db.journal.put({ ...graph.journal[0], id: 'a-j-new', name: 'Later NPC' });
    await db.characters.update('a-char', { hp: { max: 17, current: 1, temp: 0 } });

    const imported = await importCampaignBundle(bundle, 'replace');

    expect(imported.id).toBe('a-camp');
    const { exportedAt: _e, format: _f, version: _v, ...data } = await exportCampaignBundle('a-camp');
    expect(data).toEqual(campaignGraph('a'));
    expect(changes).toEqual([{ type: 'replaced', campaignId: 'a-camp' }]);
  });

  it("imports with the original ids when the campaign doesn't exist yet (either mode)", async () => {
    const bundle = { format: 'solo-dm-campaign', version: 1, exportedAt: 1, ...campaignGraph('a') } as const;
    const imported = await importCampaignBundle(parseCampaignBundle(roundTrip(bundle)), 'copy');
    expect(imported.id).toBe('a-camp');
    expect(imported.name).toBe('Campaign a');
    expect((await loadCampaignRecords('a-camp'))?.transcript).toHaveLength(3);
    expect(changes).toEqual([]);
  });

  it("round-trips in 'copy' mode: fresh ids, remapped references, original untouched", async () => {
    const graph = await seedCampaign('a');
    const bundle = parseCampaignBundle(roundTrip(await exportCampaignBundle('a-camp')));

    const copy = await importCampaignBundle(bundle, 'copy');

    expect(copy.id).not.toBe('a-camp');
    expect(copy.name).toBe('Campaign a (copy)');
    expect((await listCampaigns()).map((s) => s.campaign.id).sort()).toEqual([copy.id, 'a-camp'].sort());
    const data = await exportCampaignBundle(copy.id);
    const originalIds = new Set(allIds(graph));
    for (const id of allIds(data)) expect(originalIds.has(id), id).toBe(false);
    expect(data.character?.campaignId).toBe(copy.id);
    expect(copy.characterId).toBe(data.character?.id);
    expect(copy.activeSessionId).toBe(data.sessions.find((s) => s.number === 2)?.id);
    const sessionIds = new Set(data.sessions.map((s) => s.id));
    expect(data.transcript.every((m) => sessionIds.has(m.sessionId))).toBe(true);
    expect(data.log.every((e) => e.campaignId === copy.id && (e.sessionId === null || sessionIds.has(e.sessionId)))).toBe(true);
    expect(data.transcript).toHaveLength(graph.transcript.length);
    const { exportedAt: _e, format: _f, version: _v, ...original } = await exportCampaignBundle('a-camp');
    expect(original).toEqual(graph);
    expect(changes).toEqual([]);
  });

  it('makes the records agree with the campaign (links, owners, orphan transcript)', async () => {
    const graph = campaignGraph('a');
    const bundle: CampaignBundle = {
      format: 'solo-dm-campaign',
      version: 1,
      exportedAt: 1,
      ...graph,
      campaign: { ...graph.campaign, characterId: 'stale', activeSessionId: 'a-sess-1' },
      journal: graph.journal.map((j) => ({ ...j, campaignId: 'elsewhere' })),
      transcript: [...graph.transcript, { ...graph.transcript[0], id: 'orphan', sessionId: 'unknown-session' }],
    };

    const imported = await importCampaignBundle(bundle);

    expect(imported.characterId).toBe('a-char');
    // Session 1 has ended, so it can't be the active one.
    expect(imported.activeSessionId).toBeNull();
    expect((await db.journal.where('campaignId').equals('a-camp').count())).toBe(graph.journal.length);
    expect(await db.transcript.get('orphan')).toBeUndefined();
  });

  it('imports as a copy when record ids already belong to another campaign', async () => {
    await seedCampaign('a');
    const graph = campaignGraph('a');
    // A hand-edited file: new campaign id, but every other record id is campaign a's.
    const bundle: CampaignBundle = { format: 'solo-dm-campaign', version: 1, exportedAt: 1, ...graph, campaign: { ...graph.campaign, id: 'edited' } };

    const imported = await importCampaignBundle(bundle, 'replace');

    expect(imported.id).not.toBe('edited');
    expect(imported.id).not.toBe('a-camp');
    const { exportedAt: _e, format: _f, version: _v, ...original } = await exportCampaignBundle('a-camp');
    expect(original).toEqual(graph);
  });
});

describe('parseCampaignBundle', () => {
  const valid = () => roundTrip({ format: 'solo-dm-campaign', version: 1, exportedAt: 1, ...campaignGraph('a') }) as Record<string, unknown>;

  it('accepts a valid bundle, or its JSON text', () => {
    const data = valid();
    expect(parseCampaignBundle(data).campaign.id).toBe('a-camp');
    expect(parseCampaignBundle(JSON.stringify(data)).log).toHaveLength(12);
  });

  it.each([
    ['not an object', 42, /expected a JSON object/],
    ['an array', [], /expected a JSON object/],
    ['null', null, /expected a JSON object/],
    ['invalid JSON text', '{nope', /not valid JSON/],
    ['another format', { format: 'something-else', version: 1 }, /format marker/],
  ])('rejects %s with a readable error', (_label, input, message) => {
    expect(() => parseCampaignBundle(input)).toThrow(message);
  });

  it('explains saves from a newer version', () => {
    expect(() => parseCampaignBundle({ ...valid(), version: 2 })).toThrow(/newer version of Solo DM/);
  });

  it('names the broken field', () => {
    const data = valid();
    const campaign = data.campaign as Record<string, unknown>;
    expect(() => parseCampaignBundle({ ...data, campaign: { ...campaign, id: '' } })).toThrow(/campaign\.id/);
    const log = data.log as Record<string, unknown>[];
    expect(() => parseCampaignBundle({ ...data, log: [{ ...log[0], seq: 'first' }] })).toThrow(/log\[0\]\.seq/);
    expect(() => parseCampaignBundle({ ...data, sessions: 'none' })).toThrow(/sessions/);
    const { settings: _s, ...noSettings } = campaign;
    expect(() => parseCampaignBundle({ ...data, campaign: noSettings })).toThrow(/campaign\.settings/);
  });

  it('is lenient: keeps unknown fields and fills missing optional ones', () => {
    const data = valid();
    const campaign = data.campaign as Record<string, unknown>;
    const { tension: _t, usage: _u, scene: _sc, ...slim } = campaign;
    const journal = (data.journal as Record<string, unknown>[]).map(({ tags: _tags, ...j }) => j);

    const bundle = parseCampaignBundle({
      ...data,
      futureField: { keep: true },
      campaign: { ...slim, futureSetting: 'kept', settings: { ...(slim.settings as object), difficulty: 'legendary' } },
      journal,
      quests: undefined,
    });

    expect((bundle as unknown as Record<string, unknown>).futureField).toEqual({ keep: true });
    expect((bundle.campaign as unknown as Record<string, unknown>).futureSetting).toBe('kept');
    expect(bundle.campaign.tension).toBe(5);
    expect(bundle.campaign.usage.requests).toBe(0);
    expect(bundle.campaign.scene).toEqual({ location: 'Unknown' });
    expect(bundle.campaign.settings.difficulty).toBe('standard');
    expect(bundle.journal.every((j) => Array.isArray(j.tags))).toBe(true);
    expect(bundle.quests).toEqual([]);
    expect(bundle.character?.spellcasting?.spells).toHaveLength(10);
  });
});

describe('downloadCampaign', () => {
  afterEach(() => vi.restoreAllMocks());

  it('downloads "<slug>.solodm.json" through a temporary link', async () => {
    await seedCampaign('a', { campaign: { name: "Mira's Lantern: Act II" } });
    let blob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      blob = b as Blob;
      return 'blob:solo-dm-test';
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });

    await downloadCampaign('a-camp');

    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe('mira-s-lantern-act-ii.solodm.json');
    expect(clicked[0].href).toBe('blob:solo-dm-test');
    expect(document.body.contains(clicked[0])).toBe(false);
    expect(blob?.type).toBe('application/json');
    const parsed = parseCampaignBundle(JSON.parse((await blob?.text()) ?? '') as unknown);
    expect(parsed.campaign.id).toBe('a-camp');
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:solo-dm-test'));
    expect(await getCampaign('a-camp')).toBeDefined();
  });
});
