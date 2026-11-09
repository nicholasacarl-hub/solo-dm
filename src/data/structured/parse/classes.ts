/**
 * Offline class parser (spec §3.9): intact Markdown only — the Core Traits table and the 20-row class
 * table (both GFM, with their header rows), plus "Level N: Feature" headings. A flattened PDF loses the
 * tables, so its classes go to Claude (the level table is reported missing).
 *
 * Tables need their header rows, which the candidate's numbered paragraphs leave out (spec §3.3), so the
 * parser reads each block's own text (CandidateBlock.text, or the entries when they are given).
 *
 * Owner: E4. Pure.
 */
import { nameKey } from '@/lib/id';
import type { CompendiumEntry } from '@/types';
import { blockText } from '../paragraphs';
import type { Candidate, CandidateBlock } from '../segment';
import type { Wire } from '../wire';
import type { OfflineParse } from './index';
import { findLabel, parseTables, plainText, type MarkdownTable } from './srdRulesOptions';

const LEVEL_TITLE = /^Level\s+(\d{1,2})\s*:\s*(.+)$/i;
const ABILITY_WORD = /\b(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) is (?:your|the) spellcasting ability\b/i;
const ABILITY_CODE: Readonly<Record<string, Wire<'class'>['spellcastingAbility']>> = {
  strength: 'str', dexterity: 'dex', constitution: 'con', intelligence: 'int', wisdom: 'wis', charisma: 'cha',
};

/** A key-value table (first column = label) of a class's core traits, header row included. */
function coreTraits(tables: readonly MarkdownTable[]): Map<string, string> | null {
  for (const t of tables) {
    const rows = [t.header, ...t.rows];
    if (!rows.some((r) => /^(?:Hit Point Die|Hit Dice)$/i.test(plainText(r[0] ?? '')))) continue;
    return new Map(rows.filter((r) => r.length >= 2).map((r) => [plainText(r[0]).toLowerCase(), plainText(r.slice(1).join(' | '))]));
  }
  return null;
}

/** The class table: a header with Level and Proficiency Bonus and one body row per level (20 of them). */
function classTable(tables: readonly MarkdownTable[]): MarkdownTable | null {
  return (
    tables.find((t) => /^Level$/i.test(plainText(t.header[0] ?? '')) && t.header.some((h) => /Proficiency Bonus/i.test(h)) && t.rows.length >= 20) ?? null
  );
}

const SLOT_HEADER = /^(?:Spell Slots(?: per Spell Level)?\s*[-–—:]\s*)?(\d)(?:st|nd|rd|th)$/i;

/** Caster type from the class table's slot columns (§3.7's definitions: full 9, half 5, third 4 from level 3, pact). */
function casterTypeOf(table: MarkdownTable | null): Wire<'class'>['casterType'] {
  if (!table) return 'none';
  const headers = table.header.map(plainText);
  if (headers.some((h) => /^Slot Level$/i.test(h)) || headers.some((h) => /^Spell Slots$/i.test(h))) return 'pact';
  const slots = headers.map((h, i) => ({ level: Number(SLOT_HEADER.exec(h)?.[1] ?? 0), i })).filter((s) => s.level > 0);
  if (!slots.length) return 'none';
  const top = Math.max(...slots.map((s) => s.level));
  if (top >= 9) return 'full';
  const firstColumn = slots.find((s) => s.level === 1);
  const firstLevel = firstColumn ? table.rows.findIndex((r) => /^\d+$/.test(plainText(r[firstColumn.i] ?? ''))) + 1 : 0;
  if (top <= 4 && firstLevel >= 3) return 'third';
  return top <= 5 ? 'half' : 'full';
}

export function parseClass(candidate: Candidate, entriesById?: ReadonlyMap<string, CompendiumEntry>): OfflineParse<'class'> {
  const blocks = candidate.blocks;
  // The block's own text keeps the tables' header rows (its numbered paragraphs don't).
  const textOf = (b: CandidateBlock) => b.text ?? (entriesById ? blockText(b.entryIds, entriesById) : null) ?? b.paragraphs.join('\n\n');
  const tables = blocks.flatMap((b) => parseTables(textOf(b)));
  const traits = coreTraits(tables);
  const trait = (...labels: string[]) => {
    for (const label of labels) {
      const value = traits?.get(label.toLowerCase()) ?? findLabel(blocks, label, { loose: true })?.value;
      if (value) return value;
    }
    return '';
  };

  const features: Wire<'class'>['features'] = [];
  for (const b of blocks) {
    const titled = LEVEL_TITLE.exec(b.title);
    if (!titled || !b.paragraphs.length || /^subclass feature$/i.test(titled[2].trim())) continue;
    features.push({ level: Number(titled[1]), name: titled[2].trim(), text: { block: b.id, from: 1, to: b.paragraphs.length } });
  }
  features.sort((a, b) => a.level - b.level);

  const table = classTable(tables);
  const levelTable: Wire<'class'>['levelTable'] = table
    ? table.header.slice(1).map((header, col) => ({ header: plainText(header), values: table.rows.slice(0, 20).map((r) => plainText(r[col + 1] ?? '')) }))
    : [];
  const subclassFeature = features.find((f) => / Subclass$/i.test(f.name));
  const fullText = blocks.map(textOf).join('\n\n');
  const ability = ABILITY_WORD.exec(plainText(fullText))?.[1].toLowerCase();
  const otherList = /\b(?:from|on) the (\w+) spell list\b/i.exec(plainText(fullText));

  const wire: Wire<'class'> = {
    matchesKind: true,
    name: candidate.name,
    format: '2024',
    primaryAbilityText: trait('Primary Ability'),
    hitDieText: trait('Hit Point Die', 'Hit Dice'),
    savingThrowsText: trait('Saving Throw Proficiencies', 'Saving Throws'),
    skillsText: trait('Skill Proficiencies', 'Skills'),
    weaponsText: trait('Weapon Proficiencies', 'Weapons'),
    armorText: trait('Armor Training', 'Armor Proficiencies', 'Armor'),
    toolsText: trait('Tool Proficiencies', 'Tools'),
    equipmentText: trait('Starting Equipment'),
    casterType: casterTypeOf(table),
    spellcastingAbility: ability ? (ABILITY_CODE[ability] ?? 'none') : 'none',
    preparedSpellsText: '',
    spellListText: otherList && nameKey(otherList[1]) !== nameKey(candidate.name) ? `the ${otherList[1]} spell list` : '',
    subclassLevel: subclassFeature?.level ?? 0,
    levelTable,
    features,
    notes: '',
  };
  const missing = (['primaryAbilityText', 'hitDieText', 'savingThrowsText'] as const).filter((f) => !wire[f]) as string[];
  if (!levelTable.length) missing.push('levelTable');
  if (!features.length) missing.push('features');
  if (!wire.subclassLevel) missing.push('subclassLevel');
  return { wire, missing };
}
