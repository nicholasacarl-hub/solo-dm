/**
 * Offline gear parser (spec §3.9): weapon and armor tables (the build-srd rules: group headers such as
 * "Martial Melee Weapons" or "Light Armor (1 Minute to Don or Doff)", Damage / Properties / Mastery /
 * Armor Class / Strength / Stealth / Weight / Cost columns), and single gear entries with Cost and Weight
 * lines (a weapon or armor entry may also carry Damage or Armor Class lines). One wire item per row.
 *
 * Owner: E2. Pure.
 */
import type { Candidate } from '../segment';
import { gfmTables } from '../segment';
import type { Wire } from '../wire';
import type { OfflineParse } from './index';
import { firstTextLine, labeledValues, plain } from './lines';
import { stripInline } from './srdRulesEntity';

type WireItem = Wire<'item'>['items'][number];

const NONE = /^(?:—|–|-|none)?$/i;
const cellText = (cell: string | undefined) => {
  const t = stripInline(cell ?? '');
  return NONE.test(t) ? '' : t;
};

const emptyItem = (name: string, category: WireItem['category']): WireItem => ({
  name,
  category,
  costText: '',
  weightText: '',
  weaponCategory: 'none',
  weaponType: 'none',
  damageText: '',
  propertiesText: '',
  masteryText: '',
  armorType: 'none',
  acText: '',
  strengthText: '',
  stealthDisadvantage: false,
});

interface Group { weaponCategory: WireItem['weaponCategory']; weaponType: WireItem['weaponType']; armorType: WireItem['armorType']; shield: boolean }

/** A group heading ("Simple Ranged Weapons", "Heavy Armor (10 Minutes to Don…)", "Shield"), or null. */
function groupOf(text: string): Group | null {
  const t = stripInline(text);
  const weapon = /^(Simple|Martial)\s+(Melee|Ranged)\s+Weapons?\b/i.exec(t);
  if (weapon) {
    return { weaponCategory: weapon[1].toLowerCase() as 'simple' | 'martial', weaponType: weapon[2].toLowerCase() as 'melee' | 'ranged', armorType: 'none', shield: false };
  }
  const armor = /^(Light|Medium|Heavy)\s+Armor\b/i.exec(t);
  if (armor) return { weaponCategory: 'none', weaponType: 'none', armorType: armor[1].toLowerCase() as 'light' | 'medium' | 'heavy', shield: false };
  if (/^Shields?\b/i.test(t)) return { weaponCategory: 'none', weaponType: 'none', armorType: 'none', shield: true };
  return null;
}

const column = (header: readonly string[], re: RegExp) => header.findIndex((h) => re.test(stripInline(h)));

/** The rows of one gear table, from `firstRow` for `rows` body rows. */
function tableItems(header: readonly string[], body: readonly string[][], kind: 'weapons' | 'armor'): WireItem[] {
  const col = {
    damage: column(header, /^damage\b/i),
    properties: column(header, /^properties\b/i),
    mastery: column(header, /^mastery\b/i),
    weight: column(header, /^weight\b/i),
    cost: column(header, /^(?:cost|price)\b/i),
    ac: column(header, /^(?:armor class|ac)\b/i),
    strength: column(header, /^strength\b/i),
    stealth: column(header, /^stealth\b/i),
  };
  let group = groupOf(header[0] ?? '') ?? groupOf('');
  const items: WireItem[] = [];
  for (const row of body) {
    const name = cellText(row[0]);
    const rest = row.slice(1).map(cellText);
    if (!name) continue;
    const asGroup = groupOf(name);
    if (asGroup && rest.every((c) => !c)) {
      group = asGroup;
      continue;
    }
    if (rest.every((c) => !c)) continue; // a footnote or a stray line
    const at = (i: number) => (i >= 0 ? cellText(row[i]) : '');
    if (kind === 'weapons') {
      items.push({
        ...emptyItem(name, 'weapon'),
        costText: at(col.cost),
        weightText: at(col.weight),
        weaponCategory: group?.weaponCategory ?? 'none',
        weaponType: group?.weaponType ?? 'none',
        damageText: at(col.damage),
        propertiesText: at(col.properties),
        masteryText: at(col.mastery),
      });
    } else {
      const shield = Boolean(group?.shield) || /^shield\b/i.test(name);
      items.push({
        ...emptyItem(name, shield ? 'shield' : 'armor'),
        costText: at(col.cost),
        weightText: at(col.weight),
        armorType: shield ? 'none' : (group?.armorType ?? 'none'),
        acText: at(col.ac),
        strengthText: at(col.strength),
        stealthDisadvantage: /disadvantage/i.test(at(col.stealth)),
      });
    }
  }
  return items;
}

const ENTRY_LABELS = ['Cost', 'Weight', 'Damage', 'Properties', 'Mastery', 'Armor Class (AC)', 'Armor Class', 'AC', 'Strength', 'Stealth', 'Ability'];

/** A single gear entry ("- **Cost:** 2 GP", "- **Weight:** 1 lb."), or one weapon or armor described on its own. */
function entryItem(candidate: Candidate, text: string): WireItem {
  const v = labeledValues(text, ENTRY_LABELS);
  const get = (...labels: string[]) => cellText(labels.map((l) => v.get(l)).find(Boolean));
  const group = groupOf(firstTextLine(text));
  const name = candidate.name;
  const base = { costText: get('Cost'), weightText: get('Weight') };
  if (get('Damage') || group?.weaponCategory !== undefined && group.weaponCategory !== 'none') {
    return {
      ...emptyItem(name, 'weapon'),
      ...base,
      weaponCategory: group?.weaponCategory ?? 'none',
      weaponType: group?.weaponType ?? 'none',
      damageText: get('Damage'),
      propertiesText: get('Properties'),
      masteryText: get('Mastery'),
    };
  }
  const ac = get('Armor Class (AC)', 'Armor Class', 'AC');
  if (ac || group?.armorType !== undefined && (group.armorType !== 'none' || group.shield)) {
    const shield = Boolean(group?.shield) || /^shield\b/i.test(name);
    return {
      ...emptyItem(name, shield ? 'shield' : 'armor'),
      ...base,
      armorType: shield ? 'none' : (group?.armorType ?? 'none'),
      acText: ac,
      strengthText: get('Strength'),
      stealthDisadvantage: /disadvantage/i.test(get('Stealth')),
    };
  }
  const category: WireItem['category'] = v.has('Ability') || /\b(?:Tools|Kit|Supplies|Set|Instrument)$/i.test(name) ? 'tool' : /\bPack$/i.test(name) ? 'pack' : 'gear';
  return { ...emptyItem(name, category), ...base };
}

const missingIn = (items: readonly WireItem[]): string[] => {
  if (!items.length) return ['items'];
  const out: string[] = [];
  items.forEach((item, i) => {
    if (item.category === 'weapon' && !item.damageText) out.push(`items[${i}].damageText`);
    if ((item.category === 'armor' || item.category === 'shield') && !item.acText) out.push(`items[${i}].acText`);
  });
  return out;
};

export function parseItem(candidate: Candidate & { kind: 'item' }): OfflineParse<'item'> {
  const text = candidate.blocks.map((b) => b.text ?? b.paragraphs.join('\n\n')).join('\n\n');
  let items: WireItem[];
  if (candidate.span === 'table' || candidate.span === 'row' || candidate.table) {
    const where = candidate.table ?? { index: 0, firstRow: 0, rows: Number.POSITIVE_INFINITY };
    const table = gfmTables(text)[where.index];
    const kind = table ? (column(table.header, /^damage\b/i) >= 0 ? 'weapons' : 'armor') : null;
    items = table && kind ? tableItems(table.header, table.rows.slice(where.firstRow, where.firstRow + where.rows), kind) : [];
  } else {
    items = [entryItem(candidate, text)];
  }
  const wire: Wire<'item'> = {
    matchesKind: true,
    name: candidate.span === 'row' ? candidate.name : candidate.name,
    format: '2024',
    items,
    notes: '',
  };
  return { wire, missing: missingIn(items) };
}

/** Plain text of a description, for the gear entry's own text (not used for data: no book text is copied). */
export const describe = (text: string): string => plain(text);
