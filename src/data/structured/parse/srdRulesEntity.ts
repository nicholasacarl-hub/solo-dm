/**
 * TypeScript ports of scripts/build-srd.mjs's entity helpers (spec §3.9): the app bundle never imports
 * the Node script, so the monster, spell, magic-item and gear parsers use these. srdRulesEntity.test.ts
 * checks them against the script's exported helpers on shared strings; the unexported ones
 * (parseSpeeds, CR_LINE) are covered by the SRD parity test.
 *
 * Changes from the script, each noted at the helper: parseSpeeds and parseCrLine accept the older
 * layout ("fly 60 ft.", "1 (200 XP)" without a PB part); parseMagicItemSubtitle also reads a lowercase
 * older-format line ("Armor (plate), rare (requires attunement by a wizard)").
 *
 * Owner: E2. Pure.
 */
import type { CreatureSpeeds } from '@/types';

const round = (n: number, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;

/** Split on a separator, ignoring separators inside parentheses. */
export function splitTopLevel(text: string, separator = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const isTableLine = (line: string) => /^\s*\|/.test(line);

export function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

const isSeparatorRow = (cells: readonly string[]) => cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));

export interface MarkdownTable { header: string[]; rows: string[][] }

/** Every GFM table in a Markdown string: header cells and body rows. */
export function parseTables(md: string): MarkdownTable[] {
  const lines = md.split('\n');
  const tables: MarkdownTable[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!isTableLine(lines[i]) || !isTableLine(lines[i + 1]) || !isSeparatorRow(splitRow(lines[i + 1]))) continue;
    const header = splitRow(lines[i]);
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length && isTableLine(lines[j]); j++) rows.push(splitRow(lines[j]));
    tables.push({ header, rows });
    i = j - 1;
  }
  return tables;
}

export function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1');
}

/** Plain text of an inline Markdown fragment. */
export function stripInline(text: string): string {
  return unescapeMarkdown(text.replace(/[*_]/g, '')).replace(/\s+/g, ' ').trim();
}

/** Bullets of the form "- **Label:** value" (or "- **Label** value") in a block of Markdown. */
export function boldBullets(md: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of md.matchAll(/^- \*\*([^*]+?):?\*\*:? (.+)$/gm)) out.set(m[1].replace(/:$/, '').trim(), m[2].trim());
  return out;
}

/** "1 SP" -> 0.1, "1,500 GP" -> 1500, "Varies" -> undefined. */
export function parseCostGp(text: string | undefined): number | undefined {
  const m = /^([\d,]+(?:\.\d+)?)\s*(CP|SP|EP|GP|PP)\b/i.exec((text ?? '').trim());
  if (!m) return undefined;
  const rate = { cp: 0.01, sp: 0.1, ep: 0.5, gp: 1, pp: 10 }[m[2].toLowerCase() as 'cp' | 'sp' | 'ep' | 'gp' | 'pp'];
  return round(Number(m[1].replace(/,/g, '')) * rate);
}

/** "2 lb." -> 2, "1/4 lb." -> 0.25, "58 1/2 lb." -> 58.5, "—" -> undefined. */
export function parseWeightLb(text: string | undefined): number | undefined {
  const m = /^(?:(\d[\d,]*)(?:\s+(\d+)\/(\d+))?|(\d+)\/(\d+))\s*lb\b/i.exec((text ?? '').trim());
  if (!m) return undefined;
  if (m[4]) return round(Number(m[4]) / Number(m[5]));
  const whole = Number(m[1].replace(/,/g, ''));
  return round(m[2] ? whole + Number(m[2]) / Number(m[3]) : whole);
}

export const crToNumber = (cr: string): number => (cr.includes('/') ? Number(cr.split('/')[0]) / Number(cr.split('/')[1]) : Number(cr));

/** The proficiency bonus of a challenge rating (SRD 5.2.1 "Monsters": +2 up to CR 4, then +1 every 4 CRs, max +9). */
export function proficiencyBonusForCr(cr: number): number {
  return cr < 5 ? 2 : Math.min(9, 2 + Math.ceil((cr - 4) / 4));
}

/** XP by Challenge Rating (SRD 5.2.1 "Monsters" › "Experience Points by Challenge Rating"). */
export const XP_BY_CR: Readonly<Record<number, number>> = {
  0: 10, 0.125: 25, 0.25: 50, 0.5: 100, 1: 200, 2: 450, 3: 700, 4: 1100, 5: 1800, 6: 2300, 7: 2900,
  8: 3900, 9: 5000, 10: 5900, 11: 7200, 12: 8400, 13: 10000, 14: 11500, 15: 13000, 16: 15000,
  17: 18000, 18: 20000, 19: 22000, 20: 25000, 21: 33000, 22: 41000, 23: 50000, 24: 62000,
  25: 75000, 26: 90000, 27: 105000, 28: 120000, 29: 135000, 30: 155000,
};

/**
 * The script's CR_LINE, extended to the older layout: "3 (XP 700; PB +2)", "10 (XP 5,900, or 7,200 in
 * lair; PB +4)", "1 (200 XP)", "1/4 (50 XP)". Zero-width tolerant about spaces.
 */
const CR_LINE = /^(\d+(?:\/\d+)?)\s*\(\s*(?:XP\s*([\d,]+)|([\d,]+)\s*XP)(?:,?\s*or\s*([\d,]+)\s*in lair)?(?:\s*;\s*PB\s*\+\s*(\d+))?\s*\)/i;

export interface CrLine { cr: string; crValue: number; xp: number; xpInLair?: number; pb?: number }

export function parseCrLine(text: string): CrLine | null {
  const m = CR_LINE.exec(text.trim());
  if (!m) {
    const bare = /^(\d+(?:\/\d+)?)(?!\S)/.exec(text.trim());
    if (!bare) return null;
    const crValue = crToNumber(bare[1]);
    return Number.isFinite(crValue) ? { cr: bare[1], crValue, xp: XP_BY_CR[crValue] ?? 0 } : null;
  }
  const crValue = crToNumber(m[1]);
  return {
    cr: m[1],
    crValue,
    xp: Number((m[2] ?? m[3]).replace(/,/g, '')),
    ...(m[4] ? { xpInLair: Number(m[4].replace(/,/g, '')) } : {}),
    ...(m[5] ? { pb: Number(m[5]) } : {}),
  };
}

/** "30 ft., Fly 60 ft. (hover)" → { walk: 30, fly: 60, hover: true }; case-insensitive (older "fly 60 ft."). */
export function parseSpeeds(speed: string): CreatureSpeeds {
  const out: CreatureSpeeds = {};
  for (const part of splitTopLevel(speed, ',')) {
    const m = /^(?:(Walk|Burrow|Climb|Fly|Swim) )?(\d+) ft\.?(?: \((hover)\))?/i.exec(part.trim());
    if (!m) continue;
    const key = (m[1] ?? 'walk').toLowerCase() as 'walk' | 'burrow' | 'climb' | 'fly' | 'swim';
    if (out[key] === undefined) out[key] = Number(m[2]);
    if (m[3]) out.hover = true;
  }
  return out;
}

const RARITY_WORDS = /\b(Very Rare|Uncommon|Common|Rare|Legendary|Artifact|Rarity Varies)\b/gi;
const MAGIC_ITEM_CATEGORY: Readonly<Record<string, string>> = {
  'wondrous item': 'wondrous-item',
  weapon: 'weapon',
  armor: 'armor',
  ring: 'ring',
  rod: 'rod',
  staff: 'staff',
  wand: 'wand',
  potion: 'potion',
  scroll: 'scroll',
};

export interface MagicItemSubtitle {
  categoryText: string;
  category: string | undefined;
  baseItem: string | undefined;
  rarityText: string;
  rarity: string;
  attunement: string | boolean;
}

/**
 * "_Armor (Chain Mail), Rare (Requires Attunement)_" → category, base item, rarity, attunement. The
 * script's rule, made case-insensitive for older lines ("Armor (plate), rare (requires attunement by a
 * wizard)"); for the script's own inputs the result is identical.
 */
export function parseMagicItemSubtitle(subtitle: string): MagicItemSubtitle {
  const inner = subtitle.replace(/^_|_$/g, '').trim();
  const parts = splitTopLevel(inner, ',');
  const categoryText = parts[0] ?? '';
  let rest = inner.slice(inner.indexOf(categoryText) + categoryText.length).replace(/^,\s*/, '');
  const att = /\s*\((Requires Attunement(?: [^)]*)?)\)/i.exec(rest);
  if (att) rest = (rest.slice(0, att.index) + rest.slice(att.index + att[0].length)).trim();
  const base = /^([^(]+?)(?: \(([^)]*)\))?$/.exec(categoryText);
  const category = MAGIC_ITEM_CATEGORY[(base?.[1] ?? categoryText).toLowerCase()];
  const rarities = [...rest.matchAll(RARITY_WORDS)].map((m) => m[1].toLowerCase());
  const unique = [...new Set(rarities)];
  return {
    categoryText,
    category,
    baseItem: base?.[2],
    rarityText: rest,
    rarity: unique.length === 1 && unique[0] !== 'rarity varies' ? unique[0] : 'varies',
    attunement: att ? att[1].replace(/^Requires Attunement\s*/i, '') || true : false,
  };
}
