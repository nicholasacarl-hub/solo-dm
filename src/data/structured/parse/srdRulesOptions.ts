/**
 * TypeScript ports of scripts/build-srd.mjs's character-option helpers (spec §3.9): the app bundle never
 * imports the Node script, so the option parsers and normalizers use these, and a port-identity test
 * checks them against the script's exported helpers on shared strings. Unexported script helpers
 * (levelTableKey, typeLevelTable, lineagesFrom, firstParagraphs) are covered by the SRD parity test.
 *
 * Owner: E4. Pure.
 */
import { slugify } from '@/lib/id';
import type { Ability, EquipmentPackage, Skill } from '@/types';

const ABILITY_BY_NAME: Readonly<Record<string, Ability>> = {
  strength: 'str',
  dexterity: 'dex',
  constitution: 'con',
  intelligence: 'int',
  wisdom: 'wis',
  charisma: 'cha',
};

export const SKILL_LABELS: Readonly<Record<Skill, string>> = {
  acrobatics: 'Acrobatics',
  'animal-handling': 'Animal Handling',
  arcana: 'Arcana',
  athletics: 'Athletics',
  deception: 'Deception',
  history: 'History',
  insight: 'Insight',
  intimidation: 'Intimidation',
  investigation: 'Investigation',
  medicine: 'Medicine',
  nature: 'Nature',
  perception: 'Perception',
  performance: 'Performance',
  persuasion: 'Persuasion',
  religion: 'Religion',
  'sleight-of-hand': 'Sleight of Hand',
  stealth: 'Stealth',
  survival: 'Survival',
};

/** Letters and digits only ("Sleight of Hand" = "sleightofhand"). */
export function compactKey(text: string): string {
  return slugify(text).replace(/-/g, '');
}

const SKILL_BY_KEY = new Map<string, Skill>((Object.entries(SKILL_LABELS) as [Skill, string][]).map(([id, name]) => [compactKey(name), id]));

/** A skill by its printed name ("Animal Handling", "sleight of hand"), or undefined. */
export function skillByName(name: string): Skill | undefined {
  return SKILL_BY_KEY.get(compactKey(name));
}

/** "Rage Damage" -> "rageDamage". */
export function camelKey(label: string): string {
  const words = label.replace(/['’]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join('');
}

export function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1');
}

/** Plain text of an inline Markdown fragment. */
export function stripInline(text: string): string {
  return unescapeMarkdown(text.replace(/[*_]/g, '')).replace(/\s+/g, ' ').trim();
}

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

/** The cells of one Markdown table row. */
export function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

const isSeparatorRow = (cells: string[]) => cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));

export interface MarkdownTable {
  header: string[];
  rows: string[][];
}

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

/** "1 SP" -> 0.1, "1,500 GP" -> 1500, "Varies" -> undefined. */
export function parseCostGp(text: string | undefined): number | undefined {
  const m = /^([\d,]+(?:\.\d+)?)\s*(CP|SP|EP|GP|PP)\b/i.exec((text ?? '').trim());
  if (!m) return undefined;
  const rate = ({ cp: 0.01, sp: 0.1, ep: 0.5, gp: 1, pp: 10 } as Record<string, number>)[m[2].toLowerCase()];
  return round(Number(m[1].replace(/,/g, '')) * rate);
}

/** The first paragraph(s) of Markdown text, up to `max` characters (cut at a sentence end). */
export function firstParagraphs(md: string, max: number): string | undefined {
  const paras = md
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('|') && !p.startsWith('#'));
  let out = '';
  for (const p of paras) {
    const next = out ? `${out}\n\n${p}` : p;
    if (next.length > max) {
      if (!out) out = truncateAtSentence(p, max);
      break;
    }
    out = next;
  }
  return out || undefined;
}

function truncateAtSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
  return end > max * 0.4 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
}

// ---------------------------------------------------------------------------
// Starting equipment
// ---------------------------------------------------------------------------

function singularize(word: string, known: ReadonlySet<string>): string {
  const candidates = [word.replace(/s$/, ''), word.replace(/es$/, ''), word.replace(/ies$/, 'y')];
  return candidates.find((c) => c !== word && known.has(compactKey(c))) ?? word;
}

/** "2 Daggers" → 2 × Dagger (when "Dagger" is a known item), "Oil (2 flasks)" → 2 × Oil. */
export function parseItemPhrase(phrase: string, known: ReadonlySet<string>): { name: string; quantity: number } {
  const text = phrase
    .replace(/\s*\(same as above\)$/i, '')
    .replace(/^(.+?) (of your choice|chosen for the tool proficiency above)$/i, '$1 ($2)')
    .trim();
  const counted = /^(\d+)\s+(.+)$/.exec(text);
  if (counted) return { name: singularize(counted[2], known), quantity: Number(counted[1]) };
  const sheets = /^(.+?)\s+\((\d+)\s+[a-z]+\)$/.exec(text);
  if (sheets) return { name: sheets[1], quantity: Number(sheets[2]) };
  return { name: text, quantity: 1 };
}

/** "Choose A or B: (A) 2 Daggers, Robe, and 5 GP; or (B) 55 GP" -> EquipmentPackage[] (`known`: compactKeys of catalog names). */
export function parseEquipmentChoices(text: string, known: ReadonlySet<string> = new Set()): EquipmentPackage[] {
  const clean = stripInline(text).replace(/\s*\(see "[^"]+"\)/g, '').replace(/^Choose [^:]*:\s*/, '');
  const packages: EquipmentPackage[] = [];
  for (const m of clean.matchAll(/\(([A-Z])\)\s*(.*?)(?=;\s*(?:or\s+)?\([A-Z]\)|$)/g)) {
    packages.push({ label: `Option ${m[1]}`, ...itemsAndGold(m[2], known) });
  }
  return packages;
}

/** One package's items and coins: "Leather Armor, Dagger, and 8 GP". */
export function itemsAndGold(list: string, known: ReadonlySet<string> = new Set()): Omit<EquipmentPackage, 'label'> {
  const items: EquipmentPackage['items'] = [];
  let gp = 0;
  for (const rawPart of splitTopLevel(list.replace(/[;.]\s*$/, ''), ',')) {
    const part = rawPart.replace(/^(and|or)\s+/, '').trim();
    const money = /^(\d[\d,]*)\s*(CP|SP|EP|GP|PP)$/i.exec(part);
    if (money) gp += parseCostGp(part) ?? 0;
    else if (part) items.push(parseItemPhrase(part, known));
  }
  return { items, gp: round(gp, 2) };
}

// ---------------------------------------------------------------------------
// Abilities, skills, weapons and armor
// ---------------------------------------------------------------------------

export function parseAbilityList(text: string | undefined): Ability[] {
  return [...(text ?? '').matchAll(/\b(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\b/g)].map(
    (m) => ABILITY_BY_NAME[m[1].toLowerCase()],
  );
}

/** "Choose 2: Arcana, History, or Insight" → { count: 2, from }; names it doesn't know go to `unknown`. Null when unreadable. */
export function parseSkillChoices(text: string): { count: number; from: Skill[]; unknown: string[] } | null {
  const any = /^Choose any (\d+) skills/i.exec(text);
  if (any) return { count: Number(any[1]), from: Object.keys(SKILL_LABELS) as Skill[], unknown: [] };
  const m = /^Choose (\d+): (.+)$/.exec(stripInline(text));
  if (!m) return null;
  const from: Skill[] = [];
  const unknown: string[] = [];
  for (const raw of m[2].split(/,\s*(?:or\s+)?|\s+or\s+/)) {
    const id = SKILL_BY_KEY.get(compactKey(raw));
    if (id) from.push(id);
    else unknown.push(raw.trim());
  }
  return { count: Number(m[1]), from, unknown };
}

export function parseWeaponProficiencies(text: string): string[] {
  const t = stripInline(text);
  if (/^Simple and Martial weapons$/i.test(t)) return ['Simple weapons', 'Martial weapons'];
  return t.split(/\s+and\s+(?=Martial\b)/).map((p) => p.trim());
}

export function parseArmorTraining(text: string): string[] {
  const t = stripInline(text);
  if (/^None$/i.test(t)) return [];
  const kinds = ['Light', 'Medium', 'Heavy'].filter((k) => new RegExp(`\\b${k}\\b`).test(t)).map((k) => `${k} armor`);
  return /\bShields?\b/.test(t) ? [...kinds, 'Shields'] : kinds;
}

// ---------------------------------------------------------------------------
// Class level tables
// ---------------------------------------------------------------------------

const ORDINAL_SLOT: Readonly<Record<string, number>> = { '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5, '6th': 6, '7th': 7, '8th': 8, '9th': 9 };

/**
 * A class-table header as a builder.json key (the build script's levelTableKey, plus the extra
 * headers §3.9.1 names: "Features", "Cantrips Known", "Spells Known").
 */
export function levelTableKey(header: string): string {
  const h = stripInline(header);
  if (h === 'Level') return 'level';
  if (h === 'Class Features' || h === 'Features') return 'features';
  if (h === 'Proficiency Bonus') return 'proficiencyBonus';
  const slot = /^(?:Spell Slots(?: per Spell Level)?\s*[-–—:]\s*)?(\d(?:st|nd|rd|th))$/i.exec(h);
  if (slot) return `slot${ORDINAL_SLOT[slot[1].toLowerCase()]}`;
  if (h === 'Spell Slots') return 'pactSlots';
  if (h === 'Slot Level') return 'pactSlotLevel';
  if (/^Cantrips(?: Known)?$/i.test(h)) return 'cantrips';
  if (/^Prepared Spells$/i.test(h)) return 'preparedSpells';
  if (/^Spells Known$/i.test(h)) return 'spellsKnown';
  return camelKey(h);
}

/** Integer columns become numbers ("—" -> 0); other columns keep their text (the build script's typeLevelTable). */
export function typeLevelTable(rows: Record<string, string | number>[]): Record<string, string | number>[] {
  if (!rows.length) return [];
  const keys = Object.keys(rows[0]).filter((k) => k !== 'level' && k !== 'features');
  const numeric = new Set(keys.filter((k) => rows.every((r) => r[k] === undefined || /^(\+?-?\d+|—)$/.test(String(r[k]).trim()))));
  return rows.map((r) => {
    const out: Record<string, string | number> = { level: r.level };
    for (const [k, v] of Object.entries(r)) {
      if (k === 'level') continue;
      if (numeric.has(k)) out[k] = String(v).trim() === '—' ? 0 : Number(String(v).replace('+', ''));
      else out[k] = String(v).trim();
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Species traits and lineages
// ---------------------------------------------------------------------------

/** A lineage table row's text the SRD way: "<Level 1>. Level 3: <spell>. Level 5: <spell>." (the build script's lineagesFrom rule). */
export function lineageRowText(cells: readonly string[]): string {
  const [, first = '', third = '', fifth = ''] = cells.map((c) => (c.trim() === '—' ? '' : c.trim()));
  return `${first}${third ? ` Level 3: ${third}.` : ''}${fifth ? ` Level 5: ${fifth}.` : ''}`;
}

/** Lineage options of an SRD-style lineage trait: a Lineage/Legacy table, a Dragon table, or ≥ 2 bold run-ins. */
export function lineagesFrom(trait: { description: string }): { name: string; description: string }[] {
  const table = parseTables(trait.description)[0];
  if (table && /^(Lineage|Legacy)$/.test(table.header[0])) {
    return table.rows.map((r) => ({ name: r[0], description: lineageRowText(r) }));
  }
  if (table && /^Dragon$/.test(table.header[0])) {
    return table.rows.map((r) => ({ name: r[0], description: `${r[1]} damage` }));
  }
  const options = [...trait.description.matchAll(/^\*\*(.+?)\.\*\*\s*(.+)$/gm)].map((m) => {
    const label = stripInline(m[1]);
    const giant = /^(.+?) \((.+)\)$/.exec(label);
    return giant ? { name: giant[2], description: `${giant[1]}. ${m[2].trim()}` } : { name: label, description: m[2].trim() };
  });
  return options.length >= 2 ? options : [];
}

// ---------------------------------------------------------------------------
// Option text helpers (not ports): labels, run-ins and the heading scan of §3.9, shared by the option
// parsers and normalizers. They read SRD-style Markdown, the PDF text layer (no emphasis) and 2014 layouts.
// ---------------------------------------------------------------------------

/** Emphasis and list/quote markers removed, whitespace collapsed. */
export function plainText(text: string): string {
  return text
    .replace(/^\s*(?:[-*+•]\s+|>\s*|#{1,6}\s+)/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const EMPHASIS = String.raw`(?:\*\*\*|\*\*_|_\*\*|\*\*|__|\*|_)`;
const RUN_IN = new RegExp(
  String.raw`^(?:[-*+•]\s+)?(${EMPHASIS})\s*([^*_\n]{1,90}?)\s*(?:[.:!]\s*${EMPHASIS}|${EMPHASIS}\s*[.:!])\s*([\s\S]*)$`,
);

/** How strongly a run-in label is set: "_**X.**_" / "***X.***" (a trait), "**X.**" (often an option inside one), "_X._". */
export type RunInEmphasis = 'strong-em' | 'strong' | 'em';

const emphasisOf = (open: string): RunInEmphasis => (open.length === 3 ? 'strong-em' : open.length === 2 ? 'strong' : 'em');

/** A paragraph's emphasized run-in label: "_**Dusk Sight.**_ You…", "***Size.*** …", "**Feat:** …" → { label, rest, emphasis }. */
export function runIn(paragraph: string): { label: string; rest: string; emphasis: RunInEmphasis } | null {
  const m = RUN_IN.exec(paragraph.trim());
  if (!m) return null;
  const label = m[2].replace(/\s+/g, ' ').trim();
  return label ? { label, rest: m[3].trim(), emphasis: emphasisOf(m[1]) } : null;
}

/**
 * The value after a label at a paragraph's start, in any dialect: "- **Size:** Small", "***Size.*** Your…",
 * "Size: Small", "| Hit Point Die | D8 per … |", and (loose) the flattened table "Hit Point Die D8 per …".
 */
export function labelValue(paragraph: string, label: string, opts: { loose?: boolean } = {}): string | null {
  const line = paragraph.trim();
  const cell = /^\|\s*([^|]+?)\s*\|\s*([\s\S]*?)\s*\|?\s*$/.exec(line);
  if (cell) return new RegExp(`^(?:${label})$`, 'i').test(plainText(cell[1])) ? cell[2].trim() : null;
  const end = opts.loose ? String.raw`(?:[*_]{0,3}\s*[:.]\s*[*_]{0,3}\s*|\s+)` : String.raw`[*_]{0,3}\s*[:.]\s*[*_]{0,3}\s*`;
  const m = new RegExp(String.raw`^(?:[-*+•]\s+)?[*_]{0,3}\s*(?:${label})\s*${end}([\s\S]+)$`, 'i').exec(line);
  return m ? m[1].trim() : null;
}

/** The first paragraph (of any block) with this label: its value without emphasis, and where it is. */
export function findLabel(
  blocks: readonly { id: string; paragraphs: readonly string[] }[],
  label: string,
  opts: { loose?: boolean } = {},
): { value: string; block: string; paragraph: number } | null {
  for (const block of blocks) {
    for (let i = 0; i < block.paragraphs.length; i++) {
      const value = labelValue(block.paragraphs[i], label, opts);
      if (value !== null) return { value: plainText(value), block: block.id, paragraph: i + 1 };
    }
  }
  return null;
}

/** A "Name." run-in of the PDF text layer (no emphasis): a short Title Case label, then a sentence. */
const PLAIN_RUN_IN = /^((?:[A-Z][\w'’-]*|of|the|and|to|in|on|a|an)(?: (?:[A-Z][\w'’-]*|of|the|and|to|in|on|a|an)){0,5})\. ([A-Z][\s\S]*)$/;

export interface RunInPart {
  label: string;
  /** 1-based paragraphs of the block: the run-in's own paragraph to the one before the next run-in or heading. */
  from: number;
  to: number;
  rest: string;
  emphasis: RunInEmphasis | 'plain';
}

/**
 * The heading scan's run-ins (§3.9): every paragraph that starts with a run-in label opens a part that runs
 * to the paragraph before the next run-in or heading (or the block's end). `emphasis` limits which run-ins
 * open a part (others stay inside the current one, like a lineage trait's bold options); `plain` also
 * accepts the PDF layer's unemphasized "Name. Text" (one to six Title Case words).
 */
export function runInParts(
  paragraphs: readonly string[],
  opts: { plain?: boolean; emphasis?: readonly RunInEmphasis[] } = {},
): RunInPart[] {
  const parts: RunInPart[] = [];
  paragraphs.forEach((p, i) => {
    const heading = /^#{1,6}\s/.test(p);
    const emphasized = heading ? null : runIn(p);
    const allowed = emphasized && (!opts.emphasis || opts.emphasis.includes(emphasized.emphasis)) ? emphasized : null;
    const found = heading ? null : (allowed ?? (opts.plain && !emphasized ? plainRunIn(p) : null));
    const last = parts[parts.length - 1];
    if (heading || found) {
      if (last && last.to === -1) last.to = i;
    }
    if (found) parts.push({ label: found.label, from: i + 1, to: -1, rest: found.rest, emphasis: found.emphasis });
  });
  const last = parts[parts.length - 1];
  if (last && last.to === -1) last.to = paragraphs.length;
  return parts;
}

function plainRunIn(paragraph: string): { label: string; rest: string; emphasis: 'plain' } | null {
  const m = PLAIN_RUN_IN.exec(paragraph.trim());
  return m && m[1].length <= 60 ? { label: m[1], rest: m[2], emphasis: 'plain' } : null;
}

/** The sentences of a text (". " boundaries, keeping the period). */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"“(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Every size word in a text, in order, without repeats ("Small … or Medium …" → Small, Medium). */
export function sizesIn(text: string): ('Tiny' | 'Small' | 'Medium' | 'Large' | 'Huge' | 'Gargantuan')[] {
  const out: ('Tiny' | 'Small' | 'Medium' | 'Large' | 'Huge' | 'Gargantuan')[] = [];
  for (const m of text.matchAll(/\b(tiny|small|medium|large|huge|gargantuan)\b/gi)) {
    const size = (m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()) as (typeof out)[number];
    if (!out.includes(size)) out.push(size);
  }
  return out;
}

/** "Daggers" → "Dagger", "Pouches" → "Pouch" (the builder's catalog matching rule). */
function singularName(name: string): string {
  if (/(?:ch|sh|ss)es$/i.test(name)) return name.slice(0, -2);
  if (/ies$/i.test(name)) return `${name.slice(0, -3)}y`;
  if (/[^s]s$/i.test(name)) return name.slice(0, -1);
  return name;
}

/**
 * "Choose A or B: (A) …; or (B) 50 GP" or a single list "Rope, Oil (2 flasks), 10 GP" → packages ("Option A"
 * for a single list). Without a catalog (`known`), counted items are named in the singular ("2 Daggers" →
 * 2 × Dagger), as the build script names them when it knows the item.
 */
export function equipmentPackages(text: string, known: ReadonlySet<string> = new Set()): EquipmentPackage[] {
  const choices = parseEquipmentChoices(text, known);
  const single = choices.length ? null : itemsAndGold(stripInline(text).replace(/\s*\(see "[^"]+"\)/g, ''), known);
  const packages = choices.length ? choices : single && (single.items.length || single.gp) ? [{ label: 'Option A', ...single }] : [];
  if (known.size) return packages;
  return packages.map((p) => ({ ...p, items: p.items.map((i) => (i.quantity > 1 && !/\(/.test(i.name) ? { ...i, name: singularName(i.name) } : i)) }));
}
