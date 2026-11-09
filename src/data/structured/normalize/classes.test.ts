/**
 * The class normalizer (spec §3.9, §3.9.1, §5.6): the Wickwright's scripted wire and offline parse →
 * EXPECTED_DATA; level-table keys like builder.json's; the 2024 prepared column (equal to the SRD Cleric's
 * and Paladin's); cross-checks; classes are never "high". Invented content only.
 */
import { describe, expect, it } from 'vitest';
import { EXPECTED_DATA, GLOAMWOOD_SOURCE_ID, SCRIPTED_WIRE, SRD_BUILDER_DATA, WICKWRIGHT_SPELL_NAMES, gloamwoodEntries } from '@/test/structuredFixtures';
import { nameKey } from '@/lib/id';
import type { ClassData } from '@/types';
import { parseClass } from '../parse/classes';
import { levelTableKey } from '../parse/srdRulesOptions';
import { DATA_SCHEMAS } from '../schemas';
import { segment, type Candidate } from '../segment';
import type { Wire } from '../wire';
import type { NormalizeContext } from './index';
import { PREPARED_2024, normalizeClass, validateClass } from './classes';

const entries = gloamwoodEntries(GLOAMWOOD_SOURCE_ID);
const entriesById = new Map(entries.map((e) => [e.id, e]));
// The SRD spells the Wickwright Spell List names make it a spell list (spec §3.2 rule 5).
const knownSpellNames = new Set(WICKWRIGHT_SPELL_NAMES.filter((n) => !['Ashen Choir', 'Cinder Mote'].includes(n)).map(nameKey));
const { candidates, spellLists } = segment(entries, { knownSpellNames, knownClassNames: new Set(['fighter', 'cleric']) });
const candidate = candidates.find((c) => c.name === 'Wickwright') as Candidate & { kind: 'class' };
const ctx: NormalizeContext = { blocks: candidate.blocks, entriesById, origin: 'claude', spellLists };
const wire = SCRIPTED_WIRE.Wickwright.wire as Wire<'class'>;

describe('normalizeClass', () => {
  it("turns the Wickwright's scripted wire into its data (medium at best)", () => {
    const out = normalizeClass(wire, ctx);
    expect(out.data).toEqual(EXPECTED_DATA.Wickwright);
    expect(out.warnings).toEqual([{ code: 'spell-list', severity: 'info', field: 'spellNames', message: 'Its spell list comes from the book\'s “Wickwright Spell List”.' }]);
    expect(out.adaptations).toEqual([]);
    expect(out.confidence).toBe('medium');
    expect(DATA_SCHEMAS.class.safeParse(out.data).success).toBe(true);
  });

  it('gives the same data from the offline parse', () => {
    const parsed = parseClass(candidate, entriesById);
    expect(normalizeClass(parsed.wire, { ...ctx, origin: 'parser', missing: parsed.missing }).data).toEqual(EXPECTED_DATA.Wickwright);
  });

  it('keys level-table headers like builder.json', () => {
    const keys = ['Level', 'Proficiency Bonus', 'Class Features', 'Rages', 'Rage Damage', 'Weapon Mastery', 'Cantrips', 'Prepared Spells', '1st', '9th', 'Spell Slots', 'Slot Level', 'Spell Slots - 3rd', 'Sorcery Points', 'Cantrips Known', 'Spells Known'].map(levelTableKey);
    expect(keys).toEqual(['level', 'proficiencyBonus', 'features', 'rages', 'rageDamage', 'weaponMastery', 'cantrips', 'preparedSpells', 'slot1', 'slot9', 'pactSlots', 'pactSlotLevel', 'slot3', 'sorceryPoints', 'cantrips', 'spellsKnown']);
    const srdKeys = new Set(SRD_BUILDER_DATA.classes.flatMap((c) => Object.keys(c.levelTable[0])));
    for (const key of keys.filter((k) => k !== 'spellsKnown')) expect(srdKeys.has(key), key).toBe(true);
  });

  it("writes the 2024 prepared column for a formula caster, equal to the SRD Cleric's and Paladin's", () => {
    const column = (id: string) => SRD_BUILDER_DATA.classes.find((c) => c.id === id)?.levelTable.map((r) => r.preparedSpells);
    expect(PREPARED_2024.full).toEqual(column('srd:class:cleric'));
    expect(PREPARED_2024.half).toEqual(column('srd:class:paladin'));
    const older = { ...wire, format: '2014' as const, preparedSpellsText: '', levelTable: wire.levelTable.filter((c) => c.header !== 'Prepared Spells') };
    const formula = { ...older, preparedSpellsText: 'Intelligence is your spellcasting ability' };
    const out = normalizeClass(formula, ctx);
    expect(out.data?.levelTable.map((r) => r.preparedSpells)).toEqual([...PREPARED_2024.half]);
    expect(out.adaptations).toEqual([{ code: 'prepared-2024-column', note: 'Prepared spells follow the 2024 progression for a half caster.' }]);
  });

  it('notes a level-1 subclass and older half-caster slots', () => {
    const slots = wire.levelTable.map((c) => (c.header === '1st' ? { ...c, values: ['—', ...c.values.slice(1)] } : c));
    const out = normalizeClass({ ...wire, subclassLevel: 1, levelTable: slots }, ctx);
    expect(out.adaptations.map((a) => a.code)).toEqual(['half-caster-slots-2024', 'subclass-at-level-1']);
    expect(out.warnings.some((w) => w.code === 'cross-check' && w.field === 'subclassLevel')).toBe(true);
  });

  it('cross-checks the saving throws, hit die, PB column and columns of the wrong length', () => {
    const bad = {
      ...wire,
      savingThrowsText: 'Intelligence',
      hitDieText: 'D7 per Wickwright level',
      levelTable: wire.levelTable.map((c) => (c.header === 'Proficiency Bonus' ? { ...c, values: c.values.map(() => '+2') } : c.header === 'Wicks' ? { ...c, values: c.values.slice(0, 19) } : c)),
    };
    const out = normalizeClass(bad, ctx);
    expect(out.data).toBeNull();
    expect(out.confidence).toBe('low');
    const codes = out.warnings.map((w) => `${w.code}:${w.severity}:${w.field}`);
    expect(codes).toEqual(expect.arrayContaining(['missing:block:hitDie', 'cross-check:block:savingThrows', 'out-of-range:block:levelTable', 'cross-check:warn:levelTable']));
  });

  it('validates stored data', () => {
    expect(validateClass(EXPECTED_DATA.Wickwright as ClassData, ctx, 'Wickwright')).toEqual({ warnings: [], adaptations: [], confidence: 'medium' });
  });
});
