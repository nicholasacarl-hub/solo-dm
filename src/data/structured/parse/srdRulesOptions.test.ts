// @vitest-environment node
/**
 * Port identity (spec §3.9): the app's ports of scripts/build-srd.mjs's option helpers give the script's
 * results on the same strings — the SRD 5.2.1 core traits and background lines shipped in public/srd/
 * (CC-BY-4.0), plus a few edge cases.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CompendiumEntry, EquipmentPackage } from '@/types';
import {
  camelKey,
  compactKey,
  equipmentPackages,
  levelTableKey,
  lineagesFrom,
  parseAbilityList,
  parseArmorTraining,
  parseCostGp,
  parseEquipmentChoices,
  parseSkillChoices,
  parseTables,
  parseWeaponProficiencies,
  runIn,
  runInParts,
  splitTopLevel,
  stripInline,
} from './srdRulesOptions';

interface BuildScript {
  parseTables(md: string): { header: string[]; rows: string[][] }[];
  splitTopLevel(text: string, separator?: string): string[];
  parseCostGp(text: string): number | undefined;
  parseEquipmentChoices(text: string, known?: Set<string>): EquipmentPackage[];
  parseAbilityList(text: string): string[];
  parseSkillChoices(text: string, report: { warn(scope: string, message: string): void }, scope: string): { count: number; from: string[] };
  parseWeaponProficiencies(text: string): string[];
  parseArmorTraining(text: string): string[];
  boldBullets(md: string): Map<string, string>;
  compactKey(text: string): string;
  camelKey(text: string): string;
  stripInline(text: string): string;
}

const SCRIPT_PATH = '../../../../scripts/build-srd.mjs';
let script: BuildScript;
const quiet = { warn: () => {} };

const read = (file: string) => JSON.parse(readFileSync(new URL(`../../../../public/srd/${file}`, import.meta.url), 'utf8')) as unknown;
const compendium = read('compendium.json') as CompendiumEntry[];
const builder = read('builder.json') as { equipment: { name: string }[] };
const known = new Set(builder.equipment.map((e) => compactKey(e.name)));
const classes = compendium.filter((e) => e.kind === 'class');
const backgrounds = compendium.filter((e) => e.kind === 'background');

beforeAll(async () => {
  script = (await import(/* @vite-ignore */ SCRIPT_PATH)) as BuildScript;
});

/** The key/value core traits table of an SRD class entry. */
function coreTraits(entry: CompendiumEntry): Map<string, string> {
  const table = parseTables(entry.text).find((t) => t.header[0] === 'Primary Ability');
  if (!table) throw new Error(`${entry.name}: no core traits table`);
  return new Map([table.header, ...table.rows].map((r) => [r[0], r.slice(1).join(' | ')]));
}

describe('ports of scripts/build-srd.mjs', () => {
  it('parse the SRD class tables and core traits like the script', () => {
    expect(classes).toHaveLength(12);
    for (const entry of classes) {
      expect(parseTables(entry.text), entry.name).toEqual(script.parseTables(entry.text));
      const traits = coreTraits(entry);
      for (const [label, value] of traits) {
        expect(parseAbilityList(value), `${entry.name} ${label}`).toEqual(script.parseAbilityList(value));
        expect(splitTopLevel(value), `${entry.name} ${label}`).toEqual(script.splitTopLevel(value));
      }
      const skills = traits.get('Skill Proficiencies') ?? '';
      const mine = parseSkillChoices(skills);
      expect(mine && { count: mine.count, from: mine.from }, entry.name).toEqual(script.parseSkillChoices(skills, quiet, entry.name));
      expect(parseWeaponProficiencies(traits.get('Weapon Proficiencies') ?? ''), entry.name).toEqual(script.parseWeaponProficiencies(traits.get('Weapon Proficiencies') ?? ''));
      expect(parseArmorTraining(traits.get('Armor Training') ?? 'None'), entry.name).toEqual(script.parseArmorTraining(traits.get('Armor Training') ?? 'None'));
      const equipment = traits.get('Starting Equipment') ?? '';
      expect(parseEquipmentChoices(equipment, known), entry.name).toEqual(script.parseEquipmentChoices(equipment, known));
    }
  });

  it('parse the SRD background lines like the script', () => {
    expect(backgrounds).toHaveLength(4);
    for (const entry of backgrounds) {
      const bullets = script.boldBullets(entry.text);
      const abilities = bullets.get('Ability Scores') ?? '';
      expect(parseAbilityList(abilities), entry.name).toEqual(script.parseAbilityList(abilities));
      const equipment = bullets.get('Equipment') ?? '';
      expect(parseEquipmentChoices(equipment, known), entry.name).toEqual(script.parseEquipmentChoices(equipment, known));
      expect(equipmentPackages(equipment, known), entry.name).toEqual(script.parseEquipmentChoices(equipment, known));
    }
  });

  it('agree on the small helpers', () => {
    for (const text of ["Thieves' Tools", 'Sleight of Hand', 'Rage Damage', 'Spell Slots - 1st', 'Antipathy/Sympathy']) {
      expect(compactKey(text)).toBe(script.compactKey(text));
      expect(camelKey(text)).toBe(script.camelKey(text));
    }
    for (const text of ['_Choose A or B:_ (A) Rope', '**Feat:** Alert (see "Feats")', 'Book \\(prayers\\)']) expect(stripInline(text)).toBe(script.stripInline(text));
    for (const text of ['1 SP', '1,500 GP', '2 CP', '10 GP', 'Varies', '0.5 GP']) expect(parseCostGp(text)).toBe(script.parseCostGp(text));
    expect(splitTopLevel('A (B, C), D, E (F)')).toEqual(script.splitTopLevel('A (B, C), D, E (F)'));
  });
});

describe('option text helpers', () => {
  it('reads run-in labels in every emphasis style', () => {
    expect(runIn('_**Dusk Sight.**_ You see.')).toEqual({ label: 'Dusk Sight', rest: 'You see.', emphasis: 'strong-em' });
    expect(runIn('***Size.*** Small.')).toEqual({ label: 'Size', rest: 'Small.', emphasis: 'strong-em' });
    expect(runIn('- **Feat:** Alert')).toEqual({ label: 'Feat', rest: 'Alert', emphasis: 'strong' });
    expect(runIn('**Channel Divinity: Settling Gloom.** As an action…')?.label).toBe('Channel Divinity: Settling Gloom');
    expect(runIn('A plain sentence.')).toBeNull();
    expect(runInParts(['intro', '_**A.**_ one', 'more', '**Opt.** inner', '_**B.**_ two'], { emphasis: ['strong-em'] }).map((p) => [p.label, p.from, p.to])).toEqual([
      ['A', 2, 4],
      ['B', 5, 5],
    ]);
  });

  it('keys class-table headers and builds lineage text the SRD way', () => {
    expect(levelTableKey('Spell Slots - 2nd')).toBe('slot2');
    const trait = { description: '| Lineage | Level 1 | Level 3 | Level 5 |\n|---|---|---|---|\n| Ashwing | You glow. | Burning Hands | Continual Flame |' };
    expect(lineagesFrom(trait)).toEqual([{ name: 'Ashwing', description: 'You glow. Level 3: Burning Hands. Level 5: Continual Flame.' }]);
  });
});
