import { beforeEach, describe, expect, it } from 'vitest';
import { importedPlaceholder, wrapImported } from '@/lib/importedContent';
import { GLOAMWOOD_MARKERS, GLOAMWOOD_TITLE, importedRef, TEXT } from '@/test/structuredFixtures';
import type { Feature, InventoryItem, KnownSpell, TranscriptMessage } from '@/types';
import { exportCampaignBundle, exportCampaignBundleWithReport, parseCampaignBundle } from '@/storage';
import { serializeBundle } from './backup';
import { db } from './db';
import { REFUSED_CALL_TEXT, redactCopiedImports } from './redact';
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

describe("a spell's notes in a book's words, and refused calls' text, leave the copy", () => {
  const choirRef = importedRef({ entryId: 'lib:gloam:40', kind: 'spell', entryName: 'Ashen Choir', part: undefined, level: undefined });
  const choir: KnownSpell = { id: 'lib:gloam:40', name: 'Ashen Choir', level: 2, prepared: true, source: 'Granted in play', notes: `Sung at dusk. ${GLOAMWOOD_MARKERS[3]}`, ref: choirRef };
  const linkedOnly: KnownSpell = { ...choir, id: 'lib:gloam:41', name: 'Cinder Mote', notes: 'Cast it only at the old forge.', ref: { ...choirRef, entryName: 'Cinder Mote', textCopied: false, textHash: '' } };
  const own: KnownSpell = { id: 'sp-own', name: 'Glimmer Song', level: 1, prepared: true, source: 'Granted in play', notes: 'Once per dawn, without a slot.' };
  const toolResult = (id: string, isError: boolean): TranscriptMessage => ({
    id: `r-${id}`,
    sessionId: 'a-sess-2',
    seq: 11,
    param: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${id}`, content: 'Nothing changed.', ...(isError ? { is_error: true } : {}) }] },
    createdAt: 2,
  });
  const withSpells = (spells: KnownSpell[], transcript: TranscriptMessage[]): CampaignData => {
    const g = graph();
    const c = g.character!;
    return { ...g, character: { ...c, spellcasting: { ...(c.spellcasting ?? { ability: 'int', slots: {}, concentratingOn: null }), spells } }, transcript: [...g.transcript, ...transcript] };
  };
  const input = (data: CampaignData, id: string) => (data.transcript.find((m) => m.id === id)?.param.content as { type: string; input?: Record<string, unknown> }[])[1].input;

  it("replaces notes the DM tools marked as a book's words, on the sheet and in its spells_add input; other notes stay", () => {
    const g = withSpells([choir, linkedOnly, own], [
      toolUse('sp', 'update_character', {
        spells_add: [
          { name: 'Ashen Choir', level: 2, notes: choir.notes },
          { name: 'Glimmer Song', level: 1, notes: own.notes },
        ],
      }),
    ]);
    const { data, report } = redactCopiedImports(g);
    const spells = data.character?.spellcasting?.spells ?? [];
    expect(spells.find((s) => s.name === 'Ashen Choir')).toMatchObject({ notes: importedPlaceholder(GLOAMWOOD_TITLE), ref: { redacted: true, textCopied: true } });
    expect(spells.find((s) => s.name === 'Cinder Mote')).toEqual(linkedOnly);
    expect(spells.find((s) => s.name === 'Glimmer Song')).toEqual(own);
    expect(input(data, 'sp')).toEqual({
      spells_add: [
        { name: 'Ashen Choir', level: 2, notes: importedPlaceholder(GLOAMWOOD_TITLE) },
        { name: 'Glimmer Song', level: 1, notes: own.notes },
      ],
    });
    expect(JSON.stringify(data)).not.toContain(GLOAMWOOD_MARKERS[3]);
    expect(report.passages).toBe(6 + 2);
  });

  it("replaces every text of a call the app refused while a book is in play, and keeps an accepted call's own words", () => {
    const refusedInput = {
      features_add: [{ name: 'Lantern Lore', description: `The wick binds the hour. ${GLOAMWOOD_MARKERS[6]}` }],
      inventory_add: [{ name: 'Moth Lamp', quantity: 1, description: 'A lamp of paper moths.' }],
      spells_add: [{ name: 'Moth Call', level: 1, notes: 'Calls the moths.' }],
    };
    const accepted = { features_add: [{ name: 'Thorn Hide', description: 'Your skin grows thorns.' }] };
    const g = withSpells([], [toolUse('no', 'update_character', refusedInput), toolResult('no', true), toolUse('ok', 'update_character', accepted), toolResult('ok', false)]);
    const { data } = redactCopiedImports(g);
    expect(input(data, 'no')).toEqual({
      features_add: [{ name: 'Lantern Lore', description: REFUSED_CALL_TEXT }],
      inventory_add: [{ name: 'Moth Lamp', quantity: 1, description: REFUSED_CALL_TEXT }],
      spells_add: [{ name: 'Moth Call', level: 1, notes: REFUSED_CALL_TEXT }],
    });
    expect(input(data, 'ok')).toEqual(accepted);
    expect(JSON.stringify(data)).not.toContain(GLOAMWOOD_MARKERS[6]);
  });

  it('leaves a refused call alone in a campaign no book is part of (the same object, as before)', () => {
    const plain = campaignGraph('b');
    const g = { ...plain, transcript: [...plain.transcript, toolUse('no', 'update_character', { features_add: [{ name: 'Thorn Hide', description: 'Your skin grows thorns.' }] }), toolResult('no', true)] };
    expect(redactCopiedImports(g).data).toBe(g);
  });

  it('counts a book looked up in the transcript as in play, though nothing on the sheet came from one', () => {
    const plain = campaignGraph('b');
    const lookup: TranscriptMessage = { ...toolResult('lk', false), param: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-lk', content: wrapImported(GLOAMWOOD_TITLE, 'Book words.') }] } };
    const g = { ...plain, transcript: [...plain.transcript, lookup, toolUse('no', 'level_up', { class_name: 'Wizard', new_features: [{ name: 'Wick Sense', description: GLOAMWOOD_MARKERS[6] }] }), toolResult('no', true)] };
    const { data } = redactCopiedImports(g);
    expect(input(data, 'no')).toEqual({ class_name: 'Wizard', new_features: [{ name: 'Wick Sense', description: REFUSED_CALL_TEXT }] });
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

describe('P2: the DM’s inventory_update words about a book item leave exports', () => {
  // Invented text standing in for what the DM restates after reading the entry with get_entry.
  const RESTATED = 'While it burns, the lantern shows hidden things to everyone within 30 feet.';
  const ADDED = 'An old brass lantern with a hollow flame.';
  const linkedLantern = (over: Partial<InventoryItem> = {}): InventoryItem => ({
    ...lantern,
    description: RESTATED,
    ref: importedRef({ entryId: 'lib:gloam:43', kind: 'magic-item', entryName: 'Lantern of Hollow Light', part: undefined, level: undefined, textCopied: false, textHash: '' }),
    ...over,
  });
  const withItems = (inventory: InventoryItem[], transcript: TranscriptMessage[]): CampaignData => {
    const g = campaignGraph('a');
    const character = g.character as NonNullable<CampaignData['character']>;
    return { ...g, character: { ...character, inventory: [...character.inventory, ...inventory] }, transcript: [...g.transcript, ...transcript] };
  };
  const inputOf = (data: CampaignData, id: string) => (data.transcript.find((m) => m.id === id)?.param.content as { type: string; input?: Record<string, unknown> }[])[1].input;
  const placeholder = importedPlaceholder(GLOAMWOOD_TITLE);

  it('P2: linked without a description, then described with inventory_update: the sheet and the tool input both leave the copy', () => {
    const original = withItems(
      [linkedLantern()],
      [
        toolUse('add', 'update_character', { inventory_add: [{ name: 'Lantern of Hollow Light', quantity: 1 }] }),
        toolUse('upd', 'update_character', { inventory_update: [{ name: 'Lantern of Hollow Light', attuned: true, description: RESTATED }] }),
      ],
    );
    const before = JSON.stringify(original);
    const { data, report } = redactCopiedImports(original);
    expect(JSON.stringify(original)).toBe(before);
    expect(JSON.stringify(data)).not.toContain(RESTATED);
    expect(data.character?.inventory.find((i) => i.id === 'i-lantern')).toMatchObject({ description: placeholder, ref: { textCopied: true, redacted: true } });
    expect(inputOf(data, 'upd')).toEqual({ inventory_update: [{ name: 'Lantern of Hollow Light', attuned: true, description: placeholder }] });
    expect(inputOf(data, 'add')).toEqual({ inventory_add: [{ name: 'Lantern of Hollow Light', quantity: 1 }] });
    expect(report).toEqual({ books: [GLOAMWOOD_TITLE], passages: 2 });
  });

  it('P2: an item whose copied text already left the sheet loses its later inventory_update input too', () => {
    const copied = linkedLantern({ ref: importedRef({ entryId: 'lib:gloam:43', kind: 'magic-item', entryName: 'Lantern of Hollow Light', part: undefined, level: undefined }) });
    const { data, report } = redactCopiedImports(
      withItems(
        [copied],
        [
          toolUse('add', 'update_character', { inventory_add: [{ name: 'Lantern of Hollow Light', quantity: 1, description: ADDED }] }),
          toolUse('upd', 'update_character', { inventory_update: [{ name: 'Lantern of Hollow Light', description: RESTATED }] }),
        ],
      ),
    );
    const text = JSON.stringify(data);
    expect(text).not.toContain(RESTATED);
    expect(text).not.toContain(ADDED);
    expect(report).toEqual({ books: [GLOAMWOOD_TITLE], passages: 3 });
  });

  it('P2: an entry finds its item as the engine does ("Lantern"); a stacked add’s words go too, and plain items keep theirs', () => {
    const { data, report } = redactCopiedImports(
      withItems(
        [linkedLantern(), hookstaff],
        [
          toolUse('upd', 'update_character', {
            inventory_update: [
              { name: 'Lantern', description: RESTATED },
              { name: 'Robe', description: 'Patched at both elbows.' },
            ],
          }),
          // A second Hookstaff stacks onto the first (the sheet keeps the app's line), but the DM's words were in the call.
          toolUse('stack', 'update_character', { inventory_add: [{ name: 'Hookstaff', quantity: 1, description: 'A hooked staff, as the book tells it.' }] }),
        ],
      ),
    );
    expect(inputOf(data, 'upd')).toEqual({ inventory_update: [{ name: 'Lantern', description: placeholder }, { name: 'Robe', description: 'Patched at both elbows.' }] });
    expect(inputOf(data, 'stack')).toEqual({ inventory_add: [{ name: 'Hookstaff', quantity: 1, description: placeholder }] });
    expect(data.character?.inventory.find((i) => i.id === 'i-lantern')?.description).toBe(placeholder);
    expect(data.character?.inventory.find((i) => i.id === 'i-hook')).toEqual(hookstaff);
    expect(report.passages).toBe(3);
  });

  it('P2: a name that later fits two items ("Lantern" with a plain Lantern Hook picked up) still leaves the DM’s words out of the transcript copy', () => {
    const hook: InventoryItem = { ...lantern, id: 'i-lantern-hook', name: 'Lantern Hook', description: 'A plain iron hook.', ref: undefined };
    const { data } = redactCopiedImports(
      withItems([linkedLantern(), hook], [toolUse('upd', 'update_character', { inventory_update: [{ name: 'Lantern', description: RESTATED }] })]),
    );
    expect(JSON.stringify(data.transcript)).not.toContain(RESTATED);
    expect(inputOf(data, 'upd')).toEqual({ inventory_update: [{ name: 'Lantern', description: placeholder }] });
    expect(data.character?.inventory.find((i) => i.id === 'i-lantern-hook')?.description).toBe('A plain iron hook.');
  });
});
