/**
 * The entity normalizers (monster, spell, magic item, item; spec §3.9): the scripted Claude answers and
 * the offline parser both normalize to EXPECTED_DATA; sentinels become absent fields; grounding,
 * cross-checks and the DM tool limits (SRD 5.2.1 "Monsters": XP by CR, proficiency bonus by CR, Hit
 * Points as the Hit Dice average; "Spells": Concentration; "Equipment": Armor) produce their warnings.
 */
import { describe, expect, it } from 'vitest';
import { EXPECTED_ADAPTATIONS, EXPECTED_DATA, SCRIPTED_WIRE, gloamwoodEntries, type GloamwoodDataName } from '@/test/structuredFixtures';
import type { StructuredKind } from '@/types';
import { parseOffline } from '../parse';
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
