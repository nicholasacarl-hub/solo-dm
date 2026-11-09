import { beforeEach, describe, expect, it } from 'vitest';
import { importedPlaceholder, wrapImported } from '@/lib/importedContent';
import { GLOAMWOOD_MARKERS, GLOAMWOOD_TITLE, importedRef, TEXT } from '@/test/structuredFixtures';
import type { Feature, InventoryItem, TranscriptMessage } from '@/types';
import { exportCampaignBundle, exportCampaignBundleWithReport, parseCampaignBundle } from '@/storage';
import { serializeBundle } from './backup';
import { db } from './db';
import { redactCopiedImports } from './redact';
import { campaignGraph, resetDatabase } from './testData';
import type { CampaignData } from './types';

const EMBER_WARD = TEXT.emberWard.join('\n\n');
const MOTHS_GRACE = TEXT.mothsGrace.join('\n\n');

const emberWard: Feature = { id: 'f-ember', name: 'Ember Ward', source: 'subclass', sourceName: 'Ember Warden 3', description: EMBER_WARD, ref: importedRef() };
const mothsGrace: Feature = {
  id: 'f-moth',
  name: "Moth's Grace",
  source: 'feat',
  description: MOTHS_GRACE,
  ref: importedRef({ entryId: 'lib:gloam:35', kind: 'feat', entryName: "Moth's Grace", part: undefined, level: undefined }),
};
const lantern: InventoryItem = {
  id: 'i-lantern',
  name: 'Lantern of Hollow Light',
  quantity: 1,
  description: 'The DM says it shows what hides.',
  ref: importedRef({ entryId: 'lib:gloam:43', kind: 'magic-item', entryName: 'Lantern of Hollow Light', part: undefined, level: undefined }),
};
const hookstaff: InventoryItem = {
  id: 'i-hook',
  name: 'Hookstaff',
  quantity: 1,
  description: 'Martial melee weapon · 1d8 bludgeoning · Reach, Two-Handed',
  ref: importedRef({ entryId: 'lib:gloam:item:hookstaff', kind: 'item', entryName: 'Hookstaff', part: undefined, level: undefined, textCopied: false, textHash: '' }),
};

const toolUse = (id: string, name: string, input: unknown): TranscriptMessage => ({
  id,
  sessionId: 'a-sess-2',
  seq: 10,
  param: { role: 'assistant', content: [{ type: 'text', text: 'Leveling up.' }, { type: 'tool_use', id: `tu-${id}`, name, input }] },
  createdAt: 1,
});

function graph(): CampaignData {
  const g = campaignGraph('a');
  const character = g.character;
  if (!character) throw new Error('no character');
  return {
    ...g,
    character: { ...character, features: [...character.features, emberWard, mothsGrace], inventory: [...character.inventory, lantern, hookstaff] },
    transcript: [
      ...g.transcript,
      toolUse('lv', 'level_up', { class_name: 'Fighter', new_features: [{ name: 'Ember Ward', description: EMBER_WARD }, { name: 'Second Wind', description: 'Regain HP.' }] }),
      toolUse('uc', 'update_character', {
        features_add: [{ name: "moth's grace", description: MOTHS_GRACE }],
        inventory_add: [{ name: 'Lantern of Hollow Light', description: 'The DM says it shows what hides.' }],
      }),
      toolUse('rd', 'roll_dice', { expression: '1d20', purpose: EMBER_WARD }),
    ],
  };
}

describe('redactCopiedImports (spec §7.3)', () => {
  it('replaces copied book text on the sheet with the placeholder and marks the ref', () => {
    const { data, report } = redactCopiedImports(graph());
    const features = data.character?.features ?? [];
    expect(features.find((f) => f.id === 'f-ember')).toMatchObject({ name: 'Ember Ward', description: importedPlaceholder(GLOAMWOOD_TITLE), ref: { redacted: true, entryName: 'Ember Warden', part: 'Ember Ward' } });
    expect(features.find((f) => f.id === 'f-moth')?.description).toBe(importedPlaceholder(GLOAMWOOD_TITLE));
    // The DM's words about an imported item are left out too (textCopied: true)…
    expect(data.character?.inventory.find((i) => i.id === 'i-lantern')).toMatchObject({ description: importedPlaceholder(GLOAMWOOD_TITLE), ref: { redacted: true } });
    // …but an app-written description stays (textCopied: false).
    expect(data.character?.inventory.find((i) => i.id === 'i-hook')).toEqual(hookstaff);
    // SRD and homebrew features are untouched.
    expect(features.find((f) => f.id === 'a-feat-hb')?.description).toBe('Homebrew.');
    expect(report).toEqual({ books: [GLOAMWOOD_TITLE], passages: 6 });
  });

  it('replaces the DM tool inputs that echo those texts, in the copy only', () => {
    const original = graph();
    const before = JSON.stringify(original);
    const { data } = redactCopiedImports(original);
    expect(JSON.stringify(original)).toBe(before);
    const input = (id: string) => (data.transcript.find((m) => m.id === id)?.param.content as { type: string; input?: Record<string, unknown> }[])[1].input;
    expect(input('lv')).toEqual({ class_name: 'Fighter', new_features: [{ name: 'Ember Ward', description: importedPlaceholder(GLOAMWOOD_TITLE) }, { name: 'Second Wind', description: 'Regain HP.' }] });
    expect(input('uc')).toEqual({
      features_add: [{ name: "moth's grace", description: importedPlaceholder(GLOAMWOOD_TITLE) }],
      inventory_add: [{ name: 'Lantern of Hollow Light', description: importedPlaceholder(GLOAMWOOD_TITLE) }],
    });
    // Only the listed fields of level_up / update_character; other tools are left to the wrapper rules.
    expect(input('rd')).toEqual({ expression: '1d20', purpose: EMBER_WARD });
    // Messages without echoes are shared, not copied.
    expect(data.transcript[0]).toBe(original.transcript[0]);
  });

  it('changes nothing (same object) for a campaign without copied book text', () => {
    const plain = campaignGraph('b');
    const { data, report } = redactCopiedImports(plain);
    expect(data).toBe(plain);
    expect(report).toEqual({ books: [], passages: 0 });
  });

  it('marks a placeholder from another device as redacted without counting it', () => {
    const g = graph();
    const left = { ...emberWard, description: importedPlaceholder(GLOAMWOOD_TITLE) };
    const { data, report } = redactCopiedImports({ ...g, character: { ...(g.character as NonNullable<CampaignData['character']>), features: [left], inventory: [] }, transcript: [] });
    expect(data.character?.features[0].ref?.redacted).toBe(true);
    expect(report.passages).toBe(0);
  });
});

describe('exports leave copied book text out (backup.ts)', () => {
  beforeEach(resetDatabase);

  async function seedWithLookups() {
    const g = graph();
    // A get_character_sheet / get_entry result: wrapped, so redactImportedDeep removes it.
    const lookup: TranscriptMessage = {
      id: 'a-lookup',
      sessionId: 'a-sess-2',
      seq: 11,
      param: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-lv', content: wrapImported(GLOAMWOOD_TITLE, `Steady Flame. ${TEXT.steadyFlame[0]}`) }] },
      createdAt: 2,
    };
    // (The DM's free text elsewhere — a roll's purpose, narration — is not covered, as disclosed; leave it out here.)
    const data = { ...g, transcript: [...g.transcript.filter((m) => m.id !== 'rd'), lookup] };
    const { writeCampaignData } = await import('./campaignData');
    await writeCampaignData(data);
    return data;
  }

  it('exportCampaignBundleWithReport carries no copied text and reports it; the stored campaign is unchanged', async () => {
    const data = await seedWithLookups();
    const storedBefore = await db.characters.get(data.character?.id as string);
    const { bundle, report } = await exportCampaignBundleWithReport(data.campaign.id);
    const text = serializeBundle(bundle);
    for (const marker of GLOAMWOOD_MARKERS) expect(text).not.toContain(marker);
    expect(text).toContain('Ember Ward');
    // (JSON escapes the quotes around the title.)
    expect(text).toContain(JSON.stringify(importedPlaceholder(GLOAMWOOD_TITLE)).slice(1, -1));
    expect(report.books).toEqual([GLOAMWOOD_TITLE]);
    expect(report.passages).toBe(6);
    expect(await db.characters.get(data.character?.id as string)).toEqual(storedBefore);
    const stored = await db.transcript.get('a-lookup');
    expect(JSON.stringify(stored)).toContain(GLOAMWOOD_MARKERS[7]);
    // A file older apps read: format version 1, refs kept (with redacted), no pack fields.
    const parsed = parseCampaignBundle(text);
    expect(parsed.version).toBe(1);
    expect(parsed.character?.features.find((f) => f.id === 'f-ember')?.ref).toMatchObject({ redacted: true, textCopied: true });
    expect(Object.keys(parsed)).not.toContain('records');
    expect(Object.keys(parsed)).not.toContain('entries');
  });

  it('exportCampaignBundle (GitHub pushes) is the same redacted bundle', async () => {
    const data = await seedWithLookups();
    const bundle = await exportCampaignBundle(data.campaign.id);
    const text = serializeBundle(bundle);
    for (const marker of GLOAMWOOD_MARKERS) expect(text).not.toContain(marker);
  });
});
