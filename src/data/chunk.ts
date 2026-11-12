/**
 * Splitting imported text into searchable compendium entries, and guessing what each entry is.
 * Pure functions (no I/O): used by the import pipeline, previews and tests.
 *
 * - Markdown headings (ATX "## Name" or setext) start entries; the heading stack becomes `path`.
 * - Spells, monsters, magic items and feats stay whole: their subsections ("Actions"...) belong
 *   to the same entry. Rules sections longer than MAX_RULE_CHARS are split into parts.
 * - Plain text without Markdown headings gets short title-like lines promoted to headings when
 *   there are several of them (pasted book text); otherwise it is cut into ~1500-character chunks
 *   at paragraph boundaries.
 */
import type { CompendiumEntry, ContentKind, LibrarySource } from '@/types';
import { stripInlineMarkdown } from './text';

export const MAX_RULE_CHARS = 4000;
const MAX_ENTITY_CHARS = 12000;
export const TARGET_CHUNK_CHARS = 1500;
const MAX_SUMMARY_CHARS = 160;

// ---------------------------------------------------------------------------
// Kind guessing
// ---------------------------------------------------------------------------

const SCHOOLS = 'Abjuration|Conjuration|Divination|Enchantment|Evocation|Illusion|Necromancy|Transmutation';
// Each test looks for the line a real entry starts with, not a mention in prose (an item that names "an
// Evocation cantrip", advice that a "CR 3 creature has AC 13 and HP 65", a paragraph about "rare armor").
/** "Level 3 Evocation (Sorcerer, Wizard)", "Evocation Cantrip", "3rd-level evocation" at the start of a line. */
const SPELL_LINE = new RegExp(
  `^[\\W_]*(?:Level ([1-9]) (${SCHOOLS})|(${SCHOOLS}) Cantrip|([1-9])(?:st|nd|rd|th)[- ]level (${SCHOOLS}))\\b`,
  'im',
);
/** "Casting Time: Action" or "**Casting Time.** 1 action" (a label, not an index line "casting time, 215"). */
const CASTING_TIME = /^[\W_]*Casting Time[\s*_]*[:.]/im;
const CARD_LABEL = '(Casting Time|Range(?:/Area)?|Components|Duration)';
/** A spell card's label alone on its line or in its table cell ("Casting Time", "Range:"). */
const CARD_LABEL_ALONE = new RegExp(`^${CARD_LABEL}:?$`, 'i');
/** A line that starts with a spell card's label, as each of a card's lines does ("Casting Time …", "Range 60 feet"). */
const CARD_LABEL_START = new RegExp(`^${CARD_LABEL}\\b`, 'i');
/**
 * A label set off from its value by a tab, spaces or a dash ("Casting Time    1 action", "Range — 60 feet", "Range—Self",
 * "Duration -- 1 hour", pandoc's em dash "Range --- 60 feet").
 */
const CARD_LABEL_SET_OFF = new RegExp(`^${CARD_LABEL}(?:\\t| {2,}| ?[—–] ?| ?---? ?| - )(.+)$`, 'i');
/** "Casting Time 1 action": the label and one space before its value (bold labels without colons, a PDF's label and value runs side by side). */
const CASTING_TIME_SPACED = /^Casting Time[ \u00a0](\S.*)$/i;
/**
 * Another card label: at the start of a line ("Range 30 feet"), or later in the Casting Time's line, as a
 * label is printed (a PDF's "Casting Time Action Range 30 feet", "… RANGE 30 feet"), not a word in prose.
 */
const OTHER_LABEL_START = /^(?:Range(?:\/Area)?|Components|Duration)\b/i;
const OTHER_LABEL_LATER = /\s(?:Range(?:\/Area)?|Components|Duration|RANGE(?:\/AREA)?|COMPONENTS|DURATION)\b/;
/** A casting time's unit: "Action", "Bonus Action", "Magic action", "Reaction", "1 action", "10 minutes", "10 min.", "1 hour", "1 week", "Special". */
const CASTING_UNIT =
  '(?:(?:\\d+|one|an?)\\s+)?(?:bonus\\s+action|magic\\s+action|action|reaction)\\b|(?:\\d+|one|an?)\\s+(?:round|minute|min|hour|hr|day|week)s?\\b\\.?|special\\b';
/** A casting time, however long its trigger ("Reaction, which you take when you are hit by an attack roll…", "1 minute or Ritual"). */
const CASTING_TIME_VALUE = new RegExp(`^(?:${CASTING_UNIT})`, 'i');
/**
 * The casting times spells can have, as a glossary of a card's fields lists them ("Action, Bonus Action, Reaction, or
 * longer", "Action or longer", "1 minute or more"): two casting times with a comma between them, or "or longer" / "or
 * more" after them. Not one spell's, however it goes on ("Action or 8 hours", "1 minute or Ritual", "Reaction, which
 * you take when you take 10 or more damage").
 */
const LISTED_TIMES = new RegExp(
  `^(?:${CASTING_UNIT})(?:\\s*,\\s*(?:${CASTING_UNIT})|(?:(?:\\s*,\\s*|\\s+)or\\s+(?:${CASTING_UNIT}))*(?:\\s*,\\s*|\\s+)or\\s+(?:longer|more)\\b)`,
  'i',
);
/** A reaction's or a bonus action's trigger ("…, which you take when you take 10 or more damage"): one spell's, however it goes on. */
const TRIGGER_CLAUSE = /,?\s*which you take\b[\s\S]*$/i;
/**
 * A list of casting times further on in a value's own words, after a qualifier ("Action (most spells), Bonus Action,
 * Reaction, or longer", "Action for most spells; some take a Bonus Action, a Reaction, or longer"): two casting times
 * with a comma between them, or "or longer" anywhere. ("Or more" counts only right after the casting times, as
 * `LISTED_TIMES` reads it.)
 */
const LISTED_LATER = new RegExp(`\\b(?:${CASTING_UNIT})\\s*,\\s*(?:${CASTING_UNIT})|\\bor\\s+longer\\b`, 'i');
/** A casting time's own words: its value up to the card's next label on its line, without a trigger clause. */
const ownWords = (value: string) => value.split(/\s(?:Range(?:\/Area)?|Components|Duration)\b/i)[0].replace(TRIGGER_CLAUSE, '');
/** The casting times spells can have, as a glossary lists them (`LISTED_TIMES`, or `LISTED_LATER` in the value's own words). */
const listedTimes = (value: string) => LISTED_TIMES.test(value) || LISTED_LATER.test(ownWords(value));
/** One spell's casting time (`CASTING_TIME_VALUE`), not a list of them (`listedTimes`). */
const castingTimeValue = (value: string) => CASTING_TIME_VALUE.test(value) && !listedTimes(value);
/**
 * A casting time after one space, where prose could also stand ("Casting Time The time it takes…"): the unit
 * alone (perhaps with a full stop or a footnote mark), or before a comma, a parenthesis or bracket, a ritual
 * tag ("1 minute ritual", "or Ritual") or another casting time, or the card's next label ("Bonus Action Range
 * 30 feet", "1 action / Range 60 feet", a PDF's bulleted lines joined: "Action ● Range 30 feet").
 */
const SPACED_CASTING_TIME_VALUE = new RegExp(
  `^(?:${CASTING_UNIT})(?=[\\s.†‡]*$|\\s*[,;(\\[]|\\s+(?:or\\s+(?:Ritual\\b|${CASTING_UNIT})|Ritual\\b)|\\s*(?:[./·•◦▪‣●○■□◆◇►▸▶\\uf0b7|–—-]\\s*)?(?:Range|Components|Duration)\\b)`,
  'i',
);
/** "Casting Time" at the start of a line, after any marks: the first release's test for a spell (`V1.CASTING_TIME`). */
const CASTING_TIME_OPENS = /^[\W_]*Casting Time\b/i;
/** A spell card's fields besides its four labels, which its table or a grid's row of labels may print ("Level", "School"…). */
const FIELD_LABELS =
  'Level|School|Class(?:es)?|Sources?|Attack\\/Save|Damage\\/Effect|Ritual|Concentration|Spell Lists?|Area|Targets?|Saving Throw|Save|Attack|Damage(?: Type)?|Effects?|(?:At )?Higher Levels?|Cantrip Upgrade|Tags?|Subclasses?|Materials?';
/**
 * Any label a card's row of labels may print after Casting Time: its other labels and fields ("Range", "School",
 * "Concentration"…), not a column of names ("Spell", "Name"), which marks a list of spells (as `NAME_CELL` reads a table's).
 */
const ROW_LABELS = new RegExp(`\\b(?:Range(?:\\/Area)?|Components|Duration|${FIELD_LABELS})\\b`, 'gi');
/** A grid card's row of its labels, Casting Time first ("Casting Time Range Components Duration", "CASTING TIME RANGE"). */
const LABEL_ROW = /^Casting Time(?:\s+(?:Range(?:\/Area)?|Components|Duration))+$/i;
/** Where a table pasted as text sets its cells apart: a tab, or the spaces a tab became. */
const SPACED_CELLS = /\t| {2,}/;

const isCastingTime = (label: string) => /^casting time$/i.test(label);

/**
 * A spell card's value for its label. Casting Time's is one spell's casting time, however long its trigger runs
 * (not a page number, "Varies", what the label means or a list of casting times). The others' are short and not
 * sentences ("60 ft.", "V, S"), or end in a full stop where the card ends each value with one (`stops`). Not
 * another label (a row of labels set apart by tabs).
 */
function cardValue(label: string, value: string | undefined, stops = false): boolean {
  const v = value?.trim();
  if (!v || CARD_LABEL_ALONE.test(v.split(SPACED_CELLS)[0])) return false;
  if (isCastingTime(label)) return castingTimeValue(v);
  const bare = stops ? v.replace(/([^.])\.$/, '$1') : v;
  return bare.length <= 40 && (!/[.!?]$/.test(bare) || /\b(?:ft|mi|min|hr|rd)\.$/i.test(bare));
}

/**
 * The labels of a card's (label, value) pairs that have their values (`cardValue`). A card ends each value
 * with a full stop, as some converters write them, when its Casting Time's is a casting time and the stop
 * ("1 action.", "1 minute ritual."), not a sentence ("Action is how most spells are cast.").
 */
function valuedLabels(pairs: readonly (readonly [string, string | undefined])[]): Set<string> {
  const castingTime = pairs.find(([label, value]) => isCastingTime(label) && cardValue(label, value))?.[1]?.trim() ?? '';
  const stops = /[^.]\.$/.test(castingTime) && SPACED_CASTING_TIME_VALUE.test(castingTime);
  return new Set(pairs.filter(([label, value]) => cardValue(label, value, stops)).map(([label]) => labelKey(label)));
}

/** A card names its Casting Time and one more of its labels, each with its value. */
const isCard = (found: ReadonlySet<string>) => found.has('casting time') && found.size >= 2;
const labelKey = (label: string) => label.toLowerCase().replace('/area', '');

/** A table's delimiter row ("|---|:---:|", "--- | ---"). */
const isDelimiterRow = (line: string) => /^[\s:|-]+$/.test(line) && line.includes('-') && line.includes('|');
/** A Markdown table row's cells, without its outer pipes. */
const pipeCells = (row: string) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

interface Table {
  /** Its rows' cells (a delimiter row left out). */
  rows: string[][];
  /** Its first row heads the rest: a Markdown table's, over its delimiter row, or a table pasted as text. */
  headed: boolean;
}

/**
 * The table that starts at `lines[i]`, up to the first line that isn't one of its rows (a blank line ends
 * it): "| … |" rows, a header with pipes between its cells over a delimiter row (GFM without the outer
 * pipes), or two or more rows of cells set apart by tabs (a table pasted as text). Null when none starts there.
 */
function tableAt(lines: readonly string[], i: number): Table | null {
  const first = lines[i] ?? '';
  const run = (isRow: (line: string) => boolean) => {
    const rows: string[] = [];
    for (let j = i; j < lines.length && isRow(lines[j]); j++) rows.push(lines[j]);
    return rows;
  };
  if (first.startsWith('|') || (first.includes('|') && isDelimiterRow(lines[i + 1] ?? ''))) {
    const rows = run(first.startsWith('|') ? (l) => l.startsWith('|') : (l) => l.includes('|'));
    return { rows: rows.filter((r) => !isDelimiterRow(r)).map(pipeCells), headed: rows.length > 1 && isDelimiterRow(rows[1]) };
  }
  const rows = run((l) => SPACED_CELLS.test(l));
  return rows.length > 1 ? { rows: rows.map((r) => r.split(SPACED_CELLS).map((c) => c.trim())), headed: true } : null;
}

/** A pandoc table's rule under its header: a run of dashes for each column, spaces between them ("-------- ------ ------"). */
const COLUMN_RULE = /^ *-{3,}(?: +-{3,})+ *$/;
/** A pandoc multiline table's rule above its header and below its rows: one run of dashes across. */
const TABLE_EDGE = /^ *-{3,} *$/;

/**
 * pandoc's own Markdown tables (what `pandoc x.docx -o x.md` and `pandoc -f html` write) as Markdown pipe tables, so a
 * card printed as one reads as a Markdown table's does (`tableCard`): a simple table (a header line after a blank line,
 * over a rule of each column's dashes, then a row to a line up to a blank line) or a multiline table (between two rules
 * across: its header lines over the column rule, then its rows, groups of lines a blank line apart), each cell the text
 * in its column's place. Grid tables ("+----+") and headerless tables are left as they are.
 */
function pandocTablesAsPipes(text: string, keep?: (head: readonly string[]) => boolean): string {
  const lines = text.split('\n');
  const blank = (k: number) => k < 0 || lines[k].trim() === '';
  for (let r = 1; r < lines.length; r++) {
    if (!COLUMN_RULE.test(lines[r]) || blank(r - 1) || TABLE_EDGE.test(lines[r - 1])) continue;
    let top = r - 1;
    while (!blank(top - 1) && !TABLE_EDGE.test(lines[top - 1])) top -= 1;
    const multiline = top > 0 && TABLE_EDGE.test(lines[top - 1]);
    if (!multiline && (top !== r - 1 || !blank(top - 1))) continue;
    let end = r + 1;
    const rows: string[][] = [];
    if (multiline) {
      while (end < lines.length && !TABLE_EDGE.test(lines[end]) && !COLUMN_RULE.test(lines[end])) end += 1;
      if (end >= lines.length || !TABLE_EDGE.test(lines[end])) continue;
      for (let k = r + 1; k < end; k++) {
        if (blank(k)) continue;
        if (blank(k - 1) || k === r + 1) rows.push([]);
        rows[rows.length - 1].push(lines[k]);
      }
    } else {
      for (; end < lines.length && !blank(end) && !COLUMN_RULE.test(lines[end]) && !TABLE_EDGE.test(lines[end]); end++) rows.push([lines[end]]);
    }
    if (!rows.length) continue;
    const starts = [...lines[r].matchAll(/-+/g)].map((m) => m.index);
    // A header line the entry's text opens with lost its indent (the rule's) when the text was trimmed.
    const indent = (l: string) => l.length - l.trimStart().length;
    const header = lines.slice(top, r).map((l) => ' '.repeat(Math.max(0, indent(lines[r]) - indent(l))) + l);
    const cells = (group: readonly string[]) => starts.map((s, k) => group.map((l) => l.slice(s, starts[k + 1]).trim()).filter(Boolean).join(' '));
    const pipe = (cs: readonly string[]) => `| ${cs.join(' | ')} |`;
    // A merged first row (the card's title, "| Ember Lash | | |") is a caption: the row under it heads the table.
    let head = cells(header);
    // A table `keep` accepts by its header stays as written.
    if (keep?.(head)) continue;
    const caption: string[] = [];
    if (rows.length > 1 && head[0] && head.slice(1).every((c) => !c)) {
      caption.push(head[0]);
      head = cells(rows.shift() ?? []);
    }
    const table = [...caption, pipe(head), pipe(starts.map(() => '---')), ...rows.map((group) => pipe(cells(group)))];
    const from = multiline ? top - 1 : top;
    lines.splice(from, (multiline ? end + 1 : end) - from, ...table);
    r = from + table.length - 1;
  }
  return lines.join('\n');
}

/** A row of a card's labels (some cell is one), not of its values. */
const labelRow = (cells: readonly string[]) => cells.some((cell) => CARD_LABEL_ALONE.test(cell));
/** A spell card's other fields, which its table may print among its labels ("| Level | 1st |", "| School | Evocation |"), or its name. */
const CARD_FIELD = new RegExp(`^(?:${FIELD_LABELS}|Spell|Name):?$`, 'i');
/** A column of spells' names ("| Spell | Casting Time | Range |"): a list of spells, unless it names this one. */
const NAME_CELL = /^(?:Spells?|Spell Name|Name)$/i;
const sameName = (a: string, b: string) => b.trim() !== '' && stripInlineMarkdown(a).toLowerCase() === stripInlineMarkdown(b).toLowerCase();

/**
 * A card as a table with its labels over its values: a header row of labels over one row of values, perhaps
 * followed by more label rows, each over its values (a web page's grid). A table of several spells has more
 * rows of values instead, or a column of names (a list of one spell names another), and isn't one. The
 * Casting Time's value must be a casting time (not "Varies"); the others need a value.
 */
function headerCard(rows: readonly (readonly string[])[], name: string): boolean {
  if (rows.length < 2 || rows.length % 2 === 1) return false;
  const found = new Set<string>();
  for (let i = 0; i < rows.length; i += 2) {
    const [labels, values] = [rows[i], rows[i + 1]];
    if (!labelRow(labels) || labelRow(values)) return false;
    if (labels.some((cell, k) => NAME_CELL.test(cell) && !sameName(values[k] ?? '', name))) return false;
    labels.forEach((cell, k) => {
      const m = CARD_LABEL_ALONE.exec(cell);
      if (m && (isCastingTime(m[1]) ? cardValue(m[1], values[k]) : Boolean(values[k]))) found.add(labelKey(m[1]));
    });
  }
  return isCard(found);
}

/** A row's cells without the empty ones a table pads it with at its end. */
function filledCells(cells: readonly string[]): readonly string[] {
  let n = cells.length;
  while (n > 0 && !cells[n - 1]) n -= 1;
  return cells.slice(0, n);
}

/**
 * A row of a card's fields as its (label, value) pairs, two cells to a pair ("| Casting Time | 1 reaction |", a
 * web page's "| Casting Time | 1 Action | Range | 30 feet |"), empty cells at its end left out; null when some
 * pair isn't a spell card's field (an index's "| Cantrip | 201 |", a room's "| Hirelings | 1 |", a service's
 * "| Cost | 10 GP |").
 */
function rowPairs(row: readonly string[]): [string, string][] | null {
  const cells = filledCells(row);
  if (cells.length % 2 === 1) return null;
  const pairs: [string, string][] = [];
  for (let k = 0; k < cells.length; k += 2) {
    const [label, value] = [cells[k], cells[k + 1]];
    const m = CARD_LABEL_ALONE.exec(label);
    if (m) pairs.push([m[1], value]);
    else if (label && !CARD_FIELD.test(label)) return null;
  }
  return pairs;
}

/**
 * The (label, value) pairs of a table of a card's fields, row by row (`rowPairs`), or null when a row isn't
 * one; its first row may instead be a header that `header` accepts.
 */
function tablePairs(rows: readonly (readonly string[])[], header: (cells: readonly string[]) => boolean): [string, string][] | null {
  const pairs: [string, string][] = [];
  for (const [r, row] of rows.entries()) {
    const own = rowPairs(row);
    if (own) pairs.push(...own);
    else if (r > 0 || !header(filledCells(row))) return null;
  }
  return pairs;
}

/**
 * A card as a table of its labels beside their values (`tablePairs`): its Casting Time and another label with
 * their values, every other row a card's field, under an empty header, one of its own rows, the spell's name
 * or a header of labels and values ("| Property | Value |"). An index ("| Term | Page |") or a list of what
 * the labels mean ("| Entry | What it tells you |") isn't one.
 */
function pairsCard(rows: readonly (readonly string[])[], name: string): boolean {
  const pairs = tablePairs(rows, (cells) => (cells.length === 1 && sameName(cells[0], name)) || /^(?:Values?|Details?)$/i.test(cells[1] ?? ''));
  return pairs !== null && isCard(valuedLabels(pairs));
}

const tableCard = (table: Table, name: string) => (table.headed && headerCard(table.rows, name)) || pairsCard(table.rows, name);

/** A creature's size-and-type line ("Medium Humanoid, Neutral"), which opens its stat block. */
const CREATURE_LINE =
  /^(?:Tiny|Small|Medium|Large|Huge|Gargantuan)\b.{0,40}?\b(?:Aberration|Beast|Celestial|Construct|Dragon|Elemental|Fey|Fiend|Giant|Humanoid|Monstrosity|Ooze|Plant|Undead|Swarm)s?\b/i;

/**
 * A short line a card's table may follow: a caption or a "Source:" line (not a table row, nor a feat's
 * Prerequisite or category line, "Racial Feat" among them, nor a creature's size line).
 */
const captionLine = (line: string) =>
  line.length <= 80 &&
  !line.includes('|') &&
  !SPACED_CELLS.test(line) &&
  !PREREQUISITE_LINE.test(line) &&
  !FEAT_CATEGORY_LINE.test(line) &&
  !/\bFeat(?:\s*\([^)]*\))?$/i.test(line) &&
  !CREATURE_LINE.test(line);

/** An HTML line break, as a converter writes one into Markdown. */
const LINE_BREAK = /<br\s*\/?>/gi;

/**
 * A space as a converter writes it: a no-break, en, em, thin, hair, figure or narrow no-break space (U+00A0,
 * U+2000–U+200A, U+202F, U+205F, U+3000), or an HTML character reference for a space ("&nbsp;", "&emsp;", "&ensp;",
 * "&thinsp;", "&#8194;", "&#x2009;", "&#8239;", "&#32;"…).
 */
const SPACE_LIKE =
  /[\u00a0\u2000-\u200a\u202f\u205f\u3000]|&(?:nbsp|NonBreakingSpace|ensp|emsp|emsp13|emsp14|numsp|puncsp|thinsp|ThinSpace|hairsp|VeryThinSpace|MediumSpace|ThickSpace);|&#0*(?:32|160|819[2-9]|820[0-2]|8239|8287|12288);|&#x0*(?:20|a0|200[0-9a]|202f|205f|3000);/gi;
/**
 * What a converter leaves in a line that shows nothing: a zero-width space, a joiner, a word joiner or a byte-order
 * mark, or an HTML character reference for one ("&#8203;", "&#x200b;", "&ZeroWidthSpace;").
 */
const ZERO_WIDTH =
  /[\u200b-\u200d\u2060\ufeff]|&(?:ZeroWidthSpace|NegativeVeryThinSpace|NegativeThinSpace|NegativeMediumSpace|NegativeThickSpace|zwnj|zwj|NoBreak);|&#0*(?:820[3-5]|8288|65279);|&#x0*(?:200[b-d]|2060|feff);/gi;
/**
 * The marks a card's line may open with: any run of quote marks and list bullets ("> - ", "> > ", ">- ", "● ",
 * U+F0B7, "■ ", "•" with or without a space after it); a dash or a plus sign only before a space ("- ", "– ").
 */
const LINE_MARKS = /^(?:\s*(?:>|[•◦▪‣·●○■□◆◇►▸▶\uf0b7]|[-+–—](?=\s)))+/;

/**
 * A line as a spell card is read, without what converters add to it: characters that show nothing (or their
 * references) dropped, other spaces (no-break, em, thin… or their references, `SPACE_LIKE`) as spaces, Markdown
 * emphasis and escapes ("\|"), a hard line break ("…\") and the quote marks and bullets it opens with
 * (`LINE_MARKS`: a callout's "> - ", a word processor's "●") gone.
 */
function cardText(line: string): string {
  return line
    .replace(ZERO_WIDTH, '')
    .replace(SPACE_LIKE, ' ')
    .replace(/[*_`]/g, '')
    .replace(/\\\s*$/, '')
    .replace(/\\(?=[\s!-/:-@[-`{-~])/g, '')
    .replace(LINE_MARKS, '')
    .trim();
}

/**
 * An entry's opening lines as a spell card is read (`cardText`), blank lines kept (they end a table), up to
 * the `max`th line with text (the 16th). An HTML line break ends a line ("**Casting Time** 1 action<br>**Range**
 * 60 feet"), except inside a table's row.
 */
function cardLines(text: string, max = 16): string[] {
  const out: string[] = [];
  let withText = 0;
  for (const raw of text.split('\n')) {
    const row = raw.trimStart().startsWith('|');
    const parts = row ? [raw.replace(LINE_BREAK, ' ')] : raw.replace(/<br\s*\/?>\s*$/i, '').split(LINE_BREAK);
    for (const part of parts) {
      const line = cardText(part);
      if (line && ++withText > max) return out;
      out.push(line);
    }
  }
  return out;
}

/** A field's label alone on its line: a card's label, or another field a web page's grid prints ("Level", "School"). */
const fieldLabel = (line: string) => CARD_LABEL_ALONE.test(line) || CARD_FIELD.test(line);

/**
 * A card printed as a run of its labels, each alone on its line, then a run of as many values (a web page's
 * grid copied as text: "Casting Time", "Range", …, "1 action", "60 feet", …): each card label with the value
 * in its place. Not a list of spells copied that way: a run whose Name or Spell label has another name than
 * this entry's in its place (`NAME_CELL`, as `headerCard` reads a table's).
 */
function labelRunPairs(lines: readonly string[], name: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < lines.length; ) {
    let n = 0;
    while (i + n < lines.length && fieldLabel(lines[i + n])) n += 1;
    const values = lines.slice(i + n, i + 2 * n);
    const list = lines.slice(i, i + n).some((label, k) => NAME_CELL.test(label) && !sameName(values[k] ?? '', name));
    if (n < 2 || values.length < n || values.some(fieldLabel) || list) {
      i += Math.max(1, n);
      continue;
    }
    lines.slice(i, i + n).forEach((label, k) => {
      const m = CARD_LABEL_ALONE.exec(label);
      if (m) pairs.push([m[1], values[k]]);
    });
    i += 2 * n;
  }
  return pairs;
}

/**
 * A spell card as a web page, a table or a PDF prints it at the top of the entry, without the label's colon
 * (perhaps under the entry's name, repeated):
 * - a table on the entry's first line, or its second after a short caption or Source line: labels over a
 *   row of values (`headerCard`), or labels and their values side by side (`pairsCard`), in Markdown (pandoc's
 *   simple and multiline tables too, `pandocTablesAsPipes`) or pasted as text;
 * - "Casting Time" and another label, each alone on its line above its value (or in a run of labels over
 *   a run of their values), or set off from it by a tab, spaces or a dash;
 * - a grid's row of labels, Casting Time first, over its row of values ("CASTING TIME RANGE" / "1 action 120
 *   feet", as a PDF prints a card's boxes);
 * - "Casting Time", one space and a casting time ("- **Casting Time** 1 action", a PDF's "Casting Time Bonus
 *   Action Range 30 feet"), with another label in the card's lines or later in the same line.
 * Casting Time's value is one spell's casting time however long its trigger, the others' short and not
 * sentences (`cardValue`). An index page's "casting time, 215", a rules section's subheads, a list of what the
 * labels mean (or of the casting times a spell can have), a table or grid of several spells and a creature's or
 * a feat's table of its spells aren't cards.
 *
 * Returns the lines it read above the card's first label line (where a feat's category line or an item's
 * type line says whose card it is), or null when there's no card.
 */
function spellCard(text: string, name: string): string[] | null {
  // pandoc's own tables read as Markdown tables do; failing that, a key/value card's rows still read as the lines they
  // are ("Casting Time   1 action" under a "Property   Value" header, beside a "Spell Level" row), under a header such a
  // card has (`keyValueHead`): not a table that compares spells, or one of what each field means, holds or defaults to.
  const piped = pandocTablesAsPipes(text);
  if (piped === text) return cardIn(text, name);
  const kept = pandocTablesAsPipes(text, (head) => keyValueHead(head, name));
  return cardIn(piped, name) ?? (kept !== piped ? cardIn(kept, name) : null);
}

/** A values column's header ("Property | Value", "Attribute | Info"). */
const VALUES_HEAD = /^(?:Values?|Details?|Info(?:rmation)?)$/i;
/** A card's field as a key/value table's row labels it ("Casting Time", "Level", "Spell Level", "Spell"). */
const rowLabel = (cell: string) => fieldLabel(cell.replace(/^Spell\s+(?=\S)/i, ''));
/**
 * A header a spell card's key/value table has: its values' columns ("Property | Value", "Attribute | Info"), the spell's
 * name (perhaps beside its level line), or one of the card's own rows ("Casting Time | 1 action", "Spell Level | 1st",
 * "Casting Time | 1 action | Range | 60 feet"), its cells read as a card's lines are (`cardText`: pandoc writes a bold
 * header row, or the first row of a Word table whose label column is bold, as "**Value**", "**Spell Level**"). Not a
 * glossary's "Field | Meaning", an example's "Field | Example", or a comparison's columns of spells ("| Ember Lash | Glow
 * Mote", "Normal casting | As a ritual").
 */
function keyValueHead(head: readonly string[], name: string): boolean {
  const cells = head.map(cardText);
  if (cells.length === 4) return (rowLabel(cells[0]) && rowLabel(cells[2])) || (VALUES_HEAD.test(cells[1]) && VALUES_HEAD.test(cells[3]));
  return cells.length === 2 && (VALUES_HEAD.test(cells[1]) || sameName(head[0], name) || rowLabel(cells[0]));
}

/** `spellCard` on a text as it stands. */
function cardIn(text: string, name: string): string[] | null {
  const raw = cardLines(text);
  let at = raw.flatMap((l, i) => (l ? [i] : []));
  if (at.length > 1 && sameName(raw[at[0]], name)) at = at.slice(1);
  const lines = at.map((i) => raw[i]);
  if (!lines.length) return null;
  const first = tableAt(raw, at[0]);
  const table = first ?? (lines.length > 1 && captionLine(lines[0]) ? tableAt(raw, at[1]) : null);
  if (table && tableCard(table, name)) return first ? [] : lines.slice(0, 1);
  const pairs: [string, string | undefined][] = [];
  lines.forEach((line, i) => {
    const alone = CARD_LABEL_ALONE.exec(line);
    const setOff = alone ? null : CARD_LABEL_SET_OFF.exec(line);
    if (alone) pairs.push([alone[1], lines[i + 1]]);
    else if (setOff) pairs.push([setOff[1], setOff[2]]);
  });
  pairs.push(...labelRunPairs(lines, name));
  const spaced = lines.findIndex(spacedCastingTime);
  const card =
    isCard(valuedLabels(pairs)) ||
    lines.some((l, i) => LABEL_ROW.test(l) && castingTimeValue(lines[i + 1] ?? '')) ||
    (spaced >= 0 && (OTHER_LABEL_LATER.test(lines[spaced]) || lines.some((l, i) => i !== spaced && OTHER_LABEL_START.test(l))));
  return card ? lines.slice(0, Math.max(0, lines.findIndex((l) => CARD_LABEL_START.test(l)))) : null;
}

/** "Casting Time Bonus Action…": the label, one space and one spell's casting time (not a list of them). */
const spacedCastingTime = (line: string) => {
  const value = CASTING_TIME_SPACED.exec(line)?.[1] ?? '';
  return SPACED_CASTING_TIME_VALUE.test(value) && !listedTimes(value);
};

/** A line of a spell card that holds a label and its value ("Casting Time    Action", "Range — 60 feet", "Casting Time 1 action"). */
const cardLine = (line: string) => {
  const t = cardText(line);
  return CARD_LABEL_SET_OFF.test(t) || spacedCastingTime(t);
};

/**
 * A Markdown link's label in place of the link, a pandoc span's text in place of the span ("[Casting Time](https://…)",
 * "[Casting Time]{.label}" → "Casting Time"), set off by spaces but not from a colon or comma after it, nor is a tag's
 * label ("[Casting Time](…):", "<span>Casting Time</span>:" → "Casting Time:", a label alone on its line).
 */
const linkLabels = (line: string) =>
  line.replace(/\[([^\]\n]*)\](?:\([^)\n]*\)|\{[^}\n]*\})/g, ' $1 ').replace(/(?<! ) +(?=[:;,.])/g, '').trim();
/**
 * A line that only draws a table or a block: pandoc's rules ("-------- --------", "+=====+=====+"), a fenced div's
 * fence (":::", "::: value"), an Org table's "|---+---|", an empty spacer row ("| | |").
 */
const STRUCTURE_LINE = /^(?:[\s|+:=~-]+|:{3,}.*)$/;
/**
 * HTML tags other than a line break ("<div class=\"statblock-item-label\">", "</div>", "<span class=\"value\">"), as
 * pandoc's gfm, commonmark and markdown_mmd writers keep a web page's divs and spans: a line that holds only tags reads
 * as a blank line, and a value in a span as the value.
 */
const HTML_TAG = /<\/?(?!br\b)[A-Za-z][\w:-]*(?:\s[^<>\n]*)?\/?>/gi;
/** A short tag in parentheses between a label and its value ("(R)", "(ritual)", "(C)"), after any marks. */
const PAREN_TAGS = /^(?:[^\w(]*\([^()\n]{1,20}\))+/;
/** A line without the marks it opens with (quote marks, bullets, pipes, emoji…). */
const withoutLeadingMarks = (line: string) => line.replace(/^[\W_]+/, '');
/** The marks and the card's other labels and fields that may stand before Casting Time's value on its line ("| ", " RANGE ", " SCHOOL "). */
const MARKS_AND_LABELS = new RegExp(`^(?:[\\W_]+|(?:Range(?:\\/Area)?|Components|Duration|${FIELD_LABELS})\\b)+`, 'i');

/**
 * Whether the entry's opening lines print a spell card's Casting Time with a casting time, which is what the
 * first release stored a spell for (an opening line that read `^[\W_]*Casting Time\b`), so a spell it stored is
 * never corrected for a shape today's card test doesn't read. One of the first 16 lines with text (`cardLines`,
 * converters' marks gone; other spaces and their references as spaces; characters that show nothing as a space too,
 * so a label never runs into its value; links' targets and pandoc spans' attributes dropped, their text set off by
 * spaces; HTML tags as spaces, so a line that holds only a web page's "<div class=…>" or "</div>" reads as blank and
 * "<strong>Casting Time</strong><span>Action</span>" as a label and its value) opens with "Casting
 * Time" after any marks (`CASTING_TIME_OPENS`), and a casting time stands in its value's place:
 * - later on that line, after whatever stands between them (spaces, a colon, a dash, a pipe, a quote mark, "=",
 *   "·", "/", "»", "→"…, a short tag in parentheses, "(R)", and the card's other labels and fields where a PDF
 *   joined a grid's row of labels to its row of values): "> - **Casting Time** 1 action", "| Casting Time | 1
 *   action |", "**Casting Time** (R) 1 minute", "CASTING TIME RANGE 1 action 60 feet";
 * - or, when the rest holds only marks, a tag and the card's other labels and fields (nothing at all, a grid's
 *   "CASTING TIME RANGE SCHOOL", a header row "| Casting Time | Range | Duration | Level |"; not a column of names),
 *   at the start of the first line with text below it that doesn't only draw the table (a delimiter row, pandoc's
 *   rules and fences), or of the line above it (a value printed over its label; the entry's name when the label
 *   opens its text, as pasted text's heading guesses made the value a heading), or nowhere at all (the row ends the
 *   entry's text: pandoc's rule under a one-line value row made that row a heading; only more lone labels follow it:
 *   a PDF reader copied a card table's label column, and the value column went to the next entry, whatever stands
 *   above it, a Source, Classes or school line or a tagline among them).
 * Also a run of labels over their values (`labelRunPairs`), or a card's table wherever it starts (after a name
 * and a Source line, say). Not an index's "Casting Time, 202", a glossary's "Casting Time — How long it takes",
 * "Casting Time    Varies" or a contents page's labels over page numbers.
 */
function printsCastingTime(text: string, name: string): boolean {
  const raw = cardLines(text.replace(ZERO_WIDTH, ' ').replace(HTML_TAG, ' '), 17).map(linkLabels);
  const runs = labelRunPairs(raw.filter(Boolean).slice(0, 16), name);
  if (runs.some(([label, value]) => isCastingTime(label) && CASTING_TIME_VALUE.test(value))) return true;
  const drawn = (l: string) => l !== '' && !isDelimiterRow(l) && !STRUCTURE_LINE.test(l);
  const opensWithTime = (l: string | undefined) => l !== undefined && CASTING_TIME_VALUE.test(withoutLeadingMarks(l));
  let withText = 0;
  return raw.some((line, i) => {
    if (!line || ++withText > 16) return false;
    const table = i > 0 && tableAt(raw, i - 1) ? null : tableAt(raw, i);
    if (table && tableCard(table, name)) return true;
    const opens = CASTING_TIME_OPENS.exec(line);
    if (!opens) return false;
    const rest = line.slice(opens[0].length);
    const untagged = rest.replace(PAREN_TAGS, '');
    if ([rest, untagged].some((r) => CASTING_TIME_VALUE.test(r.replace(MARKS_AND_LABELS, '')))) return true;
    if (untagged.replace(ROW_LABELS, '').replace(/[\W_]+/g, '') !== '') return false;
    const below = raw.slice(i + 1).find(drawn);
    // A run of lone labels with nothing after it (a PDF reader copied the label column, and heading guesses made the
    // value column's first line the next entry's name) is kept, as a label row that ends the text is, whatever stands
    // above it: a Source, Classes or school line, a tagline, the prose before the next spell's name in a copy without
    // headings. (So a section's prose over a list of the card's labels stays a stored spell: the lesser harm.)
    const after = raw.slice(i + 1).filter(drawn);
    return (
      below === undefined ||
      opensWithTime(below) ||
      opensWithTime(raw.slice(0, i).reverse().find(drawn) ?? name) ||
      after.every(fieldLabel)
    );
  });
}

/**
 * A stat block: AC and HP, and a challenge rating with its XP ("CR 1/4 (XP 50; PB +2)", "Challenge 5 (1,800
 * XP)") or the six ability scores, which advice about creatures doesn't print. (A PDF can join a stat
 * line to the one before it.)
 */
const ARMOR_CLASS = /\b(?:AC|Armor Class)\b[^\n\d]{0,6}\d+/;
const HIT_POINTS = /\b(?:HP|Hit Points)\b[^\n\d]{0,6}\d+/;
const CHALLENGE = /\b(?:CR|Challenge)\b[^\n\d]{0,6}(\d+(?:\/\d+)?)[\s*_]*\((?:XP\s*[\d,]+|[\d,]+\s*XP)/i;
/** "STR DEX CON …" or "Str 21 +5 +5 Dex 9 …": a stat block's ability scores. */
const ABILITY_SCORES = /\bStr\b[\s\S]{0,80}?\bDex\b[\s\S]{0,80}?\bCon\b[\s\S]{0,80}?\bInt\b/i;
const RARITY = /\b(very rare|uncommon|common|rare|legendary|artifact|rarity varies)\b/i;
const ITEM_CATEGORY = '(?:Wondrous Item|Weapon|Armor|Ring|Rod|Staff|Wand|Potion|Scroll|Shield)\\b';
/** An item's type line wherever it stands: a category (and its parenthetical), a comma, a rarity. Prose about rare weapons isn't shaped like this. */
const ITEM_TYPE_SHAPE = new RegExp(`${ITEM_CATEGORY}(?:\\s*\\([^)\\n]*\\))?,\\s*${RARITY.source}`, 'i');
/**
 * An item's type line as a web database or a converter labels it, which the first release read as an item and today's
 * line test may miss: a category (and its parenthetical), then a rarity after a comma or another separator, perhaps
 * with a "Rarity:" label ("Item Type: Wondrous Item / Rarity: Rare", "Item Type: Armor (Plate); Rarity: Rare"), after
 * a "Rarity:" label, or in parentheses ("Magic Item: Armor (Plate) (Uncommon)", "Source: Lantern Lore · Wondrous Item
 * (Rare)"); pandoc writes a dash as "--" or "---" ("Item Type: Wondrous Item -- Uncommon"). Prose about a weapon or
 * armor of rare quality isn't shaped like this.
 */
const ITEM_TYPE_LABELLED = new RegExp(
  `${ITEM_CATEGORY}(?:\\s*\\([^)\\n]*\\))?(?:\\s*(?:[,;/|·•—–]|-{2,3})\\s*(?:Rarity\\s*:\\s*)?|\\s+-\\s+(?:Rarity\\s*:\\s*)?|\\s+Rarity\\s*:\\s*|\\s*\\(\\s*)${RARITY.source}`,
  'i',
);
/**
 * "Wondrous Item, Rare (Requires Attunement)": a line that starts with an item category and names a rarity,
 * perhaps after a label ("Type: Wondrous Item, Rare", "| Type | Wondrous Item, Rare |"), or a type line
 * after the item's name and a dash or a parenthesis ("Owl Lantern — Wondrous Item, Uncommon", "Owl
 * Lantern (wondrous item, uncommon)").
 */
const ITEM_LINE = new RegExp(
  `^[\\W_]*(?:(?:Type|Item|Category)\\s*[:|.]\\s*)?${ITEM_CATEGORY}[^\\n]{0,80}?${RARITY.source}|^[^\\n—–(]{1,60}(?:\\s[—–-]\\s|\\s\\()[\\W_]*${ITEM_TYPE_SHAPE.source}`,
  'im',
);
/** "Origin Feat" or "General Feat (Prerequisite: Level 4+)" as a line of its own. */
const FEAT_CATEGORY_LINE =/^(?:(?:Origin|General|Fighting Style|Epic Boon)\s+)?Feat\b(?:\s*\(.*\))?$/i;
/** "Prerequisite: ..." as a line of its own. */
const PREREQUISITE_LINE = /^Prerequisites?:/i;
/** Either of them: the line a feat's summary comes from. */
const FEAT_LINE = new RegExp(`${FEAT_CATEGORY_LINE.source}|${PREREQUISITE_LINE.source}`, 'i');
/** "Alert (Origin Feat)" or "Feat: Alert". */
const FEAT_NAME = /\((?:(?:Origin|General|Fighting Style|Epic Boon)\s+)?Feat\)$|^Feat:/i;
/**
 * A heading that names feats: one that ends with the word ("Feats", "Racial Feats", "Chapter 5: Feats",
 * "List of Feats:"), or the word with a qualifier ("Feat Descriptions", "Feats (Optional)"). Not a title
 * that only starts with it ("Feats of the North", "Feats and Fortresses"), and never "Features".
 */
const FEATS_HEADING = /\bFeats?[:.]?$|^Feats?(?: Descriptions?| Lists?)?(?: \([^)]*\))?[:.]?$/i;
const SIZE_LINE = /^(?:Tiny|Small|Medium|Large|Huge|Gargantuan)\b/i;

/*
 * A bare Prerequisite line. Older books print feats with only a "Prerequisite: …" line before their text,
 * and print other things that way too. Each of these signs is a shape such things print and feats don't,
 * and says an entry is not a feat (headings alone can't decide it: PDF, photo and pasted-text imports
 * often lose or merge them):
 * - a type line before the Prerequisite line: a level and a few words ("Level 5 Stronghold Room"), not
 *   the entry's name and not naming a feat;
 * - a prerequisite that names a class at a level, a warlock pact, a cantrip or a patron, as class options
 *   do ("Level 5+ Warlock", "Pact of the Blade feature", "ember dart cantrip", "the Moth Queen patron");
 * - labelled lines right after it, as a stat block has ("Item: A pair of boots", "Space: Roomy"), or
 *   such a label joined into it ("Prerequisite: None Space: Roomy");
 * - a heading above it that names class options ("Eldritch Invocations", "Wickwright Infusions").
 * A level alone ("4th Level", "Level 4+") and "Prerequisite: None" are not signs: feats print them too.
 * Only the prerequisite itself counts, not the feat's text a PDF joined to its line, nor a web copy's
 * "Source:" line. Under a heading that names feats, none of these matter.
 */
const CLASSES = 'Artificer|Barbarian|Bard|Cleric|Druid|Fighter|Monk|Paladin|Ranger|Rogue|Sorcerer|Warlock|Wizard';
/**
 * "Level 5+ Warlock", "Level 9+ Wickwright, Pact of the Tome Invocation": a class at a level (a class
 * of the rules, or a capitalized name the prerequisite ends with), or a warlock pact. Case matters: "Level
 * 4+ and Dexterity 13+" names no class, nor does a PDF's "Level 4+ You can…".
 */
const CLASS_OPTION_PREREQUISITE = new RegExp(
  `\\bLevel \\d{1,2}\\+ (?:(?:${CLASSES})\\b|(?!Characters?\\b)[A-Z][a-z]+(?: [A-Z][a-z]+)?(?=\\s*(?:[,;)]|$)))|\\bPact of the\\b`,
);
/** "eldritch blast cantrip": a cantrip by name (not "a cantrip" or "the ability to cast at least one cantrip"). */
const NAMED_CANTRIP = /^(?:the )?(?!(?:a|an|any|one|your|the|at)\s)[a-z][\w'’-]*(?: [a-z][\w'’-]*){0,2} cantrip\b/i;
const PATRON = /\bpatron\b/i;
/** A heading over class options. */
const CLASS_OPTIONS_HEADING = /\b(?:Invocations?|Infusions?)\b/i;
/** "Item: A pair of boots", "Space: Roomy": a label of up to three words, a colon and a value. */
const LABEL_LINE = /^[\p{Lu}][\p{L}'’]*(?: [\p{L}'’]+){0,2}:\s*\S/u;
/** Labels a feat's own text, or a web page's copy of it, may print (not signs of a stat block). */
const FEAT_LABELS = /^(?:Repeatable|Benefits?|Ability Score (?:Increase|Improvement)|Special|Normal|Sources?|Pages?)\b/i;
const FEAT_LABELS_ANYWHERE = /\b(?:Repeatable|Benefits?|Ability Score (?:Increase|Improvement)|Special|Normal|Sources?|Pages?)\s*:/gi;
/** A stronghold room's type line: "Level 5 Stronghold Room", "5th-level Holding Room (Basic)". */
const ROOM_TYPE_LINE = /^(?:Level\s+\d{1,2}|\d{1,2}(?:st|nd|rd|th)[-\s]level)(?:\s+[\p{L}'’-]+){1,6}(?:\s*\([^)]*\)|\s*[—–:,-]\s*[\p{L}'’ -]{1,30})?$/iu;
/**
 * Where a feat's own text starts when a PDF joined it to the Prerequisite line: a sentence end, or a
 * word that opens a sentence ("Prerequisite: Elf or half-elf You learn…").
 */
const PROSE_START = /[.!?](?=\s|$)|(?<=\S)\s(?=(?:You|Your|When|Whenever|While|As|If|Once|Each|Every|This|Through|Thanks|Since|After|Before|Choose|A|An|The)\b(?!:))/;

/** The prerequisite itself, without the feat's text a PDF joined to its line. */
export function prerequisiteClause(value: string): string {
  const v = value.trim();
  const m = PROSE_START.exec(v);
  return m ? v.slice(0, m.index).trim() : v;
}

/** Whether a label that isn't a feat's comes after other text in a line ("None Space: Roomy", "Roomy Keepers: 1"). */
function joinedLabel(text: string): boolean {
  return /\s[\p{Lu}][\p{L}'’]{1,24}:\s/u.test(` ${text.replace(FEAT_LABELS_ANYWHERE, ' ')} `);
}

/** A stat block's labelled line: a label that isn't a feat's, and a value that isn't a sentence ("Space: Roomy"), or more labels. */
function statLabelLine(line: string): boolean {
  if (!LABEL_LINE.test(line) || FEAT_LABELS.test(line) || PREREQUISITE_LINE.test(line)) return false;
  return !/[.!?]["'”’)\]]*$/.test(line) || joinedLabel(line.slice(line.indexOf(':') + 1));
}

/**
 * A type line before a Prerequisite line that says the entry isn't a feat: a stronghold room's ("Level 5
 * Stronghold Room"), or a class option's ("Eldritch Invocation", "Artificer Infusion"). Not the entry's
 * name or a feat's line (a tagline, a "Source:" line or a page header isn't one).
 */
function typeLine(line: string, name: string): boolean {
  const t = line.trim();
  const shaped = ROOM_TYPE_LINE.test(t) || (CLASS_OPTIONS_HEADING.test(t) && t.split(/\s+/).length <= 4);
  return shaped && !/\bFeats?\b/i.test(t) && t.toLowerCase() !== stripInlineMarkdown(name).trim().toLowerCase();
}

/** Whether one of the headings above an entry names feats (where older books print feats with only a Prerequisite line). */
export function underFeatsHeading(ancestors: readonly string[]): boolean {
  return ancestors.some((title) => FEATS_HEADING.test(stripInlineMarkdown(title).trim()));
}

/**
 * The headings above an entry from its stored path. Imports store the entry's own name last
 * (["Feats", "Night Walker"]); a JSON file may list only the headings above it, which are kept whole.
 */
export function headingAncestors(path: readonly string[] | undefined, name: string): string[] {
  if (!path?.length) return [];
  const last = stripInlineMarkdown(path[path.length - 1]).trim().toLowerCase();
  return last === stripInlineMarkdown(name).trim().toLowerCase() ? path.slice(0, -1) : [...path];
}

/** Headings that are part of a stat block, never entries of their own. */
const STAT_BLOCK_SECTIONS = new Set(
  ['traits', 'actions', 'bonus actions', 'reactions', 'legendary actions', 'lair actions', 'mythic actions', 'regional effects'],
);
const isStatBlockSection = (title: string) => STAT_BLOCK_SECTIONS.has(stripInlineMarkdown(title).toLowerCase());

/** The first `n` non-empty lines, without Markdown emphasis or list markers. */
function leadingLines(text: string, n: number): string[] {
  return text
    .split('\n')
    .map((l) => stripInlineMarkdown(l.replace(/^\s*(?:[-*+]\s+|>\s*)/, '')))
    .filter(Boolean)
    .slice(0, n);
}

/** Whether a text opens with a Prerequisite line (in its first two lines), as feats and class options do. */
export function opensWithPrerequisite(text: string): boolean {
  return leadingLines(text, 2).some((l) => PREREQUISITE_LINE.test(l));
}

/** Whether a bare Prerequisite line in the first two lines makes this text a feat (see the signs above). */
function prerequisiteFeat(name: string, text: string, ancestors: readonly string[]): boolean {
  const lines = leadingLines(text, 4);
  const at = lines.slice(0, 2).findIndex((l) => PREREQUISITE_LINE.test(l));
  if (at < 0) return false;
  if (underFeatsHeading(ancestors)) return true;
  if (at > 0 && typeLine(lines[0], name)) return false;
  if (ancestors.some((title) => CLASS_OPTIONS_HEADING.test(stripInlineMarkdown(title)))) return false;
  const value = prerequisiteClause(lines[at].replace(PREREQUISITE_LINE, '').trim());
  if (CLASS_OPTION_PREREQUISITE.test(value) || PATRON.test(value)) return false;
  if (value.split(/\s*[,;]\s*/).some((part) => NAMED_CANTRIP.test(part))) return false;
  if (joinedLabel(value)) return false;
  return !lines.slice(at + 1, at + 3).some(statLabelLine);
}

/**
 * "General Feat (Prerequisite: Level 4+) You gain…": a feat's category line at the start of its first
 * paragraph, when a PDF or pasted text joined the text after it or wrapped it over two lines.
 */
const CATEGORY_AT_START = /^(?:Origin|General|Fighting Style|Epic Boon) Feat\b(?:\s*\([^)]*\))?(.*)$/i;

/** The category line that opens a feat's text, joined or wrapped ("General Feat (Prerequisite: Level 4+)"), or null. */
function openingCategory(text: string): string | null {
  const first = text.trim().split(/\n[ \t]*\n/)[0].replace(/\s*\n\s*/g, ' ');
  const line = stripInlineMarkdown(first.replace(/^\s*(?:[-*+]\s+|>\s*)/, '')).trim();
  const m = CATEGORY_AT_START.exec(line);
  if (!m) return null;
  const rest = m[1].trim();
  return rest === '' || /^\p{Lu}/u.test(rest) ? line.slice(0, line.length - m[1].length).trim() : null;
}

/**
 * Guess what a piece of rules text is: a spell ("Casting Time" or "Level 3 Evocation"), a monster
 * (AC, HP and CR/Challenge), a magic item (an item category with a rarity), a feat, or otherwise a rule.
 *
 * A feat has a category line ("Origin Feat", "General Feat (Prerequisite: Level 4+)"), a name that says
 * so ("Alert (Origin Feat)"), or a bare Prerequisite line that nothing marks as something else (see the
 * signs above). `ancestors`: the headings above the entry, outermost first.
 */
export function guessKind(name: string, text: string, ancestors: readonly string[] = []): ContentKind {
  const head = text.slice(0, 2000);
  const lines = leadingLines(text, 2);
  const top = lines.join('\n');
  // An item's type line comes first: its text may then mention a spell ("cast an Evocation cantrip").
  if (lines.length > 0 && ITEM_LINE.test(lines[0])) return 'magic-item';
  // Then a spell, before a stat block: a summoning spell prints its creature's.
  if (CASTING_TIME.test(head.slice(0, 800)) || SPELL_LINE.test(top)) return 'spell';
  let itemLine = ITEM_LINE.test(top);
  let featLine = FEAT_NAME.test(name.trim()) || lines.some((l) => FEAT_CATEGORY_LINE.test(l)) || openingCategory(text) !== null;
  // A card without its colons counts only in a spell's own text: not under an item's type line, a feat's
  // category line or a Prerequisite line, in the entry's first lines or anywhere above the card (after a
  // Source line, say), which print the spell an item casts or a feat grants. The item or the feat stays one.
  const above = !itemLine && !featLine && !lines.some((l) => PREREQUISITE_LINE.test(l)) ? spellCard(head, name) : null;
  if (above) {
    itemLine = above.some((l) => ITEM_LINE.test(l));
    featLine = !itemLine && above.some((l) => FEAT_CATEGORY_LINE.test(l) || CATEGORY_AT_START.test(l));
    if (!itemLine && !featLine && !above.some((l) => PREREQUISITE_LINE.test(l))) return 'spell';
  }
  if (ARMOR_CLASS.test(head) && HIT_POINTS.test(head) && (CHALLENGE.test(head) || ABILITY_SCORES.test(head))) return 'monster';
  if (itemLine) return 'magic-item';
  if (featLine) return 'feat';
  if (prerequisiteFeat(name, text, ancestors)) return 'feat';
  return 'rule';
}

/** The first version of guessKind's tests (PARSER_VERSION 1, the only earlier release, stored kinds with these), kept to recognise its misreadings. */
const V1 = {
  SPELL_LINE: new RegExp(`\\b(?:Level ([1-9]) (${SCHOOLS})|(${SCHOOLS}) Cantrip|([1-9])(?:st|nd|rd|th)[- ]level (${SCHOOLS}))\\b`, 'i'),
  CASTING_TIME: /^[\W_]*Casting Time\b/im,
  ARMOR_CLASS: /\b(?:AC|Armor Class)\b[^\n\d]{0,6}\d+/,
  HIT_POINTS: /\b(?:HP|Hit Points)\b[^\n\d]{0,6}\d+/,
  CHALLENGE: /\b(?:CR|Challenge)\b[^\n\d]{0,6}(\d+(?:\/\d+)?)/,
  ITEM_LINE: new RegExp(`\\b(?:Wondrous Item|Weapon|Armor|Ring|Rod|Staff|Wand|Potion|Scroll|Shield)\\b[^\\n]{0,80}?${RARITY.source}`, 'i'),
  FEAT_LINE: /^(?:(?:Origin|General|Fighting Style|Epic Boon)\s+)?Feat\b(?:\s*\(.*\))?$|^Prerequisites?:/i,
};

/** What the first version of guessKind read a text as. */
export function guessKindV1(name: string, text: string): ContentKind {
  const head = text.slice(0, 2000);
  const lines = leadingLines(text, 2);
  const top = lines.join('\n');
  if (V1.CASTING_TIME.test(head.slice(0, 800)) || V1.SPELL_LINE.test(top)) return 'spell';
  if (V1.ARMOR_CLASS.test(head) && V1.HIT_POINTS.test(head) && V1.CHALLENGE.test(head)) return 'monster';
  if (V1.ITEM_LINE.test(top)) return 'magic-item';
  if (FEAT_NAME.test(name.trim()) || lines.some((l) => V1.FEAT_LINE.test(l))) return 'feat';
  return 'rule';
}

/**
 * Whether an earlier version read this text as `kind` and today's rules read it as something else (a
 * stronghold room it took for a feat, a rules paragraph it took for a magic item…). Only the entry's own
 * text counts (before its first subsection), as at import.
 */
export function misreadBefore(kind: ContentKind, name: string, text: string, ancestors: readonly string[]): boolean {
  const body = ownBody(text);
  if (guessKindV1(name, body) !== kind) return false;
  const now = guessKind(name, body, ancestors);
  if (now === kind) return false;
  // A real item's type line that today's line test misses (after a label or a table cell, labelled "Item Type: … /
  // Rarity: …", its rarity in parentheses) is no misreading,
  if (kind === 'magic-item') return !ITEM_TYPE_LABELLED.test(leadingLines(body, 2).join('\n'));
  // nor a spell whose opening lines print its card's Casting Time with a casting time in its value's place,
  // however the first release's test read it (`printsCastingTime`), where today's rules read a rules text (a
  // card an import cut short, or printed in a shape today's card test doesn't read) or a stat block (a summoning
  // spell prints its creature's), unless the entry opens as a creature's does. A feat or an item that prints the
  // card of a spell it grants is still corrected.
  if (kind !== 'spell' || (now !== 'rule' && now !== 'monster')) return true;
  return leadingLines(body, 2).some((l) => CREATURE_LINE.test(l)) || !printsCastingTime(body, name);
}

/**
 * Whether a book's entry kinds are guessKind's guesses, which a later version may correct: imported text,
 * and book data of it. A JSON file's own kinds are never second-guessed.
 */
export function kindsAreGuesses(source: Pick<LibrarySource, 'kind' | 'format' | 'kindsGuessed'>): boolean {
  return source.kind === 'import' && (source.format !== 'json' || source.kindsGuessed === true);
}

/** Kinds an earlier version could misread (detection's entity kinds). */
export const GUESSED_ENTITY_KINDS: readonly ContentKind[] = ['spell', 'monster', 'magic-item', 'feat'];

function summaryLine(text: string, pattern: RegExp): string | undefined {
  const line = leadingLines(text, 3).find((l) => pattern.test(l));
  return line ? clip(line) : undefined;
}

const clip = (s: string) => (s.length <= MAX_SUMMARY_CHARS ? s : `${s.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`);

function summarize(kind: ContentKind, text: string, path: string[] | undefined): string | undefined {
  switch (kind) {
    case 'spell':
      return summaryLine(text, SPELL_LINE);
    case 'monster': {
      const cr = CHALLENGE.exec(text)?.[1];
      const descriptor = leadingLines(text, 3).find((l) => SIZE_LINE.test(l))?.split(',')[0];
      return [cr ? `CR ${cr}` : undefined, descriptor].filter(Boolean).join(' · ') || undefined;
    }
    case 'magic-item':
      return summaryLine(text, ITEM_LINE);
    case 'feat': {
      const category = summaryLine(text, FEAT_LINE) ?? openingCategory(text);
      return category ? clip(category) : undefined;
    }
    default:
      return path && path.length > 1 ? clip(path.slice(0, -1).join(' › ')) : undefined;
  }
}

function dataFor(kind: ContentKind, text: string): Record<string, unknown> | undefined {
  if (kind === 'spell') {
    const line = leadingLines(text, 3).find((l) => SPELL_LINE.test(l)) ?? '';
    const m = SPELL_LINE.exec(line);
    if (!m) return undefined;
    const level = Number(m[1] ?? m[4] ?? 0);
    const school = m[2] ?? m[3] ?? m[5];
    const classes = /\(([^)]+)\)\s*$/.exec(line)?.[1].split(/,\s*/).filter(Boolean);
    return { level, school: school.charAt(0).toUpperCase() + school.slice(1).toLowerCase(), ...(classes?.length ? { classes } : {}) };
  }
  if (kind === 'monster') {
    const cr = CHALLENGE.exec(text)?.[1];
    return cr ? { cr } : undefined;
  }
  if (kind === 'magic-item') {
    const rarity = RARITY.exec(leadingLines(text, 2).join(' '))?.[1].toLowerCase();
    return rarity ? { rarity } : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

interface Section {
  level: number;
  title: string;
  lines: string[];
  children: Section[];
}

const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^ {0,3}(```|~~~)/;

function normalize(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
}

/** Parse ATX and setext headings into a tree (root level 0 holds text before the first heading). */
function parseSections(text: string): { root: Section; headings: number } {
  const root: Section = { level: 0, title: '', lines: [], children: [] };
  const stack: Section[] = [root];
  const lines = text.split('\n');
  let inFence = false;
  let headings = 0;
  const open = (level: number, title: string) => {
    const node: Section = { level, title, lines: [], children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
    headings += 1;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) inFence = !inFence;
    const atx = inFence ? null : ATX_HEADING.exec(line);
    if (atx) {
      open(atx[1].length, atx[2]);
      continue;
    }
    const next = lines[i + 1];
    const prev = i > 0 ? lines[i - 1] : '';
    const setext = !inFence && next !== undefined && /^ {0,3}(=+|-+)\s*$/.test(next) && isSetextTitle(line, prev);
    if (setext) {
      open(next.trim().startsWith('=') ? 1 : 2, line.trim());
      i += 1;
      continue;
    }
    stack[stack.length - 1].lines.push(line);
  }
  return { root, headings };
}

/** A setext heading's text: one non-empty line after a blank line (not a list item or table row). */
function isSetextTitle(line: string, prev: string): boolean {
  const t = line.trim();
  return t !== '' && prev.trim() === '' && !/^(?:[-*+]\s|\d+[.)]\s|\||>)/.test(t);
}

const bodyOf = (node: Section) => node.lines.join('\n').trim();

/** A section's text with its descendants; descendant headings are re-leveled to start at ###. */
function renderSection(node: Section, depth = 0): string {
  const parts: string[] = [];
  if (depth > 0) parts.push(`${'#'.repeat(Math.min(6, depth + 2))} ${node.title}`);
  const body = bodyOf(node);
  if (body) parts.push(body);
  for (const child of node.children) parts.push(renderSection(child, depth + 1));
  return parts.join('\n\n').trim();
}

// ---------------------------------------------------------------------------
// Plain-text heading inference
// ---------------------------------------------------------------------------

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'vs', 'with']);

/**
 * A spell card's label alone on its line over its value on the next ("Casting Time" / "Action", "Range" /
 * "60 feet", "Level" / "3rd"), not a rules subhead over its paragraph ("Casting Time" / "Most spells take an
 * action.", "Duration" / "A spell lasts as long as its Duration says.").
 */
function labelOverValue(line: string, next: string): boolean {
  const [t, value] = [cardText(line), cardText(next)];
  if (/^Level:?$/i.test(t)) return /^(?:\d{1,2}(?:st|nd|rd|th)?|Cantrip)$/i.test(value);
  const label = CARD_LABEL_ALONE.exec(t)?.[1];
  if (label === undefined) return false;
  if (!isCastingTime(label)) return cardValue(label, value);
  return CASTING_TIME_VALUE.test(value) && (!/[.!?]$/.test(value) || SPACED_CASTING_TIME_VALUE.test(value));
}

function looksLikeTitle(line: string, prev: string | undefined, next = ''): boolean {
  const t = line.trim();
  if (t.length < 3 || t.length > 70) return false;
  if (/[.,;:!?]$/.test(t) || /^(?:[-*+•]\s|\d+[.)]\s|\||>)/.test(t)) return false;
  if (t.includes(':') && !/^(?:chapter|part|appendix|book)\b/i.test(t)) return false;
  // A feat's category line ("Origin Feat") belongs to the feat above it, and a spell card's lines to the
  // spell: a label and its value ("Casting Time    Action", "Casting Time" over "Action"), a table's row
  // ("Casting Time | Range | Duration", with or without a delimiter row under it) or a row of its labels
  // pasted as text ("Casting Time    Range    Duration").
  if (!/^[\p{Lu}\d]/u.test(t) || isStatBlockSection(t) || FEAT_CATEGORY_LINE.test(t) || cardLine(t)) return false;
  const cells = t.split(SPACED_CELLS);
  if (t.includes('|') || isDelimiterRow(next.trim()) || labelOverValue(t, next) || (cells.length > 1 && labelRow(cells.map(cardText)))) return false;
  const words = t.split(/\s+/);
  if (words.length > 9) return false;
  const significant = words.filter((w) => /\p{L}/u.test(w) && !SMALL_WORDS.has(w.toLowerCase()));
  if (!significant.length) return false;
  const capitalized = significant.filter((w) => /^[("'‘“]?[\p{Lu}\d]/u.test(w)).length;
  if (capitalized / significant.length < 0.75) return false;
  const before = prev?.trim() ?? '';
  // A heading follows a blank line, or the end of a paragraph when the text has no blank lines.
  return before === '' || (before.length > 70 && /[.!?)"”]$/.test(before));
}

/** Promote title-like lines of plain text to "## " headings; null when fewer than two are found. */
export function inferPlainTextHeadings(text: string): string | null {
  const lines = text.split('\n');
  const marked = lines.map((line, i) => looksLikeTitle(line, i > 0 ? lines[i - 1] : undefined, lines[i + 1]));
  if (marked.filter(Boolean).length < 2) return null;
  return lines.map((line, i) => (marked[i] ? `## ${line.trim()}` : line)).join('\n');
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/** Split text into parts of about `target` characters at paragraph (then sentence) boundaries. */
export function splitIntoChunks(text: string, target = TARGET_CHUNK_CHARS): string[] {
  const pieces: string[] = [];
  for (const para of text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    if (para.length <= target * 2) {
      pieces.push(para);
      continue;
    }
    // One huge paragraph: cut at sentence ends (or hard, for text without punctuation).
    let rest = para;
    while (rest.length > target) {
      const window = rest.slice(0, target);
      const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
      const at = cut > target * 0.3 ? cut + 1 : Math.max(window.lastIndexOf(' '), Math.floor(target * 0.5));
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) pieces.push(rest);
  }
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > target) {
      chunks.push(current);
      current = piece;
    } else current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

interface ChunkOptions {
  sourceId: string;
  sourceName: string;
}

class EntryBuilder {
  readonly entries: CompendiumEntry[] = [];
  constructor(private readonly opts: ChunkOptions) {}

  /** Add an entry (split into numbered parts when too long). */
  add(name: string, text: string, ancestors: string[], kind = guessKind(name, text, ancestors)): void {
    const max = kind === 'rule' ? MAX_RULE_CHARS : MAX_ENTITY_CHARS;
    const parts = text.length > max ? splitIntoChunks(text) : [text];
    parts.forEach((part, i) => {
      const partName = i === 0 ? name : `${name} (part ${i + 1})`;
      const path = ancestors.length ? [...ancestors, partName] : undefined;
      const summary = summarize(kind, part, path);
      const data = dataFor(kind, part);
      this.entries.push({
        id: `lib:${this.opts.sourceId}:${this.entries.length + 1}`,
        sourceId: this.opts.sourceId,
        sourceName: this.opts.sourceName,
        kind,
        name: partName,
        ...(summary ? { summary } : {}),
        text: part,
        ...(path ? { path } : {}),
        ...(data ? { data } : {}),
      });
    });
  }
}

/**
 * Entries for a heading subtree. Entities keep their subsections; rules sections recurse. A stat
 * block's "Actions" (and the like) belong to the creature: when a PDF puts them at the creature's own
 * heading level, they follow the creature as siblings, and the creature before them takes them along.
 * `adopted`: such siblings, for an entity.
 *
 * A section that reads as a spell but has subsections that read as spells themselves is a chapter of spells
 * (its own text a sample card, what a card's fields mean or a list of spells), not one spell that holds them:
 * its own text is an entry of its own and its subsections are theirs. Other entities keep their subsections
 * whatever they read as (a creature's "Variant" stat block stays the creature's).
 */
function addSection(node: Section, ancestors: string[], out: EntryBuilder, adopted: readonly Section[] = []): void {
  const title = stripInlineMarkdown(node.title) || 'Untitled';
  const body = bodyOf(node);
  const kind = guessKind(title, body, ancestors);
  const inner = [...ancestors, title];
  const childKind = (c: Section) => (isStatBlockSection(c.title) ? null : guessKind(stripInlineMarkdown(c.title) || 'Untitled', bodyOf(c), inner));
  const kinds = kind === 'rule' || kind === 'spell' ? node.children.map(childKind) : [];
  if (kind !== 'rule' && !(kind === 'spell' && kinds.includes('spell'))) {
    out.add(title, renderSection({ ...node, children: [...node.children, ...adopted] }), ancestors, kind);
    return;
  }
  const ownStatBlockParts: Section[] = [];
  const adoptedBy = new Map<Section, Section[]>();
  let creature: Section | null = null;
  node.children.forEach((child, i) => {
    const childKind = kinds[i];
    if (childKind === null) {
      if (creature) adoptedBy.get(creature)?.push(child);
      else ownStatBlockParts.push(child);
      return;
    }
    creature = childKind === 'monster' ? child : null;
    if (creature) adoptedBy.set(creature, []);
  });
  const ownText = renderSection({ ...node, children: ownStatBlockParts });
  if (ownText) out.add(title, ownText, ancestors);
  node.children.forEach((child, i) => {
    if (kinds[i] !== null) addSection(child, inner, out, adoptedBy.get(child) ?? []);
  });
}

/** Split Markdown or plain text into compendium entries (ids "lib:<sourceId>:<n>"). */
export function chunkDocument(text: string, opts: ChunkOptions): CompendiumEntry[] {
  const out = new EntryBuilder(opts);
  const normalized = normalize(text).trim();
  if (!normalized) return out.entries;
  let parsed = parseSections(normalized);
  if (parsed.headings === 0) {
    const inferred = inferPlainTextHeadings(normalized);
    if (inferred) parsed = parseSections(inferred);
  }
  const { root, headings } = parsed;
  if (headings === 0) {
    const chunks = splitIntoChunks(normalized);
    chunks.forEach((chunk, i) => {
      out.add(chunks.length === 1 ? opts.sourceName : `${opts.sourceName} (part ${i + 1})`, chunk, []);
    });
    return out.entries;
  }
  const preamble = bodyOf(root);
  if (preamble) out.add(opts.sourceName, preamble, []);
  for (const child of root.children) addSection(child, [], out);
  return out.entries;
}

// ---------------------------------------------------------------------------
// Kinds an older version guessed
// ---------------------------------------------------------------------------

const PART_NAME = /^(.*) \(part (\d+)\)$/;

/** An entity entry's own text: what its stored text holds before its first subsection (renderSection re-levels those to ### and deeper). */
export function ownBody(text: string): string {
  return text.split(/\n(?=#{3,6}[ \t])/)[0];
}

/** A corrected kind for a stored entry, with the summary that kind gives (none = no summary). */
export interface KindCorrection {
  id: string;
  kind: ContentKind;
  summary?: string;
}

/** The n of "lib:<sourceId>:<n>" (Infinity for any other id). */
function ordinal(id: string): number {
  const n = Number(id.slice(id.lastIndexOf(':') + 1));
  return Number.isInteger(n) && n >= 0 ? n : Number.POSITIVE_INFINITY;
}

/**
 * Corrections for kinds an earlier version of guessKind stored (kinds are guessed once, at import;
 * src/data/structured/staleKinds.ts applies these): an entry stored as a spell, monster, magic item or
 * feat that an earlier version read that way and today's rules read as something else (misreadBefore)
 * gets the kind and summary guessKind gives now. A long entry's "(part N)" continuations follow their
 * first part. Pure. `entries`: one source's entries (all of them, or only those of those kinds), in any order.
 */
export function staleEntryKinds(entries: readonly CompendiumEntry[]): KindCorrection[] {
  const out: KindCorrection[] = [];
  let head: { name: string; parent: string; stored: ContentKind; kind: ContentKind | null } | null = null;
  const correction = (entry: CompendiumEntry, kind: ContentKind): KindCorrection => {
    const summary = summarize(kind, entry.text, entry.path);
    return { id: entry.id, kind, ...(summary ? { summary } : {}) };
  };
  const ordered = entries.map((entry, index) => ({ entry, index })).sort((a, b) => ordinal(a.entry.id) - ordinal(b.entry.id) || a.index - b.index);
  for (const { entry } of ordered) {
    const ancestors = (entry.path ?? []).slice(0, -1);
    const parent = ancestors.join('\u0000');
    const part = PART_NAME.exec(entry.name);
    if (part && head && part[1] === head.name && parent === head.parent) {
      if (head.kind && head.stored === entry.kind) out.push(correction(entry, head.kind));
      continue;
    }
    head = { name: entry.name, parent, stored: entry.kind, kind: null };
    if (!GUESSED_ENTITY_KINDS.includes(entry.kind) || !misreadBefore(entry.kind, entry.name, entry.text, ancestors)) continue;
    const kind = guessKind(entry.name, ownBody(entry.text), ancestors);
    head.kind = kind;
    out.push(correction(entry, kind));
  }
  return out;
}

/**
 * A book's entries with the kinds today's rules give where an earlier version's are stale (in memory: what
 * src/data/structured/staleKinds.ts stores), so detection reads the book right even when the correction
 * couldn't be stored. Pure.
 */
export function withCurrentKinds(entries: readonly CompendiumEntry[]): CompendiumEntry[] {
  const fixes = new Map(staleEntryKinds(entries.filter((e) => GUESSED_ENTITY_KINDS.includes(e.kind))).map((c) => [c.id, c]));
  if (fixes.size === 0) return [...entries];
  return entries.map((e) => {
    const fix = fixes.get(e.id);
    if (!fix) return e;
    const { summary: _old, ...rest } = e;
    return { ...rest, kind: fix.kind, ...(fix.summary ? { summary: fix.summary } : {}) };
  });
}
