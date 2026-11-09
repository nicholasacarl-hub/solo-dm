/**
 * Offline magic-item parser (spec §3.9): the type line under the name (parseMagicItemSubtitle, the
 * build-srd rule: "_Armor (Chain Mail), Rare (Requires Attunement)_"; older "*Armor (plate), rare
 * (requires attunement by a wizard)*"), flat bonuses only from "+N bonus to AC / Armor Class / attack and
 * damage rolls / saving throws" sentences, and "has N charges".
 *
 * Owner: E2. Pure.
 */
import type { Candidate } from '../segment';
import type { Wire } from '../wire';
import type { OfflineParse } from './index';
import { plain, proseParagraphs, textLines } from './lines';
import { parseMagicItemSubtitle } from './srdRulesEntity';

const RARITY = /\b(very rare|uncommon|common|rare|legendary|artifact|rarity varies|varies)\b/i;
const CATEGORY_WORD = /^(?:wondrous item|weapon|armor|ring|rod|staff|wand|potion|scroll|shield|ammunition)\b/i;

type Category = Wire<'magic-item'>['category'];
type Rarity = Wire<'magic-item'>['rarity'];

/** The type line: the first line that starts with a category word and names a rarity (or attunement). */
function typeLine(text: string): string {
  for (const raw of textLines(text).slice(0, 5)) {
    const line = plain(raw);
    if (CATEGORY_WORD.test(line) && (RARITY.test(line) || /requires attunement/i.test(line))) return line;
  }
  return '';
}

function categoryOf(categoryText: string, mapped: string | undefined, baseItem: string | undefined): Category {
  const word = categoryText.toLowerCase();
  if (word.startsWith('shield') || (mapped === 'armor' && /^shield$/i.test(baseItem ?? ''))) return 'shield';
  if (word.startsWith('ammunition') || (mapped === 'weapon' && /^(?:any\s+)?ammunition$|^arrows?$|^bolts?$/i.test(baseItem ?? ''))) return 'ammunition';
  const known: readonly Category[] = ['armor', 'weapon', 'ring', 'rod', 'staff', 'wand', 'potion', 'scroll', 'wondrous-item'];
  return known.includes(mapped as Category) ? (mapped as Category) : 'other';
}

interface Bonus { ac: number; save: number; attack: number; damage: number; text: string; condition: Wire<'magic-item'>['acCondition'] }

/** Flat bonuses from "+N bonus to …" sentences (the first sentence that states each); bonusText joins every phrase used with "; ". */
function bonuses(prose: string): Bonus {
  const out: Bonus = { ac: 0, save: 0, attack: 0, damage: 0, text: '', condition: 'always' };
  const sentences = prose.split(/(?<=[.!?])\s+/);
  const texts: string[] = [];
  for (const sentence of sentences) {
    const m = /\+(\d)\s+bonus\s+to\s+((?:AC|Armor Class|attack(?:\s+rolls)?|damage(?:\s+rolls)?|saving throws)(?:(?:,\s*|\s+and\s+|,\s+and\s+)(?:AC|Armor Class|attack(?:\s+rolls)?|damage(?:\s+rolls)?|saving throws))*)/i.exec(sentence);
    if (!m) continue;
    const n = Number(m[1]);
    const targets = m[2].toLowerCase();
    let used = false;
    if (/\b(?:ac|armor class)\b/.test(targets) && !out.ac) {
      out.ac = n;
      used = true;
      const noArmor = /\b(?:wear(?:ing)? no armor|no armor|aren't wearing (?:any )?armor|not wearing (?:any )?armor)\b/i.test(sentence);
      const noShield = /\b(?:no shield|not using a shield|aren't using a shield|using no shield|without a shield)\b/i.test(sentence);
      if (noArmor) out.condition = noShield ? 'no-armor-no-shield' : 'no-armor';
    }
    if (/\bsaving throws\b/.test(targets) && !out.save) {
      out.save = n;
      used = true;
    }
    if (/\battack\b/.test(targets) && !out.attack) {
      out.attack = n;
      used = true;
    }
    if (/\bdamage\b/.test(targets) && !out.damage) {
      out.damage = n;
      used = true;
    }
    if (used) texts.push(m[0].trim());
  }
  out.text = texts.join('; ');
  return out;
}

function formatOf(line: string): Wire<'magic-item'>['format'] {
  if (!line) return 'other';
  if (/\((?:requires attunement)[^)]*\)/.test(line) || /,\s*(?:very rare|uncommon|common|rare|legendary|artifact)\b/.test(line)) return '2014';
  return '2024';
}

const KEY_FIELDS = ['typeLineText'] as const;

export function parseMagicItem(candidate: Candidate & { kind: 'magic-item' }): OfflineParse<'magic-item'> {
  const text = candidate.blocks.map((b) => b.text ?? b.paragraphs.join('\n\n')).join('\n\n');
  const line = typeLine(text);
  const sub = line ? parseMagicItemSubtitle(line) : null;
  const rarityWord = sub ? (sub.rarity === 'varies' ? (RARITY.test(sub.rarityText) ? 'varies' : 'unknown') : sub.rarity) : 'unknown';
  const prose = proseParagraphs(text).map(plain).filter((p) => p !== line).join('\n');
  const b = bonuses(prose);
  const attunement = sub?.attunement;
  const wire: Wire<'magic-item'> = {
    matchesKind: true,
    name: candidate.name,
    format: formatOf(line),
    typeLineText: line,
    category: sub ? categoryOf(sub.categoryText, sub.category, sub.baseItem) : 'other',
    rarity: rarityWord as Rarity,
    attunement: attunement === true ? 'required' : typeof attunement === 'string' && attunement ? 'required-by' : 'none',
    attunementText: typeof attunement === 'string' ? attunement : '',
    baseItemText: sub?.baseItem?.trim() ?? '',
    acBonus: b.ac,
    saveBonus: b.save,
    attackBonus: b.attack,
    damageBonus: b.damage,
    bonusText: b.text,
    acCondition: b.condition,
    chargesText: /\bhas\s+\d+\s+charges\b/i.exec(prose)?.[0] ?? '',
    notes: '',
  };
  const missing: string[] = KEY_FIELDS.filter((f) => !wire[f]);
  if (wire.category === 'other') missing.push('category');
  if (wire.rarity === 'unknown') missing.push('rarity');
  return { wire, missing };
}
