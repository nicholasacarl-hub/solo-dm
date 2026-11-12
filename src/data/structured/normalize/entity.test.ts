/**
 * The entity normalizers (monster, spell, magic item, item; spec §3.9): the scripted Claude answers and
 * the offline parser both normalize to EXPECTED_DATA; sentinels become absent fields; grounding,
 * cross-checks and the DM tool limits (SRD 5.2.1 "Monsters": XP by CR, proficiency bonus by CR, Hit
 * Points as the Hit Dice average; "Spells": Concentration; "Equipment": Armor) produce their warnings.
 */
import { describe, expect, it } from 'vitest';
import compendiumRaw from '../../../../public/srd/compendium.json?raw';
import { chunkDocument } from '@/data/chunk';
import { pdfPagesToMarkdown, type PdfTextRun } from '@/data/pdfLayout';
import { EXPECTED_ADAPTATIONS, EXPECTED_DATA, SCRIPTED_WIRE, gloamwoodEntries, type GloamwoodDataName } from '@/test/structuredFixtures';
import type { CompendiumEntry, StructuredKind } from '@/types';
import { parseOffline } from '../parse';
import { flatten } from '../parse/flatten';
import { DATA_SCHEMAS } from '../schemas';
import { segment, type Candidate } from '../segment';
import type { Wire } from '../wire';
import { normalize, normalizeItemRows, validateData, type NormalizeContext } from './index';

/** SRD spells the Wickwright Spell List names (nameKeys), as the rules index would supply them. */
const SEG = { knownSpellNames: new Set(['burning-hands', 'continual-flame', 'daylight', 'detect-magic', 'faerie-fire', 'fireball']), knownClassNames: new Set<string>() };
const md = gloamwoodEntries();
const mixed = gloamwoodEntries('gloam', 'mixed');
const { candidates, spellLists } = segment(md, SEG);
const candidate = (name: string, list = candidates) => list.find((c) => c.name === name) as Candidate;
const ctxOf = (c: Candidate, entries = md, origin: NormalizeContext['origin'] = 'claude'): NormalizeContext => ({
  blocks: c.blocks,
  entriesById: new Map(entries.map((e) => [e.id, e])),
  origin,
  spellLists,
});
const wireOf = <K extends StructuredKind>(title: string) => SCRIPTED_WIRE[title].wire as Wire<K>;
const run = <K extends StructuredKind>(kind: K, name: string, wire: Wire<K> = wireOf<K>(name)) => normalize(kind, wire, ctxOf(candidate(name)));

const ENTITIES: [StructuredKind, GloamwoodDataName][] = [
  ['spell', 'Ashen Choir'],
  ['spell', 'Cinder Mote'],
  ['magic-item', 'Lantern of Hollow Light'],
  ['magic-item', 'Mothsilk Cloak'],
  ['magic-item', "Warden's Mail"],
  ['item', 'Wick Lantern'],
  ['monster', 'Bramble Hound'],
];

describe('entity normalizers: the scripted answers and the offline parser give EXPECTED_DATA', () => {
  it.each(ENTITIES)('%s %s from Claude’s answer', (kind, name) => {
    const n = run(kind, name);
    expect(n.data).toEqual(EXPECTED_DATA[name]);
    expect(n.adaptations).toEqual(EXPECTED_ADAPTATIONS[name] ?? []);
    expect(n.confidence).toBe('high');
    expect(DATA_SCHEMAS[kind].safeParse(n.data).success).toBe(true);
  });

  it.each(ENTITIES)('%s %s from the offline parser', (_kind, name) => {
    const c = candidate(name);
    const { wire, missing } = parseOffline(c);
    const n = normalize(c.kind, wire, { ...ctxOf(c, md, 'parser'), missing });
    expect(n.data).toEqual(EXPECTED_DATA[name]);
    expect(n.confidence).toBe('high');
  });

  it('reads the Glimmerwing Drake offline from Markdown with HP 52, and flags the scripted HP 58', () => {
    const c = candidate('Glimmerwing Drake');
    const offline = parseOffline(c);
    expect(normalize('monster', offline.wire as Wire<'monster'>, { ...ctxOf(c, md, 'parser'), missing: offline.missing }).data).toEqual(EXPECTED_DATA['Glimmerwing Drake']);
    const fromClaude = run('monster', 'Glimmerwing Drake');
    expect(fromClaude.data).toEqual({ ...EXPECTED_DATA['Glimmerwing Drake'], hp: 58 });
    expect(fromClaude.warnings.map((w) => [w.code, w.severity, w.field])).toEqual([
      ['ungrounded', 'warn', 'hp'],
      ['cross-check', 'warn', 'hp'],
    ]);
    expect(fromClaude.confidence).toBe('medium');
    expect(fromClaude.excerpts.find((e) => e.field === 'hpText')).toEqual({ field: 'hpText', text: '58 (8d10 + 8)', grounded: false });
  });

  it('keeps the flattened drake for Claude: no data without its ability scores', () => {
    const flat = segment(mixed, SEG).candidates;
    const c = candidate('Glimmerwing Drake', flat);
    const { wire, missing } = parseOffline(c);
    const n = normalize('monster', wire as Wire<'monster'>, { ...ctxOf(c, mixed, 'parser'), missing });
    expect(n.data).toBeNull();
    expect(n.warnings).toContainEqual(expect.objectContaining({ code: 'missing', severity: 'block', field: 'abilities' }));
    expect(n.confidence).toBe('low');
  });

  it('normalizes each row of a gear table on its own', () => {
    const rows = normalizeItemRows(wireOf<'item'>('Gloamwood Arms'), ctxOf(candidate('Gloamwood Arms')));
    expect(rows.map((r) => [r.name, r.data, r.confidence])).toEqual([['Hookstaff', EXPECTED_DATA.Hookstaff, 'high']]);
    expect(rows[0].excerpts.map((e) => e.field)).toEqual(['items[0].costText', 'items[0].weightText', 'items[0].damageText', 'items[0].propertiesText', 'items[0].masteryText']);
  });
});

describe('monster normalizer', () => {
  const hound = wireOf<'monster'>('Bramble Hound');
  const drake = wireOf<'monster'>('Glimmerwing Drake');

  it('fills an older stat block’s initiative from its Dexterity (info, adaptation) and its PB from its CR', () => {
    const n = run('monster', 'Bramble Hound');
    expect(n.warnings).toEqual([{ code: 'default-used', severity: 'info', field: 'initiative', message: 'No Initiative line: the app used the Dexterity modifier.' }]);
    expect(n.data).toMatchObject({ initiative: 1, pb: 2, xp: 200 });
  });

  it('cross-checks XP against the CR, the printed PB, HP against its dice and initiative against Dexterity', () => {
    const n = run('monster', 'Glimmerwing Drake', { ...drake, hpText: '52 (8d10 + 8)', crText: '3 (XP 900; PB +3)', initiativeText: '+7 (17)' });
    expect(n.warnings.filter((w) => w.code === 'cross-check').map((w) => w.field)).toEqual(['xp', 'pb', 'initiative']);
    expect(n.confidence).toBe('medium');
  });

  it('blocks values combat and the DM tools reject, and clamps reach', () => {
    const n = run('monster', 'Glimmerwing Drake', { ...drake, hpText: '52 (8d10 + 8)', acText: '45', speedText: '30 ft., Fly 250 ft.', reachText: 'reach 120 ft.' });
    expect(n.warnings.filter((w) => w.severity === 'block').map((w) => [w.code, w.field])).toEqual([
      ['out-of-range', 'ac'],
      ['out-of-range', 'speeds'],
    ]);
    expect(n.data?.reachFt).toBe(60);
    expect(n.confidence).toBe('low');
  });

  it('turns sentinels into absent fields and several sizes into `sizes`', () => {
    const n = run('monster', 'Glimmerwing Drake', { ...drake, hpText: '52 (8d10 + 8)', sizeText: 'Medium or Small', alignmentText: '', sensesText: '', languagesText: '', reachText: '' });
    expect(n.data).toMatchObject({ size: 'Medium', sizes: ['Medium', 'Small'], reachFt: 10 });
    for (const key of ['alignment', 'senses', 'passivePerception', 'languages', 'resistances', 'immunities', 'vulnerabilities']) expect(n.data).not.toHaveProperty(key);
  });

  it('has no data when a key field is missing, and blocks "not this kind"', () => {
    expect(run('monster', 'Goblin Warrior').data).toBeNull();
    const not = run('monster', 'Bramble Hound', { ...hound, matchesKind: false });
    expect(not.warnings).toContainEqual(expect.objectContaining({ code: 'not-this-kind', severity: 'block' }));
    expect(not.confidence).toBe('low');
  });

  it('keeps Claude’s note as modelNote with an info warning that never lowers confidence', () => {
    const n = run('monster', 'Bramble Hound', { ...hound, notes: 'Two stat blocks share this entry.' });
    expect(n.modelNote).toBe('Two stat blocks share this entry.');
    expect(n.warnings).toContainEqual(expect.objectContaining({ code: 'model-note', severity: 'info' }));
    expect(n.confidence).toBe('high');
  });

  // An invented older-layout stat block printing Damage Immunities and Condition Immunities apart.
  const husk = [
    '_Medium Undead, Neutral Evil_',
    '**Armor Class** 12',
    '**Hit Points** 22 (4d8 + 4)',
    '**Speed** 30 ft.',
    ['| STR | DEX | CON | INT | WIS | CHA |', '|---|---|---|---|---|---|', '| 13 (+1) | 14 (+2) | 12 (+1) | 5 (−3) | 9 (−1) | 6 (−2) |'].join('\n'),
    '**Damage Immunities** poison',
    '**Condition Immunities** exhaustion, poisoned',
    '**Senses** darkvision 60 ft., passive Perception 9',
    '**Languages** —',
    '**Challenge** 1/2 (100 XP)',
    '### Actions',
    '***Ember Claw.*** *Melee Weapon Attack:* +3 to hit, reach 5 ft., one target. *Hit:* 4 (1d6 + 1) slashing damage.',
  ].join('\n\n');
  const huskEntries = [{ id: 'lib:h:1', sourceId: 'h', sourceName: 'Husk Notes', kind: 'monster' as const, name: 'Lantern Husk', text: husk, path: ['Bestiary', 'Lantern Husk'] }];
  const huskCandidate = segment(huskEntries, SEG).candidates[0];
  const huskCtx = (origin: NormalizeContext['origin']): NormalizeContext => ({ blocks: huskCandidate.blocks, entriesById: new Map(huskEntries.map((e) => [e.id, e])), origin, spellLists: [] });

  it('X5: grounds an older stat block’s two immunity lines part by part, offline and from Claude', () => {
    const { wire, missing } = parseOffline(huskCandidate);
    expect((wire as Wire<'monster'>).immunitiesText).toBe('poison; exhaustion, poisoned');
    const offline = normalize('monster', wire as Wire<'monster'>, { ...huskCtx('parser'), missing });
    expect(offline.data).toMatchObject({ immunities: 'poison; exhaustion, poisoned' });
    expect(offline.warnings.filter((w) => w.code === 'ungrounded')).toEqual([]);
    expect(offline.confidence).toBe('high');
    // Each part is its own excerpt, so review can highlight both.
    expect(offline.excerpts.filter((e) => e.field === 'immunitiesText')).toEqual([
      { field: 'immunitiesText', text: 'poison', grounded: true },
      { field: 'immunitiesText', text: 'exhaustion, poisoned', grounded: true },
    ]);
    const claude = normalize('monster', { ...(wire as Wire<'monster'>), immunitiesText: 'poison; poisoned' }, huskCtx('claude'));
    expect(claude.warnings.filter((w) => w.code === 'ungrounded')).toEqual([]);
    expect(claude.confidence).toBe('high');
  });

  it('X5: still flags a joined excerpt with a part the text doesn’t have, once', () => {
    const { wire } = parseOffline(huskCandidate);
    const n = normalize('monster', { ...(wire as Wire<'monster'>), immunitiesText: 'poison; charmed' }, huskCtx('claude'));
    expect(n.warnings.filter((w) => w.code === 'ungrounded').map((w) => w.field)).toEqual(['immunities']);
    expect(n.excerpts.filter((e) => e.field === 'immunitiesText')).toEqual([{ field: 'immunitiesText', text: 'poison; charmed', grounded: false }]);
    expect(n.confidence).toBe('medium');
  });
});

describe('spell normalizer', () => {
  const choir = wireOf<'spell'>('Ashen Choir');

  it('checks the level against the printed line, and a cantrip’s level', () => {
    const n = run('spell', 'Ashen Choir', { ...choir, level: 3 });
    expect(n.data?.level).toBe(2);
    expect(n.warnings).toContainEqual(expect.objectContaining({ code: 'cross-check', field: 'level' }));
  });

  it('takes classes from the book’s spell list when none are printed', () => {
    const n = run('spell', 'Ashen Choir', { ...choir, classesText: '', levelText: 'Level 2 Evocation' });
    expect(n.data?.classes).toEqual(['Wickwright']);
    expect(n.warnings).toContainEqual(expect.objectContaining({ code: 'spell-list', severity: 'info' }));
    expect(n.confidence).toBe('high');
  });

  it('reads Concentration from the duration and flags a disagreement', () => {
    expect(run('spell', 'Ashen Choir', { ...choir, durationText: 'Concentration, up to 1 minute' }).data?.concentration).toBe(true);
    const n = run('spell', 'Ashen Choir', { ...choir, concentration: true });
    expect(n.warnings).toContainEqual(expect.objectContaining({ code: 'cross-check', field: 'concentration' }));
  });

  it('strips "or Ritual" from the casting time and marks the spell a ritual', () => {
    expect(run('spell', 'Ashen Choir', { ...choir, castingTimeText: 'Action or Ritual' }).data).toMatchObject({ castingTime: 'Action', ritual: true });
  });

  it('has no data without a school or a duration', () => {
    expect(run('spell', 'Ashen Choir', { ...choir, levelText: '', school: 'unknown' }).data).toBeNull();
    expect(run('spell', 'Ashen Choir', { ...choir, durationText: '' }).data).toBeNull();
  });

  it('X6: a level the level line doesn’t give is missing, not a cantrip (0 is also the wire’s "not stated")', () => {
    for (const levelText of ['', 'Evocation']) {
      const n = run('spell', 'Ashen Choir', { ...choir, levelText, level: 0 });
      expect(n.data, levelText).toBeNull();
      expect(n.warnings).toContainEqual(expect.objectContaining({ code: 'missing', severity: 'block', field: 'level' }));
      expect(n.confidence).toBe('low');
    }
    // A cantrip says so; a level stated as a number other than 0 stands without a parsed line.
    expect(run('spell', 'Ashen Choir', { ...choir, levelText: 'Evocation Cantrip (Wickwright)', level: 0 }).data?.level).toBe(0);
    expect(run('spell', 'Ashen Choir', { ...choir, levelText: 'Cantrip', level: 0 }).data?.level).toBe(0);
    expect(run('spell', 'Ashen Choir', { ...choir, levelText: 'Evocation', level: 2 }).data?.level).toBe(2);
  });
});

describe('magic item normalizer', () => {
  const cloak = wireOf<'magic-item'>('Mothsilk Cloak');

  it('keeps a bonus only when the excerpt states it, and the AC condition', () => {
    expect(run('magic-item', 'Mothsilk Cloak', { ...cloak, bonusText: '' }).data).not.toHaveProperty('bonuses');
    expect(run('magic-item', 'Mothsilk Cloak', { ...cloak, saveBonus: 0, acCondition: 'no-armor', bonusText: '+1 bonus to Armor Class' }).data?.bonuses).toEqual({ ac: 1, acOnlyWhen: 'no-armor' });
  });

  it('reads attunement by someone, a type-line category and a varying rarity', () => {
    const n = run('magic-item', 'Mothsilk Cloak', { ...cloak, attunement: 'required-by', attunementText: 'by a Wizard', category: 'other', rarity: 'unknown', typeLineText: 'Ring, Rarity Varies (Requires Attunement by a Wizard)' });
    expect(n.data).toMatchObject({ category: 'ring', rarity: 'varies', rarityText: 'Rarity Varies', attunement: 'by a Wizard' });
  });

  it('blocks a bonus above +5', () => {
    const n = run('magic-item', 'Mothsilk Cloak', { ...cloak, acBonus: 7, bonusText: '+7 bonus to Armor Class' });
    expect(n.warnings).toContainEqual(expect.objectContaining({ code: 'out-of-range', severity: 'block' }));
  });

  it('X7: keeps a bonus only when its "+N" names what it applies to; a misfiled one is left out with a warning', () => {
    const mail = wireOf<'magic-item'>("Warden's Mail");
    const n = run('magic-item', "Warden's Mail", { ...mail, saveBonus: 1 });
    expect(n.data?.bonuses).toEqual({ ac: 1 });
    expect(n.warnings).toContainEqual(expect.objectContaining({ code: 'ungrounded', field: 'bonuses', message: expect.stringContaining('saving throws') }));
    expect(n.confidence).toBe('medium');
    // Attack and damage in one phrase, and two phrases of different sizes joined with "; ".
    const blade = run('magic-item', 'Mothsilk Cloak', { ...cloak, acBonus: 0, saveBonus: 0, attackBonus: 1, damageBonus: 1, bonusText: '+1 bonus to attack and damage rolls made with this weapon' });
    expect(blade.data?.bonuses).toEqual({ attack: 1, damage: 1 });
    const two = run('magic-item', 'Mothsilk Cloak', { ...cloak, acBonus: 1, saveBonus: 2, bonusText: '+1 bonus to AC; +2 bonus to saving throws' });
    expect(two.data?.bonuses).toEqual({ ac: 1, savingThrows: 2 });
    // A +1 never borrows the target of a later +2 in the same sentence.
    const borrowed = run('magic-item', 'Mothsilk Cloak', { ...cloak, acBonus: 0, saveBonus: 1, bonusText: '+1 bonus to AC and a +2 bonus to saving throws' });
    expect(borrowed.data).not.toHaveProperty('bonuses');
  });

  it('X7: the offline parser keeps every bonus sentence, grounded part by part', () => {
    const text = [
      '_Armor (Plate Armor), Rare (Requires Attunement)_',
      'While wearing this armor, you have a +1 bonus to Armor Class.',
      'You also have a +2 bonus to saving throws while you wear it.',
    ].join('\n\n');
    const entries = [{ id: 'lib:t:1', sourceId: 't', sourceName: 'Test Book', kind: 'magic-item' as const, name: 'Thornwarden Plate', text, path: ['Magic Items', 'Thornwarden Plate'] }];
    const c = segment(entries, SEG).candidates[0];
    const { wire, missing } = parseOffline(c);
    expect((wire as Wire<'magic-item'>).bonusText).toBe('+1 bonus to Armor Class; +2 bonus to saving throws');
    const n = normalize('magic-item', wire as Wire<'magic-item'>, { blocks: c.blocks, entriesById: new Map(entries.map((e) => [e.id, e])), origin: 'parser', spellLists: [], missing });
    expect(n.data?.bonuses).toEqual({ ac: 1, savingThrows: 2 });
    expect(n.warnings.filter((w) => w.code === 'ungrounded')).toEqual([]);
    expect(n.confidence).toBe('high');
  });
});

describe('item normalizer', () => {
  const arms = wireOf<'item'>('Gloamwood Arms');
  const row = (patch: Partial<Wire<'item'>['items'][number]>) => normalize('item', { ...arms, items: [{ ...arms.items[0], ...patch }] }, ctxOf(candidate('Gloamwood Arms')));

  it('reads armor: AC with its Dexterity cap, Strength, Stealth, and an app-written description', () => {
    const light = row({ category: 'armor', armorType: 'light', acText: '11 + Dex modifier', weaponCategory: 'none', weaponType: 'none', damageText: '', propertiesText: '', masteryText: '' });
    expect(light.data).toMatchObject({ category: 'armor', armorClass: 11, dexCap: null, armorType: 'light', description: 'Light Armor: AC 11 + Dex modifier' });
    const medium = row({ category: 'armor', armorType: 'medium', acText: '14 + Dex modifier (max 2)', damageText: '', weaponCategory: 'none', weaponType: 'none' });
    expect(medium.data).toMatchObject({ armorClass: 14, dexCap: 2 });
    const heavy = row({ category: 'armor', armorType: 'heavy', acText: '16', strengthText: 'Str 13', stealthDisadvantage: true, damageText: '', weaponCategory: 'none', weaponType: 'none' });
    expect(heavy.data).toMatchObject({ armorClass: 16, dexCap: 0, strengthRequirement: 13, stealthDisadvantage: true, description: 'Heavy Armor: AC 16' });
    const shield = row({ category: 'shield', acText: '+2', damageText: '', weaponCategory: 'none', weaponType: 'none' });
    expect(shield.data).toMatchObject({ category: 'shield', armorClass: 2, description: 'Shield: +2 AC' });
  });

  it('reads cost in gold, fractional weight and a property’s range', () => {
    const n = row({ costText: '5 SP', weightText: '1/2 lb.', propertiesText: 'Ammunition (Range 80/320; Bolt), Loading' });
    expect(n.data).toMatchObject({ costGp: 0.5, weight: 0.5, range: '80/320', properties: ['Ammunition (Range 80/320; Bolt)', 'Loading'] });
  });

  it('has no data for a weapon without damage', () => {
    const n = row({ damageText: '' });
    expect(n.data).toBeNull();
    expect(n.confidence).toBe('low');
  });
});

describe('validateData (entity kinds)', () => {
  const ctx = ctxOf(candidate('Glimmerwing Drake'));

  it('passes EXPECTED_DATA and re-derives the older stat block’s adaptation', () => {
    expect(validateData('monster', EXPECTED_DATA['Glimmerwing Drake'], ctx)).toEqual({ warnings: [], adaptations: [], confidence: 'high' });
    expect(validateData('monster', EXPECTED_DATA['Bramble Hound'], ctx).adaptations.map((a) => a.code)).toEqual(['monster-2014-statblock']);
    expect(validateData('spell', EXPECTED_DATA['Cinder Mote'], ctx).warnings).toEqual([]);
  });

  it('turns schema issues into block warnings on their fields, with the kind’s cross-checks', () => {
    const v = validateData('monster', { ...EXPECTED_DATA['Glimmerwing Drake'], ac: 45, hp: 90 }, ctx);
    expect(v.warnings.map((w) => [w.code, w.severity, w.field])).toEqual(
      expect.arrayContaining([['out-of-range', 'block', 'ac'], ['cross-check', 'warn', 'hp']]),
    );
    expect(v.confidence).toBe('low');
    const extra = validateData('spell', { ...EXPECTED_DATA['Ashen Choir'], surprise: 1 } as never, ctx);
    expect(extra.warnings).toContainEqual(expect.objectContaining({ severity: 'block' }));
  });
});

describe('magic items with a bonus that holds only in some situations', () => {
  const item = (text: string) => {
    const entry = { id: 'lib:t:1', sourceId: 't', sourceName: 'T', kind: 'magic-item' as const, name: 'Bulwark Buckler', text, path: ['Magic Items', 'Bulwark Buckler'] };
    const c = segment([entry], SEG).candidates[0];
    const ctx: NormalizeContext = { blocks: c.blocks, entriesById: new Map([[entry.id, entry]]), origin: 'parser', spellLists: [] };
    return normalize('magic-item', parseOffline(c).wire as Wire<'magic-item'>, ctx);
  };

  it("doesn't apply it, says so with the sentence, and asks for a look (never confident)", () => {
    const n = item('_Armor (Shield), Rare (Requires Attunement)_\n\nWhile holding this Shield, you gain a +2 bonus to Armor Class against attacks made by Fiends.');
    expect(n.data).not.toHaveProperty('bonuses');
    expect(n.warnings).toContainEqual(expect.objectContaining({ code: 'cross-check', severity: 'warn', field: 'bonuses', message: expect.stringContaining('against attacks made by Fiends') }));
    expect(n.confidence).toBe('medium');
  });

  it('keeps a bonus the item always grants, with no note', () => {
    const n = item('_Armor (Shield), Rare_\n\nWhile holding this Shield, you gain a +2 bonus to Armor Class.');
    expect(n.data?.bonuses).toEqual({ ac: 2 });
    expect(n.warnings.some((w) => w.field === 'bonuses')).toBe(false);
  });

  it('says what it did with a situational bonus Claude read in, and quotes the printed sentence briefly', () => {
    const text = '_Armor (Shield), Rare (Requires Attunement)_\n\nWhile holding this Shield, you gain a +2 bonus to Armor Class against attacks made by Fiends.';
    const entry = { id: 'lib:t:1', sourceId: 't', sourceName: 'T', kind: 'magic-item' as const, name: 'Bulwark Buckler', text, path: ['Magic Items', 'Bulwark Buckler'] };
    const c = segment([entry], SEG).candidates[0];
    const ctx: NormalizeContext = { blocks: c.blocks, entriesById: new Map([[entry.id, entry]]), origin: 'claude', spellLists: [] };
    const wire = { ...(parseOffline(c).wire as Wire<'magic-item'>), acBonus: 2, bonusText: '+2 bonus to Armor Class' };
    const n = normalize('magic-item', wire, ctx);
    expect(n.data?.bonuses).toEqual({ ac: 2 });
    const note = n.warnings.find((w) => w.field === 'bonuses');
    expect(note?.message).toMatch(/^The app applies a \+2 bonus that the text gives only in some situations: check it\. “While holding this Shield, you gain a \+2 bonus/);
    expect(note!.message.length).toBeLessThan(200);
  });

  // Invented items: [what the text says, the bonuses the record applies (null: none), whether a note asks for a look].
  const READINGS: [string, string, Record<string, unknown> | null, boolean][] = [
    ['a lead-in for a while', 'As a Magic action, you can tap the brooch. For 1 minute, you gain a +2 bonus to Armor Class.', null, true],
    ['a Reaction lead-in', 'As a Reaction, you can gain a +3 bonus to Armor Class.', null, true],
    ['an "against" lead-in', 'Against ranged attacks, you gain a +2 bonus to Armor Class while you hold this Shield.', null, true],
    ['an "after" lead-in', 'After you take damage from an attack, you gain a +2 bonus to Armor Class.', null, true],
    ['an "on a hit" lead-in', 'On a hit, you gain a +1 bonus to Armor Class.', null, true],
    ['a later clause with its own condition', 'While wearing this armor, you gain a +1 bonus to Armor Class, and when you are hit by a melee attack, you gain a +1 bonus to saving throws.', { ac: 1 }, true],
    ['a clause after a semicolon', 'You gain a +1 bonus to Armor Class while you wear this cloak; whenever you are Bloodied, you also gain a +2 bonus to saving throws.', { ac: 1 }, true],
    ['an always-on bonus after another benefit', 'While wearing this armor, you have Advantage on saving throws against poison, you gain a +1 bonus to Armor Class, and you know Abyssal.', { ac: 1 }, false],
    ['"once you attune"', 'Once you attune to this circlet, you gain a +1 bonus to saving throws.', { savingThrows: 1 }, false],
    ['"on your person"', 'While this pebble is on your person, you gain a +1 bonus to ability checks and saving throws.', { savingThrows: 1 }, false],
    ['"in addition"', 'In addition, you gain a +1 bonus to saving throws.', { savingThrows: 1 }, false],
    ['a no-armor lead-in', 'If you are wearing no armor, you gain a +2 bonus to Armor Class.', { ac: 2, acOnlyWhen: 'no-armor' }, false],
    ['"against" for another benefit', 'While wearing this armor, you gain a +1 bonus to Armor Class and Advantage on saving throws against being Frightened.', { ac: 1 }, false],
    ['"when you wear"', 'When you wear this cloak, you gain a +1 bonus to Armor Class and saving throws.', { ac: 1, savingThrows: 1 }, false],
    ['"when worn"', 'When worn, this ring grants a +1 bonus to AC and saving throws.', { ac: 1, savingThrows: 1 }, false],
    ['"even if"', 'You gain a +1 bonus to Armor Class while you wear this cloak, even if you are Unconscious.', { ac: 1 }, false],
    ['"against" for its own benefit', 'You gain a +2 bonus to saving throws against poison and a +1 bonus to Armor Class.', { ac: 1 }, true],
    ['a condition for both benefits', 'You gain a +2 bonus to AC and Resistance to Fire damage while you are in Dim Light or Darkness.', null, true],
    ['a by-rarity list', 'You gain a +1, +2, or +3 bonus to Armor Class while you wear this cloak, depending on its rarity.', null, true],
    ['a by-rarity range', 'You gain a +1 to +3 bonus to Armor Class while you wear it.', null, true],
    // An always-on opener with a condition after it holds only then.
    ['wielded against some foes', 'When you wield this sword against Undead, you gain a +2 bonus to attack rolls and damage rolls.', null, true],
    ['held in some light', 'When you hold this shield in Bright Light, you gain a +1 bonus to Armor Class.', null, true],
    ['worn in some light', "When you wear this cloak while you're in Dim Light or Darkness, you gain a +1 bonus to Armor Class.", null, true],
    ['held while concentrating', 'When you hold this staff and are Concentrating on a spell, you gain a +2 bonus to saving throws.', null, true],
    ['holding something else', 'When you hold a Shield, you gain a +1 bonus to Armor Class.', null, true],
    ['worn by some wearers', 'When worn by a Paladin, this ring grants a +1 bonus to saving throws.', null, true],
    ['wielded two-handed', 'You gain a +1 bonus to damage rolls when you wield this weapon with two hands.', null, true],
    // Wordings that keep it always on.
    ['on your finger', 'While this ring is on your finger, you gain a +1 bonus to Armor Class and saving throws.', { ac: 1, savingThrows: 1 }, false],
    ['"in addition, while you hold"', 'This buckler sheds Dim Light. In addition, while you hold the buckler, you gain a +1 bonus to Armor Class.', { ac: 1 }, false],
    // "The <noun>" names the item only with its own noun (a Wondrous Item's "the weapon" is another object).
    ['"while you hold the weapon" in a wondrous item', 'This buckler sheds Dim Light. In addition, while you hold the weapon, you gain a +1 bonus to Armor Class.', null, true],
    ['on your person', 'While you have this pebble on your person, you gain a +1 bonus to saving throws.', { savingThrows: 1 }, false],
    ['around your neck', 'While this amulet hangs around your neck, you gain a +1 bonus to saving throws.', { savingThrows: 1 }, false],
    ['remaining attuned', 'While you remain attuned to it, you gain a +1 bonus to saving throws.', { savingThrows: 1 }, false],
    ['worn, carried or held', 'While you wear it, carry it, or hold it, you gain a +1 bonus to saving throws.', { savingThrows: 1 }, false],
    ['"furthermore"', 'Furthermore, you gain a +1 bonus to saving throws.', { savingThrows: 1 }, false],
    // A clause that opens the sentence governs each of its main clauses.
    ['an opening condition, then ", and you"', 'For 1 minute, you have Resistance to Fire damage, and you gain a +2 bonus to Armor Class.', null, true],
  ];
  it.each(READINGS)('applies only what always holds: %s', (_what, body, bonuses, noted) => {
    const n = item(`_Wondrous Item, Rare (Requires Attunement)_\n\n${body}`);
    expect(n.data?.bonuses ?? null).toEqual(bonuses);
    expect(n.warnings.some((w) => w.field === 'bonuses')).toBe(noted);
  });

  it("counts a closing paragraph about the ring after its variants for the item's charges, but not its bonus", () => {
    const n = item('_Ring, Rarity Varies (Requires Attunement)_\n\nThis ring comes in several kinds.\n\n_**Ruby (Rare).**_ While wearing it, you have Resistance to Fire damage.\n\n_**Sapphire (Very Rare).**_ While wearing it, you have Resistance to Cold damage.\n\nThe ring has 3 charges. You gain a +1 bonus to saving throws while you wear the ring.');
    // A variant's own paragraphs open the same way ("The shield grants…"), so only an explicit opener ("Whatever its gem, …") gives the item a bonus again.
    expect(n.data).toMatchObject({ charges: 3 });
    expect(n.data).not.toHaveProperty('bonuses');
    expect(n.warnings.find((w) => w.field === 'bonuses')?.message).toMatch(/^One kind of this item gives a \+1 bonus, so the app doesn't apply it/);
  });

  it('reads a type line after the item\'s name and a hyphen or a parenthesis', () => {
    expect(item('Moth Lantern - Wondrous item, rare (requires attunement)\n\nWhile holding this lantern, you gain a +1 bonus to AC.').data).toMatchObject({ category: 'wondrous-item', rarity: 'rare', attunement: true, bonuses: { ac: 1 } });
    expect(item('Moth Lantern (wondrous item, rare)\n\nWhile holding this lantern, you gain a +1 bonus to AC.').data).toMatchObject({ category: 'wondrous-item', rarity: 'rare', attunement: false });
    expect(item('_Armor (Shield), Uncommon_\n\nWhile holding this Shield, you gain a +1 bonus to Armor Class.').data).toMatchObject({ category: 'shield', baseItem: 'Shield' });
  });

  it("reads a variant's later paragraphs as that variant's, and leaves its charges out", () => {
    const n = item('_Wondrous Item, Rarity Varies (Requires Attunement)_\n\nEach stone orbits your head.\n\n_**Ward (Rare).**_ This grey stone hums and has 3 charges.\n\nWhile it orbits your head, you gain a +1 bonus to Armor Class.');
    expect(n.data).not.toHaveProperty('bonuses');
    expect(n.data).not.toHaveProperty('charges');
    expect(n.warnings.find((w) => w.field === 'bonuses')?.message).toMatch(/^One kind of this item gives a \+1 bonus/);
  });

  it('reads a type line wrapped over two lines whole, attunement and all', () => {
    const n = item('_Staff, Very Rare (Requires Attunement by a\nSorcerer, Warlock, or Wizard)_\n\nYou gain a +2 bonus to Armor Class while you hold it.');
    expect(n.data).toMatchObject({ attunement: 'by a Sorcerer, Warlock, or Wizard', bonuses: { ac: 2 } });
  });

  it('never says the app applies a situational bonus when only an always-on bonus of the same size is applied', () => {
    const n = item('_Wondrous Item, Rare (Requires Attunement)_\n\nYou gain a +1 bonus to Armor Class while you wear this cloak. While you are within 10 feet of an ally, you also gain a +1 bonus to Armor Class and saving throws.');
    expect(n.data?.bonuses).toEqual({ ac: 1 });
    expect(n.warnings.find((w) => w.field === 'bonuses')?.message).toMatch(/^A \+1 bonus here holds only in some situations, so the app doesn't apply it/);
  });

  it('notes nothing when the same bonus also always holds', () => {
    const n = item('_Weapon (Longsword), Rare_\n\nYou gain a +2 bonus to attack rolls and damage rolls made with this magic weapon. If the blade breaks, it keeps its +2 bonus to attack rolls and damage rolls.');
    expect(n.data?.bonuses).toEqual({ attack: 2, damage: 2 });
    expect(n.warnings.some((w) => w.field === 'bonuses')).toBe(false);
  });
});

/**
 * The offline reading of a "+N bonus" in every dialect the parity tests use: SRD-style Markdown, flatten()
 * (a PDF text layer), a PDF that joined the type line to the first paragraph, and a two-column PDF (left
 * column then right, a running header, page numbers) read by pdfPagesToMarkdown and chunkDocument. Invented
 * items, in 2024 capitalised and 2014 lowercase wording. Policy: a bonus is applied only when the text says it
 * always holds (the item worn, held, carried or attuned); anything else is left out with a note, and a Claude
 * reading that applies it is told to check it.
 */
describe('magic item bonuses in every dialect: lead-ins, conditions, always-on wordings and variants', () => {
  type Dialect = 'markdown' | 'pdf' | 'joined' | 'two-column';
  const DIALECTS: readonly Dialect[] = ['markdown', 'pdf', 'joined', 'two-column'];
  const NAME = 'Warden Token';

  const pdfLine = (str: string, y: number, fontSize = 10, x = 50): PdfTextRun => ({ str, x, y, width: str.length * fontSize * 0.5, fontSize, hasEOL: true });
  const wrapped = (text: string) =>
    text.split(/\s+/).reduce<string[]>((lines, word) => {
      const last = lines.length ? lines[lines.length - 1] : undefined;
      if (last !== undefined && `${last} ${word}`.length <= 46) lines[lines.length - 1] = `${last} ${word}`;
      else lines.push(word);
      return lines;
    }, []);
  /** Items as a two-column PDF book: each item kept within a 26-line column, at least three pages (so the header repeats as a running one). */
  function twoColumnPdf(items: readonly { name: string; text: string }[]): PdfTextRun[][] {
    const PER_COLUMN = 26;
    const pages: PdfTextRun[][] = [];
    let page: PdfTextRun[] = [];
    let column = 0;
    let row = 0;
    const header = () => pdfLine('Lantern Lore Compendium', 800, 8);
    const endPage = () => pages.push([...page, pdfLine(String(pages.length + 1), 40, 8, 300)]);
    const nextColumn = () => {
      if (column === 1) {
        endPage();
        page = [header()];
      }
      column = 1 - column;
      row = 0;
    };
    const put = (str: string, fontSize: number, gap: number) => {
      if (row > 0) row += gap;
      if (row >= PER_COLUMN) nextColumn();
      page.push(pdfLine(str, 740 - row * 12, fontSize, column === 0 ? 50 : 320));
      row += 1;
    };
    page = [header()];
    put('Magic Items', 18, 0);
    for (const item of items) {
      const paragraphs = item.text.split(/\n\s*\n/).map((p) => wrapped(p.replace(/[*_]/g, '').trim()));
      const height = 2 + paragraphs.reduce((n, lines) => n + lines.length + 1, 0);
      if (row > 0 && row + height > PER_COLUMN) nextColumn();
      put(item.name, 13, 1);
      paragraphs.forEach((lines, i) => lines.forEach((l, j) => put(l, 10, i > 0 && j === 0 ? 1 : 0)));
    }
    endPage();
    while (pages.length < 3) pages.push([header(), pdfLine('Notes', 740, 13), pdfLine('This page is left blank for notes about the items above.', 716), pdfLine(String(pages.length + 1), 40, 8, 300)]);
    return pages;
  }

  /** An item that fills most of a left column, so the one after it starts the right column. */
  const EMBER_LAMP = [
    '_Wondrous Item, Common_',
    'This lamp burns without oil and never goes out in the wind, however hard it blows.',
    'Its flame is the color of embers and gives off no smoke, so it can be carried indoors.',
    'Once per day, you can turn the flame blue for 10 minutes; it then sheds no light at all.',
    'The lamp weighs 1 pound and fits in a pack, or it hangs from a hook on a belt.',
    'A lamp of this kind is often given to new members of the Lantern Wardens.',
    'Its glass never cracks from heat, and its handle stays cool to the touch.',
  ].join('\n\n');

  function entriesFor(text: string, dialect: Dialect, name = NAME): CompendiumEntry[] {
    if (dialect === 'two-column') {
      const book = [
        { name: 'Ember Lamp', text: EMBER_LAMP },
        { name, text },
        { name: 'Moth Coin', text: '_Wondrous Item, Common_\n\nThis coin always lands on its edge when you flip it.' },
      ];
      const pages = twoColumnPdf(book);
      // The item is printed in the right column, after the left one in reading order.
      expect(pages[0].find((r) => r.str === name)?.x).toBe(320);
      return chunkDocument(pdfPagesToMarkdown(pages), { sourceId: 't', sourceName: 'T' });
    }
    const printed = dialect === 'markdown' ? text : dialect === 'pdf' ? flatten(text) : flatten(text).replace(/^([^\n]+)\n\n/, '$1 ');
    return [{ id: 'lib:t:1', sourceId: 't', sourceName: 'T', kind: 'magic-item', name, text: printed, path: ['Magic Items', name] }];
  }

  /** The record of the item read offline in a dialect, or as Claude read it (its wire with `claude` applied). */
  function read(text: string, dialect: Dialect, claude?: Partial<Wire<'magic-item'>>, name = NAME) {
    return readEntries(entriesFor(text, dialect, name), name, dialect, claude);
  }
  function readEntries(entries: CompendiumEntry[], name: string, dialect: string, claude?: Partial<Wire<'magic-item'>>) {
    const c = segment(entries, SEG).candidates.find((x) => x.kind === 'magic-item' && x.name === name);
    if (!c) throw new Error(`${name} not detected (${dialect})`);
    const { wire, missing } = parseOffline(c);
    const ctx: NormalizeContext = { blocks: c.blocks, entriesById: new Map(entries.map((e) => [e.id, e])), origin: claude ? 'claude' : 'parser', spellLists: [], ...(claude ? {} : { missing }) };
    return normalize('magic-item', { ...(wire as Wire<'magic-item'>), ...claude }, ctx);
  }
  const bonusNote = (n: ReturnType<typeof read>) => n.warnings.find((w) => w.field === 'bonuses')?.message;

  /** A Claude reading that applies every "+N bonus" the text states, whatever its wording ("+1 to AC", "+1 bonus to Constitution saving throws"), quoting each. */
  const TARGET = String.raw`(?:AC|Armor Class|attack(?:\s+rolls)?|damage(?:\s+rolls)?|saving throws)`;
  const STATED = new RegExp(String.raw`\+(\d)(?:\s+bonus)?\s+to\s+[^.;+]*?\b${TARGET}(?:(?:,|\s+and|,\s+and)\s+(?:to\s+)?(?:[\w()]+\s+){0,2}?${TARGET})*`, 'gi');
  function appliedByClaude(text: string): Partial<Wire<'magic-item'>> {
    const wire: Partial<Wire<'magic-item'>> = { acBonus: 0, saveBonus: 0, attackBonus: 0, damageBonus: 0, acCondition: 'always' };
    const quoted: string[] = [];
    for (const m of text.replace(/[*_]/g, '').matchAll(STATED)) {
      const n = Number(m[1]);
      if (/\b(?:AC|Armor Class)\b/i.test(m[0])) wire.acBonus = n;
      if (/saving throws/i.test(m[0])) wire.saveBonus = n;
      if (/attack/i.test(m[0])) wire.attackBonus = n;
      if (/damage/i.test(m[0])) wire.damageBonus = n;
      quoted.push(m[0]);
    }
    return { ...wire, bonusText: quoted.join('; ') };
  }

  const t24 = (body: string, type = '_Wondrous Item, Rare (Requires Attunement)_') => `${type}\n\n${body}`;
  const t14 = (body: string, type = '*Wondrous item, rare (requires attunement)*') => `${type}\n\n${body}`;
  const ARMOR24 = '_Armor (Scale Mail), Rare (Requires Attunement)_';
  const ARMOR14 = '*Armor (scale mail), rare (requires attunement)*';
  const SHIELD24 = '_Armor (Shield), Rare (Requires Attunement)_';
  const SHIELD14 = '*Armor (shield), rare (requires attunement)*';
  const SWORD24 = '_Weapon (Longsword), Rare_';
  const SWORD14 = '*Weapon (longsword), rare*';

  // [what the text says, the item's text, the bonuses the record applies (null: none), whether a note asks for a look, the item's name if not NAME].
  type Row = [string, string, Record<string, unknown> | null, boolean, string?];

  /** A main clause's lead-in after ", and/but/or" is judged whatever word starts it; the sentence's opening governs only a clause without one. */
  const LEAD_INS: Row[] = [
    ['", and underwater, you"', t24('While wearing this armor, you have a Swim Speed equal to your Speed, and underwater, you have a +1 bonus to Armor Class.', ARMOR24), null, true],
    ['", and underwater, you" (2014)', t14('While wearing this armor, you have a swimming speed equal to your walking speed, and underwater, you have a +1 bonus to AC.', ARMOR14), null, true],
    ['", and so long as …, you"', t24('While you wear this cloak, you have Advantage on Dexterity (Stealth) checks, and so long as you are in Dim Light or Darkness, you gain a +1 bonus to Armor Class.'), null, true],
    ['", and so long as …, you" (2014)', t14('While you wear this cloak, you have advantage on Dexterity (Stealth) checks, and so long as you are in dim light or darkness, you gain a +1 bonus to AC.'), null, true],
    ['", and provided …, you"', t24("While holding this Shield, you can't be knocked Prone, and provided you aren't wearing Heavy Armor, you gain a +2 bonus to Armor Class.", SHIELD24), null, true],
    ['", and provided …, you" (2014)', t14("While holding this shield, you can't be knocked prone, and provided you aren't wearing heavy armor, you gain a +2 bonus to AC.", SHIELD14), null, true],
    ['", and each time …, you"', t24('While you wear this badge, you know Celestial, and each time an ally within 30 feet of you drops to 0 Hit Points, you gain a +1 bonus to saving throws.'), null, true],
    ['", and every time …, you" (2014)', t14('While you wear this badge, you can speak Celestial, and every time an ally within 30 feet of you drops to 0 hit points, you gain a +1 bonus to saving throws.'), null, true],
    ['", and whilst …, you"', t24('While you wear this circlet, you can see in Dim Light, and whilst you stand in Bright Light, you gain a +1 bonus to saving throws.'), null, true],
    ['", and whilst …, you" (2014)', t14('While you wear this circlet, you can see in dim light, and whilst you stand in sunlight, you gain a +1 bonus to saving throws.'), null, true],
    ['", but within …, you"', t24('While you wear this amulet, you have Resistance to Necrotic damage, but within 5 feet of a Fiend, you have a +1 bonus to Armor Class.'), null, true],
    ['", but within …, you" (2014)', t14('While you wear this amulet, you have resistance to necrotic damage, but within 5 feet of a fiend, you have a +1 bonus to AC.'), null, true],
    ['", and while …, you"', t24('While wearing this armor, you have a Swim Speed equal to your Speed, and while you are underwater, you have a +1 bonus to Armor Class.', ARMOR24), null, true],
    ['", and, while …, you"', t24('While you wear this cloak, you have Resistance to Cold damage, and, while underwater, you have a +1 bonus to Armor Class.'), null, true],
    ['" and underwater, you" without its comma', t24('While you wear this cloak, you have Resistance to Cold damage and underwater, you have a +1 bonus to Armor Class.'), null, true],
    ['"; underwater, you" (2014)', t14('While you wear this cloak, you have resistance to cold damage; underwater, you have a +1 bonus to AC.'), null, true],
    ['"You …, and underwater, you"', t24('You have Resistance to Cold damage, and underwater, you have a +1 bonus to Armor Class.'), null, true],
    ['"Underwater, this cloak grants"', t24('Underwater, this cloak grants a +1 bonus to Armor Class.'), null, true],
    ['an opening that governs ", and you gain"', t24('While underwater, you can breathe, and you gain a +1 bonus to Armor Class.'), null, true],
    ['an opening that governs ", and in addition, you gain"', t24('While underwater, you glow, and in addition, you gain a +1 bonus to Armor Class.'), null, true],
    ['an opening that governs ", and even if …, you gain"', t24('While underwater, you glow, and even if you are Prone, you gain a +1 bonus to Armor Class.'), null, true],
    // A later main clause with an always-on lead-in of its own holds, whatever opened the sentence.
    ['"As a Bonus Action, …, and while you wear it, you"', t24('As a Bonus Action, you can make the cloak change color, and while you wear it, you gain a +1 bonus to Armor Class.'), { ac: 1 }, false],
    ['"As a bonus action, …, and while you wear it, you" (2014)', t14('As a bonus action, you can make the cloak change color, and while you wear it, you gain a +1 bonus to AC.'), { ac: 1 }, false],
    ['"When you attune …, and while you wear the ring, you"', t24('When you attune to this ring, you choose one damage type, and while you wear the ring, you have a +1 bonus to saving throws.', '_Ring, Rare (Requires Attunement)_'), { savingThrows: 1 }, false],
    ['"When you attune …, and while you wear the ring, you" (2014)', t14('When you attune to this ring, you choose one damage type, and while you wear the ring, you have a +1 bonus to saving throws.', '*Ring, rare (requires attunement)*'), { savingThrows: 1 }, false],
    ['"You …, and while you wear this cloak, you"', t24('You have Resistance to Cold damage, and while you wear this cloak, you have a +1 bonus to Armor Class.'), { ac: 1 }, false],
    ['"…, you\'re …, and while you hold it, you"', t24("While wearing it, you're immune to the Frightened condition, and while you hold it, you gain a +1 bonus to saving throws."), { savingThrows: 1 }, false],
    ['a whole opening: "wear it, carry it, or hold it"', t24('While you wear it, carry it, or hold it, you gain a +1 bonus to saving throws.'), { savingThrows: 1 }, false],
    ['a clause right after another benefit', t24('While wearing this armor, you have Advantage on saving throws against poison, you gain a +1 bonus to Armor Class, and you know Abyssal.', ARMOR24), { ac: 1 }, false],
  ];

  /** A condition left once the always-on phrases are taken out, or a condition word the item phrase must not take as an item word. */
  const CONDITIONS: Row[] = [
    ['"while you\'re Bloodied"', t24("You have a +1 bonus to Armor Class while you're Bloodied.", '_Armor (Breastplate), Rare (Requires Attunement)_'), null, true],
    ['"while you are bloodied" (2014)', t14('You have a +1 bonus to AC while you are bloodied.', '*Armor (breastplate), rare (requires attunement)*'), null, true],
    ['"while you’re Bloodied" (curly)', t24('You have a +1 bonus to Armor Class while you’re Bloodied.'), null, true],
    ['"while raging" (2014)', t14('You gain a +2 bonus to AC while raging.', '*Armor (hide), rare (requires attunement by a barbarian)*'), null, true],
    ['"while your Rage is active"', t24('You gain a +2 bonus to Armor Class while your Rage is active.', '_Armor (Hide Armor), Rare (Requires Attunement by a Barbarian)_'), null, true],
    ['"while you are flying"', t24('While you wear this cloak, you have a +1 bonus to saving throws while you are flying.'), null, true],
    ['"while flying" (2014)', t14('While you wear this cloak, you have a +1 bonus to saving throws while flying.'), null, true],
    ['"this armor underwater"', t24('You have a +1 bonus to Armor Class while you wear this armor underwater.', ARMOR24), null, true],
    ['"this armor underwater" (2014)', t14('You have a +1 bonus to AC while you wear this armor underwater.', ARMOR14), null, true],
    ['"While you wear this armor underwater, you"', t24('While you wear this armor underwater, you have a +1 bonus to Armor Class.', ARMOR24), null, true],
    ['"this sword two-handed"', t24('When you wield this sword two-handed, you have a +1 bonus to Armor Class.', SWORD24), null, true],
    ['"this sword two-handed" (2014)', t14('When you wield this sword two-handed, you have a +1 bonus to AC.', SWORD14), null, true],
    ['"it one-handed"', t24('You gain a +1 bonus to attack rolls while you wield it one-handed.', SWORD24), null, true],
    ['"this cloak mounted"', t24('You gain a +1 bonus to Armor Class while you wear this cloak mounted.'), null, true],
    ['"this Shield aloft"', t24('You gain a +1 bonus to Armor Class while you hold this Shield aloft.', SHIELD24), null, true],
    ['"this Shield firmly"', t24('You gain a +1 bonus to Armor Class while you hold this Shield firmly.', SHIELD24), null, true],
    ['"this shield skyward" (2014)', t14('You gain a +1 bonus to AC while you hold this shield skyward.', SHIELD14), null, true],
    ['"this cloak outdoors" (2014)', t14('You gain a +1 bonus to saving throws while you wear this cloak outdoors.'), null, true],
    ['"unless"', t24('You gain a +1 bonus to Armor Class unless you are Incapacitated.'), null, true],
    ['"as long as" a condition', t24('You gain a +1 bonus to saving throws as long as you are standing on the ground.'), null, true],
    ['"provided"', t24("You gain a +1 bonus to Armor Class provided you aren't holding a Shield."), null, true],
    ['"each time"', t24('You gain a +1 bonus to saving throws each time you are hit.'), null, true],
    ['"whilst" (2014)', t14('You gain a +1 bonus to saving throws whilst you are prone.'), null, true],
    ['a place after the bonus', t24('You gain a +1 bonus to Armor Class in Dim Light.'), null, true],
    ['a distance after the bonus (2014)', t14('You gain a +1 bonus to saving throws within 10 feet of an ally.'), null, true],
    ['a time after the bonus', t24('You gain a +1 bonus to Armor Class during your turn.'), null, true],
    ['"at night" (2014)', t14('You gain a +1 bonus to AC at night.'), null, true],
    ['"underwater" after the bonus', t24('You gain a +1 bonus to Armor Class underwater.'), null, true],
    ['"in melee" after a weapon bonus', t24('You gain a +2 bonus to attack rolls made with this weapon in melee.', SWORD24), null, true],
    ['a second bonus with its own condition', t24('You gain a +1 bonus to Armor Class while you wear this cloak, and a +1 bonus to saving throws while you are Bloodied.'), { ac: 1 }, true],
    ['no armor, then "while you are Bloodied"', t24('If you are wearing no armor, you gain a +2 bonus to Armor Class while you are Bloodied.'), null, true],
    ['no armor "and are Bloodied"', t24('If you are wearing no armor and are Bloodied, you gain a +2 bonus to Armor Class.'), null, true],
    ['no armor for saving throws too', t24('You gain a +1 bonus to Armor Class and saving throws while you wear no armor.'), { ac: 1, acOnlyWhen: 'no-armor' }, true],
    // The no-armor condition the app models stays applied.
    ['"while you wear no armor"', t24('You gain a +2 bonus to Armor Class while you wear no armor.'), { ac: 2, acOnlyWhen: 'no-armor' }, false],
    ['"if you aren’t wearing armor" (curly)', t24('If you aren’t wearing armor, you gain a +2 bonus to Armor Class.'), { ac: 2, acOnlyWhen: 'no-armor' }, false],
    ['"…if you are wearing no armor and using no Shield"', t24('While wearing these bracers, you gain a +2 bonus to Armor Class if you are wearing no armor and using no Shield.'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false],
    ['"…if you are wearing no armor and using no shield" (2014)', t14('While wearing these bracers, you gain a +2 bonus to AC if you are wearing no armor and using no shield.'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false],
    ['"while you aren\'t wearing armor or wielding a Shield"', t24("While you aren't wearing armor or wielding a Shield, you gain a +2 bonus to Armor Class."), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false],
    ['"while in your possession"', t24('You gain a +1 bonus to saving throws while in your possession.'), { savingThrows: 1 }, false],
  ];

  /** Wordings that keep a bonus always on, each with nothing conditional after it, and leftovers that are conditions. */
  const ALWAYS_ON: Row[] = [
    ['"this suit of armor" (2014)', t14('While wearing this suit of armor, you gain a +1 bonus to AC.', '*Armor (plate), rare (requires attunement)*'), { ac: 1 }, false],
    ['"…while you wear this suit of armor"', t24('You have a +1 bonus to Armor Class while you wear this suit of armor.', '_Armor (Plate Armor), Rare (Requires Attunement)_'), { ac: 1 }, false],
    ['"this pair of bracers"', t24('While you wear this pair of bracers, you gain a +1 bonus to Armor Class and saving throws.'), { ac: 1, savingThrows: 1 }, false],
    ['"this pair of bracers" (2014)', t14('While you wear this pair of bracers, you gain a +1 bonus to AC and saving throws.'), { ac: 1, savingThrows: 1 }, false],
    ['"this black iron helm"', t24('You have a +1 bonus to saving throws while you wear this black iron helm.'), { savingThrows: 1 }, false],
    ['"this black iron helm" (2014)', t14('You have a +1 bonus to saving throws while you wear this black iron helm.'), { savingThrows: 1 }, false],
    ['"this plain silver ring"', t24('While you wear this plain silver ring, you gain a +1 bonus to Armor Class and saving throws.', '_Ring, Rare (Requires Attunement)_'), { ac: 1, savingThrows: 1 }, false],
    ['"this plain silver ring" (2014)', t14('While you wear this plain silver ring, you gain a +1 bonus to AC and saving throws.', '*Ring, rare (requires attunement)*'), { ac: 1, savingThrows: 1 }, false],
    ['"around your neck"', t24('While you wear this amulet around your neck, you have a +1 bonus to saving throws.'), { savingThrows: 1 }, false],
    ['"on your finger" (2014)', t14('You gain a +1 bonus to AC while you wear this ring on your finger.', '*Ring, rare (requires attunement)*'), { ac: 1 }, false],
    ['"on your head"', t24('You gain a +1 bonus to saving throws while you wear this circlet on your head.'), { savingThrows: 1 }, false],
    ['"on your wrists"', t24('While you wear these bracers on your wrists, you gain a +1 bonus to Armor Class.'), { ac: 1 }, false],
    ['"on your arm"', t24('While you wear this Shield on your arm, you gain a +1 bonus to saving throws.', SHIELD24), { savingThrows: 1 }, false],
    ['"in your hand" (2014)', t14('While you hold this orb in your hand, you gain a +1 bonus to saving throws.'), { savingThrows: 1 }, false],
    ['"wearing or carrying"', t24('While you are wearing or carrying this cloak, you have a +1 bonus to Armor Class.'), { ac: 1 }, false],
    ['"wear or hold" (2014)', t14('You gain a +1 bonus to saving throws while you wear or hold this talisman.'), { savingThrows: 1 }, false],
    ['"wear and are attuned to" (2014)', t14('While you wear and are attuned to this armor, you gain a +1 bonus to AC.', '*Armor (leather), uncommon (requires attunement)*'), { ac: 1 }, false],
    ['"While this ring is worn" (2014)', t14('While this ring is worn, you gain a +1 bonus to AC.', '*Ring, rare (requires attunement)*'), { ac: 1 }, false],
    ['"while it is held"', t24('While it is held, you gain a +1 bonus to saving throws.'), { savingThrows: 1 }, false],
    ['"while it is carried"', t24('You gain a +1 bonus to saving throws while it is carried.'), { savingThrows: 1 }, false],
    ['"While worn, this cloak grants"', t24('While worn, this cloak grants a +1 bonus to Armor Class.'), { ac: 1 }, false],
    ['"While held, you"', t24('While held, you gain a +1 bonus to saving throws.'), { savingThrows: 1 }, false],
    ['"when worn or carried"', t24('This brooch grants a +1 bonus to AC when worn or carried.'), { ac: 1 }, false],
    ['"This ring, while worn, grants"', t24('This ring, while worn, grants a +1 bonus to Armor Class.', '_Ring, Rare (Requires Attunement)_'), { ac: 1 }, false],
    ['"While it\'s on your person"', t24("While it's on your person, you have a +1 bonus to saving throws."), { savingThrows: 1 }, false],
    ['"While it’s on your person" (curly)', t24('While it’s on your person, you have a +1 bonus to saving throws.'), { savingThrows: 1 }, false],
    ['"While you’re wearing" (curly)', t24('While you’re wearing this cloak, you have a +1 bonus to saving throws.'), { savingThrows: 1 }, false],
    ['"both gauntlets"', t24('While wearing both gauntlets, you gain a +1 bonus to Armor Class.'), { ac: 1 }, false, 'Gauntlets of the Warden'],
    ['"whenever you wear this cloak"', t24('You gain a +1 bonus to saving throws whenever you wear this cloak.'), { savingThrows: 1 }, false],
    ['"whilst wearing" (2014)', t14('Whilst wearing this cloak, you have a +1 bonus to saving throws.'), { savingThrows: 1 }, false],
    ['"while attuned to it"', t24('You gain a +1 bonus to saving throws while attuned to it.'), { savingThrows: 1 }, false],
    ['"Additionally, while you wear it"', t24('Additionally, while you wear it, you have a +1 bonus to saving throws.'), { savingThrows: 1 }, false],
    ['"(in addition to …)"', t24("You have a +1 bonus to Armor Class while you hold this Shield (in addition to the Shield's normal bonus).", SHIELD24), { ac: 1 }, false],
    ['"as well as <benefit>"', t24('You have a +1 bonus to Armor Class while wearing this armor, as well as Resistance to Cold damage.', '_Armor (Chain Mail), Rare_'), { ac: 1 }, false],
    ['"and <benefit>"', t24('You gain a +1 bonus to Armor Class while you wear this cloak and Advantage on Dexterity (Stealth) checks.'), { ac: 1 }, false],
    ['"even if …"', t24('You gain a +1 bonus to Armor Class while you wear this cloak, even if you are Unconscious.'), { ac: 1 }, false],
    // Fail closed: any other leftover, or a condition word in a harmless one, is a condition.
    ['"…while you wear this cloak and are Invisible"', t24('You gain a +1 bonus to Armor Class while you wear this cloak and are Invisible.'), null, true],
    ['"…while you wear this cloak in Dim Light"', t24('While you wear this cloak in Dim Light or Darkness, you have a +1 bonus to Armor Class.'), null, true],
    ['"…in dim light" (2014)', t14('While you wear this cloak in dim light or darkness, you have a +1 bonus to AC.'), null, true],
    ['"as well as <benefit> while …"', t24('You have a +1 bonus to Armor Class while wearing this armor, as well as Resistance to Cold damage while underwater.', '_Armor (Chain Mail), Rare_'), null, true],
    ['"(in addition to … when …)"', t24("You have a +1 bonus to Armor Class while you hold this Shield (in addition to the Shield's bonus when you are Bloodied).", SHIELD24), null, true],
    ['"even if" with a place', t24('You gain a +1 bonus to Armor Class while you wear this cloak, even if you are in an Antimagic Field.'), null, true],
  ];

  const STAFF24 = '_Staff, Rare (Requires Attunement)_';
  const STAFF14 = '*Staff, rare (requires attunement)*';
  const AMMO24 = '_Weapon (Any Ammunition), Rare_';

  /** An item phrase ends at its noun: a word after it is left over and judged; "the <noun>" names the item only with its own noun. */
  const ITEM_PHRASES: Row[] = [
    ['"this staff upright"', t24('You gain a +1 bonus to Armor Class while you hold this staff upright.', STAFF24), null, true],
    ['"this staff upright" (2014)', t14('You gain a +1 bonus to AC while you hold this staff upright.', STAFF14), null, true],
    ['"this Shield raised"', t24('You gain a +2 bonus to Armor Class while you hold this Shield raised.', SHIELD24), null, true],
    ['"this shield raised" (2014)', t14('You gain a +2 bonus to AC while you hold this shield raised.', SHIELD14), null, true],
    ['"this banner unfurled"', t24('You gain a +1 bonus to saving throws while you carry this banner unfurled.'), null, true],
    ['"this banner unfurled" (2014)', t14('You gain a +1 bonus to saving throws while you carry this banner unfurled.'), null, true],
    ['"this sword twohanded" (a PDF\'s line break dehyphenated)', t24('When you wield this sword twohanded, you have a +1 bonus to Armor Class.', SWORD24), null, true],
    ['"this sword two handed" (2014)', t14('You have a +1 bonus to AC while you wield this sword two handed.', SWORD14), null, true],
    ['"…this cloak and holding the torch"', t24("While you're wearing this cloak and holding the torch, you gain a +1 bonus to saving throws."), null, true],
    ['"…this cloak and holding the torch" (2014)', t14("While you're wearing this cloak and holding the torch, you gain a +1 bonus to saving throws."), null, true],
    ['", and while you hold the staff upright, you"', t24('You have Resistance to Cold damage, and while you hold the staff upright, you gain a +1 bonus to Armor Class.', STAFF24), null, true],
    ['", and while you hold the staff upright, you" (2014)', t14('You have resistance to cold damage, and while you hold the staff upright, you gain a +1 bonus to AC.', STAFF14), null, true],
    ['"while you hold the torch": another object', t24('While you hold the torch, you gain a +1 bonus to Armor Class.'), null, true],
    ['"both gauntlets" in a token: another object', t24('While wearing both gauntlets, you gain a +1 bonus to Armor Class.'), null, true],
    ['"this frobnitz": an unknown noun', t24('While you wear this frobnitz, you gain a +1 bonus to Armor Class.'), null, true],
    ['"this raised Shield": a state before the noun', t24('You gain a +2 bonus to Armor Class while you hold this raised Shield.', SHIELD24), null, true],
    ['"this drawn sword" (2014): a state before the noun', t14('While you hold this drawn sword, you gain a +1 bonus to AC.', SWORD14), null, true],
    ['"this two-handed sword": words before the noun', t24('While you wield this two-handed sword, you gain a +1 bonus to attack rolls.', SWORD24), { attack: 1 }, false],
    ['"the token": the item\'s own noun', t24('While you carry the token, you gain a +1 bonus to saving throws.'), { savingThrows: 1 }, false],
    ['"the staff" (2014): its category', t14('While you hold the staff, you gain a +2 bonus to AC.', STAFF14), { ac: 2 }, false],
    ['"this thurible": the item\'s own noun, not in the list', t24('While you carry this thurible, you gain a +1 bonus to saving throws.'), { savingThrows: 1 }, false, 'Thurible of Embers'],
    ['"your familiar gains": another creature', t24('While you wear this collar, your familiar gains a +1 bonus to Armor Class.'), null, true],
    ['"your allies gain" (2014): other creatures', t14('While you hold this banner, your allies gain a +1 bonus to saving throws.'), null, true],
    ['"you and your allies gain": the wearer too', t24('While you hold this banner, you and your allies gain a +1 bonus to saving throws.'), { savingThrows: 1 }, false],
  ];

  /** A restriction after a break: the rest of the sentence, or a later sentence about the bonus. */
  const LATER_LIMITS: Row[] = [
    ['", but only while…"', t24('You gain a +1 bonus to Armor Class while you wear this cloak, but only while you are in Dim Light or Darkness.'), null, true],
    ['", but only in…" (2014)', t14('You gain a +1 bonus to AC while you wear this cloak, but only in dim light or darkness.'), null, true],
    ['", but only against…"', t24('While wearing this cloak, you have a +1 bonus to saving throws, but only against spells.'), null, true],
    ['", but only against…" (2014)', t14('While wearing this cloak, you have a +1 bonus to saving throws, but only against spells.'), null, true],
    ['"; the bonus applies only…"', t24('You have a +1 bonus to saving throws while you wear this cloak; the bonus applies only while you are Bloodied.'), null, true],
    ['"; the bonus applies only…" (2014)', t14('You have a +1 bonus to saving throws while you wear this cloak; the bonus applies only while you are bloodied.'), null, true],
    ['", which works only…"', t24('This cloak grants a +1 bonus to Armor Class, which works only in Dim Light.'), null, true],
    ['", which works only…" (2014)', t14('This cloak grants a +1 bonus to AC, which works only in dim light.'), null, true],
    ['"The bonus applies only…" (next sentence)', t24('You gain a +1 bonus to Armor Class while you wear this cloak. The bonus applies only while you are Bloodied.'), null, true],
    ['"The bonus applies only…" (next sentence, 2014)', t14('You gain a +1 bonus to AC while you wear this cloak. The bonus applies only while you are bloodied.'), null, true],
    ['"…, and while you wear it, you gain …, but only while…"', t24('You have Resistance to Cold damage, and while you wear it, you gain a +1 bonus to Armor Class, but only while you are Bloodied.'), null, true],
    ['"…, and while you wear it, you gain …, but only while…" (2014)', t14('You have resistance to cold damage, and while you wear it, you gain a +1 bonus to AC, but only while you are bloodied.'), null, true],
    ['", except while…"', t24('While you wear this cloak, you gain a +1 bonus to Armor Class, except while you are Bloodied.'), null, true],
    ['", but you lose it while…"', t24('You gain a +1 bonus to Armor Class while you wear this cloak, but you lose it while you are Bloodied.'), null, true],
    ['"…, this bonus doesn\'t apply." (next sentence)', t24("You gain a +1 bonus to Armor Class while you wear this cloak. While you are Bloodied, this bonus doesn't apply."), null, true],
    ['"It doesn\'t work underwater." (2014)', t14("You gain a +1 bonus to AC while you wear this cloak. It doesn't work underwater."), null, true],
    ['"These bonuses end…"', t24('You gain a +1 bonus to Armor Class and a +1 bonus to saving throws while you wear this cloak. These bonuses end if you fall Unconscious.'), null, true],
    ['"The saving throw bonus applies only…": the bonus with a word naming it', t24('You gain a +1 bonus to saving throws while you wear this cloak. The saving throw bonus applies only against spells.'), null, true],
    ['"Additionally, the bonus applies only…" (2014)', t14('You gain a +1 bonus to AC while you wear this cloak. Additionally, the bonus applies only at night.'), null, true],
    ['"Unless you are Bloodied, the bonus applies."', t24('You gain a +1 bonus to Armor Class while you wear this cloak. Unless you are Bloodied, the bonus applies.'), null, true],
    // Words about the bonus that don't limit it.
    ['"…as a Bonus Action…" is no bonus', t24('While wearing this cloak, you have a +1 bonus to saving throws. While you wear it, you can make it glow, either as a Bonus Action or after you roll Initiative.'), { savingThrows: 1 }, false],
    ['"The bonus increases to +2 at night." (only more)', t24('You gain a +1 bonus to Armor Class while you wear this cloak. The bonus increases to +2 at night.'), { ac: 1 }, false],
    ['"This bonus is in addition to…"', t24("While holding this Shield, you have a +1 bonus to saving throws. This bonus is in addition to the Shield's normal bonus to AC.", SHIELD24), { savingThrows: 1 }, false],
    ['"…, or while you hold it" (another always-on phrase)', t24('You gain a +1 bonus to Armor Class while you wear this cloak, or while you hold it.'), { ac: 1 }, false],
  ];

  /** A bonus to some saves, or to rolls made with something else, is situational: the app adds an item's save bonus to every save. */
  const SCOPES: Row[] = [
    ['"saving throws made to maintain Concentration"', t24('While you wear this circlet, you have a +1 bonus to saving throws made to maintain Concentration.'), null, true],
    ['"saving throws you make to maintain concentration" (2014)', t14('While you wear this circlet, you have a +1 bonus to saving throws you make to maintain concentration on a spell.'), null, true],
    ['"saving throws to end the Charmed or Frightened condition"', t24('While wearing this badge, you have a +2 bonus to saving throws to end the Charmed or Frightened condition on yourself.'), null, true],
    ['"saving throws to end the charmed condition" (2014)', t14('While wearing this badge, you have a +2 bonus to saving throws to end the charmed or frightened condition on yourself.'), null, true],
    ['"ability checks and saving throws that use Strength"', t24('While you wear this belt, you have a +1 bonus to ability checks and saving throws that use Strength.'), null, true],
    ['"…that use Strength" (2014)', t14('While you wear this belt, you have a +1 bonus to ability checks and saving throws that use strength.'), null, true],
    ['"Constitution saving throws"', t24('While you wear this belt, you have a +1 bonus to Constitution saving throws.'), null, true],
    ['"death saving throws" (2014)', t14('While you wear this amulet, you have a +2 bonus to death saving throws.'), null, true],
    ['"attack rolls made with the torch"', t24('You gain a +1 bonus to attack rolls made with the torch.', SWORD24), null, true],
    // The weapon's own rolls hold.
    ['"…made with these arrows"', t24('You gain a +1 bonus to attack rolls and damage rolls made with these arrows.', AMMO24), { attack: 1, damage: 1 }, false],
    ['"attack rolls with this weapon" (2014)', t14('You gain a +1 bonus to attack rolls with this weapon.', SWORD14), { attack: 1 }, false],
  ];

  /** Always-on and modelled no-armor wordings that earlier versions applied. */
  const RESTORED: Row[] = [
    ['"if you wear no armor and no shield"', t24('While wearing these bracers, you gain a +2 bonus to Armor Class if you wear no armor and no shield.'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false],
    ['"if you are wearing no armor and no shield" (2014)', t14('While wearing these bracers, you gain a +2 bonus to AC if you are wearing no armor and no shield.'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false],
    ['"while you wear no armor or shield"', t24('You gain a +2 bonus to Armor Class while you wear no armor or shield.'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false],
    ['"while you wear no armor and wield no shield" (2014)', t14('You gain a +2 bonus to AC while you wear no armor and wield no shield.'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false],
    ['"while you wear neither armor nor a Shield"', t24('You gain a +2 bonus to Armor Class while you wear neither armor nor a Shield.'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false],
    ['"In addition to the Shield\'s normal bonus to AC, …"', t24("In addition to the Shield's normal bonus to AC, this Shield grants a +1 bonus to saving throws.", SHIELD24), { savingThrows: 1 }, false],
    ['"In addition to the shield\'s normal bonus to AC, …" (2014)', t14("In addition to the shield's normal bonus to AC, this shield grants a +1 bonus to saving throws.", SHIELD14), { savingThrows: 1 }, false],
    ['"In addition to its other properties, …" (2014)', t14('In addition to its other properties, this cloak grants a +1 bonus to AC and saving throws.'), { ac: 1, savingThrows: 1 }, false],
    ['"In addition to its other properties, …"', t24('In addition to its other properties, this cloak grants a +1 bonus to Armor Class and saving throws.'), { ac: 1, savingThrows: 1 }, false],
    ['"In addition to … while …" is a condition', t24('In addition to its glow while you are Bloodied, this cloak grants a +1 bonus to Armor Class.'), null, true],
    ['"while this Shield is equipped"', t24('You gain a +1 bonus to Armor Class while this Shield is equipped.', SHIELD24), { ac: 1 }, false],
    ['"while you have it equipped" (2014)', t14('You gain a +1 bonus to AC while you have it equipped.'), { ac: 1 }, false],
    ['"while it is attuned to you"', t24('You gain a +1 bonus to saving throws while it is attuned to you.'), { savingThrows: 1 }, false],
    ['"while it\'s attuned to you" (2014)', t14("You gain a +1 bonus to AC while it's attuned to you."), { ac: 1 }, false],
  ];

  const ROD24 = '_Rod, Rare (Requires Attunement)_';
  const ANY_SWORD24 = '_Weapon (Any Sword), Rare (Requires Attunement)_';

  /**
   * D1: an intro ("…, you gain the following benefits.", "…these benefits…", a ":") governs the run-in and list
   * paragraphs after it, judged by what is left once its offer is taken out; a run-in label that holds "Only", a
   * parenthesis, a condition, a place or a state fails closed.
   */
  const INTROS: Row[] = [
    ['"While you are underwater, you gain the following benefits." over run-ins', t24('While you are underwater, you gain the following benefits.\n\n_**Pressure Ward.**_ You have a +1 bonus to Armor Class.\n\n_**Gills.**_ You can breathe water.'), null, true],
    ['the same (2014)', t14('While you are underwater, you gain the following benefits.\n\n***Pressure Ward.*** You have a +1 bonus to AC.\n\n***Gills.*** You can breathe water.'), null, true],
    ['"You gain the following benefits while you are raging:" (2014)', t14('You gain the following benefits while you are raging:\n\n***Iron Hide.*** You have a +2 bonus to AC.\n\n***Fury.*** You have advantage on Strength checks.', '*Armor (hide), rare (requires attunement by a barbarian)*'), null, true],
    ['"You gain these benefits while you are Bloodied."', t24('You gain these benefits while you are Bloodied.\n\n_**Last Stand.**_ You have a +2 bonus to saving throws.\n\n_**Grit.**_ You have Resistance to Bludgeoning damage.'), null, true],
    ['"While you are Bloodied, this weapon has the following properties."', t24('While you are Bloodied, this weapon has the following properties.\n\n_**Fury.**_ The weapon grants a +2 bonus to attack rolls and damage rolls made with it.\n\n_**Ward.**_ You have Resistance to Necrotic damage.', ANY_SWORD24), null, true],
    ['list items under "While you are in Bright Light, you gain the following benefits:"', t24('While you are in Bright Light, you gain the following benefits:\n\n- **Radiant Ward.** You have a +1 bonus to Armor Class.\n- **Sun Sight.** You can see through glare.'), null, true],
    ['unlabeled list items under a conditional ":"', t24('While you are underwater, you gain the following benefits:\n\n- You can breathe water.\n- You have a +1 bonus to Armor Class.'), null, true],
    ['an intro and its run-in in one paragraph', t24('While you are underwater, you gain the following benefits. Ward. You have a +1 bonus to Armor Class.'), null, true],
    ['an intro that offers before its last sentence', t24('While you are underwater, you gain the following benefits. Each lasts until you surface.\n\n_**Ward.**_ You have a +1 bonus to Armor Class.'), null, true],
    ['"At night, the cloak has these properties:" (2014)', t14('At night, the cloak has these properties:\n\n***Ward.*** You have a +1 bonus to AC.'), null, true, 'Cloak of Wings'],
    ['label "Guard (Shield Form Only)."', t24('This bracelet can turn into a Shield or back as a Bonus Action. It has the following properties.\n\n_**Guard (Shield Form Only).**_ While you hold it, you have a +1 bonus to Armor Class.\n\n_**Shine.**_ It sheds Dim Light in a 5-foot radius.'), null, true],
    ['label "Guard (Shield Form Only)." (2014)', t14('This bracelet can turn into a shield or back as a bonus action. It has the following properties.\n\n***Guard (Shield Form Only).*** While you hold it, you have a +1 bonus to AC.\n\n***Shine.*** It sheds dim light in a 5-foot radius.'), null, true],
    ['label "Underwater."', t24('This cloak has the following properties.\n\n_**Underwater.**_ You have a +1 bonus to Armor Class.\n\n_**Shine.**_ It sheds Dim Light in a 5-foot radius.'), null, true],
    ['label "Iron hide (raging only)." (2014 sentence case)', t14('***Iron hide (raging only).*** You have a +2 bonus to AC.', '*Armor (hide), rare (requires attunement)*'), null, true],
    ['label "While in dim light." (2014)', t14('***While in dim light.*** You have a +1 bonus to AC.'), null, true],
    ['a label a PDF ran into the paragraph before', t24('This cloak has the following properties.\n\nWard. You have a +1 bonus to Armor Class. Underwater. You have a +1 bonus to saving throws.'), { ac: 1 }, true],
    // An intro, and labels, that hold.
    ['"While wearing this cloak, you gain the following benefits."', t24('While wearing this cloak, you gain the following benefits.\n\n_**Ward.**_ You have a +1 bonus to Armor Class.\n\n_**Warmth.**_ You have Resistance to Cold damage.'), { ac: 1 }, false],
    ['the same (2014)', t14('While wearing this cloak, you gain the following benefits:\n\n***Ward.*** You have a +1 bonus to AC.\n\n***Warmth.*** You have resistance to cold damage.'), { ac: 1 }, false],
    ['"While you hold it, the staff grants the following benefits:" over list items', t24('While you hold it, the staff grants the following benefits:\n\n- **Ward.** You have a +1 bonus to Armor Class.\n- **Sight.** You can see in the dark.', STAFF24), { ac: 1 }, false],
    ['"…provides three benefits while it is on your person."', t24('This brooch provides three benefits while it is on your person.\n\n_**Defense.**_ You gain a +1 bonus to Armor Class.'), { ac: 1 }, false],
    ['"Each of these rings has the following property."', t24('Each of these rings has the following property.\n\n_**Ward.**_ While you wear it, you have a +1 bonus to Armor Class.', '_Ring, Rare (Requires Attunement)_'), { ac: 1 }, false],
    ['run-ins joined in a paragraph, none a condition', t24('This cloak has the following properties.\n\nWard. You have a +1 bonus to Armor Class. Grace. You have a +1 bonus to saving throws.'), { ac: 1, savingThrows: 1 }, false],
    ['a property after "…, you can cast the following spells from it:"', t24('This staff has the following properties.\n\n_**Spells.**_ While holding the staff, you can cast the following spells from it:\n\n- Light\n- Shield\n\n_**Ward.**_ While holding the staff, you have a +1 bonus to Armor Class.', STAFF24), { ac: 1 }, false],
  ];

  /**
   * D2: a later sentence that refers back to a bonus (bonus, benefit, protection, property, effect, ward, power, magic,
   * "the +N bonus", "the <target> bonus", it/they/this/these…) and limits it marks that target's bonuses, or its
   * paragraph's, or (about the item itself) the item's; a negation limits only when it negates the bonus applying.
   */
  const LIMITS_ELSEWHERE: Row[] = [
    ['"This benefit applies only…"', t24('You gain a +1 bonus to Armor Class while you wear this cloak. This benefit applies only in Dim Light or Darkness.'), null, true],
    ['"This benefit applies only…" (2014)', t14('You gain a +1 bonus to AC while you wear this cloak. This benefit applies only in dim light or darkness.'), null, true],
    ['"This benefit doesn\'t work while…" (2014)', t14("While you wear this cloak, you have a +1 bonus to AC. This benefit doesn't work while you are bloodied."), null, true],
    ['"These benefits apply only…"', t24('While wearing this armor, you gain a +1 bonus to Armor Class and a +1 bonus to saving throws. These benefits apply only while you are underwater.', ARMOR24), null, true],
    ['"Both bonuses apply only…"', t24('While wearing this armor, you gain a +1 bonus to Armor Class and a +1 bonus to saving throws. Both bonuses apply only while you are underwater.', ARMOR24), null, true],
    ['"Neither bonus applies…"', t24("You gain a +1 bonus to Armor Class and a +1 bonus to saving throws while you wear this cloak. Neither bonus applies while you're Bloodied."), null, true],
    ['"Neither applies…" (2014)', t14("You gain a +1 bonus to AC and a +1 bonus to saving throws while you wear this cloak. Neither applies while you're bloodied."), null, true],
    ['"The +1 bonus applies only…"', t24('You gain a +1 bonus to Armor Class while you wear this cloak. The +1 bonus applies only in Dim Light.'), null, true],
    ['"This protection lasts only…"', t24('While you wear this cloak, you gain a +1 bonus to Armor Class. This protection lasts only while you are in Dim Light.'), null, true],
    ['"The benefit ends if…"', t24('While you wear this cloak, you have a +1 bonus to saving throws. The benefit ends if you fall Unconscious.'), null, true],
    ['"The cloak\'s magic works only at night."', t24("You gain a +1 bonus to Armor Class while you wear this cloak. The cloak's magic works only at night."), null, true],
    ['"…, but you lose this benefit while…"', t24('You gain a +1 bonus to Armor Class while you wear this cloak, but you lose this benefit while you are Bloodied.'), null, true],
    ['"You can\'t benefit from this bonus while…"', t24("You gain a +1 bonus to Armor Class while you wear this cloak. You can't benefit from this bonus while you're Bloodied."), null, true],
    ['"The ward fades in sunlight." (2014)', t14('While you wear this cloak, you gain a +1 bonus to AC. The ward fades in sunlight.'), null, true],
    ['the next paragraph: "This benefit applies only…"', t24('While you wear this cloak, you gain a +1 bonus to Armor Class.\n\nThis benefit applies only in Dim Light or Darkness.'), null, true],
    ['the next paragraph: "While you are underwater, these benefits end."', t24('While you wear this cloak, you gain a +1 bonus to Armor Class.\n\nWhile you are underwater, these benefits end.'), null, true],
    ['"These benefits apply only…" after two run-ins', t24('This cloak has the following properties.\n\n_**Ward.**_ You have a +1 bonus to Armor Class.\n\n_**Grace.**_ You have a +1 bonus to saving throws.\n\nThese benefits apply only while you are underwater.'), null, true],
    ['the item itself, before its bonus: "The cloak only functions at night."', t24('The cloak only functions at night.\n\nWhile you wear this cloak, you gain a +1 bonus to Armor Class.'), null, true, 'Cloak of Wings'],
    ['the item itself, after it: "This cloak has no effect underwater."', t24('While you wear this cloak, you gain a +1 bonus to Armor Class.\n\nThis cloak has no effect underwater.'), null, true],
    ['"The magic of this cloak works only at night."', t24('You gain a +1 bonus to Armor Class while you wear this cloak.\n\nThe magic of this cloak works only at night.'), null, true],
    ['the item itself, any verb: "This cloak protects you only at night."', t24('This cloak protects you only at night.\n\nWhile you wear it, you gain a +1 bonus to Armor Class.'), null, true],
    ['the item itself, a negation: "The ring doesn\'t help you underwater." (2014)', t14("While you wear this ring, you gain a +1 bonus to AC. The ring doesn't help you underwater.", '*Ring, rare (requires attunement)*'), null, true],
    ['"Bonuses from this cloak apply only at night."', t24('You gain a +1 bonus to Armor Class while you wear this cloak. Bonuses from this cloak apply only at night.'), null, true],
    ['a run-in about the benefits before it: "These benefits work only at night."', t24('This cloak has the following properties.\n\n_**Ward.**_ You have a +1 bonus to Armor Class.\n\n_**Restriction.**_ These benefits work only at night.'), null, true],
    // The item's no-armor restriction sets the condition for AC (the other targets fail closed).
    ['"These bracers work only if you wear no armor and use no Shield." first', t24('These bracers work only if you wear no armor and use no Shield. While wearing them, you gain a +2 bonus to Armor Class.'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false],
    ['the same (2014)', t14('These bracers work only if you wear no armor and use no shield. While wearing them, you gain a +2 bonus to AC.'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false],
    ['the same after the bonus', t24('While wearing these bracers, you gain a +2 bonus to Armor Class. These bracers work only if you wear no armor and use no Shield.'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false],
    ['"…work only while you wear no armor."', t24('These bracers work only while you wear no armor. While wearing them, you gain a +2 bonus to Armor Class.'), { ac: 2, acOnlyWhen: 'no-armor' }, false],
    ['the restriction for saving throws too', t24('These bracers work only if you wear no armor and use no Shield. While wearing them, you gain a +2 bonus to Armor Class and a +1 bonus to saving throws.'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, true],
    ['a restriction with more than no armor', t24('These bracers work only if you wear no armor and are Bloodied. While wearing them, you gain a +2 bonus to Armor Class.'), null, true],
    // A target named: that target's bonuses only.
    ['"The Armor Class bonus applies only…" after a spell-attack sentence', t24('While you wear this cloak, you have a +1 bonus to Armor Class. You also have a +1 bonus to spell attack rolls. The Armor Class bonus applies only in Dim Light or Darkness.'), null, true],
    ['"The AC bonus applies only…" after a saving-throw sentence', t24('You gain a +1 bonus to Armor Class while you wear this cloak. You also gain a +1 bonus to saving throws while you wear it. The AC bonus applies only in Dim Light or Darkness.'), { savingThrows: 1 }, true],
    ['"The bonus to AC applies only…" (2014)', t14('While you wear this cloak, you gain a +1 bonus to AC and saving throws. The bonus to AC applies only in dim light.'), { savingThrows: 1 }, true],
    // Words about the bonus that don't limit it.
    ['"This bonus doesn\'t stack with…"', t24("You gain a +1 bonus to Armor Class while you wear this cloak. This bonus doesn't stack with the bonus from a Cloak of Protection."), { ac: 1 }, false],
    ['"This bonus doesn\'t stack with…" (2014)', t14("You gain a +1 bonus to AC while you wear this cloak. This bonus doesn't stack with the bonus from a cloak of protection."), { ac: 1 }, false],
    ['"This bonus can\'t be suppressed…"', t24("You gain a +1 bonus to saving throws while you wear this amulet. This bonus can't be suppressed by an Antimagic Field."), { savingThrows: 1 }, false],
    ['"This bonus doesn\'t count as wearing armor."', t24("While you wear these bracers, you gain a +1 bonus to Armor Class. This bonus doesn't count as wearing armor."), { ac: 1 }, false],
    ['"This benefit applies only while you wear the cloak."', t24('You gain a +1 bonus to Armor Class. This benefit applies only while you wear the cloak.'), { ac: 1 }, false, 'Cloak of Wings'],
    ['"The benefit ends if you remove the cloak."', t24('You gain a +1 bonus to Armor Class while you wear this cloak. The benefit ends if you remove the cloak.'), { ac: 1 }, false, 'Cloak of Wings'],
    ['"…ends if you remove the cloak or fall Unconscious." limits', t24('You gain a +1 bonus to Armor Class while you wear this cloak. The benefit ends if you remove the cloak or fall Unconscious.'), null, true, 'Cloak of Wings'],
    ['"Once used, this property can\'t be used again…" in another property', t24("While you wear this cloak, you gain a +1 bonus to Armor Class.\n\n_**Shadow Step.**_ As a Bonus Action, you can teleport up to 30 feet. Once used, this property can't be used again until the next dawn."), { ac: 1 }, false],
    ['"The weapon can\'t be used this way again until the next dawn."', t24("You gain a +1 bonus to attack rolls and damage rolls made with this magic weapon.\n\nAs a Bonus Action, you can coat the blade with venom. The weapon can't be used this way again until the next dawn.", SWORD24), { attack: 1, damage: 1 }, false],
    ['"The benefit lasts as long as you hold it."', t24('While you hold this staff, you gain a +1 bonus to Armor Class. The benefit lasts as long as you hold it.', STAFF24), { ac: 1 }, false],
    ['"This cloak can only be attuned by an elf." (no condition)', t24('This cloak can only be attuned by an elf. While you wear it, you gain a +1 bonus to Armor Class.'), { ac: 1 }, false],
  ];

  /** D3: the lead-in before a bonus's subject, whatever word starts it, with or without a comma, and a parenthetical after the subject. */
  const LEAD_INS_ANY: Row[] = [
    ['"Between dusk and dawn, this weapon grants…"', t24('Between dusk and dawn, this weapon grants a +1 bonus to attack rolls and damage rolls made with it.', ANY_SWORD24), null, true],
    ['"Between dusk and dawn, this cloak grants…" (2014)', t14('Between dusk and dawn, this cloak grants a +1 bonus to AC.'), null, true],
    ['"By moonlight, the cloak grants…"', t24('By moonlight, the cloak grants a +1 bonus to Armor Class.'), null, true, 'Cloak of Night'],
    ['"Beneath the open sky, this cloak grants…"', t24('Beneath the open sky, this cloak grants a +1 bonus to saving throws.'), null, true],
    ['"Upon being hit by an attack, the shield grants…" (2014)', t14('Upon being hit by an attack, the shield grants a +2 bonus to AC.', SHIELD14), null, true],
    ['"…, and by night it grants…"', t24('This blade sheds Dim Light in a 5-foot radius, and by night it grants a +1 bonus to attack rolls and damage rolls made with it.', ANY_SWORD24), null, true],
    ['"…, and between dusk and dawn, it grants…"', t24('While you wear this cloak, you can see in Dim Light, and between dusk and dawn, it grants a +1 bonus to Armor Class.'), null, true],
    ['the same (2014)', t14('While you wear this cloak, you can see in dim light, and between dusk and dawn, it grants a +1 bonus to AC.'), null, true],
    ['"…, and after you take damage, the cloak grants…"', t24('While you wear this cloak, you can speak Sylvan, and after you take damage, the cloak grants a +1 bonus to Armor Class.'), null, true, 'Cloak of Night'],
    ['"…; by moonlight, it grants…"', t24('This cloak has 3 charges; by moonlight, it grants a +1 bonus to Armor Class.'), null, true],
    ['"The shield, once activated, grants…"', t24('The shield, once activated, grants a +1 bonus to Armor Class.', SHIELD24), null, true],
    ['"After dark the cloak grants…" (no comma)', t24('After dark the cloak grants a +1 bonus to Armor Class.'), null, true, 'Cloak of Night'],
    ['"Under a full moon you gain…" (no comma)', t24('Under a full moon you gain a +1 bonus to Armor Class.'), null, true],
    ['"In daylight the shield grants…" (no comma, 2014)', t14('In daylight the shield grants a +1 bonus to AC.', SHIELD14), null, true],
    ['"At night ravens circle the cloak, and it grants…"', t24('At night ravens circle the cloak, and it grants a +1 bonus to Armor Class.'), null, true],
    // Lead-ins and parentheticals that hold.
    ['"In your hands, this staff grants…"', t24('In your hands, this staff grants a +1 bonus to Armor Class.', STAFF24), { ac: 1 }, false],
    ['"On your finger, this ring grants…" (2014)', t14('On your finger, this ring grants a +1 bonus to AC.', '*Ring, rare (requires attunement)*'), { ac: 1 }, false],
    ['"The amulet, when worn, grants…"', t24('The amulet, when worn, grants a +1 bonus to saving throws.'), { savingThrows: 1 }, false, 'Amulet of the Fen'],
    ['"When worn this ring grants…" (no comma)', t24('When worn this ring grants a +1 bonus to Armor Class.', '_Ring, Rare (Requires Attunement)_'), { ac: 1 }, false],
    ['"Its blade is etched with runes, and you gain…"', t24('Its blade is etched with runes, and you gain a +1 bonus to attack rolls and damage rolls made with this weapon.', SWORD24), { attack: 1, damage: 1 }, false],
  ];

  /** D4: the bonus is the wearer's only when its subject is you, the wearer or the item, and the item gives it to you or the wearer. */
  const WHOSE: Row[] = [
    ['"Undead you control gain…"', t24('While you hold this rod, Undead you control gain a +1 bonus to attack rolls and damage rolls.', ROD24), null, true],
    ['"skeletons and zombies you animate gain…" (2014)', t14('While you hold this wand, skeletons and zombies you animate gain a +1 bonus to attack rolls.', '*Wand, rare (requires attunement by a wizard)*'), null, true],
    ['"your summoned spirits gain…"', t24('While you hold this staff, your summoned spirits gain a +1 bonus to Armor Class.', STAFF24), null, true],
    ['"beasts you summon gain…" (2014)', t14('While you hold this staff, beasts you summon gain a +1 bonus to AC.', STAFF14), null, true],
    ['"your hounds gain…"', t24('While you wear this horn, your hounds gain a +1 bonus to Armor Class and saving throws.'), null, true],
    ['"your followers gain…"', t24('While you carry this banner, your followers gain a +1 bonus to saving throws.'), null, true],
    ['"your minions gain…"', t24('While you wear this crown, your minions gain a +1 bonus to attack rolls.'), null, true],
    ['"each of your conjured elementals gains…"', t24('While you hold this rod, each of your conjured elementals gains a +1 bonus to Armor Class.', ROD24), null, true],
    ['"your raven gains…"', t24('While you wear this brooch, your raven gains a +1 bonus to Armor Class.'), null, true],
    ['"this banner grants your allies…"', t24('While you carry it, this banner grants your allies a +1 bonus to saving throws.'), null, true],
    ['"creatures within 10 feet of you gain…" (2014)', t14('While you wear this cloak, creatures within 10 feet of you gain a +1 bonus to AC.'), null, true],
    ['"you or an ally of your choice gains…"', t24('While you hold this banner, you or an ally of your choice gains a +1 bonus to saving throws.'), null, true],
    ['"…, and it gains…" after another creature', t24('Your familiar is linked to this cloak, and it gains a +1 bonus to Armor Class.'), null, true],
    ['"you grant…"', t24('While you hold this banner, you grant a +1 bonus to saving throws.'), null, true],
    // The wearer's.
    ['"this cloak grants you…"', t24('While you wear it, this cloak grants you a +1 bonus to saving throws.'), { savingThrows: 1 }, false],
    ['"the wearer gains…"', t24('While this cloak is worn, the wearer gains a +1 bonus to saving throws.'), { savingThrows: 1 }, false],
    ['"This weapon grants its wielder…" (2014)', t14('This weapon grants its wielder a +1 bonus to attack rolls and damage rolls made with it.', SWORD14), { attack: 1, damage: 1 }, false],
    ['"This weapon has a +1 bonus to attack rolls…"', t24('This weapon has a +1 bonus to attack rolls and damage rolls made with it.', SWORD24), { attack: 1, damage: 1 }, false],
  ];

  /** D6: always-on wordings 6da397a applied, restored. */
  const RESTORED_D6: Row[] = [
    ['"the sword" in a longsword', t24('While you hold the sword, you gain a +1 bonus to Armor Class.', '_Weapon (Longsword), Rare (Requires Attunement)_'), { ac: 1 }, false, 'Warden Blade'],
    ['"the sword" in a longsword (2014)', t14('While you hold the sword, you gain a +1 bonus to AC.', '*Weapon (longsword), rare (requires attunement)*'), { ac: 1 }, false, 'Warden Blade'],
    ['"the bow" in a longbow', t24('While you hold the bow, you gain a +1 bonus to saving throws.', '_Weapon (Longbow), Rare (Requires Attunement)_'), { savingThrows: 1 }, false, 'Moonshot'],
    ['"the axe" in a battleaxe', t24('While you hold the axe, you gain a +1 bonus to Armor Class.', '_Weapon (Battleaxe), Rare (Requires Attunement)_'), { ac: 1 }, false, 'Warden Cleaver'],
    ['"the hammer" in a warhammer (2014)', t14('While you hold the hammer, you gain a +1 bonus to AC.', '*Weapon (warhammer), rare (requires attunement)*'), { ac: 1 }, false, 'Thunder Maul'],
    ['"the band" in a ring', t24('While you wear the band, you gain a +1 bonus to Armor Class and saving throws.', '_Ring, Rare (Requires Attunement)_'), { ac: 1, savingThrows: 1 }, false, 'Ring of the Grove'],
    ['"the suit" in armor', t24('While you wear the suit, you gain a +1 bonus to saving throws.', ARMOR24), { savingThrows: 1 }, false, 'Warden Scales'],
    ['"the cloak" its text calls "this cloak" elsewhere', t24('This cloak is woven from owl feathers. While you wear the cloak, you gain a +1 bonus to Armor Class.'), { ac: 1 }, false, 'Wings of the Owl'],
    ['"the cloak" its text never calls it: fail closed', t24('While you wear the cloak, you gain a +1 bonus to Armor Class.'), null, true, 'Wings of the Owl'],
    ['"if you aren\'t wearing armor or a Shield"', t24("While wearing these bracers, you gain a +2 bonus to Armor Class if you aren't wearing armor or a Shield."), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false],
    ['"if you aren\'t wearing armor or a shield" (2014)', t14("While wearing these bracers, you gain a +2 bonus to AC if you aren't wearing armor or a shield."), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false],
    ['"if you have no armor and no Shield"', t24('While wearing these bracers, you gain a +2 bonus to Armor Class if you have no armor and no Shield.'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false],
    ['"provided you wear no armor"', t24('You gain a +2 bonus to Armor Class provided you wear no armor.'), { ac: 2, acOnlyWhen: 'no-armor' }, false],
    ['"provided you wear no armor" (2014)', t14('You gain a +2 bonus to AC provided you wear no armor.'), { ac: 2, acOnlyWhen: 'no-armor' }, false],
    ['"while you bear this Shield"', t24('You gain a +1 bonus to saving throws while you bear this Shield.', SHIELD24), { savingThrows: 1 }, false],
    ['"while you are clad in this armor"', t24('You gain a +1 bonus to Armor Class while you are clad in this armor.', ARMOR24), { ac: 1 }, false],
    ['"while you are clad in it" (2014)', t14('You gain a +1 bonus to AC while you are clad in it.', ARMOR14), { ac: 1 }, false],
  ];

  const RING24 = '_Ring, Rare (Requires Attunement)_';
  const RING14 = '*Ring, rare (requires attunement)*';
  const HIDE14 = '*Armor (hide), rare (requires attunement)*';

  /**
   * I1: the item restricted as the subject of any main clause of any sentence, before or after its bonus, after any lead-in
   * ("In sunlight, this cloak doesn't work.", "…, but the cloak doesn't function in sunlight", "…this cloak, which has no
   * effect underwater"); armor worn where it doesn't work sets the no-armor condition for AC.
   */
  const RESTRICTIONS: Row[] = [
    ['"In sunlight, this cloak doesn\'t work." (next paragraph)', t24("While you wear this cloak, you have a +1 bonus to Armor Class and saving throws.\n\nIn sunlight, this cloak doesn't work."), null, true, 'Cloak of the Deep'],
    ['"While you are Bloodied, the cloak doesn\'t function."', t24("You have a +1 bonus to Armor Class while you wear this cloak. While you are Bloodied, the cloak doesn't function."), null, true, 'Cloak of the Deep'],
    ['"Underwater, the boots have no effect." (2014)', t14('While you wear these boots, you have a +1 bonus to AC. Underwater, the boots have no effect.'), null, true, 'Boots of the Ridge'],
    ['"While you are raging, the armor doesn\'t function." (2014)', t14("You have a +1 bonus to AC while you wear this armor. While you are raging, the armor doesn't function.", ARMOR14), null, true, 'Coral Armor'],
    ['"When you are Bloodied, the cloak stops working until…"', t24('While you wear this cloak, you have a +1 bonus to Armor Class and saving throws. When you are Bloodied, the cloak stops working until you finish a Short or Long Rest.'), null, true, 'Cloak of the Deep'],
    ['"The cloak is powerless in sunlight."', t24('You have a +1 bonus to Armor Class and saving throws while you wear this cloak. The cloak is powerless in sunlight.'), null, true, 'Cloak of the Deep'],
    ['"In sunlight, the cloak becomes nonmagical."', t24('You have a +1 bonus to Armor Class while you wear this cloak. In sunlight, the cloak becomes nonmagical.'), null, true, 'Cloak of the Deep'],
    ['"In sunlight, the cloak provides no protection."', t24('You have a +1 bonus to Armor Class while you wear this cloak. In sunlight, the cloak provides no protection.'), null, true, 'Cloak of the Deep'],
    ['"In sunlight, the cloak grants no bonus."', t24('You have a +1 bonus to Armor Class while you wear this cloak. In sunlight, the cloak grants no bonus.'), null, true, 'Cloak of the Deep'],
    ['"The cloak loses its magic in sunlight."', t24('You have a +1 bonus to Armor Class and saving throws while you wear this cloak. The cloak loses its magic in sunlight.'), null, true, 'Cloak of the Deep'],
    ['"This garment works only at night." (this <any noun>)', t24('You have a +1 bonus to Armor Class while you wear it. This garment works only at night.'), null, true, 'Cloak of the Deep'],
    ['"The enchantment works only at night."', t24('You have a +1 bonus to Armor Class while you wear this cloak. The enchantment works only at night.'), null, true, 'Cloak of the Deep'],
    ['"Its protection works only…" in another paragraph', t24("While you wear this ring, you have a +1 bonus to Armor Class and saving throws.\n\nThe ring's gold band is engraved with the names of wardens long dead. Its protection works only in Dim Light or Darkness.", RING24), null, true, 'Ring of Dusk Wardens'],
    ['"Its bonus is lost in sunlight." in another paragraph (2014)', t14('You gain a +1 bonus to AC and saving throws while wearing this ring.\n\nThe band is engraved with old names. Its bonus is lost in sunlight.', RING14), null, true, 'Ring of Dusk Wardens'],
    ['"In sunlight, the cloak\'s protection fails." (2014)', t14("While wearing this cloak, you gain a +1 bonus to AC and saving throws. In sunlight, the cloak's protection fails."), null, true, 'Cloak of the Deep'],
    ['"The cloak doesn\'t work in sunlight." (next paragraph)', t24("While you wear this cloak, you have a +1 bonus to Armor Class and saving throws.\n\nThe cloak doesn't work in sunlight."), null, true, 'Cloak of the Deep'],
    ['"The ring\'s protection works only…"', t24("While you wear this ring, you have a +1 bonus to Armor Class and saving throws.\n\nThe ring's gold band is engraved with the names of wardens long dead. The ring's protection works only in Dim Light or Darkness.", RING24), null, true, 'Ring of Dusk Wardens'],
    // In the bonus's own sentence, before or after it.
    ['"This cloak works only at night, and while you wear it, you gain…"', t24('This cloak works only at night, and while you wear it, you gain a +1 bonus to Armor Class.'), null, true],
    ['"This cloak works only at night, and while you wear it, …" (2014)', t14('This cloak works only at night, and while you wear it, you gain a +1 bonus to AC.'), null, true],
    ['"The cloak has no effect in sunlight, but while you wear it, …"', t24('The cloak has no effect in sunlight, but while you wear it, you have a +1 bonus to saving throws.'), null, true, 'Cloak of Dusk'],
    ['"This ring functions only underwater, and while you wear it, …" (2014)', t14('This ring functions only underwater, and while you wear it, you gain a +1 bonus to AC and saving throws.', RING14), null, true, 'Ring of the Reed'],
    ['"…, but the cloak doesn\'t function in sunlight."', t24("You gain a +1 bonus to Armor Class while you wear this cloak, but the cloak doesn't function in sunlight."), null, true, 'Cloak of Dusk'],
    ['"…; the cloak has no effect underwater."', t24('While you wear this cloak, you gain a +1 bonus to Armor Class; the cloak has no effect underwater.'), null, true, 'Cloak of Dusk'],
    ['"…, but this cloak works only at night."', t24('While you wear this cloak, you gain a +1 bonus to Armor Class, but this cloak works only at night.'), null, true],
    ['"…this cloak, which doesn\'t function in sunlight."', t24("You gain a +1 bonus to Armor Class while you wear this cloak, which doesn't function in sunlight."), null, true],
    ['"…this cloak, which has no effect underwater."', t24('You have a +1 bonus to saving throws while you wear this cloak, which has no effect underwater.'), null, true],
    ['"This cloak works only at night." (next sentence)', t24('While you wear this cloak, you gain a +1 bonus to Armor Class. This cloak works only at night.'), null, true],
    ['"These boots only work on dry land."', t24('While you wear these boots, you have a +1 bonus to saving throws. These boots only work on dry land.'), null, true, 'Boots of the Ridge'],
    ['"It never works underwater."', t24('You have a +1 bonus to Armor Class while you wear this cloak. It never works underwater.'), null, true],
    ['"The cloak is suppressed in bright light." (2014)', t14('You have a +1 bonus to AC while you wear this cloak. The cloak is suppressed in bright light.'), null, true, 'Cloak of the Deep'],
    // Said of the item, and no restriction.
    ['"It never tears." (no condition)', t24('You have a +1 bonus to Armor Class while you wear this cloak. It never tears.'), { ac: 1 }, false],
    ['"The cloak is always warm to the touch."', t24('You have a +1 bonus to Armor Class while you wear this cloak. The cloak is always warm to the touch.'), { ac: 1 }, false, 'Cloak of the Deep'],
    ['"This cloak can be attuned only by an elf."', t24('This cloak can be attuned only by an elf. You have a +1 bonus to Armor Class while you wear it.'), { ac: 1 }, false],
    // Armor worn where the item doesn't work: the no-armor condition for AC; another target fails closed.
    ['"If you wear armor or use a Shield, these bracers have no effect."', t24('While wearing these bracers, you gain a +2 bonus to Armor Class. If you wear armor or use a Shield, these bracers have no effect.'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false, 'Bracers of the Warden'],
    ['"If you are wearing armor or using a shield, the bracers don\'t work." (2014)', t14("You gain a +2 bonus to AC while you wear these bracers. If you are wearing armor or using a shield, the bracers don't work."), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false, 'Bracers of the Warden'],
    ['"Wearing armor or using a Shield suppresses the bracers."', t24('While wearing these bracers, you gain a +2 bonus to Armor Class. Wearing armor or using a Shield suppresses the bracers.'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false, 'Bracers of the Warden'],
    ['"The bracers don\'t work if you wear armor or use a Shield."', t24("While wearing these bracers, you have a +2 bonus to Armor Class.\n\nThe bracers don't work if you wear armor or use a Shield."), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false, 'Bracers of the Warden'],
    ['"If you wear armor or use a Shield, the bracers don\'t work." (next paragraph)', t24("While wearing these bracers, you have a +2 bonus to Armor Class.\n\nIf you wear armor or use a Shield, the bracers don't work."), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false, 'Bracers of the Warden'],
    ['"If you wear armor or carry a shield, the bracers stop working." (2014)', t14('While wearing these bracers, you gain a +2 bonus to AC. If you wear armor or carry a shield, the bracers stop working.'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false, 'Bracers of the Warden'],
    ['"If you wear armor, these bracers have no effect."', t24('While wearing these bracers, you gain a +2 bonus to Armor Class. If you wear armor, these bracers have no effect.'), { ac: 2, acOnlyWhen: 'no-armor' }, false, 'Bracers of the Warden'],
    ['the no-armor restriction with a save bonus too', t24('While wearing these bracers, you gain a +2 bonus to Armor Class and a +1 bonus to saving throws. If you wear armor or use a Shield, these bracers have no effect.'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, true, 'Bracers of the Warden'],
    // What stays applied: reuse limits, a permanent loss, "can't be suppressed", "which has no string", a relative clause about something else.
    ['"…this magic weapon, which has no string."', t24('You gain a +1 bonus to attack rolls and damage rolls made with this magic weapon, which has no string.', '_Weapon (Longbow), Rare (Requires Attunement)_'), { attack: 1, damage: 1 }, false, 'Moonshot'],
    ['"You can\'t use this property again until…"', t24("While you wear this cloak, you gain a +1 bonus to Armor Class.\n\n_**Shadow Step.**_ As a Bonus Action, you can teleport. You can't use this property again until you finish a Short or Long Rest."), { ac: 1 }, false],
    ['"…the staff loses its properties and becomes a nonmagical Quarterstaff."', t24('This staff can be wielded as a magic Quarterstaff that grants a +1 bonus to attack rolls and damage rolls made with it.\n\n_**Regaining Charges.**_ If you expend the last charge, roll 1d20. On a 1, the staff loses its properties and becomes a nonmagical Quarterstaff.', STAFF24), { attack: 1, damage: 1 }, false, 'Heron Staff'],
    ['"…crumbles to dust and is destroyed."', t24('While you wear this cloak, you gain a +1 bonus to Armor Class. If you expend its last charge, the cloak crumbles to dust and is destroyed.'), { ac: 1 }, false],
    ['"…lined with blue silk that never fades."', t24('This cloak is woven of gray wool and lined with blue silk that never fades. While you wear this cloak, you have a +1 bonus to Armor Class and saving throws.'), { ac: 1, savingThrows: 1 }, false],
    ['"This cloak can\'t be suppressed by an Antimagic Field."', t24("You gain a +1 bonus to Armor Class while you wear this cloak. This cloak can't be suppressed by an Antimagic Field."), { ac: 1 }, false],
    ['"If the weapon is on your person, you can…" (the item in a lead-in)', t24("You gain a +1 bonus to attack rolls and damage rolls made with this magic weapon.\n\n_**Luck.**_ If the weapon is on your person, you can reroll one failed D20 Test if you don't have the Incapacitated condition.", SWORD24), { attack: 1, damage: 1 }, false, 'Warden Blade'],
  ];

  /** I2: references as subjects wherever they stand, "each / both / neither / all of these …", and more verbs that take one as their object. */
  const REFERENCES: Row[] = [
    ['"Each of these bonuses applies only…"', t24('While you wear this cloak, you have a +1 bonus to Armor Class and a +1 bonus to saving throws. Each of these bonuses applies only while you are in Dim Light or Darkness.'), null, true],
    ['"Each of these benefits ends if…"', t24('While you wear this cloak, you have a +1 bonus to Armor Class and a +1 bonus to saving throws. Each of these benefits ends if you are Bloodied.'), null, true],
    ['"Neither of these bonuses applies while…" (2014)', t14('While wearing this cloak, you gain a +1 bonus to AC and saving throws. Neither of these bonuses applies while you are in bright light.'), null, true],
    ['"Both of these bonuses are suppressed while…"', t24('While you wear this cloak, you have a +1 bonus to Armor Class and saving throws. Both of these bonuses are suppressed while you are Bloodied.'), null, true],
    ['"All of these bonuses end if…"', t24('While you wear this cloak, you have a +1 bonus to Armor Class and a +1 bonus to saving throws. All of these bonuses end if you are Bloodied.'), null, true],
    ['"Either of these bonuses is lost while…"', t24('While you wear this cloak, you have a +1 bonus to Armor Class and a +1 bonus to saving throws. Either of these bonuses is lost while you are Bloodied.'), null, true],
    ['"Each of the bonuses applies only…"', t24('While you wear this cloak, you have a +1 bonus to Armor Class and a +1 bonus to saving throws. Each of the bonuses applies only while you are in Dim Light or Darkness.'), null, true],
    ['"In sunlight the bonus doesn\'t apply." (no comma)', t24("You have a +1 bonus to Armor Class while you wear this cloak. In sunlight the bonus doesn't apply."), null, true],
    ['"Underwater this benefit is lost." (2014)', t14('You gain a +1 bonus to AC while you wear this cloak. Underwater this benefit is lost.'), null, true],
    ['"In bright light the bonuses don\'t apply." (2014)', t14("While wearing this cloak, you gain a +1 bonus to AC and saving throws. In bright light the bonuses don't apply."), null, true],
    ['"While you are Bloodied the bonus doesn\'t apply."', t24("You have a +1 bonus to Armor Class while you wear this cloak. While you are Bloodied the bonus doesn't apply."), null, true],
    ['"If you are Bloodied this benefit ends."', t24('You have a +1 bonus to Armor Class while you wear this cloak. If you are Bloodied this benefit ends.'), null, true],
    ['"By day the cloak\'s magic fails."', t24("You have a +1 bonus to Armor Class while you wear this cloak. By day the cloak's magic fails."), null, true],
    ['"Bright Light cancels this benefit."', t24('You have a +1 bonus to Armor Class while you wear this cloak. Bright Light cancels this benefit.'), null, true],
    ['"Sunlight dispels this protection until the next dusk."', t24('You have a +1 bonus to Armor Class while you wear this cloak. Sunlight dispels this protection until the next dusk.'), null, true],
    ['"You can\'t use this benefit while you are Bloodied."', t24("You have a +1 bonus to Armor Class while you wear this cloak. You can't use this benefit while you are Bloodied."), null, true],
    ['"In Bright Light, you lose access to this benefit."', t24('You have a +1 bonus to Armor Class while you wear this cloak. In Bright Light, you lose access to this benefit.'), null, true],
    ['"The protection fades in sunlight."', t24('You have a +1 bonus to Armor Class while you wear this cloak. The protection fades in sunlight.'), null, true],
    ['"An Antimagic Field removes this benefit."', t24('You have a +1 bonus to Armor Class while you wear this cloak. An Antimagic Field removes this benefit.'), null, true],
    ['"Darkness nullifies this protection."', t24('You have a +1 bonus to Armor Class while you wear this cloak. Darkness nullifies this protection.'), null, true],
    ['"Undead deny you this benefit."', t24('You have a +1 bonus to Armor Class while you wear this cloak. Undead within 10 feet of you deny you this benefit.'), null, true],
    ['"Bright Light negates both of these bonuses."', t24('While you wear this cloak, you have a +1 bonus to Armor Class and a +1 bonus to saving throws. Bright Light negates both of these bonuses.'), null, true],
    ['"The bonus is unavailable while you are raging." (2014)', t14('You gain a +1 bonus to AC while wearing this cloak. The bonus is unavailable while you are raging.'), null, true],
    ['"In sunlight, the bonus doesn\'t apply."', t24("You have a +1 bonus to Armor Class while you wear this cloak. In sunlight, the bonus doesn't apply."), null, true],
    ['"In sunlight they don\'t work." (a pronoun after a lead-in)', t24("You have a +1 bonus to Armor Class and saving throws while you wear this cloak. In sunlight they don't work."), null, true],
    ['"During combat the bonus ends."', t24('You have a +1 bonus to Armor Class while you wear this cloak. During combat the bonus ends.'), null, true],
    ['"Its magic fails at dawn." (2014)', t14('You have a +1 bonus to AC while you wear this cloak. Its magic fails at dawn.'), null, true],
  ];

  /** I3: a failing label governs its whole piece (a short sentence after it is no label), and a label a column ended after governs the next piece. */
  const LABELS: Row[] = [
    ['"Guard (Shield Form Only)." then "The shield hardens."', t24('_**Guard (Shield Form Only).**_ The shield hardens. While you hold it, you have a +1 bonus to Armor Class.', SHIELD24), null, true, 'Warden Shield'],
    ['"Underwater." then "You can breathe water. You can\'t drown."', t24("While you wear this cloak, you gain the following benefits.\n\n_**Underwater.**_ You can breathe water. You can't drown. You also have a +1 bonus to Armor Class."), null, true, 'Cloak of the Deep'],
    ['"Iron Hide (Raging Only)." then "Your skin thickens." (2014)', t14('***Iron Hide (Raging Only).*** Your skin thickens. You have a +2 bonus to AC.', HIDE14), null, true, 'Hide of the Bear'],
    ['"Last Stand (Bloodied Only)." then two short sentences', t24('_**Last Stand (Bloodied Only).**_ Your resolve hardens. It feels like stone. You have a +2 bonus to saving throws.'), null, true, 'Cloak of the Deep'],
    ['a list item "- **Underwater.** You can\'t drown. …"', t24("While you wear this cloak, you gain the following benefits:\n\n- **Night Sight.** You can see in Darkness.\n- **Underwater.** You can't drown. You have a +1 bonus to Armor Class."), null, true, 'Cloak of the Deep'],
    ['"Bulwark (Shield Form Only)." then "The runes flare."', t24('_**Bulwark (Shield Form Only).**_ The runes flare. You have a +1 bonus to Armor Class.', SHIELD24), null, true, 'Warden Shield'],
    ['"Night." then "The cloak shimmers."', t24('_**Night.**_ The cloak shimmers. You have a +1 bonus to Armor Class while you wear it.'), null, true, 'Cloak of the Deep'],
    ['"Bloodied." then "Stand firm."', t24('_**Bloodied.**_ Stand firm. You have a +2 bonus to saving throws while you wear this cloak.'), null, true, 'Cloak of the Deep'],
    ['an intro, then "Pressure Ward." then "Your skin hardens."', t24('While you are underwater, you gain the following benefits.\n\n_**Pressure Ward.**_ Your skin hardens. You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"Underwater." then "Your gills open." (2014)', t14('***Underwater.*** Your gills open. You gain a +1 bonus to AC.'), null, true, 'Cloak of the Deep'],
    // A label that holds stays a label for the piece; a short sentence after it is no label that lifts anything.
    ['"Ward." then "The shield hardens."', t24('_**Ward.**_ The shield hardens. While you hold it, you have a +1 bonus to Armor Class.', SHIELD24), { ac: 1 }, false, 'Warden Shield'],
  ];

  /** I4: a limit in an intro's own paragraph reaches what it offers; one in a closing paragraph reaches the run-ins it follows, wherever it stands. */
  const INTRO_LIMITS: Row[] = [
    ['"…the following benefits. They last only while…"', t24('While you wear this cloak, you gain the following benefits. They last only while you are in Dim Light or Darkness.\n\n_**Shade Ward.**_ You have a +1 bonus to Armor Class.\n\n_**Shade Step.**_ You can take the Hide action as a Bonus Action.'), null, true, 'Cloak of the Deep'],
    ['"…the following benefits. These last only while…"', t24('While you wear this cloak, you gain the following benefits. These last only while you are in Dim Light or Darkness.\n\n_**Shade Ward.**_ You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"…while wearing this mantle. The benefits don\'t function while…"', t24("You gain the following benefits while wearing this mantle. The benefits don't function while you are Bloodied.\n\n_**Brine Ward.**_ You have a +1 bonus to Armor Class and saving throws."), null, true, 'Mantle of Brine'],
    ['"…the following benefits. Each benefit works only underwater." (2014)', t14('While wearing this cloak, you gain the following benefits. Each benefit works only underwater.\n\n***Pressure Ward.*** You have a +1 bonus to AC.'), null, true, 'Cloak of the Deep'],
    ['"…the following benefits. They don\'t function while you are raging." (2014)', t14("While wearing this armor, you gain the following benefits. They don't function while you are raging.\n\n***Iron Hide.*** You have a +1 bonus to AC.", HIDE14), null, true, 'Hide of the Bear'],
    ['"…the following benefits. They work only underwater." (2014)', t14('While wearing this cloak, you gain the following benefits. They work only underwater.\n\n***Pressure Ward.*** You have a +1 bonus to AC.\n\n***Gills.*** You can breathe water.'), null, true, 'Cloak of the Deep'],
    ['"…the following benefits, which end if you are Bloodied:"', t24('While you wear this cloak, you gain the following benefits, which end if you are Bloodied:\n\n- **Shade Ward.** You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['a closing "The shadows are fickle. They work only in Dim Light or Darkness."', t24('While you wear this cloak, you gain the following benefits.\n\n_**Shade Ward.**_ You have a +1 bonus to Armor Class.\n\n_**Shade Step.**_ You can take the Hide action as a Bonus Action.\n\nThe shadows are fickle. They work only in Dim Light or Darkness.'), null, true, 'Cloak of the Deep'],
    ['a closing "…thin in sunlight. Its benefits don\'t function there."', t24("While you wear this cloak, you gain the following benefits.\n\n_**Shade Ward.**_ You have a +1 bonus to Armor Class.\n\n_**Shade Step.**_ You can take the Hide action as a Bonus Action.\n\nThe cloak's shadows thin in sunlight. Its benefits don't function there."), null, true, 'Cloak of the Deep'],
    ['"…the following benefits. These benefits last only while…"', t24('While you wear this cloak, you gain the following benefits. These benefits last only while you are in Dim Light or Darkness.\n\n_**Shade Ward.**_ You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    // Defender's shape: a limit two paragraphs on reaches only the paragraph before it.
    ['"The adjusted bonuses remain in effect until…" two paragraphs on', t24('You gain a +3 bonus to attack rolls and damage rolls made with this magic weapon.\n\nYou can move some of the bonus to your Armor Class. For example, you could gain a +2 bonus to Armor Class.\n\nThe adjusted bonuses remain in effect until the start of your next turn.', '_Weapon (Any Melee Weapon), Legendary (Requires Attunement)_'), { attack: 3, damage: 3 }, true, 'Warden Blade'],
  ];

  /** I6: headings and bold lines inside an item are labels (variants when they read "Name (Rarity)"); offers "below" and "as follows"; a list that lost its bullets. */
  const HEADINGS: Row[] = [
    ['"#### Pressure Ward" under "While you are underwater, …the following benefits."', t24('While you are underwater, you gain the following benefits.\n\n#### Deep Sight\n\nYou can see in Darkness.\n\n#### Pressure Ward\n\nYou have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"**Pressure Ward**" under the same intro', t24('While you are underwater, you gain the following benefits.\n\n**Deep Sight**\n\nYou can see in Darkness.\n\n**Pressure Ward**\n\nYou have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"**Pressure Ward.**" under the same intro', t24('While you are underwater, you gain the following benefits.\n\n**Deep Sight.**\n\nYou can see in Darkness.\n\n**Pressure Ward.**\n\nYou have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"#### Iron Hide" under "…while you are raging." (2014)', t14('You gain the following benefits while you are raging.\n\n#### Thick Pelt\n\nYou have resistance to cold damage.\n\n#### Iron Hide\n\nYou have a +2 bonus to AC.', HIDE14), null, true, 'Hide of the Bear'],
    ['"#### Night Ward": a heading that limits', t24('This cloak has two properties.\n\n#### Night Ward\n\nYou have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"…you gain the benefits below."', t24('While you are underwater, you gain the benefits below.\n\n_**Pressure Ward.**_ You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"…the benefits described below."', t24('While you are underwater, you gain the benefits described below.\n\n_**Pressure Ward.**_ You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"…the armor\'s properties are as follows."', t24("While you are underwater, the armor's properties are as follows.\n\n_**Pressure Ward.**_ You have a +1 bonus to Armor Class.", ARMOR24), null, true, 'Coral Armor'],
    ['unlabeled list items after a "." intro', t24('While you are Bloodied, you gain the following benefits.\n\n- You have Resistance to Necrotic damage.\n- You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['unlabeled list items after "You gain these benefits while…"', t24('You gain these benefits while you are Bloodied.\n\n- You have Resistance to Necrotic damage.\n- You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    // Headings and lists that hold.
    ['"#### Pressure Ward" under an always-on intro', t24('While you wear this cloak, you gain the following benefits.\n\n#### Deep Sight\n\nYou can see in Darkness.\n\n#### Pressure Ward\n\nYou have a +1 bonus to Armor Class.'), { ac: 1 }, false, 'Cloak of the Deep'],
    ['unlabeled list items under an always-on intro', t24('While you wear this cloak, you gain the following benefits.\n\n- You have Resistance to Necrotic damage.\n- You have a +1 bonus to Armor Class.'), { ac: 1 }, false, 'Cloak of the Deep'],
    ['a bold sentence is prose', t24('**While you wear this cloak, you have a +1 bonus to Armor Class.**'), { ac: 1 }, false, 'Cloak of the Deep'],
  ];

  /** I7: an opening by a preposition or a subordinator governs a later clause with no lead-in, whatever subject its first clause has. */
  const OPENINGS: Row[] = [
    ['"By night ravens circle the cloak, and it grants…"', t24('By night ravens circle the cloak, and it grants a +1 bonus to Armor Class.'), null, true],
    ['"Between dusk and dawn, its runes glow, and you gain…"', t24('Between dusk and dawn, its runes glow, and you gain a +1 bonus to Armor Class.'), null, true],
    ['"Beneath the open sky, the gem glows, and you gain…"', t24('Beneath the open sky, the gem glows, and you gain a +1 bonus to saving throws.'), null, true],
    ['"After dark, shadows cling to the wearer, and the cloak grants…"', t24('After dark, shadows cling to the wearer, and the cloak grants a +1 bonus to Armor Class.'), null, true, 'Cloak of Shadows'],
    ['"Under a full moon, your eyes shine, and you gain…" (2014)', t14('Under a full moon, your eyes shine, and you gain a +1 bonus to AC and saving throws.'), null, true],
    ['"By night the runes glow and you gain…" (a bare "and")', t24('By night the runes glow and you gain a +1 bonus to Armor Class.'), null, true],
    ['"Upon a hit, the runes flare, and you gain…" (2014)', t14('Upon a hit, the runes flare, and you gain a +1 bonus to AC.'), null, true],
    ['"At night, its runes glow, and you gain…"', t24('At night, its runes glow, and you gain a +1 bonus to Armor Class.'), null, true],
    // Openings that hold, and a first clause with no opening.
    ['"Its blade is etched with runes, and you gain…"', t24('Its blade is etched with runes, and you gain a +1 bonus to attack rolls and damage rolls made with this weapon.', SWORD24), { attack: 1, damage: 1 }, false],
    ['"While you wear this ring, your skin hardens, and you gain…"', t24('While you wear this ring, your skin hardens, and you gain a +1 bonus to Armor Class.', RING24), { ac: 1 }, false, 'Ring of Bark'],
    ['"While wearing this armor, your Speed isn\'t reduced by its weight, and you gain…"', t24("While wearing this armor, your Speed isn't reduced by its weight, and you gain a +1 bonus to saving throws.", ARMOR24), { savingThrows: 1 }, false, 'Warden Scales'],
    ['"While you wear these boots, your steps make no sound, and you gain…"', t24('While you wear these boots, your steps make no sound, and you gain a +1 bonus to saving throws.'), { savingThrows: 1 }, false, 'Boots of Hush'],
    ['"While holding this staff, its crystal sheds Dim Light…, and you gain…"', t24('While holding this staff, its crystal sheds Dim Light in a 5-foot radius, and you gain a +1 bonus to Armor Class.', STAFF24), { ac: 1 }, false, 'Staff of the Warden'],
    ['"When worn, its hood hides your face, and you gain…"', t24('When worn, its hood hides your face, and you gain a +1 bonus to Armor Class.'), { ac: 1 }, false, 'Cloak of the Fen'],
  ];

  /** I8: what follows a clause's last benefit is the whole clause's. */
  const TAILS: Row[] = [
    ['"…and Resistance to Cold damage between dusk and dawn."', t24('While you wear this cloak, you gain a +1 bonus to Armor Class and Resistance to Cold damage between dusk and dawn.'), null, true],
    ['"…and Advantage on Dexterity (Stealth) checks by moonlight."', t24('While you wear this cloak, you have a +1 bonus to Armor Class and Advantage on Dexterity (Stealth) checks by moonlight.'), null, true],
    ['"…and Resistance to Cold damage after dark."', t24('While you wear this cloak, you gain a +1 bonus to Armor Class and Resistance to Cold damage after dark.'), null, true],
    ['"…and Resistance to Cold damage only under a full moon."', t24('While you wear this cloak, you gain a +1 bonus to Armor Class and Resistance to Cold damage only under a full moon.'), null, true],
    ['"…, as well as Resistance to Necrotic damage, by night."', t24('While wearing this cloak, you gain a +1 bonus to Armor Class and saving throws, as well as Resistance to Necrotic damage, by night.'), null, true],
    ['"…and a +1 bonus to saving throws by night."', t24('While you wear this cloak, you gain a +1 bonus to Armor Class and a +1 bonus to saving throws by night.'), null, true],
    ['"…while you wear this cloak and a +1 bonus to saving throws while you are Bloodied." (no comma)', t24('You gain a +1 bonus to Armor Class while you wear this cloak and a +1 bonus to saving throws while you are Bloodied.'), null, true],
    // More benefits with nothing after them keep it whole.
    ['"…and Resistance to Cold damage."', t24('While you wear this cloak, you gain a +1 bonus to Armor Class and Resistance to Cold damage.'), { ac: 1 }, false],
    ['"…and a Swim Speed equal to your Speed."', t24('While you wear this cloak, you gain a +1 bonus to Armor Class and a Swim Speed equal to your Speed.'), { ac: 1 }, false],
    ['"…and Resistance to one damage type (see the table)."', t24('While you wear this cloak, you gain a +1 bonus to Armor Class and Resistance to Cold damage (see the table).'), { ac: 1 }, false],
    ['"…, as well as Resistance to Necrotic damage, while you wear it."', t24('You gain a +1 bonus to Armor Class, as well as Resistance to Necrotic damage, while you wear it.'), { ac: 1 }, false],
  ];

  /** I9: "as well as" / "in addition to" an object after an always-on phrase is a second object of wear or hold. */
  const SETS: Row[] = [
    ['"While you wear this cloak as well as the matching boots, …"', t24('While you wear this cloak as well as the matching boots, you gain a +1 bonus to Armor Class.'), null, true],
    ['"…while you wear this cloak as well as the matching boots."', t24('You gain a +1 bonus to Armor Class while you wear this cloak as well as the matching boots.'), null, true],
    ['"While you wear this helm in addition to the Gauntlets of the Warden, …"', t24('While you wear this helm in addition to the Gauntlets of the Warden, you gain a +1 bonus to saving throws.'), null, true, 'Helm of the Warden'],
    ['"While you hold this Shield as well as a Spear, …"', t24('While you hold this Shield as well as a Spear, you gain a +1 bonus to Armor Class.', SHIELD24), null, true, 'Phalanx Shield'],
  ];

  /** I10: a choice between benefits is never applied. */
  const CHOICES: Row[] = [
    ['"…a +1 bonus to Armor Class or a +1 bonus to saving throws."', t24('While you wear this amulet, you gain a +1 bonus to Armor Class or a +1 bonus to saving throws.'), null, true, 'Amulet of the Fen'],
    ['"…either a +1 bonus to Armor Class or a +1 bonus to saving throws."', t24('While you wear this amulet, you gain either a +1 bonus to Armor Class or a +1 bonus to saving throws.'), null, true, 'Amulet of the Fen'],
    ['"…your choice of a +1 bonus to Armor Class or …"', t24('While you wear this amulet, you gain your choice of a +1 bonus to Armor Class or a +1 bonus to saving throws.'), null, true, 'Amulet of the Fen'],
    ['"…your choice of a +1 bonus to Armor Class and …" (a borrowed verb after a choice)', t24('While you wear this amulet, you gain your choice of a +1 bonus to Armor Class and a +1 bonus to saving throws.'), null, true, 'Amulet of the Fen'],
    ['"…, choose one of the following benefits." over run-ins', t24('While you wear this amulet, choose one of the following benefits.\n\n_**Ward.**_ You have a +1 bonus to Armor Class.\n\n_**Grace.**_ You have a +1 bonus to saving throws.'), null, true, 'Amulet of the Fen'],
    ['"…, you can choose one of the following benefits:" over list items', t24('While you wear this amulet, you can choose one of the following benefits:\n\n- **Ward.** You have a +1 bonus to Armor Class.\n- **Grace.** You have a +1 bonus to saving throws.'), null, true, 'Amulet of the Fen'],
  ];

  /** I11: the item or its wearer named other ways. */
  const SUBJECTS: Row[] = [
    ['"Wearing this ring grants you…"', t24('Wearing this ring grants you a +1 bonus to Armor Class and saving throws.', RING24), { ac: 1, savingThrows: 1 }, false, 'Ring of the Fen'],
    ['"Each of these rings grants…"', t24('Each of these rings grants a +1 bonus to Armor Class and saving throws.', RING24), { ac: 1, savingThrows: 1 }, false, 'Ring of the Fen'],
    ['"Both of these rings grant…"', t24('Both of these rings grant a +1 bonus to Armor Class.', RING24), { ac: 1 }, false, 'Ring of the Fen'],
    ['"This armor has a +1 bonus to Armor Class."', t24('This armor has a +1 bonus to Armor Class.', ARMOR24), { ac: 1 }, false, 'Warden Scales'],
    ['"This shield has a +1 bonus to Armor Class."', t24('This shield has a +1 bonus to Armor Class.', SHIELD24), { ac: 1 }, false, 'Raven Shield'],
    ['"The wearer of this cloak gains…"', t24('The wearer of this cloak gains a +1 bonus to saving throws.'), { savingThrows: 1 }, false, 'Cloak of the Fen'],
    ['"This cloak\'s wearer gains…"', t24("This cloak's wearer gains a +1 bonus to saving throws."), { savingThrows: 1 }, false, 'Cloak of the Fen'],
    ['"Anyone who wears this cloak gains…"', t24('Anyone who wears this cloak gains a +1 bonus to Armor Class.'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"Whoever wears it gains…"', t24('Whoever wears it gains a +1 bonus to Armor Class.'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"The wielder of this sword gains…"', t24('The wielder of this sword gains a +1 bonus to saving throws.', SWORD24), { savingThrows: 1 }, false, 'Warden Blade'],
    ['"…, you and allies within 10 feet of you gain…"', t24('While you hold this banner, you and allies within 10 feet of you gain a +1 bonus to saving throws.'), { savingThrows: 1 }, false, 'Banner of the Fen'],
    ['"…shadows cling to you, and you and allies within 10 feet of you gain…"', t24('While you wear it, shadows cling to you, and you and allies within 10 feet of you gain a +1 bonus to Armor Class.'), { ac: 1 }, false],
    // Other creatures stay theirs.
    ['"each of your conjured elementals gains…"', t24('While you hold this rod, each of your conjured elementals gains a +1 bonus to Armor Class.', ROD24), null, true, 'Rod of Bones'],
    ['"…, and it gains…" after another creature', t24('Your familiar is linked to this cloak, and it gains a +1 bonus to Armor Class.'), null, true],
  ];
  const ROUND6: Row[] = [...RESTRICTIONS, ...REFERENCES, ...LABELS, ...INTRO_LIMITS, ...HEADINGS, ...OPENINGS, ...TAILS, ...SETS, ...CHOICES, ...SUBJECTS];

  /**
   * J1: a colon line or an intro with no comma is an intro, and a heading or a bold line is a label that governs its range (the
   * next piece, then every list item or run-in after it); a label or intro that says the item is worn or attuned holds, and
   * one that sets the no-armor condition sets it for what it governs.
   */
  const LABEL_INTROS: Row[] = [
    ['"While raging:" over a list', t24('This cloak is woven from kelp.\n\nWhile raging:\n\n- You have Resistance to Cold damage.\n- You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"While you are Bloodied:" over a list', t24('This cloak is woven from kelp.\n\nWhile you are Bloodied:\n\n- You have Resistance to Cold damage.\n- You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"Underwater:" over a list', t24('This cloak is woven from kelp.\n\nUnderwater:\n\n- You have Resistance to Cold damage.\n- You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"In Dim Light or Darkness:" over a list', t24('This cloak is woven from kelp.\n\nIn Dim Light or Darkness:\n\n- You have Resistance to Cold damage.\n- You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"**While Raging:**" over a list', t24('This cloak is woven from kelp.\n\n**While Raging:**\n\n- You have Resistance to Cold damage.\n- You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"While you are raging:" over a list (2014)', t14('This hide is thick and smells of the forest.\n\nWhile you are raging:\n\n- You have resistance to cold damage.\n- You have a +1 bonus to AC.', HIDE14), null, true, 'Hide of the Bear'],
    ['"While you are Bloodied:" over three bullets, the save bonus last', t24('This cloak is woven from kelp.\n\nWhile you are Bloodied:\n\n- You have Resistance to Necrotic damage.\n- Your Speed increases by 10 feet.\n- You have a +1 bonus to saving throws.'), null, true, 'Cloak of the Deep'],
    ['"While raging you gain these benefits." over run-ins', t24('This cloak is woven from kelp.\n\nWhile raging you gain these benefits.\n\n_**Deep Sight.**_ You can see in Darkness out to 60 feet.\n\n_**Pressure Ward.**_ You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"At night you gain these benefits." over run-ins', t24('This cloak is woven from kelp.\n\nAt night you gain these benefits.\n\n_**Deep Sight.**_ You can see in Darkness out to 60 feet.\n\n_**Pressure Ward.**_ You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"Underwater you gain the following benefits." over run-ins', t24('This cloak is woven from kelp.\n\nUnderwater you gain the following benefits.\n\n_**Deep Sight.**_ You can see in Darkness out to 60 feet.\n\n_**Pressure Ward.**_ You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"While raging you gain these benefits:" over run-ins (2014)', t14('This cloak is woven from kelp.\n\nWhile raging you gain these benefits:\n\n***Deep Sight.*** You can see in darkness out to 60 feet.\n\n***Pressure Ward.*** You have a +1 bonus to AC.'), null, true, 'Cloak of the Deep'],
    ['"While you are Bloodied:" over run-ins', t24('This cloak is woven from kelp.\n\nWhile you are Bloodied:\n\n_**Deep Sight.**_ You can see in Darkness out to 60 feet.\n\n_**Pressure Ward.**_ You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"While raging, you gain these benefits." over run-ins (the comma)', t24('This cloak is woven from kelp.\n\nWhile raging, you gain these benefits.\n\n_**Deep Sight.**_ You can see in Darkness out to 60 feet.\n\n_**Pressure Ward.**_ You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"#### Underwater" over a list', t24('This cloak has two aspects.\n\n#### Underwater\n\n- You can breathe water.\n- You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"#### While Raging" over a list', t24('This cloak has two aspects.\n\n#### While Raging\n\n- You have Resistance to Cold damage.\n- You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"**Underwater**" over a list', t24('This cloak has two aspects.\n\n**Underwater**\n\n- You can breathe water.\n- You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"**Underwater.**" over a list', t24('This cloak has two aspects.\n\n**Underwater.**\n\n- You can breathe water.\n- You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"#### While Bloodied" over three bullets', t24('This mantle smells of the sea.\n\n#### While Bloodied\n\n- You have Resistance to Necrotic damage.\n- Your Speed increases by 10 feet.\n- You have a +1 bonus to saving throws.'), null, true, 'Cloak of the Deep'],
    ['"#### Always" then "#### Underwater" over lists', t24('This cloak has two aspects.\n\n#### Always\n\n- You can see in Dim Light.\n- You have Advantage on Wisdom (Perception) checks.\n\n#### Underwater\n\n- You can breathe water.\n- You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"#### Underwater" under an always-on ":" intro', t24('While you wear this cloak, you gain the following benefits:\n\n#### Underwater\n\n- You can breathe water.\n- You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"#### Sunlight" over two plain paragraphs', t24('This cloak has two aspects.\n\n#### Sunlight\n\nThe cloak glows faintly.\n\nYou have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    // Labels and intros that hold.
    ['"While attuned:" over a list', t24('This cloak is woven from kelp.\n\nWhile attuned:\n\n- You have a +1 bonus to Armor Class.\n- You have Resistance to Cold damage.'), { ac: 1 }, false, 'Cloak of the Deep'],
    ['"While worn:" over a list', t24('This cloak is woven from kelp.\n\nWhile worn:\n\n- You have a +1 bonus to Armor Class.\n- You have Resistance to Cold damage.'), { ac: 1 }, false, 'Cloak of the Deep'],
    ['"While wearing this cloak:" over a list', t24('This cloak is woven from kelp.\n\nWhile wearing this cloak:\n\n- You have a +1 bonus to Armor Class.\n- You have Resistance to Cold damage.'), { ac: 1 }, false, 'Cloak of the Deep'],
    ['"While you wear this cloak:" over a list', t24('This cloak is woven from kelp.\n\nWhile you wear this cloak:\n\n- You have a +1 bonus to Armor Class.\n- You have Resistance to Cold damage.'), { ac: 1 }, false, 'Cloak of the Deep'],
    ['"**While Attuned**" over a list', t24('This cloak is woven from kelp.\n\n**While Attuned**\n\n- You have a +1 bonus to Armor Class.\n- You have Resistance to Cold damage.'), { ac: 1 }, false, 'Cloak of the Deep'],
    ['"#### Ward" over a list', t24('This cloak has two aspects.\n\n#### Ward\n\n- You have a +1 bonus to Armor Class.\n- You can breathe water.'), { ac: 1 }, false, 'Cloak of the Deep'],
    ['"If you wear no armor:" over a list', t24('These bracers are carved from bone.\n\nIf you wear no armor:\n\n- You have a +2 bonus to Armor Class.\n- You can move across water.'), { ac: 2, acOnlyWhen: 'no-armor' }, false, 'Bracers of the Warden'],
    ['"If you wear no armor, you gain the following benefits:"', t24('If you wear no armor, you gain the following benefits:\n\n- You have a +2 bonus to Armor Class.\n- You can move across water.'), { ac: 2, acOnlyWhen: 'no-armor' }, false, 'Bracers of the Warden'],
    ['"While you wear no armor and use no Shield, you gain the following benefits:" with a save bonus', t24('While you wear no armor and use no Shield, you gain the following benefits:\n\n- You have a +2 bonus to Armor Class.\n- You have a +1 bonus to saving throws.'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, true, 'Bracers of the Warden'],
  ];

  /** J2: a heading or a bold line between a bonus and the sentence that limits it belongs to the paragraph after it. */
  const HEADING_BACK_REACH: Row[] = [
    ['"#### Sunlight Sensitivity" before "This bonus doesn\'t apply…"', t24("While you wear this cloak, you have a +1 bonus to Armor Class.\n\n#### Sunlight Sensitivity\n\nThis bonus doesn't apply while you are in sunlight."), null, true, 'Cloak of the Deep'],
    ['"#### Drawback" before "These bonuses don\'t apply…"', t24("While you wear this cloak, you have a +1 bonus to Armor Class and saving throws.\n\n#### Drawback\n\nThese bonuses don't apply while you are in sunlight."), null, true, 'Cloak of the Deep'],
    ['"**Weakness**" before "The bonus doesn\'t apply…"', t24("While you wear this cloak, you have a +1 bonus to Armor Class.\n\n**Weakness**\n\nThe bonus doesn't apply while you are in sunlight."), null, true, 'Cloak of the Deep'],
    ['"**Drawback.**" before "This bonus doesn\'t apply…"', t24("While you wear this cloak, you have a +1 bonus to Armor Class.\n\n**Drawback.**\n\nThis bonus doesn't apply while you are in sunlight."), null, true, 'Cloak of the Deep'],
    ['"#### Description" after the bonus', t24('While you wear this cloak, you have a +1 bonus to Armor Class.\n\n#### Description\n\nThe cloak is woven from moth silk.'), { ac: 1 }, false, 'Cloak of the Deep'],
  ];

  /** J3: the item as a restriction's subject with its full name, an aside, a second subject or a "But"/"Yet" before it, and the fail-closed backstop. */
  const ITEM_SUBJECTS: Row[] = [
    ['"The Cloak of the Deep doesn\'t function in sunlight."', t24("While you wear this cloak, you have a +1 bonus to Armor Class.\n\nThe Cloak of the Deep doesn't function in sunlight."), null, true, 'Cloak of the Deep'],
    ['"The cloak of the deep doesn\'t work while you are raging." (2014)', t14("While wearing this cloak, you gain a +1 bonus to AC.\n\nThe cloak of the deep doesn't work while you are raging."), null, true, 'Cloak of the Deep'],
    ['"This cloak, woven from shadow, doesn\'t function in sunlight."', t24("While you wear this cloak, you have a +1 bonus to Armor Class.\n\nThis cloak, woven from shadow, doesn't function in sunlight."), null, true, 'Cloak of the Deep'],
    ['"The cloak, however, doesn\'t function in sunlight."', t24("While you wear this cloak, you have a +1 bonus to Armor Class.\n\nThe cloak, however, doesn't function in sunlight."), null, true, 'Cloak of the Deep'],
    ['"This cloak and its hood don\'t function in sunlight."', t24("While you wear this cloak, you have a +1 bonus to Armor Class.\n\nThis cloak and its hood don't function in sunlight."), null, true, 'Cloak of the Deep'],
    ['"The cloak (and its hood) doesn\'t function in sunlight."', t24("While you wear this cloak, you have a +1 bonus to Armor Class.\n\nThe cloak (and its hood) doesn't function in sunlight."), null, true, 'Cloak of the Deep'],
    ['"The Ring of Dusk Wardens works only in Dim Light or Darkness."', t24('While you wear this ring, you have a +1 bonus to Armor Class and saving throws.\n\nThe Ring of Dusk Wardens works only in Dim Light or Darkness.', RING24), null, true, 'Ring of Dusk Wardens'],
    ['"This cloak, however, doesn\'t function underwater." (2014)', t14("You gain a +1 bonus to AC while wearing this cloak. This cloak, however, doesn't function underwater."), null, true, 'Cloak of the Deep'],
    ['"The ring, like all such rings, works only in Dim Light or Darkness."', t24('While you wear this ring, you have a +1 bonus to Armor Class and saving throws. The ring, like all such rings, works only in Dim Light or Darkness.', RING24), null, true, 'Ring of Dusk Wardens'],
    ['"The ring of dusk wardens works only in dim light or darkness." (2014)', t14('While wearing this ring, you gain a +1 bonus to AC and saving throws. The ring of dusk wardens works only in dim light or darkness.', RING14), null, true, 'Ring of Dusk Wardens'],
    ['"This armor, once donned, doesn\'t function while you are raging." (2014)', t14("You have a +1 bonus to AC while you wear this armor. This armor, once donned, doesn't function while you are raging.", ARMOR14), null, true, 'Coral Armor'],
    ['"The cloak, however, has no effect in sunlight."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. The cloak, however, has no effect in sunlight.'), null, true, 'Cloak of the Deep'],
    ['"The cloak and its clasp stop working in sunlight."', t24('While you wear this cloak, you have a +1 bonus to Armor Class.\n\nThe cloak and its clasp stop working in sunlight.'), null, true, 'Cloak of the Deep'],
    ['"These bracers, however, don\'t function if you wear armor or use a Shield."', t24("While wearing these bracers, you gain a +2 bonus to Armor Class. These bracers, however, don't function if you wear armor or use a Shield."), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false, 'Bracers of the Warden'],
    ['"These bracers, however, don\'t work if you are wearing armor or using a shield." (2014)', t14("While wearing these bracers, you gain a +2 bonus to AC. These bracers, however, don't work if you are wearing armor or using a shield."), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false, 'Bracers of the Warden'],
    ['"But these bracers have no effect if you wear armor or use a Shield."', t24('While wearing these bracers, you gain a +2 bonus to Armor Class. But these bracers have no effect if you wear armor or use a Shield.'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false, 'Bracers of the Warden'],
    ['"The armor, though, doesn\'t function underwater."', t24("While wearing this armor, you gain a +1 bonus to Armor Class. The armor, though, doesn't function underwater.", ARMOR24), null, true, 'Coral Plate'],
    ['"The ring, however, doesn\'t function underwater." (2014)', t14("You gain a +1 bonus to AC and saving throws while wearing this ring. The ring, however, doesn't function underwater.", RING14), null, true, 'Ring of the Reed'],
    ['"The cloak, however, works only at night."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. The cloak, however, works only at night.'), null, true, 'Cloak of the Fen'],
    ['"The cloak, a relic of the Shadowfell, doesn\'t function in sunlight."', t24("While you wear this cloak, you have a +1 bonus to Armor Class. The cloak, a relic of the Shadowfell, doesn't function in sunlight."), null, true, 'Cloak of the Fen'],
    ['"The cloak (a relic of the Shadowfell) doesn\'t function in sunlight."', t24("While you wear this cloak, you have a +1 bonus to Armor Class. The cloak (a relic of the Shadowfell) doesn't function in sunlight."), null, true, 'Cloak of the Fen'],
    ['"The cloak—like all such relics—works only at night."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. The cloak—like all such relics—works only at night.'), null, true, 'Cloak of the Fen'],
    ['"But the cloak doesn\'t function in sunlight."', t24("While you wear this cloak, you have a +1 bonus to Armor Class. But the cloak doesn't function in sunlight."), null, true, 'Cloak of the Fen'],
    ['"Yet the cloak works only at night."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. Yet the cloak works only at night.'), null, true, 'Cloak of the Fen'],
    ['"The Cloak of Shadows doesn\'t function in sunlight."', t24("While you wear this cloak, you have a +1 bonus to Armor Class. The Cloak of Shadows doesn't function in sunlight."), null, true, 'Cloak of Shadows'],
    ['"This Cloak of Shadows doesn\'t function in sunlight."', t24("While you wear this cloak, you have a +1 bonus to Armor Class. This Cloak of Shadows doesn't function in sunlight."), null, true, 'Cloak of Shadows'],
    ['"The ring of the reed works only underwater." (2014)', t14('You gain a +1 bonus to AC and saving throws while wearing this ring. The ring of the reed works only underwater.', RING14), null, true, 'Ring of the Reed'],
    ['"A Ring of the Reed works only underwater."', t24('While you wear this ring, you have a +1 bonus to Armor Class. A Ring of the Reed works only underwater.', RING24), null, true, 'Ring of the Reed'],
    ['"The cloak and its clasp don\'t function in sunlight."', t24("While you wear this cloak, you have a +1 bonus to Armor Class. The cloak and its clasp don't function in sunlight."), null, true, 'Cloak of the Fen'],
    ['"The cloak, however, doesn\'t function in sunlight." before the bonus', t24("The cloak, however, doesn't function in sunlight. While you wear it, you have a +1 bonus to Armor Class."), null, true, 'Cloak of the Fen'],
    ['an aside of more than eight words (the backstop)', t24('While you wear this cloak, you have a +1 bonus to Armor Class. The cloak, a relic of the old kings who ruled the north long ago, works only at night.'), null, true, 'Cloak of the Fen'],
    ['"Each of these cloaks works only at night." (the backstop)', t24('While you wear this cloak, you have a +1 bonus to Armor Class. Each of these cloaks works only at night.'), null, true, 'Cloak of the Fen'],
    // The findings' controls: the verb right after the item, or a connective before it.
    ['"These bracers don\'t function if you wear armor or use a Shield." (control)', t24("While wearing these bracers, you gain a +2 bonus to Armor Class. These bracers don't function if you wear armor or use a Shield."), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false, 'Bracers of the Warden'],
    ['"However, the cloak has no effect in sunlight." (control)', t24('While you wear this cloak, you have a +1 bonus to Armor Class. However, the cloak has no effect in sunlight.'), null, true, 'Cloak of the Deep'],
    // Said of the item, and no restriction.
    ['"This cloak, a gift of the elves, can be attuned only by an elf."', t24('This cloak, a gift of the elves, can be attuned only by an elf. While you wear it, you have a +1 bonus to Armor Class.'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"This cloak, woven from moth silk, is warm to the touch."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. This cloak, woven from moth silk, is warm to the touch.'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"The Cloak of the Deep is woven from kelp."', t24('The Cloak of the Deep is woven from kelp. While you wear it, you have a +1 bonus to Armor Class.'), { ac: 1 }, false, 'Cloak of the Deep'],
    ['"You can remove this cloak only by casting Remove Curse." (the item as an object)', t24('While you wear this cloak, you have a +1 bonus to Armor Class. You can remove this cloak only by casting Remove Curse.'), { ac: 1 }, false, 'Cloak of the Fen'],
    // A "that" opens the item's own clause after a subject of its own: the backstop reads it.
    ['"You find that this cloak works only at night." (a "that" clause, the backstop)', t24('While you wear this cloak, you have a +1 bonus to Armor Class. You find that this cloak works only at night.'), null, true, 'Cloak of the Fen'],
    ['"They say that the cloak doesn\'t function in sunlight." (a "that" clause, the backstop)', t24("While you wear this cloak, you have a +1 bonus to Armor Class. They say that the cloak doesn't function in sunlight."), null, true, 'Cloak of the Fen'],
    ['"You know that this cloak never fails you." (a "that" clause, control)', t24('While you wear this cloak, you have a +1 bonus to Armor Class. You know that this cloak never fails you.'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"This cloak, the only one of its kind in all the northern kingdoms, is warm…" ("the only", the backstop)', t24('While you wear this cloak, you have a +1 bonus to Armor Class. This cloak, the only one of its kind in all the northern kingdoms, is warm to the touch.'), { ac: 1 }, false, 'Cloak of the Fen'],
  ];

  /** J4: every lead-in after an always-on opening is an opening of its own; "Each/Every <time>," is one that fails. */
  const STACKED_LEAD_INS: Row[] = [
    ['"While wearing this cloak, if you are in dim light or darkness, you can\'t be seen, and …" (2014)', t14("While wearing this cloak, if you are in dim light or darkness, you can't be seen, and you gain a +1 bonus to AC."), null, true, 'Cloak of the Fen'],
    ['"While you wear this ring, when you are Bloodied, you can\'t be Frightened, and …"', t24("While you wear this ring, when you are Bloodied, you can't be Frightened, and you have a +1 bonus to saving throws.", RING24), null, true, 'Ring of the Reed'],
    ['"While wearing this armor, if you are below half your hit point maximum, …, and …" (2014)', t14('While wearing this armor, if you are below half your hit point maximum, you have resistance to bludgeoning damage, and you gain a +1 bonus to AC.', ARMOR14), null, true, 'Warden Plate'],
    ['"While you wear this cloak, in Dim Light or Darkness, you can take the Hide action…, and …"', t24('While you wear this cloak, in Dim Light or Darkness, you can take the Hide action as a Bonus Action, and you have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Fen'],
    ['"While you wear this cloak, if you are Bloodied, you can\'t be Frightened, and …"', t24("While you wear this cloak, if you are Bloodied, you can't be Frightened, and you gain a +1 bonus to Armor Class."), null, true, 'Cloak of the Fen'],
    ['"Whenever you wear this cloak, if the moon is full, your eyes shine, and …"', t24('Whenever you wear this cloak, if the moon is full, your eyes shine, and you gain a +1 bonus to Armor Class.'), null, true, 'Cloak of the Fen'],
    ['"While holding this Shield, when you are Bloodied, its face glows, and …"', t24('While holding this Shield, when you are Bloodied, its face glows, and you gain a +1 bonus to Armor Class.', SHIELD24), null, true, 'Raven Shield'],
    ['"While wearing this cloak, while you are raging, your skin hardens, and …" (2014)', t14('While wearing this cloak, while you are raging, your skin hardens, and you gain a +1 bonus to AC.'), null, true, 'Cloak of the Fen'],
    ['"While you wear this ring, underwater, your skin hardens, and …"', t24('While you wear this ring, underwater, your skin hardens, and you gain a +1 bonus to Armor Class.', RING24), null, true, 'Ring of the Reed'],
    ['"When worn, at night, its hood hides your face, and …"', t24('When worn, at night, its hood hides your face, and you gain a +1 bonus to Armor Class.'), null, true, 'Cloak of the Fen'],
    ['"While wearing this armor, if you are below half your Hit Points, its plates lock together, and …"', t24('While wearing this armor, if you are below half your Hit Points, its plates lock together, and you gain a +1 bonus to Armor Class.', ARMOR24), null, true, 'Warden Plate'],
    ['"While you wear this cloak, however, at night, your eyes shine, and …"', t24('While you wear this cloak, however, at night, your eyes shine, and you gain a +1 bonus to Armor Class.'), null, true, 'Cloak of the Fen'],
    ['"Each night, its runes glow, and you gain…"', t24('Each night, its runes glow, and you gain a +1 bonus to Armor Class.'), null, true, 'Cloak of the Fen'],
    ['"Every dawn, the gem flares, and you gain…"', t24('Every dawn, the gem flares, and you gain a +1 bonus to saving throws.'), null, true, 'Cloak of the Fen'],
    ['"While you wear this cloak, if you are Bloodied, you gain…" (control)', t24('While you wear this cloak, if you are Bloodied, you gain a +1 bonus to Armor Class.'), null, true, 'Cloak of the Fen'],
    // Asides and concessions after an always-on opening hold.
    ['"While you wear this cloak, your steps make no sound, and you gain…"', t24('While you wear this cloak, your steps make no sound, and you gain a +1 bonus to Armor Class.'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"While you wear this cloak, even if you are Unconscious, your steps make no sound, and …"', t24('While you wear this cloak, even if you are Unconscious, your steps make no sound, and you gain a +1 bonus to Armor Class.'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"While you wear this cloak, in addition, your steps make no sound, and …"', t24('While you wear this cloak, in addition, your steps make no sound, and you gain a +1 bonus to Armor Class.'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"While you wear it, of course, shadows cling to you, and …"', t24('While you wear it, of course, shadows cling to you, and you gain a +1 bonus to Armor Class.'), { ac: 1 }, false, 'Cloak of the Fen'],
    // An inverted condition is a lead-in too.
    ['"While you wear this cloak, should you become Bloodied, your eyes shine, and …"', t24('While you wear this cloak, should you become Bloodied, your eyes shine, and you gain a +1 bonus to Armor Class.'), null, true, 'Cloak of the Fen'],
    ['"Should you become Bloodied, your eyes shine, and you gain…"', t24('Should you become Bloodied, your eyes shine, and you gain a +1 bonus to Armor Class.'), null, true, 'Cloak of the Fen'],
  ];

  /** J5: a reuse limit drops only its own clause; the clause beside it still limits. */
  const REUSE_CLAUSES: Row[] = [
    ['"When you are Bloodied, this benefit ends, and you can\'t use it again until…"', t24("While you wear this cloak, you have a +1 bonus to Armor Class. When you are Bloodied, this benefit ends, and you can't use it again until you finish a Long Rest."), null, true, 'Cloak of the Fen'],
    ['"The bonus is lost while you are Bloodied, and it can\'t be used again until…"', t24("While you wear this cloak, you have a +1 bonus to Armor Class. The bonus is lost while you are Bloodied, and it can't be used again until the next dawn."), null, true, 'Cloak of the Fen'],
    ['"If you drop to 0 hit points, the ring\'s protection ends, and it can\'t be used again…" (2014)', t14("You gain a +1 bonus to AC and saving throws while wearing this ring. If you drop to 0 hit points, the ring's protection ends, and it can't be used again until the next dawn.", RING14), null, true, 'Ring of the Reed'],
    ['"When you are hit by a Critical Hit, this bonus ends, and it can\'t be used again…"', t24("While holding this Shield, you have a +2 bonus to Armor Class. When you are hit by a Critical Hit, this bonus ends, and it can't be used again until you finish a Long Rest.", SHIELD24), null, true, 'Raven Shield'],
    ['"The bonus is suppressed while you are raging, and this property can\'t be used again…" (2014)', t14("While wearing this armor, you gain a +1 bonus to AC. The bonus is suppressed while you are raging, and this property can't be used again until you finish a long rest.", ARMOR14), null, true, 'Warden Plate'],
    ['"While you are Bloodied, these bonuses don\'t apply, and you can\'t use them again…"', t24("While you wear this cloak, you have a +1 bonus to Armor Class and saving throws. While you are Bloodied, these bonuses don't apply, and you can't use them again until the next dawn."), null, true, 'Cloak of the Fen'],
    ['"This benefit ends if you are Bloodied and can\'t be used again until…"', t24("While you wear this cloak, you have a +1 bonus to Armor Class. This benefit ends if you are Bloodied and can't be used again until the next dawn."), null, true, 'Cloak of the Fen'],
    ['"…the bonus ends when you are Bloodied, and if you expend the last charge, the cloak crumbles to dust."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. This bonus ends when you are Bloodied, and if you expend its last charge, the cloak crumbles to dust.'), null, true, 'Cloak of the Fen'],
    ['"When you are Bloodied, this benefit ends." (control: no reuse limit)', t24('While you wear this cloak, you have a +1 bonus to Armor Class. When you are Bloodied, this benefit ends.'), null, true, 'Cloak of the Fen'],
    ['"…; once used, this property can\'t be used again until the next dawn." (a reuse limit alone)', t24("While you wear this cloak, you have a +1 bonus to Armor Class. As a Magic action, you can turn Invisible; once used, this property can't be used again until the next dawn."), { ac: 1 }, false, 'Cloak of the Fen'],
  ];

  /** J6: an item reference as the subject of a clause before the bonus, in its own sentence. */
  const ITEM_REFERENCES: Row[] = [
    ['"The cloak\'s magic fails in sunlight, but while you wear it, …"', t24("The cloak's magic fails in sunlight, but while you wear it, you have a +1 bonus to Armor Class."), null, true, 'Cloak of the Fen'],
    ['"The ring\'s protection works only in Dim Light or Darkness, and while you wear it, …"', t24("The ring's protection works only in Dim Light or Darkness, and while you wear it, you have a +1 bonus to Armor Class and saving throws.", RING24), null, true, 'Ring of Dusk'],
    ['"The cloak\'s protection doesn\'t work in sunlight, but while you wear it, …"', t24("The cloak's protection doesn't work in sunlight, but while you wear it, you have a +1 bonus to Armor Class."), null, true, 'Cloak of the Fen'],
    ['"The armor\'s magic doesn\'t function underwater, but while wearing it, …" (2014)', t14("The armor's magic doesn't function underwater, but while wearing it, you gain a +1 bonus to AC.", ARMOR14), null, true, 'Coral Plate'],
    ['"This cloak\'s protection works only at night, and while you wear it, …"', t24("This cloak's protection works only at night, and while you wear it, you have a +1 bonus to Armor Class."), null, true, 'Cloak of the Fen'],
    ['"The cloak\'s magic is ancient, and while you wear it, …"', t24("The cloak's magic is ancient, and while you wear it, you have a +1 bonus to Armor Class."), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"…, but the cloak\'s magic fails in sunlight." (control: after the bonus)', t24("You gain a +1 bonus to Armor Class while you wear this cloak, but the cloak's magic fails in sunlight."), null, true, 'Cloak of the Fen'],
    ['"Its magic works only at night, and while you wear it, …" (control)', t24('Its magic works only at night, and while you wear it, you gain a +1 bonus to Armor Class.'), null, true, 'Cloak of the Fen'],
  ];

  /** J7: a state word only as what is said of the item; a negated "protect" needs a condition. */
  const ITEM_STATES: Row[] = [
    ['"The armor can\'t be damaged by nonmagical weapons."', t24("While you wear this armor, you have a +1 bonus to Armor Class. The armor can't be damaged by nonmagical weapons.", ARMOR24), { ac: 1 }, false, 'Warden Plate'],
    ['"The armor doesn\'t protect you from psychic damage." (2014)', t14("You have a +1 bonus to AC while you wear this armor. The armor doesn't protect you from psychic damage.", ARMOR14), { ac: 1 }, false, 'Warden Plate'],
    ['"The shield can\'t be damaged by nonmagical means."', t24("While holding this Shield, you have a +1 bonus to Armor Class. The shield can't be damaged by nonmagical means.", SHIELD24), { ac: 1 }, false, 'Raven Shield'],
    ['"The armor doesn\'t protect you while you are raging."', t24("While you wear this armor, you have a +1 bonus to Armor Class. The armor doesn't protect you while you are raging.", ARMOR24), null, true, 'Warden Plate'],
    ['"In sunlight, the cloak becomes a nonmagical cloak until dusk."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. In sunlight, the cloak becomes a nonmagical cloak until dusk.'), null, true, 'Cloak of the Fen'],
    ['"The cloak goes dormant in sunlight."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. The cloak goes dormant in sunlight.'), null, true, 'Cloak of the Fen'],
  ];

  /** O1: a colon run-in label, an opening "(" or a quotation mark before the subject. */
  const COLON_LABELS: Row[] = [
    ['"_**Weakness:**_ The cloak doesn\'t function in sunlight."', t24("While you wear this cloak, you have a +1 bonus to Armor Class.\n\n_**Weakness:**_ The cloak doesn't function in sunlight."), null, true, 'Cloak of the Deep'],
    ['"***Curse:*** This cloak works only at night." (2014)', t14('While wearing this cloak, you gain a +1 bonus to AC and saving throws.\n\n***Curse:*** This cloak works only at night.'), null, true, 'Cloak of the Deep'],
    ['"Weakness: the cloak doesn\'t function in sunlight." in the bonus\'s paragraph', t24("While you wear this cloak, you have a +1 bonus to Armor Class. Weakness: the cloak doesn't function in sunlight."), null, true, 'Cloak of the Deep'],
    ['"(The cloak doesn\'t function in sunlight.)"', t24("While you wear this cloak, you have a +1 bonus to Armor Class. (The cloak doesn't function in sunlight.)"), null, true, 'Cloak of the Deep'],
    ['"_**Weakness.**_ The cloak doesn\'t function in sunlight." (control: a period)', t24("While you wear this cloak, you have a +1 bonus to Armor Class.\n\n_**Weakness.**_ The cloak doesn't function in sunlight."), null, true, 'Cloak of the Deep'],
    ['"_**Drawback:**_ These bracers don\'t work if you wear armor or use a Shield."', t24("While wearing these bracers, you gain a +2 bonus to Armor Class.\n\n_**Drawback:**_ These bracers don't work if you wear armor or use a Shield."), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false, 'Bracers of the Warden'],
  ];

  /** O2: restrictions worded as "renders", "strips", "no benefit from", "fails to", "just an ordinary"; "the item" names every item. */
  const RESTRICTION_WORDS: Row[] = [
    ['"Wearing armor or using a Shield renders these bracers useless."', t24('While wearing these bracers, you gain a +2 bonus to Armor Class. Wearing armor or using a Shield renders these bracers useless.'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false, 'Bracers of the Warden'],
    ['"You gain no benefit from these bracers while you wear armor or use a shield." (2014)', t14('While wearing these bracers, you gain a +2 bonus to AC. You gain no benefit from these bracers while you wear armor or use a shield.'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false, 'Bracers of the Warden'],
    ['"Sunlight renders the cloak powerless."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. Sunlight renders the cloak powerless.'), null, true, 'Cloak of the Fen'],
    ['"You gain no benefit from this cloak while you are in sunlight."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. You gain no benefit from this cloak while you are in sunlight.'), null, true, 'Cloak of the Fen'],
    ['"The cloak fails to function in sunlight."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. The cloak fails to function in sunlight.'), null, true, 'Cloak of the Fen'],
    ['"The cloak is unable to function in sunlight."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. The cloak is unable to function in sunlight.'), null, true, 'Cloak of the Fen'],
    ['"The cloak refuses to work in sunlight."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. The cloak refuses to work in sunlight.'), null, true, 'Cloak of the Fen'],
    ['"Sunlight strips the cloak of its magic."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. Sunlight strips the cloak of its magic.'), null, true, 'Cloak of the Fen'],
    ['"In sunlight, the cloak is just an ordinary cloak."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. In sunlight, the cloak is just an ordinary cloak.'), null, true, 'Cloak of the Fen'],
    ['"The item works only underwater." in a ring', t24('While you wear this ring, you have a +1 bonus to Armor Class. The item works only underwater.', RING24), null, true, 'Ring of the Reed'],
    ['"The item doesn\'t function underwater." in armor (2014)', t14("You have a +1 bonus to AC while you wear this armor. The item doesn't function underwater.", ARMOR14), null, true, 'Coral Plate'],
    ['"The item doesn\'t function in sunlight." in a weapon', t24("You gain a +1 bonus to attack rolls and damage rolls made with this magic weapon. The item doesn't function in sunlight.", SWORD24), null, true, 'Sword of Dusk'],
    // One rule for each wording family: whatever verb takes "<item> of its magic", an item reference rendered inert, mundane or ordinary as a state, the item failing, its kind, a noun of the list, "neither … nor".
    ['"Sunlight robs the cloak of its magic."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. Sunlight robs the cloak of its magic.'), null, true, 'Cloak of the Fen'],
    ['"Sunlight deprives the cloak of its power."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. Sunlight deprives the cloak of its power.'), null, true, 'Cloak of the Fen'],
    ['"Exposure to sunlight renders the cloak\'s magic inert."', t24("While you wear this cloak, you have a +1 bonus to Armor Class. Exposure to sunlight renders the cloak's magic inert."), null, true, 'Cloak of the Fen'],
    ['"In sunlight, the cloak becomes mundane."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. In sunlight, the cloak becomes mundane.'), null, true, 'Cloak of the Fen'],
    ['"In sunlight, the cloak becomes a nonmagical cloak."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. In sunlight, the cloak becomes a nonmagical cloak.'), null, true, 'Cloak of the Fen'],
    ['"In sunlight, the cloak becomes an ordinary cloak."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. In sunlight, the cloak becomes an ordinary cloak.'), null, true, 'Cloak of the Fen'],
    ['"…this cloak, which fails in sunlight."', t24('You gain a +1 bonus to Armor Class while you wear this cloak, which fails in sunlight.'), null, true, 'Cloak of the Fen'],
    ['"The cloak fails in sunlight."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. The cloak fails in sunlight.'), null, true, 'Cloak of the Fen'],
    ['"Such a cloak doesn\'t function in sunlight."', t24("While you wear this cloak, you have a +1 bonus to Armor Class. Such a cloak doesn't function in sunlight."), null, true, 'Cloak of the Fen'],
    ['"The blade doesn\'t function in sunlight." in a longsword', t24("You gain a +1 bonus to attack rolls and damage rolls made with this magic weapon. The blade doesn't function in sunlight.", SWORD24), null, true, 'Sword of Dusk'],
    ['"The garment doesn\'t function in sunlight." in a mantle', t24("While you wear this mantle, you have a +1 bonus to Armor Class. The garment doesn't function in sunlight."), null, true, 'Mantle of the Fen'],
    ['"Neither the cloak nor its clasp functions in sunlight."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. Neither the cloak nor its clasp functions in sunlight.'), null, true, 'Cloak of the Fen'],
    // An event that spends the item for good, and the item failing a save, limit nothing.
    ['"When its last charge is spent, the cloak becomes an ordinary cloak."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. The cloak has 3 charges. When its last charge is spent, the cloak becomes an ordinary cloak.'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"If the cloak fails a saving throw, it is destroyed."', t24('While you wear this cloak, you have a +1 bonus to Armor Class. If the cloak fails a saving throw, it is destroyed.'), { ac: 1 }, false, 'Cloak of the Fen'],
  ];

  /** O3: a limit opening a piece with no bonus of its own, or a reference to a bonus (or, in a plain paragraph, a benefit) later in it, reaches the piece before. */
  const LATER_REFERENCES: Row[] = [
    ['"The band is cold to the touch. These bonuses apply only while…"', t24('While you wear this ring, you have a +1 bonus to Armor Class and saving throws.\n\nThe band is cold to the touch. These bonuses apply only while you are in Dim Light or Darkness.', RING24), null, true, 'Ring of the Reed'],
    ['"The cloak smells faintly of the sea. The bonus doesn\'t apply in sunlight." (2014)', t14("You gain a +1 bonus to AC while you wear this cloak.\n\nThe cloak smells faintly of the sea. The bonus doesn't apply in sunlight."), null, true, 'Cloak of the Fen'],
    ['"Shadow elves wove the first of these cloaks. The bonus applies only in Dim Light or Darkness."', t24('While you wear this cloak, you have a +1 bonus to Armor Class.\n\nShadow elves wove the first of these cloaks. The bonus applies only in Dim Light or Darkness.'), null, true, 'Cloak of the Fen'],
    ['"The bonus applies only in Dim Light or Darkness." first in its paragraph (control)', t24('While you wear this cloak, you have a +1 bonus to Armor Class.\n\nThe bonus applies only in Dim Light or Darkness. Shadow elves wove the first of these cloaks.'), null, true, 'Cloak of the Fen'],
    ['a run-in property that "loses this property if it has no charges"', t24('You gain a +1 bonus to Armor Class while you wear this cloak.\n\n_**Shroud.**_ The cloak has 3 charges. While wearing it, you can expend 1 charge to turn Invisible. The cloak loses this property if it has no charges.'), { ac: 1 }, false, 'Cloak of the Fen'],
  ];

  /** O4: a later sentence or clause that chooses among bonuses, or offers an alternative to one. */
  const LATER_CHOICES: Row[] = [
    ['"When you attune to the amulet, choose one of these bonuses."', t24('While you wear this amulet, you have a +1 bonus to Armor Class and a +1 bonus to saving throws. When you attune to the amulet, choose one of these bonuses.'), null, true, 'Amulet of the Fen'],
    ['"Each dawn, choose one of these bonuses to be active until the next dawn." (2014)', t14('While wearing this amulet, you gain a +1 bonus to AC and a +1 bonus to saving throws. Each dawn, choose one of these bonuses to be active until the next dawn.'), null, true, 'Amulet of the Fen'],
    ['"…choose one of these bonuses; the other doesn\'t apply until…"', t24("While you wear this amulet, you have a +1 bonus to Armor Class and a +1 bonus to saving throws. Each time you finish a Long Rest, choose one of these bonuses; the other doesn't apply until your next Long Rest."), null, true, 'Amulet of the Fen'],
    ['"At dawn, choose one of the two bonuses."', t24('While you wear this amulet, you have a +1 bonus to Armor Class and a +1 bonus to saving throws. At dawn, choose one of the two bonuses.'), null, true, 'Amulet of the Fen'],
    ['"Alternatively, you can have a +1 bonus to saving throws instead."', t24('While you wear this amulet, you have a +1 bonus to Armor Class. Alternatively, you can have a +1 bonus to saving throws instead.'), null, true, 'Amulet of the Fen'],
    ['"…; alternatively, you can gain a +1 bonus to saving throws."', t24('While you wear this amulet, you have a +1 bonus to Armor Class; alternatively, you can gain a +1 bonus to saving throws.'), null, true, 'Amulet of the Fen'],
    ['"Instead, you can choose to have a +1 bonus to saving throws."', t24('While you wear this amulet, you have a +1 bonus to Armor Class. Instead, you can choose to have a +1 bonus to saving throws.'), null, true, 'Amulet of the Fen'],
    ['"If you prefer, you can have a +1 bonus to saving throws instead."', t24('While you wear this amulet, you have a +1 bonus to Armor Class. If you prefer, you can have a +1 bonus to saving throws instead.'), null, true, 'Amulet of the Fen'],
    ['"Alternatively, …" in the next paragraph', t24('While you wear this amulet, you have a +1 bonus to Armor Class.\n\nAlternatively, you can have a +1 bonus to saving throws instead.'), null, true, 'Amulet of the Fen'],
    ['"…which deals Cold damage instead of Slashing damage." (no alternative)', t24('You gain a +1 bonus to attack rolls and damage rolls made with this weapon, which deals Cold damage instead of Slashing damage.', SWORD24), { attack: 1, damage: 1 }, false, 'Frost Fang'],
  ];

  /** O5: a failing intro's range goes on past a run-in's second paragraph to the run-ins after it. */
  const RUN_IN_PARAGRAPHS: Row[] = [
    ['a run-in\'s second paragraph under a conditional intro', t24('While you are underwater, you gain the following benefits.\n\n_**Deep Sight.**_ You can see in Darkness out to 60 feet.\n\nYour eyes glow a faint blue while you use this benefit.\n\n_**Pressure Ward.**_ You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['a heading\'s second paragraph under a conditional intro', t24('While you are underwater, you gain the following benefits.\n\n#### Deep Sight\n\nYou can see in Darkness out to 60 feet.\n\nYour eyes glow a faint blue while you use this benefit.\n\n#### Pressure Ward\n\nYou have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['two run-ins under a conditional intro (control: no second paragraph)', t24('While you are underwater, you gain the following benefits.\n\n_**Deep Sight.**_ You can see in Darkness out to 60 feet.\n\n_**Pressure Ward.**_ You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['a run-in\'s second paragraph under an always-on intro', t24('While you wear this cloak, you gain the following benefits.\n\n_**Deep Sight.**_ You can see in Darkness out to 60 feet.\n\nYour eyes glow a faint blue while you use this benefit.\n\n_**Pressure Ward.**_ You have a +1 bonus to Armor Class.'), { ac: 1 }, false, 'Cloak of the Deep'],
  ];
  const ROUND7: Row[] = [
    ...LABEL_INTROS, ...HEADING_BACK_REACH, ...ITEM_SUBJECTS, ...STACKED_LEAD_INS, ...REUSE_CLAUSES, ...ITEM_REFERENCES, ...ITEM_STATES, ...COLON_LABELS, ...RESTRICTION_WORDS,
    ...LATER_REFERENCES, ...LATER_CHOICES, ...RUN_IN_PARAGRAPHS,
  ];

  // Round 8: the examples and controls of the round-7 reviews' findings (layout F1–F6, grammar F1–F8), with the fixed reading.
  const PLATE24 = '_Armor (Plate Armor), Rare (Requires Attunement)_';
  const PLATE14 = '*Armor (plate), rare (requires attunement)*';
  const LONGSWORD24 = '_Weapon (Longsword), Rare (Requires Attunement)_';
  const LONGSWORD14 = '*Weapon (longsword), rare (requires attunement)*';
  const CLOAK24 = 'While you wear this cloak, you have a +1 bonus to Armor Class.';
  const CLOAK14 = 'While wearing this cloak, you gain a +1 bonus to AC.';
  const SH24 = 'While holding this Shield, you have a +2 bonus to Armor Class.';
  const PL24 = 'While you wear this armor, you have a +1 bonus to Armor Class.';
  const PL14 = 'You have a +1 bonus to AC while you wear this armor.';

  /** Layout F1: a failing heading or bold line governs past a list item's second paragraph, or any plain line between bullets. */
  const kelpList = (lead: string, between = '  This Resistance ends if you leave the water.') =>
    t24(`This cloak is woven from kelp.\n\n${lead}\n\n- You have Resistance to Cold damage.\n\n${between}\n\n- You have a +1 bonus to Armor Class.`);
  const MARKERS = ['\\column', '\\page', '---', '![kelp](kelp.png)', '<!-- art -->', '{{note}}', '<br>', '&nbsp;'];
  const LIST_PARAGRAPHS: Row[] = [
    ['"#### Underwater" over a list, an item\'s indented second paragraph', kelpList('#### Underwater'), null, true, 'Cloak of the Deep'],
    ['"**While Raging**" over a list, an item\'s indented second paragraph', kelpList('**While Raging**'), null, true, 'Cloak of the Deep'],
    ['"#### While Raging" over a list, an item\'s indented second paragraph', kelpList('#### While Raging'), null, true, 'Cloak of the Deep'],
    ['"#### Night Form" over a list, an item\'s indented second paragraph', kelpList('#### Night Form'), null, true, 'Cloak of the Deep'],
    ['"**Underwater**" over a list, an item\'s indented second paragraph', kelpList('**Underwater**'), null, true, 'Cloak of the Deep'],
    ['"#### Underwater" over a list, a plain paragraph between its bullets', kelpList('#### Underwater', 'This Resistance ends if you leave the water.'), null, true, 'Cloak of the Deep'],
    ['"#### Underwater" over a list, a second paragraph, then two more bullets', t24('This cloak has two aspects.\n\n#### Underwater\n\n- You have Resistance to Cold damage.\n\n  This Resistance ends if you leave the water.\n\n- You can breathe water.\n- You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"#### Underwater" over a numbered list, an item\'s second paragraph', t24('This cloak has two aspects.\n\n#### Underwater\n\n1. You have Resistance to Cold damage.\n\n   This Resistance ends if you leave the water.\n\n2. You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"#### Underwater" over a "*" list, an item\'s second paragraph', t24('This cloak has two aspects.\n\n#### Underwater\n\n* You have Resistance to Cold damage.\n\n  This Resistance ends if you leave the water.\n\n* You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"#### Underwater" over run-ins, a run-in\'s second paragraph', t24('This cloak has two aspects.\n\n#### Underwater\n\n_**Deep Sight.**_ You can see in Darkness out to 60 feet.\n\nYour eyes glow a faint blue while you use this benefit.\n\n_**Pressure Ward.**_ You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ['"#### Underwater" over a list of run-ins, an item\'s second paragraph', t24('This cloak has two aspects.\n\n#### Underwater\n\n- _**Gills.**_ You can breathe water.\n\n  This Resistance ends if you leave the water.\n\n- _**Ward.**_ You have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Deep'],
    ...MARKERS.map((m): Row => [`"#### Underwater" over a list, "${m}" between its bullets`, kelpList('#### Underwater', m), null, true, 'Cloak of the Deep']),
    ...MARKERS.map((m): Row => [`"**Underwater**" over a list, "${m}" between its bullets`, kelpList('**Underwater**', m), null, true, 'Cloak of the Deep']),
    // The layout review's flowing-book item: a bullet of two sentences, then an indented second paragraph.
    ['"#### Underwater" over a list, a bullet of two sentences and a second paragraph', t24("This cloak is woven from kelp and smells of the sea.\n\n#### Underwater\n\n- You have Resistance to Cold damage. This Resistance ends if you leave the water.\n\n  You also can't drown while you wear the cloak.\n\n- You have a +1 bonus to Armor Class."), null, true, 'Cloak of the Kelp Court'],
    // Controls: a failing colon or no-comma intro over the same lists (O5).
    ['"While raging:" over a list, "\\column" between its bullets (control)', kelpList('While raging:', '\\column'), null, true, 'Cloak of the Deep'],
    ['"While raging you gain these benefits." over a list, an item\'s second paragraph (control)', kelpList('While raging you gain these benefits.'), null, true, 'Cloak of the Deep'],
  ];

  /** Layout F2: the same lists under a no-armor heading or intro keep the no-armor condition for the AC bonus after the second paragraph. */
  const openHand = (lead: string, between: string | null = "  This benefit doesn't stack with Evasion.") =>
    t24(`These bracers are made of hardened leather.\n\n${lead}\n\n- You have Advantage on Dexterity saving throws.\n\n${between === null ? '' : `${between}\n\n`}- You have a +2 bonus to Armor Class.`);
  const NO_ARMOR_LISTS: Row[] = [
    ['"#### While Wearing No Armor" over a list, an item\'s second paragraph', openHand('#### While Wearing No Armor'), { ac: 2, acOnlyWhen: 'no-armor' }, false, 'Bracers of the Open Hand'],
    ['"If you wear no armor and use no Shield:" over a list, an item\'s second paragraph', openHand('If you wear no armor and use no Shield:'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false, 'Bracers of the Open Hand'],
    ['"While wearing no armor:" over a list, an item\'s second paragraph', openHand('While wearing no armor:'), { ac: 2, acOnlyWhen: 'no-armor' }, false, 'Bracers of the Open Hand'],
    ['"#### While Wearing No Armor" over a list, a plain paragraph between its bullets', openHand('#### While Wearing No Armor', "This benefit doesn't stack with Evasion."), { ac: 2, acOnlyWhen: 'no-armor' }, false, 'Bracers of the Open Hand'],
    ['"#### While Wearing No Armor" over a list, "\\column" between its bullets', openHand('#### While Wearing No Armor', '\\column'), { ac: 2, acOnlyWhen: 'no-armor' }, false, 'Bracers of the Open Hand'],
    ['"If you wear no armor and use no Shield:" over a list, "\\column" between its bullets', openHand('If you wear no armor and use no Shield:', '\\column'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false, 'Bracers of the Open Hand'],
    ['"#### While Wearing No Armor" over a list (control: no second paragraph)', openHand('#### While Wearing No Armor', null), { ac: 2, acOnlyWhen: 'no-armor' }, false, 'Bracers of the Open Hand'],
    ['"If you wear no armor and use no Shield:" over a list (control: no second paragraph)', openHand('If you wear no armor and use no Shield:', null), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false, 'Bracers of the Open Hand'],
  ];

  /**
   * Layout F3: an always-on bonus paragraph, then an SRD 5.2.1 paragraph that refers to its own effect, property or magic (only a
   * reference to a bonus reaches back from later in a paragraph). LATER_REFERENCES above holds round 6's M1a–c.
   */
  const SRD_ITEMS = (JSON.parse(compendiumRaw) as CompendiumEntry[]).filter((e) => e.kind === 'magic-item');
  /** An SRD 5.2.1 magic item's type line and the paragraph of its text that holds `words` (if given), verbatim. */
  const srd = (name: string, words = '') => {
    const paragraphs = SRD_ITEMS.find((e) => e.name === name)?.text.split(/\n\s*\n/) ?? [];
    const paragraph = paragraphs.slice(1).find((p) => p.includes(words));
    if (!paragraph) throw new Error(`no "${words}" in SRD ${name}`);
    return { type: paragraphs[0], paragraph };
  };
  const SRD_BONUS = 'You have a +1 bonus to Armor Class and saving throws.';
  const FOLLOWED: [string, string][] = [
    ['Cloak of Invisibility', 'The effect ends early if you pull the hood down'],
    ['Cloak of Displacement', 'the property ceases to function until the start of your next turn'],
    ['Gauntlets of Ogre Power', 'They have no effect on you if your Strength is 19 or higher'],
    ['Potion of Invisibility', 'The effect ends early if you make an attack roll'],
    ['Animated Shield', 'until you take a Bonus Action to end this effect'],
    ['Wings of Flying', 'until you end the effect early as a Magic action'],
    ['Ring of Free Action', 'magic can neither reduce any of your Speeds'],
    ['Boots of Speed', 'If you click your heels together again, you end the effect'],
    ['Crystal Ball of Mind Reading', 'but it ends if the _Scrying_ spell ends'],
    ['Crystal Ball of Telepathy', 'but it ends if _Scrying_ ends'],
    ['Dancing Sword', 'It also ceases to hover if you grasp it'],
    ['Dust of Sneezing and Choking', 'The effect also ends on any creature'],
    ['Oil of Etherealness', 'gains the effect of the _Etherealness_ spell'],
    ['Oil of Slipperiness', 'gains the effect of the _Freedom of Movement_ spell'],
    ['Ring of Shooting Stars', 'You can expend its charges to use the properties below'],
    ['Staff of Swarming Insects', 'disperses the swarm and ends the effect'],
  ];
  const withSrd = (name: string, words: string, after = '') => {
    const { type, paragraph } = srd(name, words);
    return `${type}\n\n${SRD_BONUS}\n\n${paragraph}${after}`;
  };
  const SRD_FOLLOWERS: Row[] = [
    ...FOLLOWED.map(([name, words]): Row => [`an always-on bonus, then SRD ${name}'s "${words}…" paragraph`, withSrd(name, words), { ac: 1, savingThrows: 1 }, false, name]),
    // The layout review's flowing-book item, and the fixer's and the column sweep's invented forms.
    ['"…while you wear this cloak.", then SRD Cloak of Invisibility\'s paragraph under another name', t24(`You have a +1 bonus to Armor Class and saving throws while you wear this cloak.\n\n${srd('Cloak of Invisibility', 'The effect ends early').paragraph}`), { ac: 1, savingThrows: 1 }, false, 'Cloak of the Hooded Ward'],
    ['"You can cast Light with it. The effect lasts 1 hour." in the next paragraph', t24(`${CLOAK24}\n\nYou can cast Light with it. The effect lasts 1 hour.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"As a magic action, you can turn invisible. The effect lasts 1 minute." in the next paragraph', t24(`${CLOAK24}\n\nAs a magic action, you can turn invisible. The effect lasts 1 minute.`), { ac: 1 }, false, 'Cloak of the Fen'],
    // Controls: a reference to a bonus still reaches back from anywhere in a paragraph with no bonus of its own (M1a–c).
    ['SRD Gauntlets of Ogre Power\'s paragraph, then "These bonuses apply only while…" (control)', withSrd('Gauntlets of Ogre Power', 'They have no effect', ' These bonuses apply only while you are in Dim Light or Darkness.'), null, true, 'Gauntlets of Ogre Power'],
    ['SRD Cloak of Invisibility\'s paragraph, then "The bonus doesn\'t apply in sunlight." (control)', withSrd('Cloak of Invisibility', 'The effect ends early', " The bonus doesn't apply in sunlight."), null, true, 'Cloak of Invisibility'],
    ['SRD Ring of Free Action\'s paragraph, then "The bonus applies only in Dim Light or Darkness." (control)', withSrd('Ring of Free Action', 'magic can neither', ' The bonus applies only in Dim Light or Darkness.'), null, true, 'Ring of Free Action'],
  ];

  /** Layout F4: three SRD 5.2.1 sentences that don't restrict the item (spent uses, a preposition's object, a leading If-clause's item), and conditional controls. */
  const SRD_WORDS: [string, string][] = [
    ['Chime of Opening', 'After the tenth time, it cracks and becomes useless.'],
    ['Sending Stones', 'If one of the stones in a pair is destroyed, the other one becomes nonmagical.'],
    ['Mysterious Deck', 'Any cards drawn in excess of this number have no effect.'],
    // The layout review's variants of each.
    ['Chime of Opening', 'It cracks and becomes useless.'],
    ['Chime of Opening', 'After the tenth time, it becomes useless.'],
    ['Chime of Opening', 'After the tenth time, the chime cracks and becomes useless.'],
    ['Chime of Opening', 'After the tenth use, it crumbles to dust.'],
    ['Chime of Opening', 'After the tenth time, it becomes a nonmagical chime.'],
    ['Sending Stones', 'If one stone is destroyed, the other one becomes nonmagical.'],
    ['Sending Stones', 'If one of the stones in a pair is destroyed, the other one becomes a nonmagical stone.'],
    ['Sending Stones', 'If one of the stones is destroyed, the other one is destroyed too.'],
    ['Mysterious Deck', 'Cards drawn in excess of this number have no effect.'],
    ['Mysterious Deck', 'Extra cards have no effect.'],
  ];
  const SRD_SENTENCES: Row[] = [
    ...SRD_WORDS.flatMap(([name, words]): Row[] => {
      const { type } = srd(name);
      return [
        [`SRD ${name}: "${words}" after the bonus`, `${type}\n\n${SRD_BONUS} ${words}`, { ac: 1, savingThrows: 1 }, false, name],
        [`SRD ${name}: "${words}" in the next paragraph`, `${type}\n\n${SRD_BONUS}\n\n${words}`, { ac: 1, savingThrows: 1 }, false, name],
      ];
    }),
    ...SRD_WORDS.slice(0, 3).map(([name, words]): Row => [`an always-on bonus, then SRD ${name}'s whole paragraph`, withSrd(name, words), { ac: 1, savingThrows: 1 }, false, name]),
    // In an invented cloak: a use count before a permanent loss, and an object of "in excess of", hold.
    ['"After the tenth time, it cracks and becomes useless." (a cloak)', t24(`${CLOAK24} After the tenth time, it cracks and becomes useless.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"After its third use, the cloak becomes useless."', t24(`${CLOAK24} After its third use, the cloak becomes useless.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"Any cloaks woven in excess of this number have no effect."', t24(`${CLOAK24} Any cloaks woven in excess of this number have no effect.`), { ac: 1 }, false, 'Cloak of the Fen'],
    // Controls: charges, a time, damage, a pair's part, a condition or "only" still restrict.
    ['"Once its charges are spent, it becomes useless." (control)', t24(`${CLOAK24} Once its charges are spent, it becomes useless.`), null, true, 'Cloak of the Fen'],
    ['"When its last charge is expended, it becomes useless until it regains a charge." (control)', t24(`${CLOAK24} When its last charge is expended, it becomes useless until it regains a charge.`), null, true, 'Cloak of the Fen'],
    ['"After the first hour, the cloak becomes powerless." (control)', t24(`${CLOAK24} After the first hour, the cloak becomes powerless.`), null, true, 'Cloak of the Fen'],
    ['"After you take damage, the cloak becomes useless." (control)', t24(`${CLOAK24} After you take damage, the cloak becomes useless.`), null, true, 'Cloak of the Fen'],
    ['"If one of the clasps in a pair is torn, the cloak becomes powerless." (control)', t24(`${CLOAK24} If one of the clasps in a pair is torn, the cloak becomes powerless.`), null, true, 'Cloak of the Fen'],
    ['"If the cloak is in sunlight, it becomes powerless." (control)', t24(`${CLOAK24} If the cloak is in sunlight, it becomes powerless.`), null, true, 'Cloak of the Fen'],
    ['"Each of these cloaks works only at night." (control)', t24(`${CLOAK24} Each of these cloaks works only at night.`), null, true, 'Cloak of the Fen'],
    ['"In excess of three charges, the cloak has no effect." (control)', t24(`${CLOAK24} In excess of three charges, the cloak has no effect.`), null, true, 'Cloak of the Fen'],
    // Controls: spent uses excuse only a state, never a condition, a negation or "only" beside it (restrictsItem's `spent` and `condition`).
    ['"After the tenth time, the cloak becomes useless in sunlight." (control)', t24(`${CLOAK24} After the tenth time, the cloak becomes useless in sunlight.`), null, true, 'Cloak of the Fen'],
    ['"After the tenth use, the shield doesn\'t protect you from ranged attacks." (control)', t24(`${SH24} After the tenth use, the shield doesn't protect you from ranged attacks.`, SHIELD24), null, true, 'Raven Shield'],
    ['"After the tenth time, the cloak doesn\'t function." (control)', t24(`${CLOAK24} After the tenth time, the cloak doesn't function.`), null, true, 'Cloak of the Fen'],
    ['"After the tenth time, the cloak works only at night." (control)', t24(`${CLOAK24} After the tenth time, the cloak works only at night.`), null, true, 'Cloak of the Fen'],
  ];

  /** Layout F5: a colon line that is only a label with no condition holds, as the same label alone does. */
  const grayList = (lead: string) => t24(`This cloak is woven from gray wool.\n\n${lead}\n\n- You have a +1 bonus to Armor Class.\n- You have Resistance to Cold damage.`);
  const COLON_LABEL_LINES: Row[] = [
    ...['Benefits:', 'Properties:', 'Magical Properties:', 'Effects:', 'Abilities:', 'Attuned Benefits:', '**Benefits:**', 'Benefits'].map((lead): Row => [`"${lead}" over a list`, grayList(lead), { ac: 1 }, false, 'Cloak of the Gray Ward']),
    ['"While attuned:" over a list (control)', grayList('While attuned:'), { ac: 1 }, false, 'Cloak of the Gray Ward'],
    ['"While raging:" over a list (control)', grayList('While raging:'), null, true, 'Cloak of the Gray Ward'],
  ];

  /** Layout F6, as a paragraph: a label alone that names a condition governs its own text only, up to the next run-in. */
  const LABEL_ALONE_TEXTS: Row[] = [
    ['"Night Sight." alone, its text, then "Ward. While you wear…"', t24('This cloak is woven from shadow and smells of smoke.\n\nNight Sight.\n\nYou can see in Darkness out to 60 feet.\n\nWard. While you wear this cloak, you have a +1 bonus to Armor Class.'), { ac: 1 }, false, 'Cloak of Dusk'],
    ['"Underwater Breathing." alone, its text, then "Ward. You have…"', t24('This cloak is woven from shadow and smells of smoke.\n\nUnderwater Breathing.\n\nYou can breathe water.\n\nWard. You have a +1 bonus to Armor Class.'), { ac: 1 }, false, 'Cloak of Dusk'],
  ];

  /** Grammar F1: a limit that shares its clause with a reuse limit (", after which", ", at which point", "and then", an aside) is still a limit. */
  const JOINED: [string, string][] = [
    ['", after which it can\'t be used again"', "The bonus ends when you are Bloodied, after which it can't be used again until the next dawn."],
    ['"…and then can\'t be used again"', "The bonus lasts until you are Bloodied and then can't be used again until the next dawn."],
    ['"This benefit, which ends when…, can\'t be used again"', "This benefit, which ends when you are Bloodied, can't be used again until the next dawn."],
    ['", at which point it can\'t be used again"', "This bonus lasts until you are Bloodied, at which point it can't be used again until the next dawn."],
    ['"…this benefit ends and then can\'t be used again"', "If you are Bloodied, this benefit ends and then can't be used again until the next dawn."],
    ['", after which you can\'t use it again"', "The bonus ends early if you are Bloodied, after which you can't use it again until you finish a Long Rest."],
    ['"…the bonus ends, after which it can\'t be used again"', "When you are Bloodied, the bonus ends, after which it can't be used again until the next dawn."],
    ['"The protection fails … and then can\'t be used again"', "The protection fails when you are Bloodied and then can't be used again until the next dawn."],
  ];
  const JOINED14: [string, string][] = [
    ['", after which it can\'t be used again"', "The bonus ends when you drop below half your hit point maximum, after which it can't be used again until the next dawn."],
    ['"…and then can\'t be used again"', "This benefit lasts until you are reduced to 0 hit points and then can't be used again until the next dawn."],
    ['"This benefit, which ends if …, can\'t be used again"', "This benefit, which ends if you fall unconscious, can't be used again until the next dawn."],
  ];
  const REUSE_JOINS: Row[] = [
    ...JOINED.flatMap(([what, limit]): Row[] => [
      [`${what} in the next sentence`, t24(`${CLOAK24} ${limit}`), null, true, 'Cloak of the Fen'],
      [`${what} in the next paragraph`, t24(`${CLOAK24}\n\n${limit}`), null, true, 'Cloak of the Fen'],
    ]),
    ...JOINED14.flatMap(([what, limit]): Row[] => [
      [`${what} in the next sentence (2014)`, t14(`${CLOAK14} ${limit}`), null, true, 'Cloak of the Fen'],
      [`${what}, the ring's protection (2014)`, t14(`You gain a +1 bonus to AC and saving throws while wearing this ring. ${limit.replace(/The bonus|This benefit/, "The ring's protection")}`, RING14), null, true, 'Ring of the Reed'],
    ]),
    ['"…, but the bonus ends when …, after which it can\'t be used again" in the bonus\'s sentence', t24("While you wear this cloak, you have a +1 bonus to Armor Class, but the bonus ends when you are Bloodied, after which it can't be used again until the next dawn."), null, true, 'Cloak of the Fen'],
    ['"…; this bonus ends when you take a Critical Hit, after which…" in the bonus\'s sentence', t24("While holding this Shield, you have a +2 bonus to Armor Class; this bonus ends when you take a Critical Hit, after which it can't be used again until you finish a Long Rest.", SHIELD24), null, true, 'Raven Shield'],
    ['"…, which lasts until you fail a save and then can\'t be used again" in the bonus\'s sentence', t24("While you wear this ring, you have a +1 bonus to saving throws, which lasts until you fail a save and then can't be used again until the next dawn.", RING24), null, true, 'Ring of the Reed'],
    ['"…, but it ends when you are Bloodied, after which you can\'t use it again" in the bonus\'s sentence', t24("While you wear this cloak, you have a +1 bonus to Armor Class, but it ends when you are Bloodied, after which you can't use it again until the next dawn."), null, true, 'Cloak of the Fen'],
    ['"The bonus is suppressed while you are raging, after which this property…" (2014)', t14("You have a +1 bonus to AC while you wear this armor. The bonus is suppressed while you are raging, after which this property can't be used again until you finish a long rest.", PLATE14), null, true, 'Warden Plate'],
    ['"…, the cloak loses its magic, after which it can\'t be used again" (2014)', t14(`${CLOAK14} If you drop to 0 hit points, the cloak loses its magic, after which it can't be used again until the next dawn.`), null, true, 'Cloak of the Fen'],
    ['"The ring\'s magic fails if …, after which it can\'t be used again" (2014)', t14("You gain a +1 bonus to AC and saving throws while wearing this ring. The ring's magic fails if you drop to 0 hit points, after which it can't be used again until the next dawn.", RING14), null, true, 'Ring of the Reed'],
    // Controls: the limit joined with ", and", and reuse limits alone.
    ['"When you are Bloodied, the cloak stops working, and it can\'t be used again…" (control)', t24(`${CLOAK24} When you are Bloodied, the cloak stops working, and it can't be used again until the next dawn.`), null, true, 'Cloak of the Fen'],
    ['"When you are Bloodied, the bonus ends, and it can\'t be used again…" (control)', t24(`${CLOAK24} When you are Bloodied, the bonus ends, and it can't be used again until the next dawn.`), null, true, 'Cloak of the Fen'],
    ['"You can cast Fly from the cloak, after which it can\'t be used this way again…" (control)', t24(`${CLOAK24} You can cast Fly from the cloak, after which it can't be used this way again until the next dawn.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"…; once used, this property can\'t be used again…" (control)', t24(`${CLOAK24} As a Magic action, you can turn Invisible; once used, this property can't be used again until the next dawn.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"Once you use the cloak to cast Fly, you can\'t do so again…" (control)', t24(`${CLOAK24} Once you use the cloak to cast Fly, you can't do so again until the next dawn.`), { ac: 1 }, false, 'Cloak of the Fen'],
  ];

  /** Grammar F2: a negated protect, help, apply or extend scoped to attacks, hits, rolls, saves, spells or a kind of creature restricts. */
  const SCOPED_NEGATIONS: Row[] = [
    ['"The shield doesn\'t protect you from ranged attacks."', t24(`${SH24} The shield doesn't protect you from ranged attacks.`, SHIELD24), null, true, 'Raven Shield'],
    ['"The shield doesn\'t protect you from ranged attacks." (2014)', t14("While holding this shield, you gain a +2 bonus to AC. The shield doesn't protect you from ranged attacks.", SHIELD14), null, true, 'Raven Shield'],
    ['"…, but the shield doesn\'t protect you from ranged attacks." (2014)', t14("While holding this shield, you gain a +2 bonus to AC, but the shield doesn't protect you from ranged attacks.", SHIELD14), null, true, 'Raven Shield'],
    ['"…, but the shield doesn\'t protect you from ranged attacks." in the bonus\'s sentence', t24("While holding this Shield, you have a +2 bonus to Armor Class, but the shield doesn't protect you from ranged attacks.", SHIELD24), null, true, 'Raven Shield'],
    ['"…, though it doesn\'t protect you from ranged attacks." (2014)', t14("You gain a +2 bonus to AC while you wield this shield, though it doesn't protect you from ranged attacks.", SHIELD14), null, true, 'Raven Shield'],
    ['"The shield doesn\'t protect you from ranged attacks, however."', t24(`${SH24} The shield doesn't protect you from ranged attacks, however.`, SHIELD24), null, true, 'Raven Shield'],
    ['"The shield doesn\'t protect you from attacks made by Undead."', t24(`${SH24} The shield doesn't protect you from attacks made by Undead.`, SHIELD24), null, true, 'Raven Shield'],
    ['"The shield doesn\'t protect you from attacks from behind."', t24(`${SH24} The shield doesn't protect you from attacks from behind.`, SHIELD24), null, true, 'Raven Shield'],
    ['"This bonus doesn\'t protect you from ranged attacks."', t24(`${SH24} This bonus doesn't protect you from ranged attacks.`, SHIELD24), null, true, 'Raven Shield'],
    ['"The cloak doesn\'t protect you from attacks you can\'t see."', t24(`${CLOAK24} The cloak doesn't protect you from attacks you can't see.`), null, true, 'Cloak of the Fen'],
    ['"The cloak doesn\'t protect you from attacks by creatures you can\'t see."', t24(`${CLOAK24} The cloak doesn't protect you from attacks by creatures you can't see.`), null, true, 'Cloak of the Fen'],
    ['"The cloak doesn\'t protect you from melee attacks."', t24(`${CLOAK24} The cloak doesn't protect you from melee attacks.`), null, true, 'Cloak of the Fen'],
    ['"The cloak doesn\'t protect you from spells."', t24(`${CLOAK24} The cloak doesn't protect you from spells.`), null, true, 'Cloak of the Fen'],
    ['"The cloak won\'t protect you from Dragons."', t24(`${CLOAK24} The cloak won't protect you from Dragons.`), null, true, 'Cloak of the Fen'],
    ['"The armor doesn\'t protect you from Opportunity Attacks."', t24(`${PL24} The armor doesn't protect you from Opportunity Attacks.`, PLATE24), null, true, 'Warden Plate'],
    ['"The armor doesn\'t protect you from critical hits." (2014)', t14(`${PL14} The armor doesn't protect you from critical hits.`, PLATE14), null, true, 'Warden Plate'],
    ['"The armor\'s magic doesn\'t protect you from critical hits." (2014)', t14(`${PL14} The armor's magic doesn't protect you from critical hits.`, PLATE14), null, true, 'Warden Plate'],
    ['"The ring doesn\'t help you on Death Saving Throws."', t24("While you wear this ring, you have a +1 bonus to saving throws. The ring doesn't help you on Death Saving Throws.", RING24), null, true, 'Ring of the Reed'],
    ['"…, but the ring doesn\'t help you on death saving throws." (2014)', t14("You gain a +1 bonus to saving throws while wearing this ring, but the ring doesn't help you on death saving throws.", RING14), null, true, 'Ring of the Reed'],
    ['"The ring doesn\'t apply to Death Saving Throws."', t24("While you wear this ring, you have a +1 bonus to saving throws. The ring doesn't apply to Death Saving Throws.", RING24), null, true, 'Ring of the Reed'],
    ['"This bonus doesn\'t apply to Death Saving Throws."', t24("While you wear this ring, you have a +1 bonus to saving throws. This bonus doesn't apply to Death Saving Throws.", RING24), null, true, 'Ring of the Reed'],
    ['"The ring\'s bonus doesn\'t apply to Death Saving Throws."', t24("While you wear this ring, you have a +1 bonus to saving throws. The ring's bonus doesn't apply to Death Saving Throws.", RING24), null, true, 'Ring of the Reed'],
    ['"The weapon doesn\'t help you against Constructs."', t24("You have a +1 bonus to attack rolls and damage rolls made with this magic weapon. The weapon doesn't help you against Constructs.", LONGSWORD24), null, true, 'Sword of Dusk'],
    ['"The cloak\'s protection doesn\'t extend to ranged attacks, but while you wear it, …"', t24("The cloak's protection doesn't extend to ranged attacks, but while you wear it, you have a +1 bonus to Armor Class."), null, true, 'Cloak of the Fen'],
    // Controls: a damage type is no scope; a scope with "against" already was one; references that limit nothing.
    ['"The cloak doesn\'t protect you from Psychic damage." (control)', t24(`${CLOAK24} The cloak doesn't protect you from Psychic damage.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"The cloak doesn\'t protect you from falling damage." (control)', t24(`${CLOAK24} The cloak doesn't protect you from falling damage.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"The armor can\'t be damaged by nonmagical weapons." (control)', t24(`${PL24} The armor can't be damaged by nonmagical weapons.`, PLATE24), { ac: 1 }, false, 'Warden Plate'],
    ['"The cloak doesn\'t help you against ranged attacks." (control)', t24(`${CLOAK24} The cloak doesn't help you against ranged attacks.`), null, true, 'Cloak of the Fen'],
    ['"The cloak\'s magic can\'t be dispelled, and while you wear it, …" (control)', t24("The cloak's magic can't be dispelled, and while you wear it, you have a +1 bonus to Armor Class."), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"The cloak\'s magic protects you, and while you wear it, …" (control)', t24("The cloak's magic protects you, and while you wear it, you have a +1 bonus to Armor Class."), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"The cloak\'s protection is constant, and while you wear it, …" (control)', t24("The cloak's protection is constant, and while you wear it, you have a +1 bonus to Armor Class."), { ac: 1 }, false, 'Cloak of the Fen'],
  ];

  /** Grammar F3: the item's state with "functions/acts/counts/behaves as", "is treated as", a "-ly" adverb, "all but", "as … as" or "a mere". */
  const STATE_FORMS: Row[] = [
    ['"In sunlight, the cloak functions as a nonmagical cloak."', t24(`${CLOAK24} In sunlight, the cloak functions as a nonmagical cloak.`), null, true, 'Cloak of the Fen'],
    ['"In sunlight, the cloak functions as a nonmagical cloak." (2014)', t14('You gain a +1 bonus to AC while you wear this cloak. In sunlight, the cloak functions as a nonmagical cloak.'), null, true, 'Cloak of the Fen'],
    ['"In sunlight, the cloak acts as a nonmagical cloak."', t24(`${CLOAK24} In sunlight, the cloak acts as a nonmagical cloak.`), null, true, 'Cloak of the Fen'],
    ['"Underwater, the cloak counts as a nonmagical cloak."', t24(`${CLOAK24} Underwater, the cloak counts as a nonmagical cloak.`), null, true, 'Cloak of the Fen'],
    ['"In sunlight, the cloak behaves as an ordinary cloak."', t24(`${CLOAK24} In sunlight, the cloak behaves as an ordinary cloak.`), null, true, 'Cloak of the Fen'],
    ['"Underwater, the ring is magically inert."', t24('While you wear this ring, you have a +1 bonus to Armor Class and saving throws. Underwater, the ring is magically inert.', RING24), null, true, 'Ring of the Reed'],
    ['"While you are raging, the armor is magically inert."', t24(`${PL24} While you are raging, the armor is magically inert.`, PLATE24), null, true, 'Warden Plate'],
    ['"The cloak is magically inert in sunlight."', t24(`${CLOAK24} The cloak is magically inert in sunlight.`), null, true, 'Cloak of the Fen'],
    ['"In Bright Light, the cloak is all but useless."', t24(`${CLOAK24} In Bright Light, the cloak is all but useless.`), null, true, 'Cloak of the Fen'],
    ['"The cloak is treated as nonmagical while you are in sunlight."', t24(`${CLOAK24} The cloak is treated as nonmagical while you are in sunlight.`), null, true, 'Cloak of the Fen'],
    ['"While you are raging, the armor counts as nonmagical armor." (2014)', t14(`${PL14} While you are raging, the armor counts as nonmagical armor.`, PLATE14), null, true, 'Warden Plate'],
    ['"In sunlight, the sword acts as a nonmagical Longsword."', t24('You have a +1 bonus to attack rolls and damage rolls made with this magic weapon. In sunlight, the sword acts as a nonmagical Longsword.', LONGSWORD24), null, true, 'Sword of Dusk'],
    ['"Against Constructs, the sword functions as a nonmagical weapon." (2014)', t14('You gain a +1 bonus to attack and damage rolls made with this magic weapon. Against Constructs, the sword functions as a nonmagical weapon.', LONGSWORD14), null, true, 'Sword of Dusk'],
    ['"In sunlight, the cloak is nearly powerless."', t24(`${CLOAK24} In sunlight, the cloak is nearly powerless.`), null, true, 'Cloak of the Fen'],
    ['"In sunlight, the cloak is as powerless as any other cloak." (2014)', t14(`${CLOAK14} In sunlight, the cloak is as powerless as any other cloak.`), null, true, 'Cloak of the Fen'],
    ['"The cloak is utterly and completely powerless in sunlight."', t24(`${CLOAK24} The cloak is utterly and completely powerless in sunlight.`), null, true, 'Cloak of the Fen'],
    ['"In sunlight, the cloak is a mere nonmagical cloak."', t24(`${CLOAK24} In sunlight, the cloak is a mere nonmagical cloak.`), null, true, 'Cloak of the Fen'],
    // Controls: the copula forms are read; a state word in a by-phrase or an object is none.
    ['"The cloak is powerless in sunlight." (control)', t24(`${CLOAK24} The cloak is powerless in sunlight.`), null, true, 'Cloak of the Fen'],
    ['"In sunlight, the cloak becomes a nonmagical cloak." (control)', t24(`${CLOAK24} In sunlight, the cloak becomes a nonmagical cloak.`), null, true, 'Cloak of the Fen'],
    ['"The shield can\'t be damaged by nonmagical means." (control)', t24(`${SH24} The shield can't be damaged by nonmagical means.`, SHIELD24), { ac: 2 }, false, 'Raven Shield'],
  ];

  /** Grammar F4: a concession or an always-on phrase stacked after an always-on opening holds ("even when…", "at all times", "whether or not…"). */
  const stackedOn = (lead: string, first = 'your steps make no sound') => t24(`While you wear this cloak, ${lead}, ${first}, and you have a +1 bonus to Armor Class.`);
  const CONCESSIONS: Row[] = [
    ['"…, even when you are Unconscious, your steps make no sound, and …"', stackedOn('even when you are Unconscious'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"…, even underwater, your steps make no sound, and …"', stackedOn('even underwater'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"…, even in sunlight, shadows cling to you, and …"', stackedOn('even in sunlight', 'shadows cling to you'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"…, at all times, shadows cling to you, and …"', stackedOn('at all times', 'shadows cling to you'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"…, whether or not you are Bloodied, shadows cling to you, and …"', stackedOn('whether or not you are Bloodied', 'shadows cling to you'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"…, in any light, shadows cling to you, and …"', stackedOn('in any light', 'shadows cling to you'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"…, even while you sleep, you can\'t be surprised, and …"', stackedOn('even while you sleep', "you can't be surprised"), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"…, even though you are Bloodied, your steps make no sound, and …"', stackedOn('even though you are Bloodied'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"…, even at night, your skin glows faintly, and …" (a ring)', t24('While you wear this ring, even at night, your skin glows faintly, and you have a +1 bonus to Armor Class and saving throws.', RING24), { ac: 1, savingThrows: 1 }, false, 'Ring of the Reed'],
    ['"…, even while asleep, you can\'t be surprised, and …" (2014)', t14("While wearing this cloak, even while asleep, you can't be surprised, and you gain a +1 bonus to AC."), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"…, day or night, shadows cling to you, and …"', stackedOn('day or night', 'shadows cling to you'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"…, awake or asleep, your steps make no sound, and …"', stackedOn('awake or asleep'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"…, as long as you are attuned to it, shadows cling to you, and …"', stackedOn('as long as you are attuned to it', 'shadows cling to you'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"…, while it is attuned to you, shadows cling to you, and …"', stackedOn('while it is attuned to you', 'shadows cling to you'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"…, in turn, shadows cling to you, and …"', stackedOn('in turn', 'shadows cling to you'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"…, in addition to its other properties, shadows cling to you, and …"', stackedOn('in addition to its other properties', 'shadows cling to you'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"…, no matter the weather, your steps make no sound, and …"', stackedOn('no matter the weather'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"…, regardless of the light, shadows cling to you, and …"', stackedOn('regardless of the light', 'shadows cling to you'), { ac: 1 }, false, 'Cloak of the Fen'],
    // Controls: G2's "even if" holds; a condition stacked there doesn't.
    ['"…, even if you are Unconscious, your steps make no sound, and …" (control)', stackedOn('even if you are Unconscious'), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"…, if you are Bloodied, your steps make no sound, and …" (control)', stackedOn('if you are Bloodied'), null, true, 'Cloak of the Fen'],
    ['"…, in battle, it billows dramatically, and …" (control)', stackedOn('in battle', 'it billows dramatically'), null, true, 'Cloak of the Fen'],
    ['"Once you attune to this cloak, at dawn each day, its colors shift, and …" (control)', t24('Once you attune to this cloak, at dawn each day, its colors shift, and you have a +1 bonus to Armor Class.'), null, true, 'Cloak of the Fen'],
  ];

  /** Grammar F5: "choose one of the following …" offers what follows; it isn't a choice among the bonuses before it. */
  const FOLLOWING_OFFERS: Row[] = [
    ['"When you attune to the cloak, choose one of the following properties:" over a list', t24(`${CLOAK24}\n\nWhen you attune to the cloak, choose one of the following properties:\n\n- _Fire._ You have Resistance to Fire damage.\n- _Cold._ You have Resistance to Cold damage.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"…choose one of the following properties: …" in the bonus\'s paragraph', t24(`${CLOAK24} When you attune to the cloak, choose one of the following properties: Resistance to Fire damage or Resistance to Cold damage.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"Each dawn, choose one of the following effects, which lasts until the next dawn:" over a list', t24(`${CLOAK24}\n\nEach dawn, choose one of the following effects, which lasts until the next dawn:\n\n- You can breathe water.\n- You have a Climb Speed equal to your Speed.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"…choose one of the following properties: …" (2014)', t14(`${CLOAK14} When you attune to the cloak, choose one of the following properties: resistance to fire damage or resistance to cold damage.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"When you finish a Long Rest, pick one of the following powers. …"', t24(`${CLOAK24}\n\nWhen you finish a Long Rest, pick one of the following powers. You can use that power once before your next Long Rest.`), { ac: 1 }, false, 'Cloak of the Fen'],
    // Controls: an offer of something else holds; a choice among the bonuses, or among run-ins that hold the bonus, doesn't.
    ['"…, choose one of the following damage types when you attune to the armor: …" (control)', t24(`${PL24} In addition, choose one of the following damage types when you attune to the armor: Acid, Cold, Fire, Lightning, or Thunder. You have Resistance to that damage type.`, PLATE24), { ac: 1 }, false, 'Warden Plate'],
    ['"Choose one of the following benefits." over a run-in with the bonus (control)', t24('Choose one of the following benefits.\n\n_**Ward.**_ While you wear this cloak, you gain a +1 bonus to Armor Class.\n\n_**Shade.**_ You can take the Hide action as a Bonus Action.'), null, true, 'Cloak of the Fen'],
    ['"When you attune to the amulet, choose one of these bonuses." (control)', t24('While you wear this amulet, you have a +1 bonus to Armor Class and a +1 bonus to saving throws. When you attune to the amulet, choose one of these bonuses.'), null, true, 'Amulet of the Fen'],
    ['"Each dawn, choose one of these bonuses to be active until the next dawn." (control)', t24('While you wear this amulet, you have a +1 bonus to Armor Class and a +1 bonus to saving throws. Each dawn, choose one of these bonuses to be active until the next dawn.'), null, true, 'Amulet of the Fen'],
  ];

  /** Grammar F6: a colon run-in label is judged as a label; one with no condition holds. */
  const COLON_RUN_INS: Row[] = [
    ['"**Stealth:** The armor doesn\'t impose Disadvantage…"', t24(`${PL24}\n\n**Stealth:** The armor doesn't impose Disadvantage on Dexterity (Stealth) checks.`, PLATE24), { ac: 1 }, false, 'Warden Plate'],
    ['"_**Care:**_ The cloak never needs to be cleaned."', t24(`${CLOAK24}\n\n_**Care:**_ The cloak never needs to be cleaned.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"***Sentience:*** The cloak can\'t speak, but it can feel your emotions." (2014)', t14(`${CLOAK14}\n\n***Sentience:*** The cloak can't speak, but it can feel your emotions.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"***Sentience:*** The cloak can\'t speak, but…"', t24(`${CLOAK24}\n\n***Sentience:*** The cloak can't speak, but it can feel your emotions.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"_**Attunement:**_ The cloak doesn\'t require a bard to attune to it."', t24(`${CLOAK24}\n\n_**Attunement:**_ The cloak doesn't require a bard to attune to it.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"Lore: The cloak never fades." (the round-7 fixer\'s listed cost)', t24(`${CLOAK24}\n\nLore: The cloak never fades.`), { ac: 1 }, false, 'Cloak of the Fen'],
    // Controls: the period form; a colon label over a restriction of the item.
    ['"_**Care.**_ The cloak never needs to be cleaned." (control)', t24(`${CLOAK24}\n\n_**Care.**_ The cloak never needs to be cleaned.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"_**Weakness:**_ The cloak doesn\'t function in sunlight." (control)', t24(`${CLOAK24}\n\n_**Weakness:**_ The cloak doesn't function in sunlight.`), null, true, 'Cloak of the Fen'],
    ['"***Curse:*** This cloak works only at night." (control, 2014)', t14('While wearing this cloak, you gain a +1 bonus to AC and saving throws.\n\n***Curse:*** This cloak works only at night.'), null, true, 'Cloak of the Fen'],
  ];

  /** Grammar F7: an object restriction needs the wearer as its subject, and no negation or "only" before its verb. */
  const OBJECT_SUBJECTS: Row[] = [
    ['"Other creatures gain no benefit from the cloak."', t24(`${CLOAK24} Other creatures gain no benefit from the cloak.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"A creature that steals the armor gains no benefit from it."', t24(`${PL24} A creature that steals the armor gains no benefit from it.`, PLATE24), { ac: 1 }, false, 'Warden Plate'],
    ['"Creatures other than you gain no benefit from this ring."', t24('While you wear this ring, you have a +1 bonus to saving throws. Creatures other than you gain no benefit from this ring.', RING24), { savingThrows: 1 }, false, 'Ring of the Reed'],
    ['"A thief gains no benefit from the cloak unless it attunes to it." (2014)', t14(`${CLOAK14} A thief gains no benefit from the cloak unless it attunes to it.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"Creatures that touch the shield gain no benefit from it."', t24(`${SH24} Creatures that touch the shield gain no benefit from it.`, SHIELD24), { ac: 2 }, false, 'Raven Shield'],
    ['"Your allies can\'t benefit from this cloak."', t24(`${CLOAK24} Your allies can't benefit from this cloak.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"No mortal magic can render the cloak powerless."', t24(`${CLOAK24} No mortal magic can render the cloak powerless.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"Not even an Antimagic Field renders the cloak powerless."', t24(`${CLOAK24} Not even an Antimagic Field renders the cloak powerless.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"Nothing makes the cloak useless, not even sunlight."', t24(`${CLOAK24} Nothing makes the cloak useless, not even sunlight.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"Only a Wish spell can render the cloak inert."', t24(`${CLOAK24} Only a Wish spell can render the cloak inert.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"Rain never leaves the cloak wet."', t24(`${CLOAK24} Rain never leaves the cloak wet.`), { ac: 1 }, false, 'Cloak of the Fen'],
    // Controls: the wearer gaining no benefit, or the item rendered powerless, in a situation.
    ['"Sunlight renders the cloak powerless." (control)', t24(`${CLOAK24} Sunlight renders the cloak powerless.`), null, true, 'Cloak of the Fen'],
    ['"You gain no benefit from this cloak while you are in sunlight." (control)', t24(`${CLOAK24} You gain no benefit from this cloak while you are in sunlight.`), null, true, 'Cloak of the Fen'],
    ['"Wearing armor or using a Shield renders these bracers useless." (control)', t24('While wearing these bracers, you gain a +2 bonus to Armor Class. Wearing armor or using a Shield renders these bracers useless.'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false, 'Bracers of the Warden'],
    ['"You gain no benefit from these bracers while you wear armor or use a shield." (control, 2014)', t14('While wearing these bracers, you gain a +2 bonus to AC. You gain no benefit from these bracers while you wear armor or use a shield.'), { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false, 'Bracers of the Warden'],
  ];

  /** Grammar F8: J3's backstop reads "only" next to a works-verb or a condition, and not a spell's or a part's failing. */
  const BACKSTOP_WORDS: Row[] = [
    ['"…; the spell doesn\'t work on Undead."', t24(`${CLOAK24} Once per day, you can cast Charm Person from the cloak; the spell doesn't work on Undead.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"…; the spell doesn\'t work on undead." (2014)', t14(`${CLOAK14} Once per day, you can cast charm person from the cloak; the spell doesn't work on undead.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"Dwarven smiths forged this armor only for their kings."', t24(`${PL24} Dwarven smiths forged this armor only for their kings.`, PLATE24), { ac: 1 }, false, 'Warden Plate'],
    ['"Elves weave these cloaks only from moonlit spider silk."', t24(`${CLOAK24} Elves weave these cloaks only from moonlit spider silk.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"Thieves prize this cloak only slightly less than gold."', t24(`${CLOAK24} Thieves prize this cloak only slightly less than gold.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"You will find that this cloak only improves with age."', t24(`${CLOAK24} You will find that this cloak only improves with age.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"The strap doesn\'t work loose."', t24(`${CLOAK24} The strap doesn't work loose.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"Nothing can tear this cloak, and only fire can burn it."', t24(`${CLOAK24} Nothing can tear this cloak, and only fire can burn it.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"Merchants sell such cloaks only in the City of Brass."', t24(`${CLOAK24} Merchants sell such cloaks only in the City of Brass.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"Dragons covet this cloak, and only a dragon\'s fire can harm it."', t24(`${CLOAK24} Dragons covet this cloak, and only a dragon's fire can harm it.`), { ac: 1 }, false, 'Cloak of the Fen'],
    // Controls: the backstop still reads the item working only so.
    ['"The cloak, a relic of the old kings who ruled the north long ago, works only at night." (control)', t24(`${CLOAK24} The cloak, a relic of the old kings who ruled the north long ago, works only at night.`), null, true, 'Cloak of the Fen'],
    ['"Rumor has it that the ring works only for elves." (control)', t24('While you wear this ring, you have a +1 bonus to Armor Class and saving throws. Rumor has it that the ring works only for elves.', RING24), null, true, 'Ring of the Reed'],
  ];
  /**
   * Round 9 (the round-8 re-runs of every review). Layout G1: a colon line that names a condition the run-in label list
   * doesn't know is an intro that doesn't hold; only one that names what follows, or an always-on or no-armor phrase, holds.
   */
  const COLON_CONDITIONS: Row[] = [
    ...['Wild Shape:', 'Versus Fiends:', 'Below Half Hit Points:', 'Enraged:', 'For Druids:', 'On a Hit:', 'By Day:', 'Curse:', 'Polymorphed:'].map((lead): Row => [`"${lead}" over a list`, grayList(lead), null, true, 'Cloak of the Gray Ward']),
    ...['Features:', 'Powers:', 'Traits:', 'Its Powers:', 'While Attuned:'].map((lead): Row => [`"${lead}" over a list (control)`, grayList(lead), { ac: 1 }, false, 'Cloak of the Gray Ward']),
    ['"No Armor:" over a list (control)', grayList('No Armor:'), { ac: 1, acOnlyWhen: 'no-armor' }, false, 'Cloak of the Gray Ward'],
  ];

  /** Layout G2: a heading or a bold line printed plain (no period: not a run-in label a column ended after) keeps its whole range. */
  const deepWard = (lead: string) => t24(`This cloak is woven from kelp.\n\n${lead}\n\nYou can breathe water.\n\n_**Pressure Ward.**_ You have a +1 bonus to Armor Class.`);
  const PLAIN_HEADINGS: Row[] = ['**Underwater**', '**While Raging**', '**Night Form**', '#### Underwater', '#### While Raging'].map((lead): Row => [`"${lead}" over a paragraph, then a run-in bonus`, deepWard(lead), null, true, 'Cloak of the Deep']);

  /**
   * Layout G4, grammar G2: the spent-uses rule takes a lead-in that is only the use count ("After the tenth time"), the
   * leading-If cut only a main clause about the other one ("…, the other one becomes nonmagical"), and the preposition rule
   * not the item's own noun or kind ("A cloak of this kind…", "The threads of this cloak…").
   */
  const NARROWED: [string, string][] = [
    ['"After the first use each day, the cloak becomes powerless."', 'After the first use each day, the cloak becomes powerless.'],
    ['"After its third use in a day, the cloak becomes inert."', 'After its third use in a day, the cloak becomes inert.'],
    ['"Once its uses are spent for the day, the cloak becomes inert."', 'Once its uses are spent for the day, the cloak becomes inert.'],
    ['"After the third time you use it while underwater, the cloak becomes useless."', 'After the third time you use it while underwater, the cloak becomes useless.'],
    ['"After its first use each day, the cloak goes dormant."', 'After its first use each day, the cloak goes dormant.'],
    // Uses that may come back at dawn: not a count of uses for good (fail closed).
    ['"Once its uses are spent, the cloak becomes useless."', 'Once its uses are spent, the cloak becomes useless.'],
    ['"When the cloak is underwater, its clasp goes dark and the cloak becomes powerless."', 'When the cloak is underwater, its clasp goes dark and the cloak becomes powerless.'],
    ['"When the cloak is in sunlight, its threads fade and the cloak becomes an ordinary cloak."', 'When the cloak is in sunlight, its threads fade and the cloak becomes an ordinary cloak.'],
    ['"If the cloak is torn, the tear glows and the cloak has no effect until it is mended."', 'If the cloak is torn, the tear glows and the cloak has no effect until it is mended.'],
    ['"If the cloak is torn, its weave stops working until it is mended."', 'If the cloak is torn, its weave stops working until it is mended.'],
    ['"If the cloak is submerged, the fabric is powerless."', 'If the cloak is submerged, the fabric is powerless.'],
    ['"When the cloak is wet, the garment doesn\'t function."', "When the cloak is wet, the garment doesn't function."],
    ['"Whenever the cloak touches water, its runes stop working."', 'Whenever the cloak touches water, its runes stop working.'],
    ['"Once the cloak is wet, its threads are inert until dawn."', 'Once the cloak is wet, its threads are inert until dawn.'],
    ['"A cloak of this kind works only at night."', 'A cloak of this kind works only at night.'],
    ['"A cloak of this kind doesn\'t function in sunlight."', "A cloak of this kind doesn't function in sunlight."],
    ['"Cloaks of this kind are powerless in sunlight."', 'Cloaks of this kind are powerless in sunlight.'],
    ['"The threads of this cloak unravel and become useless in sunlight."', 'The threads of this cloak unravel and become useless in sunlight.'],
    // The cut before "the other …" drops only the other one's words: the rest of the main clause is still read.
    ['"If the cloak gets wet, the other properties stop working and the cloak becomes powerless."', 'If the cloak gets wet, the other properties stop working and the cloak becomes powerless.'],
    ['"If the cloak gets wet, the other properties stop working and it becomes powerless."', 'If the cloak gets wet, the other properties stop working and it becomes powerless.'],
    ['"If the cloak gets wet, the other properties stop working or the cloak becomes powerless."', 'If the cloak gets wet, the other properties stop working or the cloak becomes powerless.'],
    ['"When the cloak is in sunlight, the remaining threads fade and the cloak becomes inert."', 'When the cloak is in sunlight, the remaining threads fade and the cloak becomes inert.'],
    ['"When the cloak is wet, the second layer swells and the cloak stops working."', 'When the cloak is wet, the second layer swells and the cloak stops working.'],
    ['"When the cloak is wet, the other threads fade, so it stops working."', 'When the cloak is wet, the other threads fade, so it stops working.'],
    ['"If the cloak gets wet, the other properties, like the cloak itself, stop working."', 'If the cloak gets wet, the other properties, like the cloak itself, stop working.'],
  ];
  const NARROW_RULES: Row[] = [
    ...NARROWED.flatMap(([what, limit]): Row[] => [
      [`${what} in the next sentence`, t24(`${CLOAK24} ${limit}`), null, true, 'Cloak of the Fen'],
      [`${what} in the next paragraph`, t24(`${CLOAK24}\n\n${limit}`), null, true, 'Cloak of the Fen'],
    ]),
    ['"If the ring is submerged, its gem dims and the ring stops working."', t24('While you wear this ring, you have a +1 bonus to Armor Class and saving throws. If the ring is submerged, its gem dims and the ring stops working.', RING24), null, true, 'Ring of the Reed'],
    ['"The weave of this armor doesn\'t function underwater."', t24(`${PL24} The weave of this armor doesn't function underwater.`, PLATE24), null, true, 'Warden Plate'],
    ['"When the cloak is dropped, the hood falls and the cloak keeps working." (control)', t24(`${CLOAK24} When the cloak is dropped, the hood falls and the cloak keeps working.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"If the cloak gets wet, the other properties stop working but the cloak keeps working." (control)', t24(`${CLOAK24} If the cloak gets wet, the other properties stop working but the cloak keeps working.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"If the cloak is destroyed, the other cloak in the pair becomes nonmagical and its wearer must attune to a new one." (control)', t24(`${CLOAK24} If the cloak is destroyed, the other cloak in the pair becomes nonmagical and its wearer must attune to a new one.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"If one of the stones in a pair is destroyed, the other one becomes nonmagical and crumbles to dust." (control)', t24(`${CLOAK24} If one of the stones in a pair is destroyed, the other one becomes nonmagical and crumbles to dust.`), { ac: 1 }, false, 'Sending Stones of the Fen'],
  ];

  /** Layout G3, grammar G3: a reference to a benefit, a protection or a ward later in a plain paragraph with no bonus of its own reaches the bonus before it. */
  const BENEFIT_REFERENCES: Row[] = [
    ...[
      'The hem is cold to the touch. This benefit works only in Dim Light or Darkness.',
      'The cloak is woven from kelp. This benefit works only underwater.',
      'The cloak is woven from kelp. This protection fades in sunlight.',
      'The cloak is woven from kelp. These benefits last only while you are raging.',
      'The cloak is woven from kelp. The ward fails in sunlight.',
    ].map((later): Row => [`"${later}" in the next paragraph`, t24(`${CLOAK24}\n\n${later}`), null, true, 'Cloak of the Fen']),
    ['"…This benefit lasts while you wear the cloak." in the next paragraph (control)', t24(`${CLOAK24}\n\nThe cloak is woven from kelp. This benefit lasts while you wear the cloak.`), { ac: 1 }, false, 'Cloak of the Fen'],
  ];

  /** Grammar G1: the wearer named in the third person is still the wearer, and "only" sunlight is a situation; only another creature's loss, or nothing short of a spell, limits nothing. */
  const WEARER_SUBJECTS: Row[] = [
    ...[
      'The wearer gains no benefit from it in sunlight.',
      'In sunlight, the wearer gains no benefit from the cloak.',
      'Its wearer gains no benefit from it in sunlight.',
      'Whoever wears the cloak gains no benefit from it in sunlight.',
      'The wearer receives no protection from the cloak while underwater.',
      'The wearer gets no benefit from the cloak if the wearer is Bloodied.',
      'The wearer of this cloak gains no benefit from it in sunlight.',
      'A wearer gains no benefit from the cloak while underwater.',
      "The cloak's wearer gains no benefit from it in sunlight.",
      'Only sunlight renders the cloak powerless.',
      'Only bright light can render the cloak inert.',
      'Nothing but sunlight can render the cloak powerless.',
      'Only water suppresses the cloak.',
    ].flatMap((limit): Row[] => [
      [`"${limit}" in the next sentence`, t24(`${CLOAK24} ${limit}`), null, true, 'Cloak of the Fen'],
      [`"${limit}" in the next paragraph`, t24(`${CLOAK24}\n\n${limit}`), null, true, 'Cloak of the Fen'],
    ]),
    ['"A creature wearing the armor gains no benefit from it in sunlight."', t24(`${PL24} A creature wearing the armor gains no benefit from it in sunlight.`, PLATE24), null, true, 'Warden Plate'],
    ['"While raging, the wearer gains no benefit from this armor."', t24(`${PL24} While raging, the wearer gains no benefit from this armor.`, PLATE24), null, true, 'Warden Plate'],
    ['"The bearer gains no benefit from the ring at night."', t24('While you wear this ring, you have a +1 bonus to saving throws. The bearer gains no benefit from the ring at night.', RING24), null, true, 'Ring of the Reed'],
  ];

  /** Grammar G4: "only" a few words after a works-verb, on J3's backstop path (a long aside, "Legends claim…"). */
  const RELIC = 'The cloak, a relic of the old kings who ruled the north long ago,';
  const ONLY_LATER: Row[] = [
    ...['protects you only from ranged attacks.', 'works for elves only.', 'is effective for elves only.', 'shields you only from the front.', 'protects you only outdoors.', 'protects you only once per day.'].map((rest): Row => [`"…${rest}" after a long aside`, t24(`${CLOAK24} ${RELIC} ${rest}`), null, true, 'Cloak of the Fen']),
    ['"Legends claim the cloak guards you only from arrows."', t24(`${CLOAK24} Legends claim the cloak guards you only from arrows.`), null, true, 'Cloak of the Fen'],
  ];

  /** Grammar G5: "the listed bonuses" points back at the bonuses before it, so choosing one of them makes them a choice. */
  const TWO24 = 'While you wear this cloak, you have a +1 bonus to Armor Class and a +1 bonus to saving throws.';
  const LISTED_CHOICES: Row[] = [
    ['"choose one of the listed bonuses" in the next paragraph', t24(`${TWO24}\n\nWhen you attune to the cloak, choose one of the listed bonuses.`), null, true, 'Cloak of the Fen'],
    ['"pick one of the listed benefits; the other doesn\'t apply." in the next paragraph', t24(`${TWO24}\n\nWhen you attune to the cloak, pick one of the listed benefits; the other doesn't apply.`), null, true, 'Cloak of the Fen'],
  ];
  /** Round-9 grammar re-run: a state after a colon run-in label the label words don't know is a loss in what it names (ef67a2b noted these; the label is no longer dropped silently). */
  const COLON_STATES: Row[] = [
    ...['**Daytime:** The cloak is inert.', '**Wild Shape:** The cloak is inert.', '_**Rain:**_ The cloak is powerless.', '**Storms:** The cloak has no effect.'].flatMap((limit): Row[] => [
      [`"${limit}" in the next sentence`, t24(`${CLOAK24} ${limit}`), null, true, 'Cloak of the Fen'],
      [`"${limit}" in the next paragraph`, t24(`${CLOAK24}\n\n${limit}`), null, true, 'Cloak of the Fen'],
    ]),
    ['"**Daytime:** The armor is inert." (armor)', t24(`${PL24}\n\n**Daytime:** The armor is inert.`, PLATE24), null, true, 'Warden Plate'],
    // Controls: an always-on colon label over a state, and a holding label over what isn't a loss.
    ['"**While Attuned:** The cloak is magically bound to you." (control)', t24(`${CLOAK24}\n\n**While Attuned:** The cloak is magically bound to you.`), { ac: 1 }, false, 'Cloak of the Fen'],
    ['"**Lore:** The cloak was woven by river folk." (control)', t24(`${CLOAK24}\n\n**Lore:** The cloak was woven by river folk.`), { ac: 1 }, false, 'Cloak of the Fen'],
  ];
  /** Round-9 grammar re-run: "choose one of the following bonuses" names a choice among the bonuses stated before it (ef67a2b noted these). */
  const FOLLOWING_BONUSES: Row[] = [
    ['"…choose one of the following bonuses: the bonus to Armor Class or the bonus to saving throws." in the same paragraph', t24(`${TWO24} When you attune to the cloak, choose one of the following bonuses: the bonus to Armor Class or the bonus to saving throws.`), null, true, 'Cloak of the Fen'],
    ['"…choose one of the following bonuses: …" in the next paragraph', t24(`${TWO24}\n\nWhen you attune to the cloak, choose one of the following bonuses: the bonus to Armor Class or the bonus to saving throws.`), null, true, 'Cloak of the Fen'],
    ['"Each dawn, choose one of the following bonuses to keep until the next dawn: …"', t24(`${TWO24}\n\nEach dawn, choose one of the following bonuses to keep until the next dawn: the bonus to Armor Class or the bonus to saving throws.`), null, true, 'Cloak of the Fen'],
    ['"…pick one of the following bonuses; the other doesn\'t apply."', t24(`${TWO24}\n\nWhen you attune to the cloak, pick one of the following bonuses; the other doesn't apply.`), null, true, 'Cloak of the Fen'],
  ];
  /** Round-9 grammar re-run: "Only" or "Nothing but" a kind of magic renders the item powerless in that situation; only a Wish spell, a deity, divine magic or an artifact is beyond a situation (ef67a2b noted these). */
  const KINDS_OF_MAGIC: Row[] = [
    ...['Only fire magic can render the cloak powerless.', 'Nothing but fire magic can render the cloak powerless.', 'Only shadow spells can render the cloak inert.', 'Only necromantic magic suppresses the cloak.'].flatMap((limit): Row[] => [
      [`"${limit}" in the next sentence`, t24(`${CLOAK24} ${limit}`), null, true, 'Cloak of the Fen'],
      [`"${limit}" in the next paragraph`, t24(`${CLOAK24}\n\n${limit}`), null, true, 'Cloak of the Fen'],
    ]),
    ['"Only a god can render the cloak powerless." (control)', t24(`${CLOAK24} Only a god can render the cloak powerless.`), { ac: 1 }, false, 'Cloak of the Fen'],
  ];
  const ROUND9: Row[] = [...COLON_CONDITIONS, ...PLAIN_HEADINGS, ...NARROW_RULES, ...BENEFIT_REFERENCES, ...WEARER_SUBJECTS, ...ONLY_LATER, ...LISTED_CHOICES, ...COLON_STATES, ...FOLLOWING_BONUSES, ...KINDS_OF_MAGIC];

  const ROUND8: Row[] = [
    ...LIST_PARAGRAPHS, ...NO_ARMOR_LISTS, ...SRD_FOLLOWERS, ...SRD_SENTENCES, ...COLON_LABEL_LINES, ...LABEL_ALONE_TEXTS,
    ...REUSE_JOINS, ...SCOPED_NEGATIONS, ...STATE_FORMS, ...CONCESSIONS, ...FOLLOWING_OFFERS, ...COLON_RUN_INS, ...OBJECT_SUBJECTS, ...BACKSTOP_WORDS,
  ];

  /**
   * The same text in 2014 wording: a lowercase type line, bold-italic run-in labels, "AC" and the game terms 2014 books
   * print in lower case ("dim light", "bloodied", "shield", "bonus action").
   */
  const TERMS_2014 = /\b(?:Dim Light|Bright Light|Darkness|Bloodied|Shield|Resistance|Advantage|Bonus Action|Unconscious|Antimagic Field|Undead|Necrotic|Bludgeoning|Cold|Fire|Prone|Swim Speed)\b/g;
  const as2014 = (text: string) =>
    text
      .replace(/^_([^_\n]+)_/, (_m, line: string) => `*${line.charAt(0)}${line.slice(1).toLowerCase()}*`)
      .replace(/_\*\*([^*]+)\*\*_/g, '***$1***')
      .replace(/\bArmor Class\b/g, 'AC')
      .replace(TERMS_2014, (term: string, at: number, whole: string) => (/(?:^|[.!?:]\s+|\n)(?:\*{3}|_\*\*)?$/.test(whole.slice(0, at)) ? term : term.toLowerCase()));
  /** Every new row in 2024 wording again in 2014 wording. */
  const in2014 = (rows: readonly Row[]): Row[] => rows.filter(([, text]) => text.startsWith('_')).map(([what, text, bonuses, noted, name]) => [`${what} (2014 wording)`, as2014(text), bonuses, noted, name]);
  const ROUND5: Row[] = [...INTROS, ...LIMITS_ELSEWHERE, ...LEAD_INS_ANY, ...WHOSE, ...RESTORED_D6];

  const ROWS: Row[] = [...LEAD_INS, ...CONDITIONS, ...ALWAYS_ON, ...ITEM_PHRASES, ...LATER_LIMITS, ...SCOPES, ...RESTORED, ...ROUND5, ...in2014(ROUND5), ...ROUND6, ...in2014(ROUND6), ...ROUND7, ...in2014(ROUND7), ...ROUND8, ...in2014(ROUND8), ...ROUND9, ...in2014(ROUND9)];

  it.each(ROWS)('applies only what always holds, in every dialect: %s', (_what, text, bonuses, noted, name) => {
    for (const dialect of DIALECTS) {
      const n = read(text, dialect, undefined, name);
      expect(n.data?.bonuses ?? null, dialect).toEqual(bonuses);
      expect(bonusNote(n) !== undefined, dialect).toBe(noted);
      if (noted) expect(bonusNote(n), dialect).toMatch(/holds only in some situations, so the app doesn't apply it \(the DM can\)/);
    }
  });

  it.each(ROWS)('tells a Claude reading that applies a bonus to check it only when it holds in some situations: %s', (_what, text, bonuses, noted, name) => {
    // Claude reads the no-armor condition the text sets, as the offline reader does (a wrong one is tested below).
    const acCondition = (bonuses?.acOnlyWhen as Wire<'magic-item'>['acCondition'] | undefined) ?? 'always';
    for (const dialect of ['markdown', 'two-column'] as const) {
      const n = read(text, dialect, { ...appliedByClaude(text), acCondition }, name);
      if (noted) expect(bonusNote(n), dialect).toMatch(/^The app applies a \+\d bonus that the text gives only in some situations: check it\./);
      else expect(bonusNote(n), dialect).toBeUndefined();
    }
  });

  /** One variant's paragraphs, including a second one that opens "The shield …" or "This weapon …". */
  const WARDEN_SHIELD = [
    '_Armor (Shield), Rarity Varies (Requires Attunement)_',
    'A warden shield bears the sigil of one grove.',
    'Oak (Uncommon). This Shield is carved from living oak.',
    'The shield grants a +1 bonus to saving throws while you hold it.',
    'Iron (Very Rare). This Shield is forged of cold iron.',
    'The shield grants a +2 bonus to Armor Class while you hold it.',
  ].join('\n\n');
  const WARDEN_SHIELD_2014 = [
    '*Armor (shield), rarity varies (requires attunement)*',
    'A warden shield bears the sigil of one grove.',
    '***Oak (uncommon).*** This shield is carved from living oak.',
    'The shield grants a +1 bonus to saving throws while you hold it.',
    '***Iron (very rare).*** This shield is forged of cold iron.',
    'The shield grants a +2 bonus to AC while you hold it.',
  ].join('\n\n');
  const SEASON_BLADE = [
    '_Weapon (Any Sword), Rarity Varies (Requires Attunement)_',
    'Each season blade answers to one season.',
    '_**Spring (Uncommon).**_ This blade smells of rain.',
    'This weapon grants a +1 bonus to attack rolls and damage rolls made with it.',
    '_**Winter (Very Rare).**_ This blade is rimed with frost.',
    'This weapon grants a +3 bonus to attack rolls and damage rolls made with it.',
  ].join('\n\n');
  const SEASON_BLADE_2014 = [
    '*Weapon (any sword), rarity varies (requires attunement)*',
    'Each season blade answers to one season.',
    '***Spring (uncommon).*** This blade smells of rain.',
    'This weapon grants a +1 bonus to attack rolls and damage rolls made with it.',
    '***Winter (very rare).*** This blade is rimed with frost.',
    'This weapon grants a +3 bonus to attack rolls and damage rolls made with it.',
  ].join('\n\n');

  /** D7: a variant's run-in with a colon, or a digit in its name, is one too. */
  const WARDEN_SHIELD_COLON = [
    '_Armor (Shield), Rarity Varies (Requires Attunement)_',
    'A warden shield bears the sigil of one grove.',
    'Oak (Uncommon): While you hold this Shield, you have a +1 bonus to saving throws.',
    'Iron (Very Rare): While you hold this Shield, you have a +2 bonus to Armor Class.',
  ].join('\n\n');
  const WARDEN_SHIELD_MARKS = [
    '*Armor (shield), rarity varies (requires attunement)*',
    'Each mark is a different make.',
    '***Mark 1 (uncommon).*** While you hold this shield, you have a +1 bonus to saving throws.',
    '***Mark 2 (very rare).*** While you hold this shield, you have a +2 bonus to AC.',
  ].join('\n\n');

  /** I6: variants under headings or bold lines ("#### Oak (Uncommon)", "**Ironwood (Rare)**"), 2024 and 2014. */
  const GROVE = (mark: (s: string) => string, type = '_Ring, Rarity Varies (Requires Attunement)_', ac = 'Armor Class') =>
    [type, 'This ring comes in two kinds.', mark('Oak (Uncommon)'), `While you wear this ring, you have a +1 bonus to ${ac}.`, mark('Ironwood (Rare)'), `While you wear this ring, you have a +2 bonus to ${ac} and saving throws.`].join('\n\n');
  const GROVE14 = '*Ring, rarity varies (requires attunement)*';

  it.each([
    ['variants under "####" headings', GROVE((x) => `#### ${x}`), 1],
    ['variants under bold lines', GROVE((x) => `**${x}**`), 1],
    ['variants under "####" headings (2014)', GROVE((x) => `#### ${x}`, GROVE14, 'AC'), 1],
    ['variants under bold lines (2014)', GROVE((x) => `**${x}**`, GROVE14, 'AC'), 1],
    ['a shield', WARDEN_SHIELD, 1],
    ['a shield (2014)', WARDEN_SHIELD_2014, 1],
    ['a weapon', SEASON_BLADE, 1],
    ['a weapon (2014)', SEASON_BLADE_2014, 1],
    ['run-ins with a colon', WARDEN_SHIELD_COLON, 1],
    ['run-ins with a digit in the name (2014)', WARDEN_SHIELD_MARKS, 1],
  ] as const)("keeps one variant's bonus in its next paragraph variant-only, in every dialect: %s", (_what, text, n) => {
    for (const dialect of DIALECTS) {
      const record = read(text, dialect);
      expect(record.data, dialect).not.toHaveProperty('bonuses');
      expect(bonusNote(record), dialect).toMatch(new RegExp(String.raw`^One kind of this item gives a \+${n} bonus, so the app doesn't apply it \(the DM can\)`));
    }
    // Claude applying one variant's bonus is told only one kind gives it.
    const claude = read(text, 'markdown', appliedByClaude(text.split('\n\n').slice(-1)[0]));
    expect(bonusNote(claude)).toMatch(/^The app applies a \+\d bonus that only one kind of this item gives: check it\./);
  });

  const RING = (closing: string) =>
    ['_Ring, Rarity Varies (Requires Attunement)_', 'This ring comes in several kinds.', 'Ruby (Rare). While wearing it, you have Resistance to Fire damage.', 'Sapphire (Very Rare). While wearing it, you have Resistance to Cold damage.', closing].join('\n\n');

  it('gives the item a bonus again after its variants only at an explicit whole-item opener', () => {
    for (const dialect of DIALECTS) {
      for (const opener of ['Whatever its gem, the ring has 3 charges, and you gain a +1 bonus to saving throws while you wear it.', 'Each kind of ring has 3 charges, and you gain a +1 bonus to saving throws while you wear it.']) {
        expect(read(RING(opener), dialect).data, `${dialect}: ${opener}`).toMatchObject({ bonuses: { savingThrows: 1 }, charges: 3 });
      }
      // "The ring …" after the last variant counts for the charges, not the bonus.
      const closing = read(RING('The ring has 3 charges. You gain a +1 bonus to saving throws while you wear the ring.'), dialect);
      expect(closing.data, dialect).toMatchObject({ charges: 3 });
      expect(closing.data, dialect).not.toHaveProperty('bonuses');
    }
  });

  it("reads a \"The ring …\" paragraph followed by another variant's run-in as the earlier variant's, charges and all", () => {
    const text = ['_Ring, Rarity Varies (Requires Attunement)_', 'This ring comes in several kinds.', 'Ruby (Rare). While wearing it, you have Resistance to Fire damage.', 'The ring has 3 charges.', 'Sapphire (Very Rare). While wearing it, you have Resistance to Cold damage.'].join('\n\n');
    for (const dialect of DIALECTS) expect(read(text, dialect).data, dialect).not.toHaveProperty('charges');
  });

  const STAFF_2014 = [
    '*Staff, rarity varies (requires attunement by a druid)*',
    'Each of these staffs is carved from one kind of wood.',
    '***Ash (rare).*** You can cast the *gust of wind* spell from the staff.',
    '***Yew (very rare).*** You can cast the *wall of thorns* spell from the staff.',
    'Every staff has 10 charges and regains 1d6 + 4 expended charges daily at dawn.',
  ].join('\n\n');
  const CLOAK = (closing: string) =>
    ['_Wondrous Item, Rarity Varies (Requires Attunement)_', 'This cloak comes in several colors.', 'Crimson (Rare). While wearing it, you have Resistance to Fire damage.', 'Azure (Very Rare). While wearing it, you have Resistance to Cold damage.', closing].join('\n\n');

  it("counts a closing \"Each ring …\", \"Every staff …\" or \"This cloak …\" paragraph for the item's charges, but its bonus stays one kind's", () => {
    const cases: [string, string, number, string][] = [
      ['"Each ring has 3 charges"', RING('Each ring has 3 charges and regains 1d3 expended charges daily at dawn.'), 3, NAME],
      ['"Every staff has 10 charges" (2014)', STAFF_2014, 10, NAME],
      ['"This cloak has 3 charges"', CLOAK('This cloak has 3 charges and regains 1d3 expended charges daily at dawn.'), 3, NAME],
      ['"These rings have 3 charges"', RING('These rings have 3 charges and regain 1d3 expended charges daily at dawn.'), 3, NAME],
      ['"Each such ring has 3 charges"', RING('Each such ring has 3 charges and regains 1d3 expended charges daily at dawn.'), 3, NAME],
      ['"Each one has 3 charges"', RING('Each one has 3 charges and regains 1d3 expended charges daily at dawn.'), 3, NAME],
      ['"Every one of them has 3 charges"', RING('Every one of them has 3 charges and regains 1d3 expended charges daily at dawn.'), 3, NAME],
      ['"Each thurible …": the item\'s own noun', RING('Each thurible has 4 charges.'), 4, 'Thurible of Embers'],
    ];
    for (const [what, text, charges, name] of cases) {
      for (const dialect of DIALECTS) expect(read(text, dialect, undefined, name).data, `${dialect}: ${what}`).toMatchObject({ charges });
    }
    // "The sapphire …" after the Sapphire's run-in is that kind's.
    for (const dialect of DIALECTS) expect(read(RING('The sapphire has 3 charges.'), dialect).data, dialect).not.toHaveProperty('charges');
    for (const dialect of DIALECTS) {
      // A bonus there stays one kind's (left out, with the variant note), and "Each time …" isn't about every ring.
      for (const closing of ['Each ring grants a +1 bonus to saving throws while you wear it.', 'Each time you finish a Long Rest, you gain a +1 bonus to saving throws until dawn. The ring has 3 charges.']) {
        const n = read(RING(closing), dialect);
        expect(n.data, `${dialect}: ${closing}`).not.toHaveProperty('bonuses');
        expect(bonusNote(n), `${dialect}: ${closing}`).toMatch(/^One kind of this item gives a \+1 bonus, so the app doesn't apply it \(the DM can\)/);
      }
    }
  });

  it("tells a Claude reading to check a bonus it applies that the text doesn't always give, whatever its wording, and a no-armor condition the text doesn't set", () => {
    const claude = (text: string, wire: Partial<Wire<'magic-item'>>) => read(text, 'markdown', { acBonus: 0, saveBonus: 0, attackBonus: 0, damageBonus: 0, acCondition: 'always', ...wire });
    // Each is grounded (the quote states it), so applied, and the note says so: offline, none is applied.
    const worded: [string, string, Partial<Wire<'magic-item'>>][] = [
      ['"+1 to AC while raging" (2014)', t14('While you wear this hide armor, you gain +1 to AC while raging.', '*Armor (hide), rare (requires attunement by a barbarian)*'), { acBonus: 1, bonusText: '+1 to AC while raging' }],
      ['"+1 bonus to your Armor Class"', t24("You have a +1 bonus to your Armor Class while you're Bloodied.", '_Armor (Breastplate), Rare (Requires Attunement)_'), { acBonus: 1, bonusText: '+1 bonus to your Armor Class' }],
      ['"+2 bonus to all saving throws"', t24('While underwater, you have a +2 bonus to all saving throws.'), { saveBonus: 2, bonusText: '+2 bonus to all saving throws' }],
      ['"+1 bonus to Constitution saving throws"', t24('While you wear this belt, you have a +1 bonus to Constitution saving throws.'), { saveBonus: 1, bonusText: '+1 bonus to Constitution saving throws' }],
      ['"+2 bonus to spell attack rolls" (2014)', t14('While you hold this talisman, you gain a +2 bonus to spell attack rolls.'), { attackBonus: 2, bonusText: '+2 bonus to spell attack rolls' }],
      ['"your familiar gains…"', t24('While you wear this collar, your familiar gains a +1 bonus to Armor Class.'), { acBonus: 1, bonusText: '+1 bonus to Armor Class' }],
    ];
    for (const [what, text, wire] of worded) {
      expect(read(text, 'markdown').data, what).not.toHaveProperty('bonuses');
      const n = claude(text, wire);
      expect(n.data, what).toHaveProperty('bonuses');
      expect(bonusNote(n), what).toMatch(/^The app applies a \+\d bonus that the text gives only in some situations: check it\. “/);
    }
    // Offline, a situational "+N to AC" or "+N bonus to all saving throws" is noted too.
    for (const [, text] of [worded[0], worded[2], worded[3]]) expect(bonusNote(read(text, 'markdown'))).toMatch(/^A \+\d bonus here holds only in some situations/);
    // A bonus stated nowhere in the prose (a table) is noted, without a quote.
    const table = claude('_Wondrous Item, Rare_\n\n| Level | Bonus |\n|---|---|\n| 1 | +1 to AC |', { acBonus: 1, bonusText: '+1 to AC' });
    expect(bonusNote(table)).toBe("The app applies a +1 bonus to Armor Class that the text doesn't say always holds: check it.");

    // SRD 5.2.1 Bracers of Defense: the text sets "no armor and no Shield".
    const bracers = '_Wondrous Item, Rare (Requires Attunement)_\n\nWhile wearing these bracers, you gain a +2 bonus to Armor Class if you are wearing no armor and using no Shield.';
    const ac = (acCondition: Wire<'magic-item'>['acCondition'], text = bracers) => claude(text, { acBonus: 2, acCondition, bonusText: '+2 bonus to Armor Class' });
    expect(read(bracers, 'markdown').data?.bonuses).toEqual({ ac: 2, acOnlyWhen: 'no-armor-no-shield' });
    expect(ac('always').data?.bonuses).toEqual({ ac: 2 });
    expect(bonusNote(ac('always'))).toMatch(/^The app applies a \+2 bonus to Armor Class whatever you wear, but the text gives it only while you wear no armor and use no Shield: check it\. “While wearing these bracers/);
    expect(bonusNote(ac('no-armor'))).toMatch(/^The app applies a \+2 bonus to Armor Class only while you wear no armor, but the text gives it only while you wear no armor and use no Shield: check it\./);
    expect(bonusNote(ac('no-armor-no-shield'))).toBeUndefined();
    // A condition the text doesn't set, or a stricter one, is a difference too.
    const plain = t24('While wearing these bracers, you gain a +2 bonus to Armor Class.');
    expect(bonusNote(ac('no-armor', plain))).toMatch(/^The app applies a \+2 bonus to Armor Class only while you wear no armor, but the text gives it whatever you wear: check it\./);
    expect(bonusNote(ac('always', plain))).toBeUndefined();
    const noArmor = t24('You gain a +2 bonus to Armor Class while you wear no armor.');
    expect(bonusNote(ac('no-armor-no-shield', noArmor))).toMatch(/^The app applies a \+2 bonus to Armor Class only while you wear no armor and use no Shield, but the text gives it only while you wear no armor: check it\./);
    expect(bonusNote(ac('no-armor', noArmor))).toBeUndefined();
  });

  it('reads headings and bold lines inside an item through the Markdown import, as labels or variant run-ins (I6)', () => {
    const doc = (body: string, name: string, type: string) => `# Treasures of the Drowned Coast\n\n## Magic Items\n\n### ${name}\n\n${type}\n\n${body}\n\n### Moth Coin\n\n_Wondrous Item, Common_\n\nThis coin always lands on its edge.`;
    const RV = '_Ring, Rarity Varies (Requires Attunement)_';
    const cases: [string, string, string, Record<string, unknown> | null, RegExp | null][] = [
      ['"#### Pressure Ward" under a conditional intro', 'Cloak of the Deep', doc('While you are underwater, you gain the following benefits.\n\n#### Deep Sight\n\nYou can see in Darkness.\n\n#### Pressure Ward\n\nYou have a +1 bonus to Armor Class.', 'Cloak of the Deep', t24('').trim()), null, /^A \+1 bonus here holds only in some situations/],
      ['"**Pressure Ward**" under a conditional intro', 'Cloak of the Deep', doc('While you are underwater, you gain the following benefits.\n\n**Deep Sight**\n\nYou can see in Darkness.\n\n**Pressure Ward**\n\nYou have a +1 bonus to Armor Class.', 'Cloak of the Deep', t24('').trim()), null, /^A \+1 bonus here holds only in some situations/],
      ['"**Pressure Ward.**" under a conditional intro', 'Cloak of the Deep', doc('While you are underwater, you gain the following benefits.\n\n**Deep Sight.**\n\nYou can see in Darkness.\n\n**Pressure Ward.**\n\nYou have a +1 bonus to Armor Class.', 'Cloak of the Deep', t24('').trim()), null, /^A \+1 bonus here holds only in some situations/],
      ['"#### Oak (Uncommon)" variants', 'Ring of the Grove', doc('This ring comes in two kinds.\n\n#### Oak (Uncommon)\n\nWhile you wear this ring, you have a +1 bonus to Armor Class.\n\n#### Ironwood (Rare)\n\nWhile you wear this ring, you have a +2 bonus to Armor Class and saving throws.', 'Ring of the Grove', RV), null, /^One kind of this item gives a \+1 bonus/],
      ['"**Oak (Uncommon)**" variants', 'Ring of the Grove', doc('This ring comes in two kinds.\n\n**Oak (Uncommon)**\n\nWhile you wear this ring, you have a +1 bonus to Armor Class.\n\n**Ironwood (Rare)**\n\nWhile you wear this ring, you have a +2 bonus to Armor Class and saving throws.', 'Ring of the Grove', RV), null, /^One kind of this item gives a \+1 bonus/],
      ['"#### Pressure Ward" under an always-on intro', 'Cloak of the Deep', doc('While you wear this cloak, you gain the following benefits.\n\n#### Deep Sight\n\nYou can see in Darkness.\n\n#### Pressure Ward\n\nYou have a +1 bonus to Armor Class.', 'Cloak of the Deep', t24('').trim()), { ac: 1 }, null],
    ];
    for (const [what, name, md, bonuses, note] of cases) {
      const n = readEntries(chunkDocument(md, { sourceId: 'm', sourceName: 'M' }), name, what);
      expect(n.data?.bonuses ?? null, what).toEqual(bonuses);
      if (note) expect(bonusNote(n), what).toMatch(note);
      else expect(bonusNote(n), what).toBeUndefined();
    }
  });

  /** The app's PDF import of one page: a lamp's entry, then the item, its body lines as [text, font size] ('' is a blank line). */
  function pdfItemEntries(name: string, type: string, body: readonly (readonly [string, number])[]): CompendiumEntry[] {
    const header = () => pdfLine('Lantern Lore Compendium', 800, 8);
    const rows = [pdfLine('Magic Items', 740, 18), pdfLine('Ember Lamp', 716, 13), pdfLine('Wondrous Item, Common', 704), pdfLine('This lamp burns without oil and never goes out in', 692), pdfLine('the wind, however hard it blows.', 680)];
    let y = 656;
    rows.push(pdfLine(name, y, 13), pdfLine(type, (y -= 12)));
    for (const [text, size] of body) {
      y -= 12;
      if (text) rows.push(pdfLine(text, y, size));
    }
    const blank = (n: number) => [header(), pdfLine('Notes', 740, 13), pdfLine('This page is left blank for notes about the items above.', 716), pdfLine(String(n), 40, 8, 300)];
    return chunkDocument(pdfPagesToMarkdown([[header(), ...rows, pdfLine('1', 40, 8, 300)], blank(2), blank(3)]), { sourceId: 'p', sourceName: 'P' });
  }

  it('reads a colon intro, a heading or a bold line over a list, and a heading before a back-reference, through the Markdown and PDF imports (J1, J2)', () => {
    const doc = (body: string, name: string, type: string) => `# Treasures of the Drowned Coast\n\n## Magic Items\n\n### ${name}\n\n${type}\n\n${body}\n\n### Moth Coin\n\n_Wondrous Item, Common_\n\nThis coin always lands on its edge.`;
    const W24 = t24('').trim();
    const W14 = t14('').trim();
    const NOTED = /^A \+1 bonus here holds only in some situations/;
    // [what, the entries, the item's name, the bonuses applied, the note].
    const cases: [string, CompendiumEntry[], string, Record<string, unknown> | null, RegExp | null][] = [
      ['"#### Underwater" over a list', chunkDocument(doc('This cloak has two aspects.\n\n#### Underwater\n\n- You can breathe water.\n- You have a +1 bonus to Armor Class.', 'Cloak of the Deep', W24), { sourceId: 'm', sourceName: 'M' }), 'Cloak of the Deep', null, NOTED],
      ['"#### While Raging" over a list (2014)', chunkDocument(doc('This cloak has two aspects.\n\n#### While Raging\n\n- You have resistance to cold damage.\n- You have a +1 bonus to AC.', 'Cloak of the Deep', W14), { sourceId: 'm', sourceName: 'M' }), 'Cloak of the Deep', null, NOTED],
      ['"**Underwater**" over a list', chunkDocument(doc('This cloak has two aspects.\n\n**Underwater**\n\n- You can breathe water.\n- You have a +1 bonus to Armor Class.', 'Cloak of the Deep', W24), { sourceId: 'm', sourceName: 'M' }), 'Cloak of the Deep', null, NOTED],
      ['"#### While Bloodied" over three bullets', chunkDocument(doc('This mantle smells of the sea.\n\n#### While Bloodied\n\n- You have Resistance to Necrotic damage.\n- Your Speed increases by 10 feet.\n- You have a +1 bonus to saving throws.', 'Cloak of the Deep', W24), { sourceId: 'm', sourceName: 'M' }), 'Cloak of the Deep', null, NOTED],
      ['"#### Always" then "#### Underwater" over lists', chunkDocument(doc('This cloak has two aspects.\n\n#### Always\n\n- You can see in Dim Light.\n- You have Advantage on Wisdom (Perception) checks.\n\n#### Underwater\n\n- You can breathe water.\n- You have a +1 bonus to Armor Class.', 'Cloak of the Deep', W24), { sourceId: 'm', sourceName: 'M' }), 'Cloak of the Deep', null, NOTED],
      ['"#### Underwater" under an always-on ":" intro', chunkDocument(doc('While you wear this cloak, you gain the following benefits:\n\n#### Underwater\n\n- You can breathe water.\n- You have a +1 bonus to Armor Class.', 'Cloak of the Deep', W24), { sourceId: 'm', sourceName: 'M' }), 'Cloak of the Deep', null, NOTED],
      ['"**While Attuned**" over a list', chunkDocument(doc('This cloak is woven from kelp.\n\n**While Attuned**\n\n- You have a +1 bonus to Armor Class.\n- You have Resistance to Cold damage.', 'Cloak of the Deep', W24), { sourceId: 'm', sourceName: 'M' }), 'Cloak of the Deep', { ac: 1 }, null],
      ['"#### Sunlight Sensitivity" before "This bonus doesn\'t apply…"', chunkDocument(doc("While you wear this cloak, you have a +1 bonus to Armor Class.\n\n#### Sunlight Sensitivity\n\nThis bonus doesn't apply while you are in sunlight.", 'Cloak of the Deep', W24), { sourceId: 'm', sourceName: 'M' }), 'Cloak of the Deep', null, NOTED],
      ['"#### Drawback" before "These bonuses don\'t apply…" (2014)', chunkDocument(doc("While wearing this cloak, you gain a +1 bonus to AC and saving throws.\n\n#### Drawback\n\nThese bonuses don't apply while you are in sunlight.", 'Cloak of the Deep', W14), { sourceId: 'm', sourceName: 'M' }), 'Cloak of the Deep', null, NOTED],
      // The app's PDF import: a sub-heading in a larger font or a body-size line over "•" bullets, colon intros over bullets, and a sub-heading before a back-reference.
      ['an 11.5-point "Underwater" over "•" bullets', pdfItemEntries('Cloak of the Deep', 'Wondrous Item, Rare (Requires Attunement)', [['This cloak has two aspects.', 10], ['', 0], ['Underwater', 11.5], ['• You can breathe water.', 10], ['• You have a +1 bonus to Armor Class.', 10]]), 'Cloak of the Deep', null, NOTED],
      ['a body-size "Underwater" over "•" bullets', pdfItemEntries('Cloak of the Deep', 'Wondrous Item, Rare (Requires Attunement)', [['This cloak has two aspects.', 10], ['', 0], ['Underwater', 10], ['• You can breathe water.', 10], ['• You have a +1 bonus to Armor Class.', 10]]), 'Cloak of the Deep', null, NOTED],
      ['"While raging:" over "•" bullets', pdfItemEntries('Cloak of the Deep', 'Wondrous Item, Rare (Requires Attunement)', [['This cloak is woven from kelp and smells of the sea.', 10], ['', 0], ['While raging:', 10], ['• You have Resistance to Cold damage.', 10], ['• You have a +1 bonus to Armor Class.', 10]]), 'Cloak of the Deep', null, NOTED],
      ['"While you are Bloodied:" over "•" bullets', pdfItemEntries('Cloak of the Deep', 'Wondrous Item, Rare (Requires Attunement)', [['This cloak is woven from kelp and smells of the sea.', 10], ['', 0], ['While you are Bloodied:', 10], ['• You have Resistance to Necrotic damage.', 10], ['• You have a +1 bonus to saving throws.', 10]]), 'Cloak of the Deep', null, NOTED],
      ['"While attuned:" over "•" bullets', pdfItemEntries('Cloak of the Deep', 'Wondrous Item, Rare (Requires Attunement)', [['This cloak is woven from kelp and smells of the sea.', 10], ['', 0], ['While attuned:', 10], ['• You have a +1 bonus to Armor Class.', 10], ['• You have Resistance to Cold damage.', 10]]), 'Cloak of the Deep', { ac: 1 }, null],
      ['an 11.5-point "Sunlight Sensitivity" before "This bonus doesn\'t apply…"', pdfItemEntries('Cloak of the Deep', 'Wondrous Item, Rare (Requires Attunement)', [['While you wear this cloak, you have a +1 bonus', 10], ['to Armor Class.', 10], ['', 0], ['Sunlight Sensitivity', 11.5], ["This bonus doesn't apply while you are in", 10], ['sunlight.', 10]]), 'Cloak of the Deep', null, NOTED],
      ['"While you are underwater, you gain the following benefits:" over "•" bullets', pdfItemEntries('Cloak of the Deep', 'Wondrous Item, Rare (Requires Attunement)', [['This cloak is woven from kelp and smells of the sea.', 10], ['', 0], ['While you are underwater, you gain the following', 10], ['benefits:', 10], ['• You have Resistance to Cold damage.', 10], ['• You have a +1 bonus to Armor Class.', 10]]), 'Cloak of the Deep', null, NOTED],
    ];
    for (const [what, entries, name, bonuses, note] of cases) {
      const n = readEntries(entries, name, what);
      expect(n.data?.bonuses ?? null, what).toEqual(bonuses);
      if (note) expect(bonusNote(n), what).toMatch(note);
      else expect(bonusNote(n), what).toBeUndefined();
      // A Claude reading that applies the bonus is told to check it, or isn't when it always holds.
      const text = entries.find((e) => e.name === name)?.text ?? '';
      const c = readEntries(entries, name, what, appliedByClaude(text));
      if (note) expect(bonusNote(c), what).toMatch(/^The app applies a \+\d bonus that the text gives only in some situations: check it\./);
      else expect(bonusNote(c), what).toBeUndefined();
    }
  });

  /** A printed line: its text in the body font, or its text and font size; '' is a blank line. */
  type PrintedLine = string | readonly [string, number];
  const printed = (l: PrintedLine): readonly [string, number] => (typeof l === 'string' ? [l, 10] : l);
  /**
   * A two-column PDF page printed line by line: a lamp's entry at the top of the left column, then the item (its
   * name, its type line and `left`), and the right column goes on with `right`. A word may break at a line's end.
   */
  function columnPages(name: string, type: string, left: readonly PrintedLine[], right: readonly PrintedLine[]): PdfTextRun[][] {
    const header = () => pdfLine('Lantern Lore Compendium', 800, 8);
    const lamp = wrapped('This lamp burns without oil and never goes out in the wind, however hard it blows. Its flame is the color of embers and gives off no smoke, so it can be carried indoors.');
    const col0 = [pdfLine('Magic Items', 740, 18), pdfLine('Ember Lamp', 716, 13), pdfLine('Wondrous Item, Common', 704), ...lamp.map((l, i) => pdfLine(l, 692 - i * 12))];
    let y = 692 - lamp.length * 12 - 12;
    col0.push(pdfLine(name, y, 13));
    for (const [str, size] of [type, ...left].map(printed)) {
      y -= 12;
      if (str) col0.push(pdfLine(str, y, size));
    }
    const col1 = right.map(printed).flatMap(([str, size], i) => (str ? [pdfLine(str, 740 - i * 12, size, 320)] : []));
    const blank = (n: number) => [header(), pdfLine('Notes', 740, 13), pdfLine('This page is left blank for notes about the items above.', 716), pdfLine(String(n), 40, 8, 300)];
    return [[header(), ...col0, ...col1, pdfLine('1', 40, 8, 300)], blank(2), blank(3)];
  }

  it("reads a word a PDF broke at a line's or a column's end, and a sentence a column break cut, as printed", () => {
    // [what, name, type line, the left column's lines, the right column's, what the layout makes of the break, the bonuses applied, noted].
    const cases: [string, string, string, string[], string[], RegExp, Record<string, unknown> | null, boolean][] = [
      ['"two-" | "handed" in a column', 'Warden Blade', 'Weapon (Longsword), Rare', ['When you wield this sword two-', 'handed, you have a +1 bonus to Armor Class.'], [], /sword twohanded, you/, null, true],
      ['"two-" | "handed" across columns', 'Warden Blade', 'Weapon (Longsword), Rare', ['Its edge is dull until you speak its name aloud.', 'When you wield this sword two-'], ['handed, you have a +1 bonus to Armor Class.'], /sword two-\n\nhanded, you/, null, true],
      ['2014 "…sword two-" | "handed." in a column', 'Warden Blade', 'Weapon (longsword), rare', ['You have a +1 bonus to AC while you wield this sword two-', 'handed.'], [], /sword twohanded\./, null, true],
      ['2014 "rapier one-" | "handed, …" across columns', 'Warden Rapier', 'Weapon (rapier), rare (requires attunement)', ['Its guard is shaped like a heron in flight, wings open.', 'While you wield this rapier one-'], ['handed, you gain a +1 bonus to AC.'], /rapier one-\n\nhanded, you/, null, true],
      ['a condition in the next column', 'Raven Plate', 'Armor (Breastplate), Rare (Requires Attunement)', ['Ravens are etched on this breastplate. You have', 'a +1 bonus to Armor Class'], ["while you're Bloodied. The ravens seem to watch", 'whoever wears the breastplate.'], /Armor Class\n\nwhile you're Bloodied/, null, true],
      ['a condition in the next column (2014)', 'Raven Plate', 'Armor (breastplate), rare (requires attunement)', ['Ravens are etched on this breastplate. You have', 'a +1 bonus to AC'], ['while you are bloodied. The ravens seem to watch', 'whoever wears the breastplate.'], /to AC\n\nwhile you are bloodied/, null, true],
      // SRD 5.2.1 Elven Chain and Staff of Power, broken where a flowing two-column book breaks them.
      ['SRD Elven Chain', 'Elven Chain', 'Armor (Chain Mail or Chain Shirt), Rare', ['You gain a +1 bonus to Armor Class while you'], ['wear this armor. You are considered trained with', 'this armor even if you lack training with Medium', 'or Heavy armor.'], /while you\n\nwear this armor/, { ac: 1 }, false],
      ['SRD Staff of Power', 'Staff of Power', 'Staff, Very Rare (Requires Attunement by a Sorcerer, Warlock, or Wizard)', ['This staff has 20 charges and can be wielded as a', 'magic Quarterstaff that grants a +2 bonus'], ['to attack rolls and damage rolls made with it. While', 'holding it, you gain a +2 bonus to Armor Class,', 'saving throws, and spell attack rolls.'], /\+2 bonus\n\nto attack rolls/, { ac: 2, savingThrows: 2, attack: 2, damage: 2 }, false],
      // D5: a break before a capital, joined again where the first part can't end a sentence.
      ['"…hold this" | "Shield raised…"', 'Raven Shield', 'Armor (Shield), Rare (Requires Attunement)', ['Ravens are etched on its rim. You gain a +2', 'bonus to Armor Class while you hold this'], ['Shield raised before you. The ravens seem to', 'watch whoever holds it.'], /hold this\n\nShield raised/, null, true],
      ['2014 "…hold this" | "shield raised…"', 'Raven Shield', 'Armor (shield), rare (requires attunement)', ['Ravens are etched on its rim. You gain a +2', 'bonus to AC while you hold this'], ['shield raised before you. The ravens seem to', 'watch whoever holds it.'], /hold this\n\nshield raised/, null, true],
      ['SRD Staff of Power at "Armor" | "Class"', 'Staff of Power', 'Staff, Very Rare (Requires Attunement by a Sorcerer, Warlock, or Wizard)', ['This staff has 20 charges and can be wielded as a', 'magic Quarterstaff that grants a +2 bonus to attack', 'rolls and damage rolls made with it. While holding', 'it, you gain a +2 bonus to Armor'], ['Class, saving throws, and spell attack rolls.'], /bonus to Armor\n\nClass, saving throws/, { ac: 2, savingThrows: 2, attack: 2, damage: 2 }, false],
      ['SRD Staff of Striking at "a magic" | "Quarterstaff"', 'Staff of Striking', 'Staff, Very Rare (Requires Attunement)', ['This staff can be wielded as a magic'], ['Quarterstaff that grants a +3 bonus to attack rolls', 'and damage rolls made with it.'], /as a magic\n\nQuarterstaff that/, { attack: 3, damage: 3 }, false],
      ['"…+1 bonus to" | "Armor Class and saving throws…"', 'Warden Cloak', 'Wondrous Item, Rare (Requires Attunement)', ['Ravens are stitched on its hem. You gain a +1 bonus to'], ['Armor Class and saving throws while you wear this', 'cloak.'], /bonus to\n\nArmor Class and/, { ac: 1, savingThrows: 1 }, false],
      // I5: where the first part can't end a sentence, the next goes on whatever it looks like (a "label" there is the cut sentence's end).
      ['"…hold this" | "Shield in Dim Light or Darkness." (a run-in\'s shape)', 'Raven Shield', 'Armor (Shield), Rare (Requires Attunement)', ['Ravens are etched on its rim. You gain a +1', 'bonus to Armor Class while you hold this'], ['Shield in Dim Light or Darkness. The ravens', 'seem to watch whoever holds it.'], /hold this\n\nShield in Dim Light/, null, true],
      // "…a +1 bonus to" | "Ward. …" reads "+1 bonus to Ward": no target the app tracks, so nothing is applied or noted.
      ['a "+1 bonus to" cut before a run-in label', 'Warden Cloak', 'Wondrous Item, Rare (Requires Attunement)', ['Ravens are stitched on its hem. You gain a +1 bonus to'], ['Ward. You can see in the dark.'], /bonus to\n\nWard\. You can see/, null, false],
      // SRD 5.2.1 Dwarven Plate, Glamoured Studded Leather, Shield of the Cavalier and Sun Blade, cut where the layout review's books cut them.
      ['SRD Dwarven Plate at "…+2 bonus to" | "Armor Class. In addition…"', 'Dwarven Plate', 'Armor (Half Plate Armor or Plate Armor), Very Rare', ['While wearing this armor, you gain a +2 bonus to'], ['Armor Class. In addition, if an effect moves you', 'against your will along the ground, you can take a', 'Reaction to reduce the distance you are moved by up', 'to 10 feet.'], /bonus to\n\nArmor Class\. In addition/, { ac: 2 }, false],
      ['SRD Glamoured Studded Leather at "…to Armor" | "Class. You can also…"', 'Glamoured Studded Leather', 'Armor (Studded Leather Armor), Rare', ['While wearing this armor, you gain a +1 bonus to Armor'], ['Class. You can also take a Bonus Action to cause the', 'armor to assume the appearance of a normal set of', 'clothing or some other kind of armor.'], /to Armor\n\nClass\. You can also/, { ac: 1 }, false],
      ['SRD Shield of the Cavalier at "…+2 bonus to" | "Armor Class. This bonus…"', 'Shield of the Cavalier', 'Armor (Shield), Very Rare (Requires Attunement)', ['While holding this Shield, you have a +2 bonus to'], ["Armor Class. This bonus is in addition to the Shield's", 'normal bonus to AC.'], /bonus to\n\nArmor Class\. This bonus/, { ac: 2 }, false],
      ['SRD Sun Blade at "…instead of" | "Slashing damage. When…"', 'Sun Blade', 'Weapon (Longsword), Rare (Requires Attunement)', ['You gain a +2 bonus to attack rolls and damage rolls', 'made with this weapon, which deals Radiant damage', 'instead of'], ['Slashing damage. When you hit an Undead with it,', 'that target takes an extra 1d8 Radiant damage.'], /instead of\n\nSlashing damage\. When/, { attack: 2, damage: 2 }, false],
      // I5: a break before "(" or a dash goes on, in any case.
      ['"…to Armor Class" | "(only while you are in Dim Light or Darkness)."', 'Warden Cloak', 'Wondrous Item, Rare (Requires Attunement)', ['While you wear this cloak, you have a +1 bonus to Armor Class'], ['(only while you are in Dim Light or Darkness).'], /Armor Class\n\n\(only while/, null, true],
      ['2014 "…and saving throws" | "(but only while…)."', 'Warden Cloak', 'Wondrous item, rare (requires attunement)', ['While wearing this cloak, you gain a +1 bonus to AC and saving throws'], ['(but only while you are in dim light or darkness).'], /saving throws\n\n\(but only while/, null, true],
      ['"…to Armor Class" | "— but only while…"', 'Warden Cloak', 'Wondrous Item, Rare (Requires Attunement)', ['While you wear this cloak, you have a +1 bonus to Armor Class'], ['— but only while you are in Dim Light or Darkness.'], /Armor Class\n\n— but only/, null, true],
      // I4: SRD 5.2.1 Defender keeps its +3 wherever a column breaks its second paragraph.
      ['SRD Defender at "…+2 bonus to Armor Class." | "The adjusted bonuses…"', 'Defender', 'Weapon (Any Melee Weapon), Legendary (Requires Attunement)', ['You gain a +3 bonus to attack rolls and damage rolls', 'made with this magic weapon.', 'The first time you attack with the weapon on each of', "your turns, you can transfer some or all of the weapon's", 'bonus to your Armor Class. For example, you could', 'reduce the bonus to your attack rolls and damage rolls', 'to +1 and gain a +2 bonus to Armor Class.'], ['The adjusted bonuses remain in effect until the start', 'of your next turn, although you must hold the weapon', 'to gain a bonus to AC from it.'], /Armor Class\.\n\nThe adjusted bonuses/, { attack: 3, damage: 3 }, true],
      ['SRD Defender at "…+2 bonus to Armor" | "Class. The adjusted…"', 'Defender', 'Weapon (Any Melee Weapon), Legendary (Requires Attunement)', ['You gain a +3 bonus to attack rolls and damage rolls', 'made with this magic weapon.', 'The first time you attack with the weapon on each of', "your turns, you can transfer some or all of the weapon's", 'bonus to your Armor Class. For example, you could', 'reduce the bonus to your attack rolls and damage rolls', 'to +1 and gain a +2 bonus to Armor'], ['Class. The adjusted bonuses remain in effect until the', 'start of your next turn, although you must hold the', 'weapon to gain a bonus to AC from it.'], /to Armor\n\nClass\. The adjusted/, { attack: 3, damage: 3 }, true],
      // I4: a closing limit a column split from its paragraph still reaches the run-ins an intro offered.
      ['a closing "The shadows are fickle." | "They work only in Dim Light or Darkness."', 'Cloak of Fickle Shadows', 'Wondrous Item, Rare (Requires Attunement)', ['While you wear this cloak, you gain the following', 'benefits.', 'Shade Ward. You have a +1 bonus to Armor Class.', 'Shade Step. You can take the Hide action as a Bonus', 'Action.', 'The shadows are fickle and thin quickly in the open.'], ['They work only in Dim Light or Darkness.'], /in the open\.\n\nThey work only/, null, true],
      // I1: "Its protection works only…" is the item's, whichever paragraph a column puts it in.
      ['"…glows faintly at dusk." | "Its protection works only…"', 'Ring of Dusk Wardens', 'Ring, Rare (Requires Attunement)', ['While you wear this ring, you have a +1 bonus to Armor', 'Class and saving throws. The gold band is engraved', 'with old names, and it glows faintly at dusk.'], ['Its protection works only in Dim Light or Darkness.'], /at dusk\.\n\nIts protection/, null, true],
      // I3: a label a column ended after governs what follows it, under an intro too.
      ['"Deep Sight." | "You can see in Darkness." under a conditional intro', 'Cloak of the Deep', 'Wondrous Item, Rare (Requires Attunement)', ['While you are underwater, you gain the following', 'benefits.', 'Deep Sight.'], ['You can see in Darkness out to 60 feet.', 'Pressure Ward. You have a +1 bonus to Armor Class.'], /Deep Sight\.\n\nYou can see/, null, true],
      ['"Pressure Ward." | "You have a +1 bonus…" under a conditional intro', 'Cloak of the Deep', 'Wondrous Item, Rare (Requires Attunement)', ['While you are underwater, you gain the following', 'benefits.', 'Deep Sight. You can see in Darkness out to 60 feet.', 'Pressure Ward.'], ['You have a +1 bonus to Armor Class.'], /Pressure Ward\.\n\nYou have/, null, true],
      // I3: a label a column ended after governs what follows it.
      ['"Guard (Shield Form Only)." | "While you hold it, …"', 'Warden Shield', 'Armor (Shield), Rare (Requires Attunement)', ['This Shield can turn into a cloak or back as a Bonus', 'Action.', 'Guard (Shield Form Only).'], ['While you hold it, you have a +1 bonus to Armor Class.'], /Form Only\)\.\n\nWhile you hold it/, null, true],
      ['"Guard" | "(Shield Form Only). While you hold it, …" (a parenthesis)', 'Warden Shield', 'Armor (Shield), Rare (Requires Attunement)', ['This Shield can turn into a cloak or back as a Bonus', 'Action.', 'Guard'], ['(Shield Form Only). While you hold it, you have a +1', 'bonus to Armor Class.'], /Guard\n\n\(Shield Form Only\)/, null, true],
      ['"Guard (Shield" | "Form Only). While you hold it, …" (an open parenthesis)', 'Warden Shield', 'Armor (Shield), Rare (Requires Attunement)', ['This Shield can turn into a cloak or back as a Bonus', 'Action.', 'Guard (Shield'], ['Form Only). While you hold it, you have a +1 bonus to', 'Armor Class.'], /Guard \(Shield\n\nForm Only\)/, null, true],
      // J1: a colon intro at a column's end, and a column that ends right after a list's bullet, still govern the list.
      ['"While raging:" | "• …" (J1)', 'Cloak of the Deep', 'Wondrous Item, Rare (Requires Attunement)', ['This cloak is woven from kelp and smells of the sea.', 'While raging:'], ['• You have Resistance to Cold damage.', '• You have a +1 bonus to Armor Class.'], /While raging:\n\n•/, null, true],
      ['"• You have Resistance…" "•" | "You have a +1 bonus…" (J1)', 'Cloak of the Deep', 'Wondrous Item, Rare (Requires Attunement)', ['This cloak is woven from kelp and smells of the sea.', 'While raging:', '• You have Resistance to Cold damage.', '•'], ['You have a +1 bonus to Armor Class.'], /•\n\nYou have a \+1/, null, true],
      // J2: a label a column ended after, between a bonus and its back-reference.
      ['"Drawback." | "This bonus doesn\'t apply…" (J2)', 'Cloak of the Deep', 'Wondrous Item, Rare (Requires Attunement)', ['While you wear this cloak, you have a +1 bonus to Armor', 'Class.', 'Drawback.'], ["This bonus doesn't apply while you are in sunlight."], /Drawback\.\n\nThis bonus/, null, true],
      // J3: an aside a column split from its verb.
      ['"…The cloak, however," | "doesn\'t function in sunlight." (J3)', 'Cloak of the Deep', 'Wondrous Item, Rare (Requires Attunement)', ['While you wear this cloak, you have a +1 bonus to Armor', 'Class. The cloak, however,'], ["doesn't function in sunlight."], /however,\n\ndoesn't function/, null, true],
    ];
    for (const [what, name, type, left, right, layout, bonuses, noted] of cases) {
      const entries = chunkDocument(pdfPagesToMarkdown(columnPages(name, type, left, right)), { sourceId: 't', sourceName: 'T' });
      expect(entries.find((e) => e.name === name)?.text, what).toMatch(layout);
      const n = readEntries(entries, name, what);
      expect(n.data?.bonuses ?? null, what).toEqual(bonuses);
      // Defender's note is about its example's +2, never its +3.
      if (name === 'Defender') {
        expect(bonusNote(n), what).toMatch(/^A \+2 bonus here holds only in some situations/);
        continue;
      }
      if (noted) expect(bonusNote(n), what).toMatch(/holds only in some situations, so the app doesn't apply it \(the DM can\)/);
      else expect(bonusNote(n), what).toBeUndefined();
      // A Claude reading that applies it is told to check it, or isn't when it always holds (one with no target to read applies nothing).
      const wire = appliedByClaude([...left, ...right].join(' ').replace(/(\w)- (\w)/g, '$1-$2'));
      const c = readEntries(entries, name, what, wire);
      const applies = [wire.acBonus, wire.saveBonus, wire.attackBonus, wire.damageBonus].some((b) => (b ?? 0) > 0);
      if (noted) expect(bonusNote(c), what).toMatch(applies ? /^The app applies a \+\d bonus that the text gives only in some situations: check it\./ : /holds only in some situations/);
      else expect(bonusNote(c), what).toBeUndefined();
    }
  });

  /** One import's reading against the fixed one, offline and as a Claude reading that applies every stated bonus with the text's AC condition. */
  function expectImported(what: string, entries: CompendiumEntry[], name: string, bonuses: Record<string, unknown> | null, noted: boolean, claudeText = entries.find((e) => e.name === name)?.text ?? '') {
    const n = readEntries(entries, name, what);
    expect(n.data?.bonuses ?? null, what).toEqual(bonuses);
    if (noted) expect(bonusNote(n), what).toMatch(/holds only in some situations, so the app doesn't apply it \(the DM can\)/);
    else expect(bonusNote(n), what).toBeUndefined();
    const acCondition = (bonuses?.acOnlyWhen as Wire<'magic-item'>['acCondition'] | undefined) ?? 'always';
    const c = readEntries(entries, name, what, { ...appliedByClaude(claudeText), acCondition });
    if (noted) expect(bonusNote(c), what).toMatch(/^The app applies a \+\d bonus that the text gives only in some situations: check it\./);
    else expect(bonusNote(c), what).toBeUndefined();
  }

  it("reads the round-7 layout findings through the Markdown and PDF imports: a list item's second paragraph, no-armor lists, colon label lines (layout F1, F2, F5)", () => {
    const doc = (body: string, name: string, type: string) => chunkDocument(`# Treasures of the Drowned Coast\n\n## Magic Items\n\n### ${name}\n\n${type}\n\n${body}\n\n### Moth Coin\n\n_Wondrous Item, Common_\n\nThis coin always lands on its edge.`, { sourceId: 'm', sourceName: 'M' });
    const W24 = t24('').trim();
    const W14 = t14('').trim();
    const T24 = 'Wondrous Item, Rare (Requires Attunement)';
    const T14 = 'Wondrous item, rare (requires attunement)';
    const kelp = (lead: string, y: '24' | '14', between = '  This Resistance ends if you leave the water.') =>
      `This cloak is woven from kelp.\n\n${lead}\n\n- You have ${y === '24' ? 'Resistance to Cold' : 'resistance to cold'} damage.\n\n${y === '24' ? between : between.replace('Resistance', 'resistance')}\n\n- You have a +1 bonus to ${y === '24' ? 'Armor Class' : 'AC'}.`;
    const hand = (lead: string, y: '24' | '14') =>
      `These bracers are made of hardened leather.\n\n${lead}\n\n- You have ${y === '24' ? 'Advantage' : 'advantage'} on Dexterity saving throws.\n\n  This benefit doesn't stack with Evasion.\n\n- You have a +2 bonus to ${y === '24' ? 'Armor Class' : 'AC'}.`;
    const gray = (lead: string) => `This cloak is woven from gray wool.\n\n${lead}\n\n- You have a +1 bonus to Armor Class.\n- You have Resistance to Cold damage.`;
    const bullets = (head: readonly [string, number], y: '24' | '14', gap = true) =>
      pdfItemEntries('Cloak of the Deep', y === '24' ? T24 : T14, [
        ['This cloak is woven from kelp and smells of the sea.', 10], ['', 0], head, [`• You have ${y === '24' ? 'Resistance to Cold' : 'resistance to cold'} damage.`, 10],
        ...(gap ? [['', 0] as const] : []), [`This ${y === '24' ? 'Resistance' : 'resistance'} ends if you leave the water.`, 10], ...(gap ? [['', 0] as const] : []), [`• You have a +1 bonus to ${y === '24' ? 'Armor Class' : 'AC'}.`, 10],
      ]);
    const handBullets = (head: readonly [string, number]) =>
      pdfItemEntries('Bracers of the Open Hand', T24, [['These bracers are made of hardened leather.', 10], ['', 0], head, ['• You have Advantage on Dexterity saving throws.', 10], ['', 0], ["This benefit doesn't stack with Evasion.", 10], ['', 0], ['• You have a +2 bonus to Armor Class.', 10]]);
    const grayBullets = (lead: string) => pdfItemEntries('Cloak of the Gray Ward', T24, [['This cloak is woven from gray wool.', 10], ['', 0], [lead, 10], ['• You have a +1 bonus to Armor Class.', 10], ['• You have Resistance to Cold damage.', 10]]);
    // [what, the entries, the item's name, the bonuses applied, noted].
    const cases: [string, CompendiumEntry[], string, Record<string, unknown> | null, boolean][] = [
      // F1: a failing heading or bold line over a list, past an item's second paragraph or a line between bullets.
      ['"#### Underwater" over a list, an item\'s second paragraph', doc(kelp('#### Underwater', '24'), 'Cloak of the Deep', W24), 'Cloak of the Deep', null, true],
      ['"**While Raging**" over a list, an item\'s second paragraph', doc(kelp('**While Raging**', '24'), 'Cloak of the Deep', W24), 'Cloak of the Deep', null, true],
      ['"#### While Raging" over a list, an item\'s second paragraph (2014)', doc(kelp('#### While Raging', '14'), 'Cloak of the Deep', W14), 'Cloak of the Deep', null, true],
      ['"#### Night Form" over a list, an item\'s second paragraph', doc(kelp('#### Night Form', '24'), 'Cloak of the Deep', W24), 'Cloak of the Deep', null, true],
      ['"#### Underwater" over a list, "\\column" between its bullets', doc(kelp('#### Underwater', '24', '\\column'), 'Cloak of the Deep', W24), 'Cloak of the Deep', null, true],
      ['"**Underwater**" over a list, "<!-- art -->" between its bullets', doc(kelp('**Underwater**', '24', '<!-- art -->'), 'Cloak of the Deep', W24), 'Cloak of the Deep', null, true],
      // F2: the same lists under a no-armor heading, bold line or intro keep the no-armor condition.
      ['"#### While Wearing No Armor" over a list, an item\'s second paragraph', doc(hand('#### While Wearing No Armor', '24'), 'Bracers of the Open Hand', W24), 'Bracers of the Open Hand', { ac: 2, acOnlyWhen: 'no-armor' }, false],
      ['"**While Wearing No Armor**" over a list, an item\'s second paragraph', doc(hand('**While Wearing No Armor**', '24'), 'Bracers of the Open Hand', W24), 'Bracers of the Open Hand', { ac: 2, acOnlyWhen: 'no-armor' }, false],
      ['"If you wear no armor and use no Shield:" over a list, an item\'s second paragraph', doc(hand('If you wear no armor and use no Shield:', '24'), 'Bracers of the Open Hand', W24), 'Bracers of the Open Hand', { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false],
      ['"#### While Wearing No Armor" over a list, an item\'s second paragraph (2014)', doc(hand('#### While Wearing No Armor', '14'), 'Bracers of the Open Hand', W14), 'Bracers of the Open Hand', { ac: 2, acOnlyWhen: 'no-armor' }, false],
      ['"If you wear no armor and use no shield:" over a list, an item\'s second paragraph (2014)', doc(hand('If you wear no armor and use no shield:', '14'), 'Bracers of the Open Hand', W14), 'Bracers of the Open Hand', { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false],
      // F5: a colon label line with no condition holds; one with a condition doesn't.
      ...['Benefits:', 'Properties:', 'Effects:'].map((lead): [string, CompendiumEntry[], string, Record<string, unknown> | null, boolean] => [`"${lead}" over a list`, doc(gray(lead), 'Cloak of the Gray Ward', W24), 'Cloak of the Gray Ward', { ac: 1 }, false]),
      ['"While raging:" over a list (control)', doc(gray('While raging:'), 'Cloak of the Gray Ward', W24), 'Cloak of the Gray Ward', null, true],
      // The app's PDF import. F1: an 11.5-point sub-heading or a body-size label over "•" bullets, a bullet's second paragraph.
      ['an 11.5-point "Underwater" over "•" bullets, a bullet\'s second paragraph', bullets(['Underwater', 11.5], '24'), 'Cloak of the Deep', null, true],
      ['an 11.5-point "Underwater" over "•" bullets, a bullet\'s second paragraph (2014)', bullets(['Underwater', 11.5], '14'), 'Cloak of the Deep', null, true],
      ['an 11.5-point "While Raging" over "•" bullets, a bullet\'s second paragraph', bullets(['While Raging', 11.5], '24'), 'Cloak of the Deep', null, true],
      ['an 11.5-point "While Raging" over "•" bullets, a bullet\'s second paragraph (2014)', bullets(['While Raging', 11.5], '14'), 'Cloak of the Deep', null, true],
      ['a body-size "Underwater" over "•" bullets, a bullet\'s second paragraph', bullets(['Underwater', 10], '24'), 'Cloak of the Deep', null, true],
      ['an 11.5-point "Underwater" over "•" bullets, a bullet\'s second sentence on the next line', bullets(['Underwater', 11.5], '24', false), 'Cloak of the Deep', null, true],
      ['"While raging:" over "•" bullets, a bullet\'s second paragraph (control)', bullets(['While raging:', 10], '24'), 'Cloak of the Deep', null, true],
      ['"While you are Bloodied:" over "•" bullets, a bullet\'s second paragraph (control, 2014)', bullets(['While you are Bloodied:', 10], '14'), 'Cloak of the Deep', null, true],
      // F2: a no-armor sub-heading or intro over "•" bullets, a bullet's second paragraph.
      ['an 11.5-point "While Wearing No Armor" over "•" bullets, a bullet\'s second paragraph', handBullets(['While Wearing No Armor', 11.5]), 'Bracers of the Open Hand', { ac: 2, acOnlyWhen: 'no-armor' }, false],
      ['"If you wear no armor and use no Shield:" over "•" bullets, a bullet\'s second paragraph', handBullets(['If you wear no armor and use no Shield:', 10]), 'Bracers of the Open Hand', { ac: 2, acOnlyWhen: 'no-armor-no-shield' }, false],
      // F5: colon label lines over "•" bullets.
      ...['Benefits:', 'Properties:', 'Magical Properties:', 'Effects:', 'Abilities:', 'Attuned Benefits:', 'While attuned:'].map((lead): [string, CompendiumEntry[], string, Record<string, unknown> | null, boolean] => [`"${lead}" over "•" bullets`, grayBullets(lead), 'Cloak of the Gray Ward', { ac: 1 }, false]),
      ['"While raging:" over "•" bullets (control)', grayBullets('While raging:'), 'Cloak of the Gray Ward', null, true],
    ];
    for (const [what, entries, name, bonuses, noted] of cases) expectImported(what, entries, name, bonuses, noted);
  });

  it('reads a column break between a bullet\'s two sentences, and a run-in label a column ended after, as the round-7 layout review asks (layout F1, F6)', () => {
    const T24 = 'Wondrous Item, Rare (Requires Attunement)';
    const T14 = 'Wondrous item, rare (requires attunement)';
    // [what, name, type line, the left column's lines, the right column's, what the layout makes of the break, the bonuses applied, noted].
    const cases: [string, string, string, PrintedLine[], PrintedLine[], RegExp, Record<string, unknown> | null, boolean][] = [
      // F1: under an 11.5-point sub-heading, a column ends between a bullet's two sentences.
      ['"• You have Resistance to Cold damage." | "This Resistance ends…" under "Underwater"', 'Cloak of the Deep', T24, ['This cloak is woven from kelp and smells of the sea.', ['Underwater', 11.5], '• You have Resistance to Cold damage.'], ['This Resistance ends if you leave the water.', '• You have a +1 bonus to Armor Class.'], /Cold damage\.\n\nThis Resistance ends/, null, true],
      ['2014 "• You have resistance to cold damage." | "This resistance ends…" under "Underwater"', 'Cloak of the Deep', T14, ['This cloak is woven from kelp and smells of the sea.', ['Underwater', 11.5], '• You have resistance to cold damage.'], ['This resistance ends if you leave the water.', '• You have a +1 bonus to AC.'], /cold damage\.\n\nThis resistance ends/, null, true],
      ['"• You have Resistance to Cold damage." | "This Resistance ends…" under "While Raging"', 'Cloak of the Deep', T24, ['This cloak is woven from kelp and smells of the sea.', ['While Raging', 11.5], '• You have Resistance to Cold damage.'], ['This Resistance ends if you leave the water.', '• You have a +1 bonus to Armor Class.'], /Cold damage\.\n\nThis Resistance ends/, null, true],
      // F6: a run-in label a column ended after governs its own text only, up to the next run-in.
      ['"Night Sight." | "You can see in Darkness…", then "Ward. While you wear…"', 'Cloak of Dusk', T24, ['This cloak is woven from shadow and smells of', 'smoke.', '', 'Night Sight.'], ['You can see in Darkness out to 60 feet.', '', 'Ward. While you wear this cloak, you have a +1', 'bonus to Armor Class.'], /Night Sight\.\n\nYou can see in Darkness/, { ac: 1 }, false],
      ['2014 "Shadow Step." | "As a bonus action…", then "Ward. While wearing…"', 'Cloak of Dusk', T14, ['This cloak is woven from shadow and smells of', 'smoke.', '', 'Shadow Step.'], ['As a bonus action, you can teleport up to 30 feet', 'into dim light or darkness.', '', 'Ward. While wearing this cloak, you gain a +1', 'bonus to AC.'], /Shadow Step\.\n\nAs a bonus action/, { ac: 1 }, false],
      ['"Underwater Breathing." | "You can breathe water.", then "Ward. You have…"', 'Cloak of Dusk', T24, ['This cloak is woven from shadow and smells of', 'smoke.', '', 'Underwater Breathing.'], ['You can breathe water.', '', 'Ward. You have a +1 bonus to Armor Class.'], /Underwater Breathing\.\n\nYou can breathe water/, { ac: 1 }, false],
      // Controls: a column that ends inside the label leaves a cut label that still governs.
      ['"Night" | "Sight. You can see…" (control)', 'Cloak of Dusk', T24, ['This cloak is woven from shadow and smells of', 'smoke.', '', 'Night'], ['Sight. You can see in Darkness out to 60 feet.', '', 'Ward. While you wear this cloak, you have a +1', 'bonus to Armor Class.'], /Night\n\nSight\. You can see/, null, true],
      ['2014 "Shadow" | "Step. As a bonus action…" (control)', 'Cloak of Dusk', T14, ['This cloak is woven from shadow and smells of', 'smoke.', '', 'Shadow'], ['Step. As a bonus action, you can teleport up to 30', 'feet into dim light or darkness.', '', 'Ward. While wearing this cloak, you gain a +1', 'bonus to AC.'], /Shadow\n\nStep\. As a bonus action/, null, true],
      ['"Underwater" | "Breathing. You can breathe water." (control)', 'Cloak of Dusk', T24, ['This cloak is woven from shadow and smells of', 'smoke.', '', 'Underwater'], ['Breathing. You can breathe water.', '', 'Ward. You have a +1 bonus to Armor Class.'], /Underwater\n\nBreathing\. You can/, null, true],
    ];
    for (const [what, name, type, left, right, layout, bonuses, noted] of cases) {
      const entries = chunkDocument(pdfPagesToMarkdown(columnPages(name, type, left, right)), { sourceId: 't', sourceName: 'T' });
      expect(entries.find((e) => e.name === name)?.text, what).toMatch(layout);
      expectImported(what, entries, name, bonuses, noted, [...left, ...right].map((l) => printed(l)[0]).join(' '));
    }
  });
});
