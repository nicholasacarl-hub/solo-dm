/**
 * Offline spell parser (spec §3.9): the level-and-school line ("_Level 2 Evocation (Sorcerer, Wizard)_",
 * "_Evocation Cantrip (Bard)_", older "*3rd-level evocation (ritual)*"), Casting Time / Range /
 * Components / Duration as bullets or lines, then from the description: the saving throw, a spell
 * attack, the first damage and the cantrip's damage by character level, and the area phrase.
 *
 * Owner: E2. Pure.
 */
import type { Candidate } from '../segment';
import type { Wire } from '../wire';
import type { OfflineParse } from './index';
import { labeledValues, plain, proseParagraphs, textLines } from './lines';

const SCHOOLS = ['abjuration', 'conjuration', 'divination', 'enchantment', 'evocation', 'illusion', 'necromancy', 'transmutation'] as const;
const SCHOOL = SCHOOLS.join('|');
/** "Level 2 Evocation", "Evocation Cantrip", "3rd-level evocation" (case-insensitive). */
export const SPELL_LINE = new RegExp(String.raw`\b(?:Level\s+(\d)\s+(${SCHOOL})|(${SCHOOL})\s+Cantrip|(\d)(?:st|nd|rd|th)[- ]level\s+(${SCHOOL}))\b`, 'i');

const ABILITY_WORD: Readonly<Record<string, Wire<'spell'>['saveAbility']>> = {
  strength: 'str', dexterity: 'dex', constitution: 'con', intelligence: 'int', wisdom: 'wis', charisma: 'cha',
};

/** "20-foot", "20 feet", "40-foothigh" + an optional qualifier (engine/areas.ts's MEASURE). */
const MEASURE = String.raw`\d+\s*-?\s*(?:foot|feet)\s*-?\s*(?:long|wide|radius|high|tall)?`;
const SHAPES = String.raw`(?:Line|Cylinder|Sphere|Cone|Cube|Emanation|square|circle)`;
/** The area phrases engine/areas.ts parseAreaText reads, as text: "20-foot-radius Sphere", "a Line 60 feet long". */
const AREA_PHRASE = new RegExp(
  String.raw`\b${MEASURE}(?:\s*,?\s*(?:and\s+)?${MEASURE})?[\s-]+${SHAPES}\b|\b(?:Line|Cylinder)\b(?:\s+(?:of\s+[a-z ]+?|that\s+is))?\s+${MEASURE}(?:\s*(?:,|and|with\s+a)\s*${MEASURE})?`,
  'i',
);

/** The level line: the first line naming a level and school. */
function levelLine(text: string): { text: string; level: number; school: Wire<'spell'>['school']; classes: string; ritual: boolean } | null {
  for (const raw of textLines(text).slice(0, 6)) {
    const line = plain(raw);
    const m = SPELL_LINE.exec(line);
    if (!m) continue;
    const level = Number(m[1] ?? m[4] ?? 0);
    const school = (m[2] ?? m[3] ?? m[5]).toLowerCase() as Wire<'spell'>['school'];
    const paren = /\(([^)]*)\)\s*$/.exec(line)?.[1].trim() ?? '';
    const ritual = /^ritual$/i.test(paren) || /\britual\b/i.test(line);
    const classes = /^ritual$/i.test(paren) ? '' : paren;
    return { text: line, level, school, classes, ritual };
  }
  return null;
}

/** "levels 5 (2d10), 11 (3d10), and 17 (4d10)" (2024) or "5th level (2d10), 11th level (3d10), and 17th level (4d10)" (older). */
const SCALING = /\blevels?\s+5\s*\(\d+d\d+\),\s*11\s*\(\d+d\d+\),?\s*(?:and\s+)?17\s*\(\d+d\d+\)|\b5th\s+level\s*\(\d+d\d+\),\s*11th\s+level\s*\(\d+d\d+\),?\s*(?:and\s+)?17th\s+level\s*\(\d+d\d+\)/i;

/** The first damage it deals: "8d6 Fire damage", "Force damage equal to 4d12", "3d8 damage" (of a chosen type). */
const DAMAGE_EXCERPT = /\d+d\d+(?:\s*[+−-]\s*\d+)?\s+\w+\s+damage|\b\w+\s+damage\s+equal\s+to\s+\d+d\d+(?:\s*[+−-]\s*\d+)?|\d+d\d+(?:\s*[+−-]\s*\d+)?\s+damage/i;

function formatOf(line: string, hasClasses: boolean): Wire<'spell'>['format'] {
  if (/\d(?:st|nd|rd|th)[- ]level/i.test(line)) return '2014';
  if (/^Level\s+\d/i.test(line) || hasClasses) return '2024';
  if (/\bcantrip\b/.test(line)) return '2014';
  return 'other';
}

const KEY_FIELDS = ['levelText', 'castingTimeText', 'rangeText', 'durationText'] as const;

export function parseSpell(candidate: Candidate & { kind: 'spell' }): OfflineParse<'spell'> {
  const text = candidate.blocks.map((b) => b.text ?? b.paragraphs.join('\n\n')).join('\n\n');
  const line = levelLine(text);
  const v = labeledValues(text, ['Casting Time', 'Range', 'Components', 'Duration']);
  const castingTime = v.get('Casting Time') ?? '';
  const duration = v.get('Duration') ?? '';
  const range = v.get('Range') ?? '';
  const prose = proseParagraphs(text)
    .filter((p) => !SPELL_LINE.test(plain(p).slice(0, 80)) && !/^(?:Casting Time|Range|Components|Duration)\s*:/i.test(plain(p)))
    .map(plain)
    .join('\n');
  const area = AREA_PHRASE.exec(prose)?.[0] ?? AREA_PHRASE.exec(range)?.[0] ?? '';
  const save = /\b(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s+saving\s+throw/i.exec(prose)?.[1];
  const attack = /\b(melee|ranged)\s+spell\s+attack/i.exec(prose)?.[1].toLowerCase();
  const damage = DAMAGE_EXCERPT.exec(prose)?.[0] ?? '';
  const scaling = SCALING.exec(prose)?.[0] ?? '';
  const wire: Wire<'spell'> = {
    matchesKind: true,
    name: candidate.name,
    format: line ? formatOf(line.text, Boolean(line.classes)) : 'other',
    levelText: line?.text ?? '',
    level: line?.level ?? 0,
    school: line?.school ?? 'unknown',
    classesText: line?.classes ?? '',
    castingTimeText: castingTime,
    rangeText: range,
    componentsText: v.get('Components') ?? '',
    durationText: duration,
    ritual: Boolean(line?.ritual) || /\bor\s+Ritual\b/i.test(castingTime),
    concentration: /^concentration\b/i.test(duration),
    areaText: area,
    saveAbility: save ? (ABILITY_WORD[save.toLowerCase()] ?? 'none') : 'none',
    attack: attack === 'melee' || attack === 'ranged' ? attack : 'none',
    damageText: damage,
    cantripScalingText: line?.level === 0 ? scaling : '',
    notes: '',
  };
  const missing = KEY_FIELDS.filter((f) => !wire[f]);
  return { wire, missing };
}
