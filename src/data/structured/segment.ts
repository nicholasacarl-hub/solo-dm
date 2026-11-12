/**
 * Segmentation and detection (spec §3.2, pure): a source's entries in reading order → the things the
 * app can structure ("candidates"), each with its blocks (one entry or a "(part N)" chain, paragraphs
 * numbered by splitParagraphs), plus the book's class spell lists.
 *
 * 1. Reading order: the numeric suffix of `lib:<sourceId>:<n>` (IndexedDB returns "…:10" before "…:2").
 * 2. Part chains: "X (part N)" with the same parent path as the preceding "X" / "X (part N-1)" joins it.
 * 3. Outline: a tree from `path` (top-level entries have none: [name]); headings with no text of their
 *    own become empty outline nodes.
 * 4. Detection, depth-first, first match wins (labels case-insensitive, with or without emphasis, at
 *    line starts, so PDF text layers and photo transcriptions match too). A section kind (class,
 *    subclass, background, species) consumes its subtree, except that a class's subclasses become their
 *    own candidates, and an entry stored as a spell, monster, magic item or feat inside a section stays
 *    its own candidate (it is never part of the section's text).
 * 5. Spell lists: "<Class> Spells" / "<Class> Spell List" naming ≥ 5 known spells → a SpellListHint.
 * 6. Manual marking: markCandidate (All entries › Structure as…).
 *
 * Owner: E2.
 */
import { nameKey } from '@/lib/id';
import { textFingerprint } from '@/lib/importedContent';
import type { CompendiumEntry, RecordSpan, StructuredKind } from '@/types';
import { guessKind, opensWithPrerequisite, ownBody } from '../chunk';
import { STRUCTURED_LIMITS } from './schemas';
import { isDelimiterRow, splitParagraphs } from './paragraphs';

export interface CandidateBlock {
  id: string;                    // "B1", "B2"… — what the request and the wire's spans use
  entryIds: string[];            // one entry, or a "(part N)" chain
  title: string;                 // the first entry's name without " (part N)"
  path: string[];
  paragraphs: string[];          // splitParagraphs(joined full texts)
  /** Additive (E2): the joined full texts themselves, table header rows included (parsers read table columns from it). */
  text?: string;
}
export interface Candidate {
  key: string;                   // candidateKey (§2.6)
  kind: StructuredKind;
  name: string;
  span: RecordSpan;
  entryIds: string[];
  rowIndex?: number;
  parentClassName?: string;      // a subclass found inside a class chapter, under "X Subclass:", or under a heading naming a class
  blocks: CandidateBlock[];
  textHash: string;              // textFingerprint(full texts joined by "\n\n")
  reason: string;                // app-written: "Has Armor Class, Hit Points and Challenge lines"
  /** Additive (E2): the section had more than STRUCTURED_LIMITS.entriesPerRecord entries and was cut there. */
  truncated?: true;
  /** Additive (E2), span 'table': which gear table of the block (0-based) and which of its body rows. */
  table?: { index: number; firstRow: number; rows: number };
}
export interface SpellListHint { className: string; spellNames: string[]; entryId: string }
/** nameKey()s of the spells and classes already known (SRD, and this book's class candidates). */
export interface SegmentContext { knownSpellNames: ReadonlySet<string>; knownClassNames: ReadonlySet<string> }

// ---------------------------------------------------------------------------
// Reading order, chains, outline
// ---------------------------------------------------------------------------

const PART = /^(.*) \(part (\d+)\)$/;

/** The numeric suffix of "lib:<sourceId>:<n>" (Infinity for any other id). */
export function ordinalOf(id: string): number {
  const n = Number(id.slice(id.lastIndexOf(':') + 1));
  return Number.isInteger(n) && n >= 0 ? n : Number.POSITIVE_INFINITY;
}

/** Entries in reading order (stable for ids without a numeric suffix). */
export function readingOrder(entries: readonly CompendiumEntry[]): CompendiumEntry[] {
  return entries
    .map((entry, index) => ({ entry, index, ordinal: ordinalOf(entry.id) }))
    .sort((a, b) => a.ordinal - b.ordinal || a.index - b.index)
    .map((x) => x.entry);
}

interface Chain {
  entries: CompendiumEntry[];
  title: string;
  /** The first entry's path, or [title] for a top-level entry. */
  path: string[];
}

const parentPathOf = (entry: CompendiumEntry) => (entry.path ?? [entry.name]).slice(0, -1);
const samePath = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Group entries (already in reading order) into "(part N)" chains. */
export function chainsOf(entries: readonly CompendiumEntry[]): Chain[] {
  const chains: Chain[] = [];
  for (const entry of entries) {
    const part = PART.exec(entry.name);
    const last = chains[chains.length - 1];
    if (
      part &&
      last &&
      last.title === part[1] &&
      Number(part[2]) === last.entries.length + 1 &&
      samePath(parentPathOf(entry), parentPathOf(last.entries[0]))
    ) {
      last.entries.push(entry);
      continue;
    }
    chains.push({ entries: [entry], title: entry.name, path: entry.path?.length ? [...entry.path] : [entry.name] });
  }
  return chains;
}

interface OutlineNode {
  title: string;
  path: string[];
  chain: Chain | null;
  children: OutlineNode[];
  parent: OutlineNode | null;
}

const isStrictPrefix = (a: readonly string[], b: readonly string[]) => a.length < b.length && a.every((x, i) => x === b[i]);

function outlineOf(chains: readonly Chain[]): OutlineNode {
  const root: OutlineNode = { title: '', path: [], chain: null, children: [], parent: null };
  const stack: OutlineNode[] = [root];
  for (const chain of chains) {
    while (stack.length > 1 && !isStrictPrefix(stack[stack.length - 1].path, chain.path)) stack.pop();
    let parent = stack[stack.length - 1];
    for (let depth = parent.path.length; depth < chain.path.length - 1; depth++) {
      const node: OutlineNode = { title: chain.path[depth], path: chain.path.slice(0, depth + 1), chain: null, children: [], parent };
      parent.children.push(node);
      stack.push(node);
      parent = node;
    }
    const node: OutlineNode = { title: chain.title, path: chain.path, chain, children: [], parent };
    parent.children.push(node);
    stack.push(node);
  }
  return root;
}

const ownText = (node: OutlineNode) => (node.chain ? node.chain.entries.map((e) => e.text).join('\n\n') : '');

/** The node's text with its descendants (child titles as "### " headings), up to about `max` characters. */
function subtreeText(node: OutlineNode, max: number): string {
  const parts: string[] = [];
  let length = 0;
  const visit = (n: OutlineNode, heading: boolean) => {
    if (length >= max) return;
    if (heading) {
      parts.push(`### ${n.title}`);
      length += n.title.length + 6;
    }
    const own = ownText(n);
    if (own) {
      parts.push(own);
      length += own.length + 2;
    }
    for (const child of n.children) visit(child, true);
  };
  visit(node, false);
  return parts.join('\n\n').slice(0, max);
}

function* walk(node: OutlineNode): Generator<OutlineNode> {
  yield node;
  for (const child of node.children) yield* walk(child);
}

const ancestorsOf = (node: OutlineNode) => {
  const out: OutlineNode[] = [];
  for (let p = node.parent; p && p.parent; p = p.parent) out.push(p);
  return out;
};

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * A label at a line start: after an optional list marker, quote marker or table pipe and optional
 * emphasis. Strict labels need a ":", "." or "|" after them ("**Feat:**", "***Size.***", "| Size |");
 * loose ones (class traits, which a flattened table prints as "Hit Point Die D8 per…") a word boundary.
 */
function label(source: string, loose = false): RegExp {
  const end = loose ? String.raw`(?:[:.|]|\b)` : String.raw`[:.|]`;
  return new RegExp(String.raw`^[ \t>]*(?:[-*+•][ \t]+|\d+[.)][ \t]+)?(?:\|[ \t]*)?[*_]{0,3}[ \t]*(?:${source})[ \t]*[*_]{0,3}[ \t]*${end}`, 'im');
}

const L = {
  hitDie: label('Hit Point Die|Hit Dice', true),
  savingThrows: label('Saving Throws?(?: Proficiencies)?', true),
  abilityScores: label('Ability Scores'),
  feat: label('Feat'),
  skills: label('Skill Proficiencies'),
  tools: label('Tool Proficienc(?:y|ies)'),
  equipment: label('Equipment'),
  languages: label('Languages'),
  creatureType: label('Creature Type'),
  size: label('Size'),
  speed: label('Speed'),
  asi: label('Ability Score Increase'),
  cost: label('Cost'),
  weight: label('Weight'),
  feature: /^(?:[ \t>]*[*_]{0,3}[ \t]*Feature[ \t]*:|#{1,6}[ \t]+Feature[ \t]*:)/im,
} as const;

const PB_HEADER = /^[ \t]*\|.*\bProficiency Bonus\b.*\|[ \t]*\n[ \t]*\|?[ \t]*:?-{3,}/im;
const LEVEL_HEADING = /^#{1,6}[ \t]+Level[ \t]+\d{1,2}[ \t]*:/gim;
const LEVEL_RUN_IN = /^(?:#{1,6}[ \t]+|[*_]{1,3}[ \t]*)?Level[ \t]+\d{1,2}[ \t]*:/im;
const LEVEL_SENTENCE_2014 = /\b(?:Starting at|At) \d{1,2}(?:st|nd|rd|th) level\b/i;
const PER_CLASS_LEVEL = /\bper ([A-Za-z][A-Za-z' -]{0,40}?) level\b/i;
const SUBCLASS_TITLE = /^(.+?) Subclass:\s*(.+)$/i;
const SUBCLASS_NAME = /^(?:Path|College|Circle|Oath|Way|School) of\b|\s(?:Domain|Archetype|Patron|Origin|Tradition)$/i;
const SUBCLASS_GROUP = /(?:Subclasses|Archetypes|Domains|Paths|Colleges|Circles|Oaths|Traditions|Patrons|Origins)$/i;
const CLASS_OWN_SECTION = /\b(?:Class Features|Features|Traits|Spell List|Spells)$/i;
const GEAR_PATH = /\b(?:Equipment|Gear|Tools|Packs)\b/i;
const SPELL_LIST_TITLE = /^(.+?) (?:Spells|Spell List)$/i;
const LEVEL_TITLE = /^Level \d{1,2}:/i;

const countMatches = (re: RegExp, text: string) => [...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))].length;

// ---------------------------------------------------------------------------
// GFM tables (gear)
// ---------------------------------------------------------------------------

const TABLE_LINE = /^\s*\|/;

/** "| a | b |" → ["a", "b"] (emphasis kept). */
export function tableCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

export interface GfmTable { header: string[]; rows: string[][] }

/** Every GFM table in a text: header cells and body rows (the build-srd parseTables rule). */
export function gfmTables(text: string): GfmTable[] {
  const lines = text.split('\n');
  const tables: GfmTable[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!TABLE_LINE.test(lines[i]) || !TABLE_LINE.test(lines[i + 1]) || !isDelimiterRow(lines[i + 1])) continue;
    const header = tableCells(lines[i]);
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length && TABLE_LINE.test(lines[j]); j++) rows.push(tableCells(lines[j]));
    tables.push({ header, rows });
    i = j - 1;
  }
  return tables;
}

const plainCell = (cell: string) => cell.replace(/[*_`]/g, '').trim();

/**
 * A weapon or armor table header (spec §3.2): Damage + Properties, or Armor Class/AC + Strength/Stealth.
 * A shield table prints neither Strength nor Stealth, so Armor Class/AC under a first column naming
 * shields counts too (the SRD's "Shield" table).
 */
export function gearTableKind(header: readonly string[]): 'weapons' | 'armor' | null {
  const cells = header.map((h) => plainCell(h).toLowerCase());
  const has = (re: RegExp) => cells.some((c) => re.test(c));
  if (has(/^damage\b/) && has(/^properties\b/)) return 'weapons';
  if ((has(/^armor class\b/) || has(/^ac\b/)) && (has(/^strength\b/) || has(/^stealth\b/) || /^shields?\b/.test(cells[0] ?? ''))) return 'armor';
  return null;
}

/** The gear tables of a text, in order. */
export function gearTables(text: string): GfmTable[] {
  return gfmTables(text).filter((t) => gearTableKind(t.header) !== null);
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

const BLOCK_PATH_LIMIT = 8;

/**
 * A chain's block for a candidate: id "B<n>", the document's heading path as stored. Requests leave the
 * document's top-level heading (often the book's title) out of it: src/dm/extract/blocks.ts requestPath.
 */
function blockOf(chain: Chain, n: number): CandidateBlock {
  const path = chain.path;
  const text = chain.entries.map((e) => e.text).join('\n\n');
  return {
    id: `B${n}`,
    entryIds: chain.entries.map((e) => e.id),
    title: chain.title,
    path: path.slice(-BLOCK_PATH_LIMIT),
    paragraphs: splitParagraphs(text),
    text,
  };
}

/** Blocks for entries (in reading order, grouped into part chains): B1, B2, …. */
export function blocksOf(entries: readonly CompendiumEntry[]): CandidateBlock[] {
  return chainsOf(entries).map((chain, i) => blockOf(chain, i + 1));
}

/** candidateKey (§2.6): `<kind>:<nameKey(name)>:<primary entry id>` (+ `:r<n>` for a table row). */
export function candidateKey(kind: StructuredKind, name: string, primaryEntryId: string, rowIndex?: number): string {
  return `${kind}:${nameKey(name)}:${primaryEntryId}${rowIndex !== undefined ? `:r${rowIndex}` : ''}`;
}

/** Strip a feat name's category suffix or prefix: "Alert (Origin Feat)" / "Feat: Alert" → "Alert". */
function cleanName(kind: StructuredKind, title: string): string {
  if (kind === 'feat') return title.replace(/\s*\((?:(?:Origin|General|Fighting Style|Epic Boon)\s+)?Feat\)$/i, '').replace(/^Feat:\s*/i, '').trim() || title;
  if (kind === 'subclass') return SUBCLASS_TITLE.exec(title)?.[2].trim() ?? title;
  return title;
}

function makeCandidate(
  kind: StructuredKind,
  span: RecordSpan,
  name: string,
  chains: readonly Chain[],
  reason: string,
  extra: Partial<Pick<Candidate, 'parentClassName' | 'rowIndex' | 'table'>> = {},
): Candidate {
  const limit = STRUCTURED_LIMITS.entriesPerRecord;
  const kept: Chain[] = [];
  let count = 0;
  let truncated = false;
  for (const chain of chains) {
    if (count + chain.entries.length > limit) {
      truncated = true;
      break;
    }
    kept.push(chain);
    count += chain.entries.length;
  }
  if (!kept.length && chains.length) kept.push({ ...chains[0], entries: chains[0].entries.slice(0, limit) });
  const blocks = kept.map((c, i) => blockOf(c, i + 1));
  const entries = kept.flatMap((c) => c.entries);
  const entryIds = entries.map((e) => e.id);
  return {
    key: candidateKey(kind, name, entryIds[0], extra.rowIndex),
    kind,
    name,
    span,
    entryIds,
    ...(extra.rowIndex !== undefined ? { rowIndex: extra.rowIndex } : {}),
    ...(extra.parentClassName ? { parentClassName: extra.parentClassName } : {}),
    blocks,
    textHash: textFingerprint(entries.map((e) => e.text).join('\n\n')),
    reason,
    ...(truncated ? { truncated: true as const } : {}),
    ...(extra.table ? { table: extra.table } : {}),
  };
}

const ENTITY_KINDS = new Set<StructuredKind>(['monster', 'spell', 'magic-item', 'feat']);
const ENTITY_REASON: Record<string, string> = {
  monster: 'Has Armor Class, Hit Points and Challenge lines',
  spell: 'Has a spell level and school line, or a Casting Time line',
  'magic-item': 'Has a magic item category and rarity line',
  feat: 'Has a feat category line, or a Prerequisite line before its text',
};

/**
 * An entity kind for a node with entries: its stored kind, else what guessKind reads from the entry's
 * own text (before its first subsection, as the importer reads it: an older import may have kept a
 * room's subsections, a stat block among them, inside the room's entry) and the headings above it.
 * Detection corrects the stored kinds an older guessKind got wrong before it segments (staleKinds.ts).
 */
function entityKind(node: OutlineNode): { kind: StructuredKind; reason: string } | null {
  if (!node.chain) return null;
  const first = node.chain.entries[0];
  if (ENTITY_KINDS.has(first.kind as StructuredKind)) return { kind: first.kind as StructuredKind, reason: ENTITY_REASON[first.kind] };
  const ancestors = ancestorsOf(node).map((a) => a.title).reverse();
  const guessed = guessKind(node.title, ownBody(ownText(node)), ancestors);
  return ENTITY_KINDS.has(guessed as StructuredKind) ? { kind: guessed as StructuredKind, reason: ENTITY_REASON[guessed] } : null;
}

/** §3.2 class rule, plus: when the Hit Point Die names its class ("D8 per Wickwright level"), that is this node. */
function isClassNode(node: OutlineNode): boolean {
  const head = [ownText(node), ...node.children.map((c) => `### ${c.title}\n\n${ownText(c)}`)].join('\n\n');
  if (!L.hitDie.test(head) || !L.savingThrows.test(head)) return false;
  const subtree = subtreeText(node, 12_000);
  if (!PB_HEADER.test(subtree) && countMatches(LEVEL_HEADING, subtree) < 3) return false;
  const named = PER_CLASS_LEVEL.exec(head)?.[1];
  if (!named) return true;
  const a = nameKey(named);
  const b = nameKey(node.title);
  return a.includes(b) || b.includes(a);
}

const hasLevelFeatures = (node: OutlineNode, allow2014: boolean) => {
  const text = subtreeText(node, 20_000);
  return LEVEL_RUN_IN.test(text) || (allow2014 && LEVEL_SENTENCE_2014.test(text));
};

/** A known class named in a title ("Cleric Domains" → "Cleric"), as printed. */
function classNamedIn(title: string, known: ReadonlySet<string>): string | undefined {
  const words = title.replace(/[*_`]/g, '').split(/\s+/).filter(Boolean);
  for (let len = Math.min(3, words.length); len >= 1; len--) {
    for (let i = 0; i + len <= words.length; i++) {
      const phrase = words.slice(i, i + len).join(' ');
      if (known.has(nameKey(phrase))) return phrase;
    }
  }
  return undefined;
}

const isSubclassTitle = (title: string) => SUBCLASS_TITLE.test(title) || SUBCLASS_NAME.test(title);

/**
 * A PDF's three heading sizes can flatten a subclass's feature headings to its own level: a
 * subclass-titled node without children takes the following leaf siblings (up to the next
 * subclass-titled sibling, an entry stored as an entity or opening with a Prerequisite line, or a
 * sibling with children of its own).
 */
function adoptedSiblings(node: OutlineNode): OutlineNode[] {
  if (node.children.length || !node.parent || !isSubclassTitle(node.title)) return [];
  const siblings = node.parent.children;
  const out: OutlineNode[] = [];
  for (let i = siblings.indexOf(node) + 1; i < siblings.length && out.length < STRUCTURED_LIMITS.subclassFeatures; i++) {
    const s = siblings[i];
    // A class option or feat that follows (it opens with a Prerequisite line) is no subclass feature.
    if (isSubclassTitle(s.title) || s.children.length || !s.chain || ENTITY_KINDS.has(s.chain.entries[0].kind as StructuredKind) || opensWithPrerequisite(ownText(s))) break;
    out.push(s);
  }
  return out;
}

/** A subclass anywhere (title rules); parent = the class chapter, the "X Subclass:" prefix or an ancestor naming a known class. */
function subclassMatch(node: OutlineNode, classNode: OutlineNode | null, known: ReadonlySet<string>): { parent?: string; reason: string } | null {
  const titled = SUBCLASS_TITLE.exec(node.title);
  if (titled) {
    return { parent: classNode?.title ?? titled[1].trim(), reason: `Titled “${titled[1].trim()} Subclass: …”` };
  }
  if (SUBCLASS_NAME.test(node.title) && (hasLevelFeatures(node, true) || adoptedSiblings(node).some((s) => hasLevelFeatures(s, true)))) {
    const parent = classNode?.title ?? ancestorsOf(node).map((a) => classNamedIn(a.title, known)).find(Boolean);
    return { ...(parent ? { parent } : {}), reason: 'Titled like a subclass, with features by level' };
  }
  return null;
}

function backgroundMatch(node: OutlineNode): string | null {
  const text = ownText(node).slice(0, 3000);
  if (!text) return null;
  const labels2024 = [L.abilityScores, L.feat, L.skills, L.tools, L.equipment].filter((re) => re.test(text)).length;
  if (labels2024 >= 3) return 'Has Ability Scores, Feat, Skill Proficiencies, Tool Proficiency or Equipment lines';
  const feature = L.feature.test(text) || node.children.some((c) => /^Feature\s*:/i.test(c.title));
  if (L.skills.test(text) && L.equipment.test(text) && (L.languages.test(text) || L.tools.test(text)) && feature) {
    return 'Has Skill Proficiencies, Equipment and Languages lines and a Feature (older layout)';
  }
  return null;
}

function speciesMatch(node: OutlineNode): string | null {
  const text = ownText(node).slice(0, 2000);
  if (!text) return null;
  if ([L.creatureType, L.size, L.speed].filter((re) => re.test(text)).length >= 3) return 'Has Creature Type, Size and Speed lines';
  if ([L.asi, L.size, L.speed, L.languages].filter((re) => re.test(text)).length >= 3) {
    return 'Has Ability Score Increase, Size, Speed and Languages traits (older layout)';
  }
  return null;
}

/** Gear tables of a node (≤ 60 rows each, split beyond), and a single gear entry with Cost and Weight. */
function itemCandidates(node: OutlineNode): Candidate[] {
  if (!node.chain) return [];
  const text = ownText(node);
  const tables = gfmTables(text);
  const gear = tables.map((t, index) => ({ t, index, kind: gearTableKind(t.header) })).filter((x) => x.kind !== null);
  const max = STRUCTURED_LIMITS.rowsPerGearTable;
  const out: Candidate[] = [];
  for (const { t, index, kind } of gear) {
    const base = gear.length === 1 ? node.title : `${node.title} (${plainCell(t.header[0]) || `table ${out.length + 1}`})`;
    const reason = kind === 'weapons' ? 'A weapon table (Damage and Properties columns)' : 'An armor table (an Armor Class column with Strength, Stealth or shields)';
    for (let first = 0; first < Math.max(1, t.rows.length); first += max) {
      const rows = Math.min(max, t.rows.length - first);
      const name = t.rows.length > max ? `${base} (rows ${first + 1}–${first + rows})` : base;
      out.push(makeCandidate('item', 'table', name, [node.chain], reason, { table: { index, firstRow: first, rows } }));
    }
  }
  if (out.length) return out;
  const head = text.slice(0, 2000);
  if (L.cost.test(head) && L.weight.test(head) && ancestorsOf(node).some((a) => GEAR_PATH.test(a.title))) {
    return [makeCandidate('item', 'entry', node.title, [node.chain], 'Has Cost and Weight lines, under an equipment heading')];
  }
  return [];
}

interface SectionResult {
  candidate: Candidate;
  /** Nodes inside the section that are their own candidates (subclasses, stored entities). */
  inner: OutlineNode[];
  /** A class: the inner nodes that are its subclasses. */
  subclasses?: ReadonlySet<OutlineNode>;
  /** Following siblings taken into the section (flattened subclass features). */
  adopted?: OutlineNode[];
}

/** The chains of a section's subtree in reading order, minus the nodes that are their own candidates. */
function sectionChains(node: OutlineNode, isOwn: (n: OutlineNode) => boolean): { chains: Chain[]; inner: OutlineNode[] } {
  const chains: Chain[] = [];
  const inner: OutlineNode[] = [];
  const visit = (n: OutlineNode, top: boolean) => {
    if (!top && isOwn(n)) {
      inner.push(n);
      return;
    }
    if (n.chain) chains.push(n.chain);
    for (const child of n.children) visit(child, false);
  };
  visit(node, true);
  return { chains, inner };
}

const isStoredEntity = (n: OutlineNode) => Boolean(n.chain && ENTITY_KINDS.has(n.chain.entries[0].kind as StructuredKind));

/** The subclasses inside a class chapter: titled ones anywhere, and children (or grouped children) with Level N: features. */
function classSubclasses(classNode: OutlineNode, known: ReadonlySet<string>): Set<OutlineNode> {
  const found = new Set<OutlineNode>();
  for (const n of walk(classNode)) {
    if (n !== classNode && subclassMatch(n, classNode, known)) found.add(n);
  }
  const consider = (children: readonly OutlineNode[]) => {
    for (const child of children) {
      if (found.has(child) || LEVEL_TITLE.test(child.title) || CLASS_OWN_SECTION.test(child.title)) continue;
      if (PB_HEADER.test(subtreeText(child, 12_000))) continue;
      if (SUBCLASS_GROUP.test(child.title)) consider(child.children);
      else if (hasLevelFeatures(child, false)) found.add(child);
    }
  };
  consider(classNode.children);
  // A found node's own descendants belong to it.
  for (const n of [...found]) for (const d of walk(n)) if (d !== n) found.delete(d);
  return found;
}

/** A section candidate at this node, if any. `subclassOf`: the class whose chapter holds this subclass. */
function sectionCandidate(node: OutlineNode, known: ReadonlySet<string>, subclassOf: OutlineNode | null): SectionResult | null {
  if (subclassOf) {
    const { chains, inner } = sectionChains(node, isStoredEntity);
    if (!chains.length) return null;
    const reason = subclassMatch(node, subclassOf, known)?.reason ?? `A section with features by level inside the ${subclassOf.title} chapter`;
    return { candidate: makeCandidate('subclass', 'section', cleanName('subclass', node.title), chains, reason, { parentClassName: subclassOf.title }), inner };
  }
  if (isClassNode(node)) {
    const subclasses = classSubclasses(node, known);
    const { chains, inner } = sectionChains(node, (n) => subclasses.has(n) || isStoredEntity(n));
    if (chains.length) {
      const reason = 'Has Hit Point Die and Saving Throw lines, with a class table or Level N: features';
      return { candidate: makeCandidate('class', 'section', node.title, chains, reason), inner, subclasses };
    }
  }
  const sub = subclassMatch(node, null, known);
  if (sub) {
    const { chains, inner } = sectionChains(node, isStoredEntity);
    const adopted = adoptedSiblings(node);
    chains.push(...adopted.flatMap((n) => (n.chain ? [n.chain] : [])));
    if (!chains.length) return null;
    const candidate = makeCandidate('subclass', 'section', cleanName('subclass', node.title), chains, sub.reason, sub.parent ? { parentClassName: sub.parent } : {});
    return { candidate, inner, adopted };
  }
  const background = backgroundMatch(node);
  if (background) {
    const { chains, inner } = sectionChains(node, isStoredEntity);
    return { candidate: makeCandidate('background', 'section', node.title, chains, background), inner };
  }
  const species = speciesMatch(node);
  if (species) {
    const { chains, inner } = sectionChains(node, isStoredEntity);
    return { candidate: makeCandidate('species', 'section', node.title, chains, species), inner };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Spell lists
// ---------------------------------------------------------------------------

const cleanSpellName = (raw: string) =>
  raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`†‡]/g, '')
    .replace(/\s*\((?:ritual|concentration|[^)]{0,20})\)\s*$/i, '')
    .replace(/[.,;:]+$/, '')
    .trim();

const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)])\s+(.+)$/gm;

function spellListHint(node: OutlineNode, knownClasses: ReadonlySet<string>, knownSpells: ReadonlySet<string>): SpellListHint | null {
  const title = SPELL_LIST_TITLE.exec(node.title);
  if (!title || !knownClasses.has(nameKey(title[1])) || !node.chain) return null;
  const text = subtreeText(node, 40_000);
  const names: string[] = [];
  const listed = [...text.matchAll(LIST_ITEM)].map((m) => cleanSpellName(m[1])).filter(Boolean);
  // A PDF text layer loses list markers: short lines of their own that read like names.
  const lines = listed.length
    ? []
    : text
        .split(/\n+/)
        .map((l) => l.trim())
        .filter((l) => l.length <= 50 && !/^#/.test(l) && !/[.!?:;]$/.test(l) && /^[\p{Lu}\d]/u.test(l) && l.split(/\s+/).length <= 6)
        .map((l) => cleanSpellName(l))
        .filter(Boolean);
  const items = listed.length ? listed : lines;
  let known = items.filter((n) => knownSpells.has(nameKey(n))).length;
  names.push(...items);
  for (const table of gfmTables(text)) {
    const columns = table.header.map((_, col) => table.rows.map((r) => cleanSpellName(r[col] ?? '')).filter((c) => c && c !== '—' && c !== '-'));
    for (const cells of columns) {
      const hits = cells.filter((c) => knownSpells.has(nameKey(c))).length;
      if (cells.length && hits / cells.length >= 0.5) {
        names.push(...cells);
        known += hits;
      }
    }
  }
  if (known < 5) return null;
  const unique = [...new Map(names.map((n) => [nameKey(n), n])).values()];
  return { className: title[1].trim(), spellNames: unique, entryId: node.chain.entries[0].id };
}

// ---------------------------------------------------------------------------
// segment()
// ---------------------------------------------------------------------------

export function segment(entries: readonly CompendiumEntry[], ctx: SegmentContext): { candidates: Candidate[]; spellLists: SpellListHint[] } {
  const ordered = readingOrder(entries);
  const root = outlineOf(chainsOf(ordered));
  const candidates: Candidate[] = [];
  const knownClasses = new Set(ctx.knownClassNames);

  const consumed = new Set<OutlineNode>();
  const visit = (node: OutlineNode, subclassOf: OutlineNode | null) => {
    if (consumed.has(node)) return;
    if (node !== root) {
      const entity = entityKind(node);
      if (entity) {
        candidates.push(makeCandidate(entity.kind, 'entry', cleanName(entity.kind, node.title), [node.chain as Chain], entity.reason));
        for (const child of node.children) visit(child, null);
        return;
      }
      const section = sectionCandidate(node, knownClasses, subclassOf);
      if (section) {
        candidates.push(section.candidate);
        for (const n of section.adopted ?? []) consumed.add(n);
        if (section.candidate.kind === 'class') knownClasses.add(nameKey(section.candidate.name));
        for (const inner of section.inner) visit(inner, section.subclasses?.has(inner) ? node : null);
        return;
      }
      candidates.push(...itemCandidates(node));
    }
    for (const child of node.children) visit(child, null);
  };
  visit(root, null);

  const order = new Map(ordered.map((e, i) => [e.id, i]));
  candidates.sort((a, b) => (order.get(a.entryIds[0]) ?? 0) - (order.get(b.entryIds[0]) ?? 0));

  const knownSpells = new Set(ctx.knownSpellNames);
  for (const c of candidates) if (c.kind === 'spell') knownSpells.add(nameKey(c.name));
  const spellLists: SpellListHint[] = [];
  for (const node of walk(root)) {
    const hint = node === root ? null : spellListHint(node, knownClasses, knownSpells);
    if (hint) spellLists.push(hint);
  }
  return { candidates, spellLists };
}

// ---------------------------------------------------------------------------
// Rebuilding and marking candidates
// ---------------------------------------------------------------------------

const MARKED = 'Marked by you';
const SECTION_KINDS = new Set<StructuredKind>(['class', 'subclass', 'background', 'species']);

/**
 * All entries › Structure as…: a candidate of `kind` for the chosen entries (a section kind takes each
 * chosen entry's subtree along; an item with gear tables becomes its first table). `entries` is the
 * whole source, so subtrees and part chains can be found.
 */
export function markCandidate(entries: readonly CompendiumEntry[], entryIds: readonly string[], kind: StructuredKind): Candidate | null {
  const ordered = readingOrder(entries);
  const root = outlineOf(chainsOf(ordered));
  const chosen = new Set(entryIds);
  const nodes = [...walk(root)].filter((n) => n.chain?.entries.some((e) => chosen.has(e.id)));
  if (!nodes.length) return null;
  const first = nodes[0];
  if (kind === 'item') {
    const tables = itemCandidates(first);
    if (tables.length) return { ...tables[0], reason: MARKED };
  }
  let chains: Chain[];
  if (SECTION_KINDS.has(kind)) {
    const seen = new Set<Chain>();
    chains = [];
    for (const node of nodes) {
      for (const n of walk(node)) {
        if (!n.chain || seen.has(n.chain)) continue;
        seen.add(n.chain);
        chains.push(n.chain);
      }
    }
  } else chains = nodes.map((n) => n.chain as Chain);
  const titled = kind === 'subclass' ? SUBCLASS_TITLE.exec(first.title) : null;
  const parent = titled?.[1].trim();
  return makeCandidate(kind, SECTION_KINDS.has(kind) ? 'section' : 'entry', cleanName(kind, first.title), chains, MARKED, parent ? { parentClassName: parent } : {});
}

/**
 * The candidate behind an existing record (re-reads and Claude requests): the record's entries as
 * blocks, with the same name, key and span. A table or row record finds its gear table again by name.
 */
export function candidateFor(
  record: { kind: StructuredKind; name: string; span: RecordSpan; entryIds: string[]; candidateKey: string; rowIndex?: number },
  entriesById: ReadonlyMap<string, CompendiumEntry>,
  extra: { parentClassName?: string; tableName?: string } = {},
): Candidate | null {
  const entries = record.entryIds.map((id) => entriesById.get(id));
  if (entries.some((e) => !e) || !entries.length) return null;
  const chains = chainsOf(entries as CompendiumEntry[]);
  if (record.span === 'table' || record.span === 'row') {
    const node: OutlineNode = { title: chains[0].title, path: chains[0].path, chain: chains[0], children: [], parent: null };
    const tables = itemCandidates(node);
    const wanted = record.span === 'table' ? record.name : extra.tableName;
    const table = tables.find((t) => t.name === wanted) ?? tables.find((t) => t.key === record.candidateKey) ?? tables[0];
    if (!table || table.span !== 'table') return null;
    if (record.span === 'table') return { ...table, key: record.candidateKey };
    return { ...table, key: record.candidateKey, name: record.name, span: 'row', ...(record.rowIndex !== undefined ? { rowIndex: record.rowIndex } : {}) };
  }
  const candidate = makeCandidate(record.kind, record.span, record.name, chains, 'Read again', extra.parentClassName ? { parentClassName: extra.parentClassName } : {});
  return { ...candidate, key: record.candidateKey };
}
