/**
 * Offline monster parser (spec §3.9): fills the same wire object Claude returns from a stat block in
 * SRD-style Markdown (2024: "- **AC** 17", "**CR** 3 (XP 700; PB +2)", the Str./Dex. table with a Score
 * row; 2014: "**Armor Class** 13", "**Challenge** 1 (200 XP)", the STR | DEX table with "14 (+2)"
 * cells) and in a PDF text layer (no emphasis; "AC 17 Initiative +2 (12)"; the ability grid as
 * "Str 16 +3 +3" lines). A table whose header row is gone ("Score 16 14 13 …") isn't read: its columns
 * can't be told apart, so the stat block goes to Claude.
 *
 * Owner: E2. Pure.
 */
import type { AbilityScores } from '@/types';
import type { Candidate } from '../segment';
import type { Wire } from '../wire';
import type { OfflineParse } from './index';
import { firstTextLine, labeledValues, plain, textLines } from './lines';
import { parseTables, stripInline } from './srdRulesEntity';

const SIZE = '(?:Tiny|Small|Medium|Large|Huge|Gargantuan)';
const DESCRIPTOR = new RegExp(String.raw`^(${SIZE}(?:\s*(?:,|or)\s*${SIZE})*)\s+(.+?)\s*,\s*([^,]+)$`, 'i');

const LABELS = [
  'AC', 'Armor Class', 'Initiative', 'HP', 'Hit Points', 'Speed', 'Skills', 'Senses', 'Languages', 'CR', 'Challenge',
  'Saving Throws', 'Resistances', 'Immunities', 'Vulnerabilities', 'Damage Resistances', 'Damage Immunities',
  'Condition Immunities', 'Damage Vulnerabilities', 'Gear', 'Proficiency Bonus',
];
/** Labels that start mid-line in a PDF text layer ("AC 17 Initiative +2 (12)"), with how their value starts. */
const INLINE = {
  AC: /\d/, 'Armor Class': /\d/, Initiative: /[+\-−–]?\s?\d/, HP: /\d/, 'Hit Points': /\d/, Speed: /\d/, CR: /\d/, Challenge: /\d/,
} as const;

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
type Key = (typeof ABILITIES)[number];
const abilityOf = (cell: string): Key | undefined => {
  const t = stripInline(cell).toLowerCase().replace(/\.$/, '');
  return ABILITIES.find((a) => t === a || ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'][ABILITIES.indexOf(a)] === t);
};
const leadingNumber = (cell: string | undefined) => {
  const m = /^\s*(\d{1,2})\b/.exec(stripInline(cell ?? ''));
  return m ? Number(m[1]) : undefined;
};
const complete = (scores: Partial<AbilityScores>): AbilityScores | null =>
  ABILITIES.every((a) => typeof scores[a] === 'number' && (scores[a] as number) > 0) ? (scores as AbilityScores) : null;

/** The ability table: a header naming the six abilities (a Score row, or one row of "14 (+2)" cells), or a grid of "| Str | 16 | +3 |" rows. */
function abilitiesFromTables(text: string): AbilityScores | null {
  for (const table of parseTables(text)) {
    const cols = table.header.map(abilityOf);
    if (new Set(cols.filter(Boolean)).size === 6) {
      const score = table.rows.find((r) => /^score$/i.test(stripInline(r[0] ?? ''))) ?? (table.rows.length === 1 ? table.rows[0] : undefined);
      if (!score) continue;
      const out: Partial<AbilityScores> = {};
      cols.forEach((a, i) => {
        if (a && out[a] === undefined) out[a] = leadingNumber(score[i]);
      });
      const done = complete(out);
      if (done) return done;
    }
    const grid: Partial<AbilityScores> = {};
    for (const row of [table.header, ...table.rows]) {
      row.forEach((cell, i) => {
        const a = abilityOf(cell);
        if (a && grid[a] === undefined) grid[a] = leadingNumber(row[i + 1]);
      });
    }
    const done = complete(grid);
    if (done) return done;
  }
  return null;
}

/** A PDF text layer: "Str 16 +3 +3" (2024 grid) or "STR 14 (+2)" lines; or the 2014 "STR DEX CON INT WIS CHA" line over "14 (+2) …". */
function abilitiesFromLines(text: string): AbilityScores | null {
  const flat = plain(text);
  const out: Partial<AbilityScores> = {};
  for (const m of flat.matchAll(/\b(STR|DEX|CON|INT|WIS|CHA)\.?\s+(\d{1,2})(?=\s|\(|$)/gi)) {
    const a = m[1].toLowerCase() as Key;
    if (out[a] === undefined) out[a] = Number(m[2]);
  }
  const direct = complete(out);
  if (direct) return direct;
  const lines = textLines(text).map(plain);
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!/^STR\s+DEX\s+CON\s+INT\s+WIS\s+CHA$/i.test(lines[i])) continue;
    const values = [...lines[i + 1].matchAll(/(\d{1,2})\s*\([+\-−–]?\d+\)/g)].map((m) => Number(m[1]));
    if (values.length === 6) return Object.fromEntries(ABILITIES.map((a, j) => [a, values[j]])) as AbilityScores;
  }
  return null;
}

/** The longest "reach N ft." among the melee attack lines, as printed. */
function longestReach(text: string): string {
  let best: { ft: number; text: string } | null = null;
  for (const line of textLines(text).map(plain)) {
    if (!/\bMelee\b[^.:]{0,30}?(?:Attack Roll|Weapon Attack|Attack)\s*:/i.test(line)) continue;
    for (const m of line.matchAll(/\breach\s+(\d+)\s*(?:ft\.?|feet)/gi)) {
      const ft = Number(m[1]);
      if (!best || ft > best.ft) best = { ft, text: m[0] };
    }
  }
  return best?.text ?? '';
}

function formatOf(text: string, crText: string, initiative: string): Wire<'monster'>['format'] {
  if (/XP\s*[\d,]+.*PB/i.test(crText) || initiative || /\bAttack Roll\s*:/i.test(plain(text))) return '2024';
  if (/\(\s*[\d,]+\s*XP\s*\)/i.test(crText) || /\bWeapon Attack\s*:/i.test(plain(text))) return '2014';
  return 'other';
}

const KEY_FIELDS = ['sizeText', 'typeText', 'acText', 'hpText', 'speedText', 'crText', 'abilityScores'] as const;

export function parseMonster(candidate: Candidate & { kind: 'monster' }): OfflineParse<'monster'> {
  const text = candidate.blocks.map((b) => b.text ?? b.paragraphs.join('\n\n')).join('\n\n');
  const descriptorLine = textLines(text)
    .slice(0, 8)
    .map(plain)
    .find((l) => DESCRIPTOR.test(l)) ?? firstTextLine(text);
  const d = DESCRIPTOR.exec(descriptorLine);
  const v = labeledValues(text, LABELS, { inline: INLINE });
  const get = (...labels: string[]) => labels.map((l) => v.get(l)).find(Boolean) ?? '';
  const immunities = get('Immunities') || [v.get('Damage Immunities'), v.get('Condition Immunities')].filter(Boolean).join('; ');
  const abilities = abilitiesFromTables(text) ?? abilitiesFromLines(text);
  const crText = get('CR', 'Challenge');
  const initiativeText = get('Initiative');
  const wire: Wire<'monster'> = {
    matchesKind: true,
    name: candidate.name,
    format: formatOf(text, crText, initiativeText),
    sizeText: d?.[1].trim() ?? '',
    typeText: d?.[2].trim() ?? '',
    alignmentText: d?.[3].trim() ?? '',
    acText: get('AC', 'Armor Class'),
    hpText: get('HP', 'Hit Points'),
    speedText: get('Speed'),
    initiativeText,
    crText,
    abilityScores: abilities ?? { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
    sensesText: get('Senses'),
    languagesText: get('Languages'),
    resistancesText: get('Resistances', 'Damage Resistances'),
    immunitiesText: immunities,
    vulnerabilitiesText: get('Vulnerabilities', 'Damage Vulnerabilities'),
    reachText: longestReach(text),
    legendary: /^(?:#{1,6}[ \t]*|[*_]{0,3})Legendary Actions\b/im.test(text),
    notes: '',
  };
  const missing = KEY_FIELDS.filter((f) => (f === 'abilityScores' ? !abilities : !wire[f]));
  return { wire, missing };
}
