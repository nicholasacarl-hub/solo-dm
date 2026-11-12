/**
 * Offline magic-item parser (spec §3.9): the type line under the name (parseMagicItemSubtitle, the
 * build-srd rule: "_Armor (Chain Mail), Rare (Requires Attunement)_"; older "*Armor (plate), rare
 * (requires attunement by a wizard)*"), flat bonuses only from "+N bonus to AC / Armor Class / attack and
 * damage rolls / saving throws" clauses that always hold, and "has N charges".
 *
 * Owner: E2. Pure.
 */
import type { Candidate } from '../segment';
import type { Wire } from '../wire';
import type { OfflineParse } from './index';
import { plain, textLines } from './lines';
import { parseMagicItemSubtitle } from './srdRulesEntity';

const RARITY = /\b(very rare|uncommon|common|rare|legendary|artifact|rarity varies|varies)\b/i;
const CATEGORY = String.raw`(?:wondrous item|weapon|armor|ring|rod|staff|wand|potion|scroll|shield|ammunition)\b`;
const CATEGORY_WORD = new RegExp(`^${CATEGORY}`, 'i');

type Category = Wire<'magic-item'>['category'];
type Rarity = Wire<'magic-item'>['rarity'];

const PAREN = String.raw`\s*\([^)]*\)`;
const RARITY_WORD = String.raw`(?:very rare|uncommon|common|rare|legendary|artifact|rarity varies|varies)\b`;
/**
 * A type line's own grammar: a category with its parentheticals, a comma, then rarities joined by ", ",
 * " or " or ", or ", each with its parentheticals (the attunement clause among them): "Wondrous Item,
 * Rare or Very Rare (Requires Attunement)", "Weapon (Any Simple or Martial), Uncommon (+1), Rare (+2), or
 * Very Rare (+3)", "Wondrous Item (Common Clothes), Uncommon".
 */
const TYPE_LINE = new RegExp(
  String.raw`^((?:wondrous item|weapon|armor|ring|rod|staff|wand|potion|scroll|shield|ammunition)\b[^,(]*(?:${PAREN})*\s*,\s*${RARITY_WORD}(?:${PAREN})*(?:\s*(?:,\s*(?:or\s+)?|or\s+)${RARITY_WORD}(?:${PAREN})*)*)(.*)$`,
  'i',
);
/** A type line that names no rarity ends at its attunement clause. */
const ATTUNEMENT_END = /^(.*?\(requires attunement[^)]*\))(.*)$/i;
/**
 * A label, a table cell or the item's name before its type line ("Type: Wondrous Item, Rare", "| Type |
 * Wondrous Item, Rare |", "Owl Lantern — Wondrous Item, Rare", "Owl Lantern - …", "Owl Lantern (wondrous item, rare)").
 * A name before a dash may start with a category word and hold a parenthesis ("Ring of Warmth — Ring, Uncommon",
 * "Stone of Good Luck (Luckstone) — Wondrous Item, …"); a name before a parenthesis may not, so a type line
 * that ends in one ("Shield, Rare (shield +1)") stays whole.
 */
const BEFORE_TYPE_LINE = new RegExp(
  String.raw`^\|?\s*(?:(?:Type|Item|Category)\s*[:.|]\s*|[^—–|]{1,60}\s[—–-]\s|(?!${CATEGORY})[^—–|(]{1,60}\s\((?=[^()]*\)\s*$))(?=${CATEGORY})`,
  'i',
);
/** The item's text, joined after its type line by a PDF (the line's grammar says where it ends): a capital letter. */
const JOINED_PROSE = /^["“‘(]?\p{Lu}/u;
const opensMore = (text: string) => (text.match(/\(/g)?.length ?? 0) > (text.match(/\)/g)?.length ?? 0);

/**
 * The type line: the first line that starts with a category word and names a rarity (or attunement).
 * A PDF often joins the item's first paragraph onto it; that part (`rest`) is the item's text, where its
 * bonus and charges usually are. A line that stands alone is all type line. `raw`: the line as it stood.
 */
export function typeLine(text: string): { line: string; raw: string; rest: string } {
  const lines = textLines(text).slice(0, 7);
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    // A type line wrapped over lines ("(Requires Attunement by a" / "Sorcerer or Wizard)") is read whole.
    let printed = lines[i];
    for (let j = i + 1; opensMore(printed) && j < lines.length && j <= i + 2; j++) printed = `${printed} ${lines[j]}`;
    if (opensMore(printed)) printed = lines[i];
    const raw = plain(printed);
    const named = BEFORE_TYPE_LINE.exec(raw);
    // "Owl Lantern (wondrous item, rare)": the parenthesis around the type line goes too.
    const unwrapped = named?.[0].trimEnd().endsWith('(') ? raw.slice(named[0].length).replace(/\)\s*$/, '') : raw.replace(BEFORE_TYPE_LINE, '');
    // A line whose dash isn't after a name ("Armor (Scale Mail), Rare — Armor of the Deep") is read whole.
    const line = [unwrapped, raw].map((l) => l.replace(/\s*\|\s*$/, '')).find((l) => isTypeLine(l, l !== raw));
    if (line === undefined) continue;
    const m = TYPE_LINE.exec(line) ?? ATTUNEMENT_END.exec(line);
    const rest = m?.[2].trim() ?? '';
    return m && rest && JOINED_PROSE.test(rest) ? { line: m[1].trim(), raw, rest } : { line, raw, rest: '' };
  }
  return { line: '', raw: '', rest: '' };
}

/** A line that starts with a category word and names a rarity (or attunement); after a label or a name, only one shaped like a type line ("…, Rare"). */
function isTypeLine(line: string, afterName: boolean): boolean {
  if (!CATEGORY_WORD.test(line) || !(RARITY.test(line) || /requires attunement/i.test(line))) return false;
  return !afterName || TYPE_LINE.test(line);
}

/** The text of a candidate's blocks, as the parser reads it. */
export function itemText(blocks: readonly { text?: string; paragraphs: readonly string[] }[]): string {
  return blocks.map((b) => b.text ?? b.paragraphs.join('\n\n')).join('\n\n');
}

/** Every match of a global regex, without the copy matchAll makes of it (copying a long pattern is costly). */
function execAll(re: RegExp, text: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push(m);
    if (m[0] === '') re.lastIndex++;
  }
  return out;
}

/** A text's sentences, each with its closing ". ! ?" (split where a space follows one). */
function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (const m of execAll(SENTENCE_END, text)) {
    out.push(text.slice(from, m.index + 1));
    from = m.index + m[0].length;
  }
  out.push(text.slice(from));
  return out;
}
const SENTENCE_END = /[.!?]\s+/g;

/** A line of a Markdown list ("- …", "* …", "• …", "1. …"). */
const LIST_LINE = /^\s*(?:[-*+•]|\d+[.)])\s+(.*)$/;
/** A paragraph that is one list item, as itemParagraphs marks it ("- Radiant Ward. You have…"). */
const LIST_ITEM = /^[-•]\s+/;

/**
 * An item's prose blocks: no tables; each list item a block of its own marked "- " (a book lists what an intro offers as
 * "- **Label.** …"; flatten() and a PDF give each item a paragraph, or run them together); and each heading ("####
 * Pressure Ward") or bold-only line ("**Pressure Ward**", "**Pressure Ward.**", "**Oak (Uncommon)**") a block of its own
 * marked as a heading "# ", which pieces() reads as a label that governs the next piece, or a variant's run-in (I6).
 */
function proseBlocks(text: string): string[] {
  const out: string[] = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    let item: string | null = null;
    const flush = () => {
      if (item !== null) out.push(item);
      item = null;
    };
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('|')) {
        flush();
        continue;
      }
      const bold = BOLD_LINE.exec(line);
      const heading = HEADING_LINE.exec(line) ?? (bold && boldLabel(bold[1]) ? bold : null);
      if (heading) {
        flush();
        out.push(`# ${heading[1].trim()}`);
        continue;
      }
      const m = LIST_LINE.exec(line);
      if (m) {
        flush();
        item = `- ${m[1]}`;
      } else item = item === null ? line : `${item} ${line}`;
    }
    flush();
  }
  return out;
}
/** A Markdown heading line, and a line that is all bold ("**Pressure Ward**", "_**Pressure Ward.**_", "***Iron Hide***"). */
const HEADING_LINE = /^#{1,6}\s+(.+?)[\s#]*$/;
const BOLD_LINE = /^(?:[*_]{0,1})(?:\*\*|__)\s*([^*_]{1,80}?)\s*(?:\*\*|__)(?:[*_]{0,1})$/;
/** A bold line that reads as a label (a variant's name, Title Case words, a parenthesis, or up to three words), not a bold sentence. */
const boldLabel = (text: string) => {
  const bare = text.replace(/[.:]\s*$/, '').trim();
  return !/\+\s?\d/.test(bare) && (VARIANT_NAME.test(bare) || RUN_IN_LABEL.exec(`${bare}. A`)?.[1] === bare || (bare.includes('(') && labelShaped(bare)) || bare.split(/\s+/).length <= 3);
};

/**
 * An item's prose paragraphs, emphasis removed: without its type line, with what a PDF joined onto that
 * line, with a sentence a PDF broke at a column or page end whole again (rejoined), and with the list items
 * and intro a PDF ran together apart again (blocksOf).
 */
export function itemParagraphs(text: string): string[] {
  const known = paragraphsCache.get(text);
  if (known) return [...known];
  const out = readParagraphs(text);
  remember(paragraphsCache, text, out);
  return [...out];
}

/**
 * The parser and the normalizer each read an item's paragraphs and bonuses from the same text: the last few readings
 * are kept, so the second read costs nothing. The functions stay pure (a reading depends on its arguments only).
 */
const paragraphsCache = new Map<string, readonly string[]>();
const phrasesCache = new Map<string, readonly BonusPhrase[]>();
function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.size >= 64) cache.delete(cache.keys().next().value as string);
  cache.set(key, value);
}

function readParagraphs(text: string): string[] {
  const { raw, rest } = typeLine(text);
  let found = !raw;
  const paragraphs = proseBlocks(text)
    .map(plain)
    .map((p) => {
      // A heading before the type line is the item's own (its name), not one of its labels.
      if (!found && HEADING_PARA.test(p)) return '';
      if (found || !p.startsWith(raw)) return p;
      found = true;
      return `${rest} ${p.slice(raw.length)}`.trim();
    })
    .filter(Boolean);
  return rejoined(paragraphs).flatMap(blocksOf);
}

/** A paragraph that ends its last sentence (". ! ?", perhaps inside quotes or brackets). */
const ENDS_SENTENCE = /[.!?]["”’')\]]*$/;
/**
 * Where a sentence can't end, so a PDF cut it there (D5): an article or determiner, a preposition, a conjunction, an
 * auxiliary, "you", "+N", "bonus", "Armor", "magic", an article and one word, a comma or a dash ("…a +2 bonus to
 * Armor" | "Class, …", "…while you hold this" | "Shield raised…", "…wielded as a magic" | "Quarterstaff that…").
 */
const CANT_END = new RegExp(
  String.raw`(?:^|[\s(])(?:a|an|the|this|that|these|those|its|your|their|his|her|our|each|every|any|some|no|both|either|neither|all|another|such|to|of|in|on|at|by|for|with|from|into|onto|upon|against|within|without|during|after|before|under|over|between|through|across|around|near|as|than|beneath|below|above|behind|beyond|beside|among|along|toward|towards|via|per|like|and|or|but|nor|while|whilst|when|whenever|if|unless|until|because|although|though|whereas|so|which|who|whose|where|are|is|was|were|be|been|being|am|can|could|may|might|must|shall|should|will|would|do|does|did|has|have|had|not|only|also|even|you|you're|you've|you'll|bonus|armor|hit|dim|bright|saving|magic|magical|nonmagical|\+\d+)$|(?:^|\s)(?:a|an)\s+[\p{L}'-]+$|[,;—–-]$`,
  'iu',
);
/** A paragraph that starts on its own whatever came before: a heading, a table, a list item, a type line or a variant's run-in (I5). */
const standsAlone = (p: string) => /^(?:#|\||[-*+•]\s)/.test(p) || isTypeLine(p, false) || VARIANT_RUN_IN.test(p) || VARIANT_ALONE.test(p);

/**
 * pdfPagesToMarkdown starts a paragraph at every column and page break (and after a short line), so "…You have
 * a +1 bonus to Armor Class" | "while you're Bloodied." come apart. A paragraph with no closing ". ! ?" goes on
 * in the next one (I5) when that starts in lower case ("two-" | "handed" keeps its hyphen), with "(" or a dash
 * ("…to Armor Class" | "(only while…)", "…to Armor Class" | "— but only…"), or, whatever it starts with, when the
 * first ends where a sentence can't (CANT_END: "…while you hold this" | "Shield raised…", "…+2 bonus to" | "Armor
 * Class. In addition…", "…instead of" | "Slashing damage. When…"; or inside a parenthesis) and the next doesn't
 * start on its own (standsAlone): a one-to-three-word "label" there is the end of the cut sentence. A heading, a
 * table or an intro's ":" never goes on.
 */
function rejoined(paragraphs: readonly string[]): string[] {
  const out: string[] = [];
  // What is judged of the last paragraph, kept as paragraphs join it, so a chain of joins never reads it again (G3): its
  // open parentheses, its last words (endOf: a sentence's end is judged there), whether it is only a list's bullet, and
  // whether it is a heading or a table row (joins only add to its end).
  let depth = 0;
  let end = '';
  let lone = false;
  let block = false;
  const push = (p: string) => {
    out.push(p);
    depth = balanceOf(p);
    end = endOf(p);
    lone = /^[-•*+]$/.test(p.trim());
    block = /^(?:#|\|)/.test(p);
  };
  for (const p of paragraphs) {
    const last = out.length - 1;
    if (last < 0) {
      push(p);
      continue;
    }
    // A list's bullet a column ended right after ("•" | "You have a +1 bonus…") goes on in the next paragraph, a list item
    // again; so does one a PDF ran onto the end of the line before it ("…Cold damage. •" | "You have a +1 bonus…").
    if (lone && !/^(?:#|\|)/.test(p)) {
      out[last] = `${out[last].trim()} ${p}`;
      depth += balanceOf(p);
      end = endOf(out[last]);
      lone = /^[-•*+]$/.test(out[last].trim());
      block = false;
      continue;
    }
    if (/[.!?:]\s+•\s*$/.test(end) && !/^(?:#|\||[-•*+]\s)/.test(p)) {
      out[last] = out[last].replace(/\s+•\s*$/, '');
      push(`• ${p}`);
      continue;
    }
    const open = !ENDS_SENTENCE.test(end) && !block && !standsAlone(p);
    const broken = open && (/^\p{Ll}/u.test(p) || (!/:\s*$/.test(end) && (/^["“‘]?[([—–]/u.test(p) || CANT_END.test(end) || depth > 0)));
    if (broken) {
      const glued = /\p{L}-$/u.test(end) && /^\p{Ll}/u.test(p);
      out[last] = glued ? `${out[last]}${p}` : `${out[last]} ${p}`;
      // endOf of the joined paragraph, from its last words only (the same words: they end it).
      end = endOf(glued ? `${end}${p}` : `${end} ${p}`);
      depth += balanceOf(p);
      // A joined paragraph holds more than a bullet (a letter, a bracket, a dash or the word it was cut after).
      lone = false;
    } else push(p);
  }
  return out;
}
/** A text's "(" less its ")". */
const balanceOf = (text: string) => (text.match(/\(/g)?.length ?? 0) - (text.match(/\)/g)?.length ?? 0);
/** A paragraph's last words, from a space, for the tests anchored at its end (ENDS_SENTENCE, CANT_END). */
function endOf(text: string): string {
  if (text.length <= 120) return text;
  const at = text.indexOf(' ', text.length - 120);
  return at < 0 ? text.slice(-120) : text.slice(at);
}

/**
 * A paragraph's blocks: list items a PDF ran together ("- Radiant Ward. … - Sun Sight. …") apart, and an intro
 * that ends in ":" apart from what it offers when a PDF joined them ("…the following benefits: Radiant Ward. …").
 */
function blocksOf(paragraph: string): string[] {
  const items = /\s[-•]\s|•/.test(paragraph) ? paragraph.split(/(?<=[.!?:])\s+(?=[-•]\s+\S)|\s+(?=•\s*\S)/) : [paragraph];
  return items.flatMap((p) => {
    if (!p.includes(':')) return [p];
    const out: string[] = [];
    let from = 0;
    for (const m of p.matchAll(/:\s+(?=\S)/g)) {
      const at = (m.index ?? 0) + 1;
      const after = p.slice(at).trimStart();
      if (INTRO_OFFER.test(lastSentence(p.slice(from, at))) || LIST_ITEM.test(after) || runInLabel(after) !== null) {
        out.push(p.slice(from, at).trim());
        from = at;
      }
    }
    out.push(p.slice(from).trim());
    return out.filter(Boolean);
  });
}

const lastSentence = (text: string) => sentencesOf(text).pop() ?? '';

function categoryOf(categoryText: string, mapped: string | undefined, baseItem: string | undefined): Category {
  const word = categoryText.toLowerCase();
  if (word.startsWith('shield') || (mapped === 'armor' && /^shield$/i.test(baseItem ?? ''))) return 'shield';
  if (word.startsWith('ammunition') || (mapped === 'weapon' && /^(?:any\s+)?ammunition$|^arrows?$|^bolts?$/i.test(baseItem ?? ''))) return 'ammunition';
  const known: readonly Category[] = ['armor', 'weapon', 'ring', 'rod', 'staff', 'wand', 'potion', 'scroll', 'wondrous-item'];
  return known.includes(mapped as Category) ? (mapped as Category) : 'other';
}

type AcCondition = Wire<'magic-item'>['acCondition'];
interface Bonus { ac: number; save: number; attack: number; damage: number; text: string; condition: AcCondition; acExcerpt: string }

/**
 * "+N bonus to …" or "+N to …" naming what it raises, each target perhaps after "all" or "your", or "to" in a
 * list: "+1 bonus to AC and saving throws", "+2 bonus to all saving throws", "+1 to AC", "+1 bonus to your
 * Armor Class", "+1 bonus to AC and to saving throws" ("ability checks" too, which the app doesn't track). "Its
 * AC" is someone else's (a companion's, an object's): LOOSE reads it.
 */
const BONUS_TARGET = String.raw`(?:all\s+)?(?:your\s+)?(?:AC|Armor Class|attack(?:\s+rolls)?|damage(?:\s+rolls)?|saving throws|ability checks)`;
const BONUS = new RegExp(String.raw`\+\s?(\d)(?!\d)(?:\s+bonus)?\s+to\s+(${BONUS_TARGET}(?:(?:,\s*|\s+and\s+|,\s+and\s+)(?:to\s+)?${BONUS_TARGET})*)`, 'gi');
/**
 * Every "+N" the normalizer grounds a reading's bonus by (bonusStated: "+N (bonus) to …" naming the target
 * before the next "+", ";" or full stop), worded otherwise: "+2 bonus to spell attack rolls", "+1 bonus to its
 * AC", "+1 bonus to Dexterity saving throws". The app applies none of these; a record that does gets a note.
 */
const LOOSE = /\+\s?(\d)(?!\d)(?:\s+bonus)?\s+to\b([^.;+]*)/gi;
const LOOSE_TARGETS: readonly (readonly [BonusTarget, RegExp])[] = [
  ['ac', /\bAC\b|\bArmor Class\b/i],
  ['savingThrows', /\bsaving throws?\b/i],
  ['attack', /\battack\b/i],
  ['damage', /\bdamage\b/i],
];
/** A bonus whole at a paragraph's end (no cut). */
const BONUS_AT_END = new RegExp(`${BONUS.source}\\s*$`, 'i');
/** A bonus a PDF cut at a paragraph's end before its target was whole ("…a +2 bonus to", "…a +2 bonus to Armor"). */
const CUT_BONUS = /\+\s?(\d)(?!\d)(?:\s+bonus(?:\s+to(?:\s+(?:all|your))?(?:\s+(?:(Armor)|(saving)))?)?)?\s*$/i;
/**
 * A save bonus for some saves only, by ability or kind ("+1 bonus to Constitution saving throws", "+2 bonus to
 * death saving throws"): the app adds an item's save bonus to every save, so it holds only in some situations,
 * and the note says so even when no record applies it.
 */
const ABILITY_OR_KIND = String.raw`(?:Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma|death)`;
const SCOPED_SAVES = new RegExp(String.raw`^\s*(?:all\s+)?(?:your\s+)?(?:${ABILITY_OR_KIND}(?:\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+))*${ABILITY_OR_KIND}\s+saving throws?\b`, 'i');
const NO_ARMOR = /\b(?:wear(?:ing)? no armor|no armor|(?:aren't|not) wearing (?:any )?armor|(?:don't|do not) wear (?:any )?armor|neither armor)\b/i;
/**
 * The no-shield part of the no-armor condition (NO_ARMOR_PHRASE): "and using no Shield", "and no shield", "no
 * armor or shield", "neither armor nor a shield", "and not wielding a shield", "and don't use a shield", "aren't
 * wearing armor or a Shield".
 */
const NO_SHIELD =
  /\b(?:no shield|no armor,? (?:or|nor) (?:a )?shield|neither armor nor (?:a )?shield|(?:not|aren't|don't|do not) (?:using|wielding|holding|carrying|use|wield|hold|carry) a shield|without a shield|(?:aren't|not|don't|do not) wear(?:ing)? (?:any )?armor,? (?:or|nor) (?:(?:using|wielding|holding|carrying|use|wield|hold|carry) )?(?:a )?shield)\b/i;
const HANDED = String.raw`(?:one|two|single|bare)(?:-\s?|\s)?handed`;
/**
 * A bonus that holds only in some situations: against some foes, for a while, as a Reaction, for a
 * charge spent, when something happens, while something else is so ("while you're Bloodied", "while
 * raging"), unless, provided or each time something is, in an example, with some weapons only ("damage
 * rolls made with such weapons"), underwater, mounted or two-handed, in some place or at some time ("in
 * Dim Light", "within 10 feet of an ally", "during your turn", "at night"). The app applies flat bonuses
 * only (SRD 5.2.1 "Magic Items": a bonus the item always grants while worn, held or attuned). The reader judges
 * each bonus by grammar that fails closed (situationalIn): its subject must be the wearer or the item (subjectOf),
 * whatever leads into its clause must say the item is worn, held, carried or attuned (leadInHolds), what follows
 * its targets must keep it whole (tailHolds), no later clause, sentence, opening (I7), intro or label may limit it (D1, D2, I1-I4), and
 * this list is the last check over what is left of its clause. Fail closed: a bonus left out is noted and the DM
 * can apply it; one applied in the wrong situation changes combat unseen.
 */
const AGAINST = /\bagainst\b/i;
const SITUATIONAL = new RegExp(
  String.raw`\buntil\b|\bfor (?:\d+|one|an?|the next) (?:rounds?|minutes?|hours?|days?|turns?)\b|\bReaction\b|\b(?:expend|spend)\b|\bcharges?\s+to\b|\bwhen(?:ever)?\b|\bwhil(?:e|st)\b|\b(?:as|so)\s+long\s+as\b|\bprovid(?:ed|ing)\b(?!\s+by\b)|\b(?:each|every)\s+time\b|\bunless\b|\bfor the duration\b|\bonce (?:per|each|every|a|an|on|during)\b|\bsuch weapons\b|\b(?:underwater|underground|outdoors|indoors|outside|aloft|afloat|alone|overhead|mounted|${HANDED})\b|\b(?:in|within|inside|during|near)\b(?!\s+(?:addition\b|your\s+(?:possession|hands?)\b))|\bat\b(?!\s+all\s+times\b)`,
  'i',
);
/** A letter of a word (apostrophes are straightened before a bonus is judged). */
const L = String.raw`[\p{L}'-]`;
const WORD_END = String.raw`(?!${L})`;
/** Words that end the item's noun phrase: what follows it in a condition ("this sword against Undead", "this cloak and are Invisible"). */
const NOT_ITEM = String.raw`(?:against|in|into|inside|on|onto|upon|at|with|within|without|while|whilst|when|whenever|if|unless|until|and|or|but|nor|for|near|to|by|as|after|before|during|from|of|off|out|over|under|beneath|below|above|across|around|through|among|between|beyond|behind|beside|along|than|so|is|are|was|were|be|been|has|have|had|can|could|may|might|must|shall|should|will|would|you|your|it|its|they|them|their|that|which|who|whose|where|there|here|then|now|again|still|even|also|only|just|not|no|this|these|those|the|a|an|up|down)`;
/** Adverbs and manner words: a condition after the item ("this armor underwater", "this sword two-handed" or "twohanded", "this Shield firmly"), never an item's own noun. */
const ADVERB = String.raw`(?:underwater|underground|outdoors|indoors|outside|aloft|afloat|alone|overhead|(?:one|two|single|bare)-?handed|mounted|(?!(?:(?:un)?godly|ghostly|ghastly|deadly|lovely|costly|kingly|lordly|princely|priestly|saintly|stately|(?:un)?earthly|otherworldly|heavenly|family|friendly)${WORD_END})${L}{3,}ly|${L}{2,}wards?)`;
const NOT_ITEM_WORD = new RegExp(String.raw`^(?:${NOT_ITEM}|${ADVERB})$`, 'iu');
/** A state the item is in for a while ("this raised Shield", "this drawn sword", "this unlit lantern"): a condition, never a word of its phrase. */
const STATE = String.raw`(?:raised|lowered|drawn|sheathed|unsheathed|lit|unlit|lighted|ignited|burning|open|opened|closed|shut|unfurled|furled|folded|unfolded|extended|retracted|readied|upright|inverted|reversed|activated|active|inactive|charged|uncharged|loaded|unloaded|strung|unstrung|empty|full|filled)`;
/** A word of an item phrase before its noun ("black", "iron", "two-handed", "magic", "polished"): any but those that end a noun phrase, and states. */
const WORD = String.raw`(?!(?:${NOT_ITEM}|${STATE})${WORD_END})${L}+${WORD_END}`;
/**
 * Nouns a book calls an item by (a generous list). An item phrase ends at one ("this black iron helm", "this
 * two-handed sword", "this pair of bracers"), so a word after it ("this staff upright", "this Shield raised",
 * "this sword twohanded") is a leftover the bonus is judged by (harmlessAfter), never part of the item; a phrase
 * that ends at another word fails closed, unless that word is the item's own (namesItem).
 */
const ITEM_NOUNS = [
  'item', 'object', 'weapon', 'armor', 'armour', 'shield', 'buckler', 'targe', 'ring', 'rod', 'staff', 'wand', 'potion', 'scroll', 'ammunition',
  'sword', 'blade', 'longsword', 'shortsword', 'greatsword', 'rapier', 'scimitar', 'falchion', 'cutlass', 'sickle', 'scythe', 'dagger', 'knife',
  'axe', 'battleaxe', 'greataxe', 'handaxe', 'hatchet', 'halberd', 'glaive', 'mace', 'hammer', 'warhammer', 'maul', 'flail', 'morningstar', 'club',
  'greatclub', 'quarterstaff', 'spear', 'javelin', 'lance', 'pike', 'pick', 'trident', 'whip', 'bow', 'longbow', 'shortbow', 'crossbow', 'sling',
  'blowgun', 'net', 'dart', 'arrow', 'bolt', 'bullet', 'mail', 'plate', 'shirt', 'breastplate', 'cuirass', 'hauberk', 'brigandine', 'leather',
  'hide', 'chain', 'suit', 'coat', 'greaves', 'vambraces', 'pauldrons', 'gorget', 'amulet', 'necklace', 'pendant', 'periapt', 'medallion',
  'talisman', 'torc', 'locket', 'collar', 'brooch', 'pin', 'badge', 'emblem', 'insignia', 'medal', 'clasp', 'buckle', 'cloak', 'cape', 'mantle',
  'shroud', 'robe', 'vestments', 'raiment', 'garb', 'tunic', 'tabard', 'vest', 'gown', 'clothes', 'boots', 'slippers', 'shoes', 'sandals',
  'gloves', 'gauntlets', 'bracers', 'bracer', 'bracelet', 'armband', 'armlet', 'anklet', 'band', 'belt', 'girdle', 'sash', 'bandolier', 'helm',
  'helmet', 'hat', 'cap', 'hood', 'cowl', 'circlet', 'crown', 'coronet', 'diadem', 'tiara', 'headband', 'mask', 'goggles', 'lenses', 'lens',
  'spectacles', 'monocle', 'eyepatch', 'veil', 'scarf', 'earring', 'harness', 'wings', 'orb', 'stone', 'gem', 'gemstone', 'jewel', 'crystal',
  'prism', 'ellipsoid', 'rhomboid', 'spindle', 'pearl', 'pebble', 'shard', 'scarab', 'figurine', 'statuette', 'idol', 'icon', 'token', 'coin',
  'charm', 'trinket', 'fetish', 'totem', 'rune', 'sigil', 'symbol', 'relic', 'reliquary', 'phylactery', 'lantern', 'lamp', 'candle', 'torch',
  'horn', 'lute', 'harp', 'lyre', 'drum', 'flute', 'pipes', 'bagpipes', 'whistle', 'instrument', 'bell', 'chime', 'mirror', 'book', 'tome',
  'manual', 'codex', 'grimoire', 'deck', 'card', 'bag', 'pouch', 'sack', 'quiver', 'bottle', 'flask', 'vial', 'jug', 'decanter', 'censer',
  'brazier', 'bowl', 'chalice', 'cup', 'goblet', 'tankard', 'key', 'rope', 'shackles', 'banner', 'cube', 'sphere', 'bead', 'feather', 'quill',
  'scepter', 'sceptre', 'cane', 'baton', 'crook', 'fan', 'carpet', 'broom', 'compass', 'spyglass', 'hourglass', 'agate', 'amber', 'amethyst',
  'beryl', 'bloodstone', 'carnelian', 'chalcedony', 'citrine', 'coral', 'diamond', 'emerald', 'garnet', 'jade', 'jasper', 'moonstone',
  'obsidian', 'onyx', 'opal', 'peridot', 'quartz', 'ruby', 'sapphire', 'sardonyx', 'spinel', 'topaz', 'tourmaline', 'turquoise', 'zircon',
];
const NAME_STOP = new Set(['the', 'and', 'with', 'from', 'for', 'one', 'two', 'three', 'time', 'times', 'day', 'days', 'turn', 'turns', 'round', 'rounds', 'kind', 'kinds', 'type', 'types']);
const BASE_STOP = new Set(['any', 'simple', 'martial', 'light', 'medium', 'heavy', 'melee', 'ranged', 'magic']);
/** A category's generic nouns (D6): "the band" is a ring, "the suit" armor. */
const GENERIC_NOUNS: Readonly<Record<string, readonly string[]>> = { ring: ['band'], armor: ['suit', 'armour'], shield: ['buckler'] };

/**
 * The nouns an item's own text names it by (pure): its name's head noun ("Ring of Warmth" → ring, "Warden
 * Token" → token, "Cloak of Many Colors" → cloak), its category and its base item from its type line
 * ("Armor (Chain Mail or Chain Shirt)" → armor, mail, shirt). "The cloak has 3 charges" or "Each token …"
 * after the item's last variant is about the whole item, and "while you hold the token" names it.
 */
export function itemNouns(name: string, typeLineText: string): string[] {
  const bare = name.replace(/[‘’]/g, "'").replace(/\([^)]*\)/g, ' ').split(',')[0].trim();
  const named = (/([\p{L}'-]+)\s+of\b/iu.exec(bare)?.[1] ?? bare.split(/\s+/).pop() ?? '').toLowerCase().replace(/'s$/, '');
  const category = /^(wondrous item|weapon|armor|ring|rod|staff|wand|potion|scroll|shield|ammunition)\b/i.exec(typeLineText)?.[1].toLowerCase().replace('wondrous item', 'item');
  const base = (/^[\p{L} ]+?\s*\(([^)]*)\)/u.exec(typeLineText)?.[1] ?? '')
    .split(/,|\bor\b/i)
    .map((part) => part.trim().split(/\s+/).pop()?.toLowerCase() ?? '');
  return [...new Set([named, category ?? '', ...base])].filter((w) => /^[\p{L}'-]{3,}$/u.test(w) && !NAME_STOP.has(w) && !BASE_STOP.has(w) && !NOT_ITEM_WORD.test(w));
}

/** A noun's singular and plural forms ("staff", "staffs", "staves"; "boots", "boot"). */
function forms(noun: string): string[] {
  const n = noun.toLowerCase();
  const out = [n, `${n}s`, `${n}es`];
  if (n.endsWith('fe')) out.push(`${n.slice(0, -2)}ves`);
  else if (n.endsWith('f')) out.push(`${n.slice(0, -1)}ves`);
  if (/[^aeiou]y$/.test(n)) out.push(`${n.slice(0, -1)}ies`);
  if (n.endsWith('ies')) out.push(`${n.slice(0, -3)}y`);
  else if (/(?:ss|sh|ch|x)es$/.test(n)) out.push(n.slice(0, -2));
  else if (n.endsWith('s') && !n.endsWith('ss')) out.push(n.slice(0, -1));
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const longestFirst = (words: Iterable<string>) => [...new Set(words)].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
/** One of these words, whole, in any of its forms ("ring", "rings"; "staff", "staves"). */
const anyOf = (words: readonly string[]) => String.raw`(?:${longestFirst(words.flatMap(forms))})${WORD_END}`;
const NOUN_LIST = [...ITEM_NOUNS, 'staves', 'knives'];
/** An item noun of the list, whole, singular or plural ("helm", "helms", "staves"), perhaps before "'s" ("this Shield's"). */
const NOUN = String.raw`(?:${longestFirst(NOUN_LIST)})(?:e?s)?(?=(?:'s)?(?!${L}))`;
/** Every form of the list's nouns (namesItem). */
const NOUN_FORMS: ReadonlySet<string> = new Set(NOUN_LIST.flatMap(forms));
/**
 * The words of an item phrase after its determiner: "suit", "pair", "set" or "piece" of a noun ("this pair of
 * bracers", "this suit of magic armor"), up to three words ending at a noun of the list ("this black iron helm",
 * "this two-handed sword"), or one other word (namesItem takes it only when it is the item's own noun).
 */
const NOUN_PHRASE = String.raw`(?:(?:suit|pair|set|piece)s?\s+of\s+(?:${WORD}\s+){0,2}${NOUN}|(?:${WORD}\s+){0,3}${NOUN}|${WORD})`;
const PRONOUN = String.raw`(?:it|them)(?![\p{L}-])`;
/**
 * The item as a phrase's object, captured for namesItem: "it", "them", "this armor", "these bracers", "this black
 * iron helm", "this suit of armor", "the ring", "both gauntlets", "this" alone. Its last word is its noun: "this
 * staff upright" or "this sword twohanded" leaves "upright" or "twohanded" over.
 */
const THE_ITEM = String.raw`(${PRONOUN}|(?:this|these|that|those|the|both|either)\s+${NOUN_PHRASE}|(?:this|these)${WORD_END})`;
/** An item phrase that opens a text, captured ("This cloak works…", "The ring's magic…"). The other checks build on it, so the long noun list is compiled into few patterns. */
const ITEM_AT_START = new RegExp(String.raw`^${THE_ITEM}`, 'iu');
/** The item phrase that opens a text, if any, and its length (ITEM_AT_START). */
const itemAt = (text: string): { phrase: string; length: number } | null => {
  const m = ITEM_AT_START.exec(text);
  return m ? { phrase: m[1], length: m[0].length } : null;
};
/** Whether a whole text is an item phrase with a determiner ("this cloak", "the black iron helm"; subjectOf). */
const isItemPhrase = (text: string) => /^(?:this|these|that|those|the|both|either)\s/i.test(text) && itemAt(text)?.length === text.length;
/** Where "this" or "these" starts an item phrase in an item's text: the nouns its text calls it (D6). */
const THIS_AT = new RegExp(String.raw`(?<!${L})(?:this|these)\s`, 'giu');

/**
 * The forms of the nouns an item's text names it by: its own (itemNouns), its category's generic nouns ("band",
 * "suit"), and every listed noun its text calls it with "this" or "these" ("This cloak is woven…" makes "the cloak"
 * the item in "Wings of the Owl"). Pure.
 */
function ownFormsOf(paragraphs: readonly string[], nouns: readonly string[]): ReadonlySet<string> {
  const all = new Set(nouns);
  for (const n of nouns) for (const g of GENERIC_NOUNS[n] ?? []) all.add(g);
  for (const p of paragraphs) {
    for (const m of execAll(THIS_AT, p)) {
      const words = itemAt(p.slice(m.index))?.phrase.toLowerCase().split(/\s+/) ?? [];
      const noun = words.length > 1 ? words[words.length - 1].replace(/'s$/, '') : '';
      if (NOUN_FORMS.has(noun)) all.add(noun);
    }
  }
  return new Set([...all].flatMap(forms));
}

/**
 * Whether an item phrase (THE_ITEM's capture, apostrophes straightened) names the item: "it", "them", "this" or
 * "these" alone or with a noun of the list or the item's own ("this cloak", "this thurible" in a Thurible of
 * Embers); "the", "that", "those", "both" or "either" only with one of the item's own nouns (`own`, ownFormsOf), or
 * a noun one of them ends with ("the sword" in a Longsword, "the bow" in a Longbow): "the ring" in a ring, but "the
 * torch" in a cloak is another object, so holding it is a condition. Pure.
 */
function namesItem(phrase: string, own: ReadonlySet<string>): boolean {
  const words = phrase.toLowerCase().split(/\s+/);
  if (words.length === 1) return true;
  const noun = words[words.length - 1].replace(/'s$/, '');
  if (own.has(noun) || (/^th(?:is|ese)$/.test(words[0]) && NOUN_FORMS.has(noun))) return true;
  if (noun.length < 3) return false;
  for (const o of own) if (o.length > noun.length && o.endsWith(noun)) return true;
  return false;
}

/** Wearing, holding, carrying, wielding, bearing, donning, equipping, clad in or attuning to it, one verb or several ("wear or hold", "wearing or carrying", "wear and are attuned to"). */
const VERB = String.raw`(?:(?:are|'re)\s+)?(?:wear(?:ing)?|hold(?:ing)?|carry(?:ing)?|wield(?:ing)?|bear(?:ing)?|don(?:ning)?|equip(?:ping)?|clad\s+in|(?:remain(?:ing)?\s+)?attuned\s+to)`;
const VERBS = String.raw`${VERB}(?:\s*,\s*${VERB})*(?:\s*,?\s*(?:and|or)\s+${VERB})?`;
/** "wear it", "wearing or carrying this cloak", "wear it, carry it, or hold it"; a second object is the same item ("and are attuned to it"), else a condition ("wearing this cloak and holding the torch"). */
const WEARING = String.raw`${VERBS}\s+${THE_ITEM}(?:\s*,?\s*(?:and|or)\s+${VERBS}\s+${PRONOUN}|\s*,\s*${VERBS}\s+${PRONOUN})*`;
/** Where it is: "on your person", "in your possession", "around your neck", "on your finger", "in your hand". */
const PLACE = String.raw`(?:on\s+your\s+(?:person|body|head|fingers?|neck|arms?|wrists?)|in\s+your\s+(?:possession|hands?)|around\s+your\s+(?:neck|wrists?|arms?|waist)|strapped\s+to\s+your\s+arm)`;
/** Worn, held, carried, wielded, donned, equipped or attuned, one or several ("when worn or carried"). */
const WORN = String.raw`(?:worn|held|carried|wielded|donned|equipped|attuned)`;
const WORNS = String.raw`${WORN}(?:\s*,\s*${WORN})*(?:\s*,?\s*(?:and|or)\s+${WORN})?`;
const WHILE = String.raw`(?:while|whilst|when|whenever|as\s+long\s+as|so\s+long\s+as)`;
const YOU = String.raw`(?:you(?:'re|\s+are)?\s+)?`;
/**
 * Words that keep a bonus always on: the item worn, held, carried or attuned to ("while wearing this armor",
 * "when you hold the weapon", "while you wear this amulet around your neck", "while this ring is worn",
 * "while it's on your person", "while you have it equipped", "while it is attuned to you", "whenever you
 * wear this cloak", "once you attune to it", "when worn or carried"). They count only with nothing
 * conditional after them (harmlessAfter): "while you wield this sword against Undead", "when you hold this
 * shield in Bright Light", "…with two hands" or "while you wear this armor underwater" hold only in some
 * situations; and only when their item phrases name the item (namesItem: not "while you hold the torch"). The
 * longer of two forms comes first, as a regex takes the first alternative that matches ("while attuned to it",
 * not "while attuned"). Each THE_ITEM is a capture group, so held() can check it.
 */
const ALWAYS_ON_PHRASE = [
  String.raw`${WHILE}\s+${YOU}${WEARING}(?:\s+${PLACE})?`,
  String.raw`${WHILE}\s+(?:you\s+have\s+)?${THE_ITEM}(?:'s|\s+(?:is|are|hangs?|rests?|sits?|remains?|stays?))?\s+${PLACE}`,
  String.raw`${WHILE}\s+${YOU}attuned\s+to\s+${THE_ITEM}`,
  String.raw`${WHILE}\s+(?:you\s+)?have\s+${THE_ITEM}\s+(?:equipped|on)(?![\p{L}-])`,
  String.raw`${WHILE}\s+(?:${THE_ITEM}(?:'s|\s+(?:is|are|remains?))\s+)?(?:${PLACE}|${WORNS}(?:\s+(?:to|by)\s+you(?![\p{L}-]))?(?:\s+${PLACE})?)`,
  String.raw`once\s+${YOU}attuned?(?:\s+to\s+${THE_ITEM})?`,
  String.raw`${WHILE}\s+${YOU}attuned`,
].join('|');
const ALWAYS_ON_AT_START = new RegExp(String.raw`^(?:${ALWAYS_ON_PHRASE})${WORD_END}`, 'iu');
const ALWAYS_ON_ANYWHERE = new RegExp(String.raw`(?<!${L})(?:${ALWAYS_ON_PHRASE})${WORD_END}`, 'giu');
/** Where the item is, as a lead-in of its own (D3): "In your hands, this staff grants…", "On your finger, this ring…". */
const PLACE_AT_START = new RegExp(String.raw`^${PLACE}${WORD_END}`, 'iu');
/** "made with this magic weapon", "you make with it", "with these arrows", "using it": what an attack or damage bonus may name after its rolls (G3). */
const WEAPON_USE = new RegExp(String.raw`^(?:(?:that\s+)?(?:made|you\s+make)\s+)?(?:with|using)\s+${THE_ITEM}`, 'iu');

/** A match's item phrases (its capture groups) all name the item (namesItem). */
const namesAll = (groups: readonly unknown[], own: ReadonlySet<string>) => groups.every((g) => typeof g !== 'string' || namesItem(g, own));

/** About every one of the item, after its last variant: "Each ring …", "Every staff …", "Each such ring …", "These boots …", "All of these cloaks …" (not "Each time …", "Each ring of this kind …"). */
const EVERY = String.raw`^(?:(?:Each|Every|All)(?:\s+such)?(?:\s+of\s+(?:these|the|its))?|These|Those|Both)\s+(?:magic\s+)?`;
const NOT_A_KIND = String.raw`(?!\s+of\s+(?:this|that|the\s+same|one)\s+(?:kind|type|sort|colou?r|variety|version|form)\b)`;
/** About "the ring" or "this cloak" after its last variant: the item's own, for its charges. */
const ABOUT = String.raw`^(?:The|This)\s+(?:magic\s+)?`;
const EVERY_ITEM = new RegExp(`${EVERY}${NOUN}${NOT_A_KIND}`, 'iu');
const ABOUT_ITEM = new RegExp(`${ABOUT}${NOUN}`, 'iu');
/** "Each one has 3 charges", "Every one of them …": every one of the item, after its last variant (D6). */
const EVERY_ONE = /^(?:Each|Every)\s+one\b(?!\s+of\s+(?:this|that|the\s+same)\s+(?:kind|type|sort|variety|version|form)\b)/i;
/** The same for the item's own nouns that aren't in the list ("Each thurible …"), by the item's nouns. */
const ownOpeners = new Map<string, { every: RegExp; about: RegExp } | null>();

function ownOpenersFor(nouns: readonly string[]): { every: RegExp; about: RegExp } | null {
  const extra = nouns.filter((n) => !NOUN_FORMS.has(n));
  const key = extra.join(' ');
  const known = ownOpeners.get(key);
  if (known !== undefined) return known;
  const head = extra.length ? anyOf(extra) : '';
  const made = head ? { every: new RegExp(`${EVERY}${head}${NOT_A_KIND}`, 'iu'), about: new RegExp(`${ABOUT}${head}`, 'iu') } : null;
  if (ownOpeners.size > 500) ownOpeners.clear();
  ownOpeners.set(key, made);
  return made;
}

/**
 * The no-armor condition the app models (acOnlyWhen), said whole: "if you are wearing no armor and using no Shield",
 * "while you wear no armor or shield", "while you aren't wearing armor or wielding a Shield", "if you aren't wearing
 * armor or a Shield", "if you have no armor and no Shield", "provided you wear no armor".
 */
const NOT_USING_SHIELD = String.raw`(?:(?:(?:are\s+)?not|aren't)\s+(?:using|wielding|holding|carrying)|(?:don't|do\s+not)\s+(?:use|wield|hold|carry))\s+a\s+shield`;
const SHIELD_VERB = String.raw`(?:(?:are\s+)?(?:using|wielding|holding|carrying)|use|wield|hold|carry)`;
const NO_SHIELD_AFTER = String.raw`(?:\s*,?\s*(?:and|nor)\s+(?:${YOU}${SHIELD_VERB}\s+)?no\s+shield|\s*,?\s*and\s+${YOU}${NOT_USING_SHIELD}|,?\s+(?:or|nor)\s+(?:a\s+)?shield)`;
const NO_ARMOR_PHRASE = String.raw`(?:if|while|whilst|when|whenever|as\s+long\s+as|so\s+long\s+as|provided(?:\s+that)?|providing(?:\s+that)?)\s+${YOU}(?:(?:wear(?:ing)?|don(?:ning)?|hav(?:e|ing))\s+no\s+armor(?:${NO_SHIELD_AFTER})?|wear(?:ing)?\s+neither\s+armor\s+nor\s+(?:a\s+)?shield|(?:(?:are\s+)?not|aren't|don't|do\s+not)\s+wear(?:ing)?\s+(?:any\s+)?armor(?:,?\s+(?:or|nor)\s+(?:${SHIELD_VERB}\s+)?(?:a\s+)?shield|\s*,?\s*and\s+${YOU}${NOT_USING_SHIELD})?)`;
const NO_ARMOR_AT_START = new RegExp(String.raw`^(?:${NO_ARMOR_PHRASE})${WORD_END}`, 'iu');
const NO_ARMOR_ANYWHERE = new RegExp(String.raw`(?<!${L})(?:${NO_ARMOR_PHRASE})${WORD_END}`, 'giu');
/** Words that make a condition wherever they stand in what follows an always-on phrase. */
const CONDITION_WORD = new RegExp(
  String.raw`\b(?:while|whilst|when|whenever|if|unless|until|till|in|into|inside|within|against|with|without|during|after|before|once|near|except|only|provided|providing|as\s+long\s+as|so\s+long\s+as|(?:each|every)\s+time|underwater|underground|outdoors|indoors|outside|aloft|afloat|alone|overhead|mounted|${HANDED})\b|\bat\b(?!\s+all\s+times\b)|\bfor\s+(?:\d+|one|two|three|an?|the\s+next|the\s+duration)\b`,
  'i',
);
/** Words that only join a sentence to the one before ("In addition, …"). */
const CONNECTIVE = /^(?:in addition|additionally|also|furthermore|moreover|however|likewise|similarly|besides|still)\b,?\s*/i;
/** "In addition to its other properties, …", "In addition to the Shield's normal bonus to AC, …": a connective when it names no condition. */
const IN_ADDITION_TO = /^in addition to\b([^,;]*)(?:,\s*|$)/i;
const withoutConnective = (text: string): string => {
  const m = IN_ADDITION_TO.exec(text);
  return m && !CONDITION_WORD.test(m[1]) ? text.slice(m[0].length) : text.replace(CONNECTIVE, '');
};
/** "if" makes a condition, but not "even if". */
const IF = /(?<!\beven )\bif\b/i;
const EXAMPLE = /\bfor (?:example|instance)\b/i;
/** Where a sentence's clauses meet. */
const CLAUSE_BREAK = /;|,\s+(?:and|but|or|which|whose|you)\s+/gi;
/** Where a clause's benefits meet ("+1 bonus to AC and Advantage on…"). */
const BENEFIT_BREAK = /\s+and\s+(?=(?:Advantage|Disadvantage|Resistance|Immunity|proficiency|a\s+\+\d)\b)/gi;
/** Where a main clause ends and the next one's lead-in starts: "…, and underwater, you…", "…, but within 5 feet of a Fiend, you…", "…; in darkness, you…". */
const MAIN_BREAK = /;|,\s*(?:and|but|or)\b,?/gi;
/** The same without its comma ("…Resistance and underwater, you…"), when there is no other. */
const BARE_BREAK = /\s(?:and|but|or)\s/gi;
/** A subject right after a main break (";" or ", and/but/or"; a bare "and" is no clause start, I7): its clause has no lead-in of its own. */
const AFTER_MAIN_BREAK = /(?:;|,\s*(?:and|but|or)\b,?)\s*$/i;
/** "+1, +2, or +3 bonus to …", "+1/+2/+3", "+1 to +3": the matched value ends a by-rarity list. */
const RUN_BEFORE = /\+\d\s*(?:,\s*(?:(?:or|and)\s+)?|\s(?:or|and|to)\s+|\/|[–-])\s*$/i;
/** A paragraph about every kind of the item ("Whatever its gem, …", "Each kind of this ring…", "Each of them …"): it ends a run of variants. */
const WHOLE_ITEM =
  /^(?:Whatever|Whichever|Regardless)\b|^(?:Each|Every|All)\b(?:\s+[\p{L}'’-]+){0,3}?\s+(?:kinds?|types?|versions?|variet(?:y|ies)|forms?|variants?)\b|^(?:Each|Every|All)\s+of\s+(?:them|these)\b/iu;
/** "Protection (Rare). …", "Oak (Uncommon): …", "Mark 1 (Uncommon). …" (D7): where one variant's text starts, in an item whose rarity varies. */
const VARIANT_START = String.raw`\p{Lu}[\p{L}\d' -]{1,40} \((?:[Cc]ommon|[Uu]ncommon|[Rr]are|[Vv]ery [Rr]are|[Ll]egendary)\)[.:]\s`;
const VARIANT_RUN_IN = new RegExp(String.raw`^(?:[-•]\s+)?${VARIANT_START}`, 'u');
/** A variant's rarity in parentheses, somewhere in a paragraph (before splitting it at AT_VARIANT). */
const RARITY_PAREN = /\((?:[Cc]ommon|[Uu]ncommon|[Rr]are|[Vv]ery [Rr]are|[Ll]egendary)\)[.:]\s/;
const AT_VARIANT = new RegExp(String.raw`(?<=[.!?])\s+(?=(?:[-•]\s+)?${VARIANT_START})`, 'u');
/** A variant's name and rarity alone (I6): "Oak (Uncommon)" as a heading's text, a bold line, or a paragraph a PDF printed alone ("Ironwood (Rare)."). */
const VARIANT_NAME_BODY = String.raw`\p{Lu}[\p{L}\d' -]{1,40} \((?:[Cc]ommon|[Uu]ncommon|[Rr]are|[Vv]ery [Rr]are|[Ll]egendary)\)`;
const VARIANT_NAME = new RegExp(String.raw`^${VARIANT_NAME_BODY}[.:]?$`, 'u');
const VARIANT_ALONE = new RegExp(String.raw`^(?:[-•]\s+)?${VARIANT_NAME_BODY}[.:]?\s*$`, 'u');
/** A heading inside an item's text ("#### Pressure Ward", flatten()'s "### Pressure Ward"), with its text. */
const HEADING_PARA = /^#{1,6}\s+(.+?)[\s#]*$/;
/** Where a variant's text starts (I6): its run-in ("Oak (Uncommon). …"), or its name alone as a heading, a bold line or a PDF's line. */
const startsVariant = (text: string) => VARIANT_RUN_IN.test(text) || VARIANT_ALONE.test(text) || VARIANT_NAME.test(HEADING_PARA.exec(text)?.[1] ?? '');
/** A variant's own name, lower case ("oak", "mark 1"), from where its text starts. */
const variantName = (text: string) => {
  const t = (HEADING_PARA.exec(text)?.[1] ?? text).replace(LIST_ITEM, '');
  return t.slice(0, t.indexOf(' (')).toLowerCase();
};

/**
 * A run-in label that opens a paragraph or a list item, emphasis already removed ("Pressure Ward. …", "Guard (Shield
 * Form Only). …", "Button 2. …", "Giant's Bane. …"): Title Case words, perhaps with a parenthesis, then "." or ":"
 * and a new sentence; or, whatever its case, a short phrase with a parenthesis ("Iron hide (raging only). …"), of
 * up to three words ("Underwater only. …") or a lead-in with no main clause ("While in dim light. …"), since a PDF
 * loses the emphasis that marks one. A variant's run-in ("Oak (Uncommon). …") isn't one.
 */
const LABEL_WORD = String.raw`(?:\p{Lu}[\p{L}\d'’-]*|\d+)`;
const LABEL_MINOR = String.raw`(?:of|the|and|or|a|an|in|on|to|for|with|at|by|from|vs)`;
const NEXT_SENTENCE = String.raw`[.:]\s+(?=["“‘(]?[\p{Lu}\d+])`;
const RUN_IN_LABEL = new RegExp(String.raw`^(?:[-•]\s+)?(${LABEL_WORD}(?: (?:${LABEL_WORD}|${LABEL_MINOR}))*?(?: ?\([^()]{1,80}\))?)${NEXT_SENTENCE}`, 'u');
const SHORT_LABEL = new RegExp(String.raw`^(?:[-•]\s+)?(\p{Lu}[^\s.:!?()]*(?: [^\s.:!?()]+){0,4}? ?\([^()]{1,80}\)|\p{Lu}[^\s.:!?()]*(?: [^\s.:!?()]+){0,2})${NEXT_SENTENCE}`, 'u');
/** A lead-in on its own, whatever its case, as a label ("When underwater in deep water. …", "While in dim light. …"): no main clause follows it. */
const FRAGMENT_LABEL = new RegExp(
  String.raw`^(?:[-•]\s+)?((?:While|Whilst|When|Whenever|If|Unless|Until|Once|During|After|Before|As long as|So long as|In|At|On|Under|Within|Without|Against|Underwater|Only|Except)\b[^.,:;!?]{0,60})${NEXT_SENTENCE}`,
  'u',
);

/** A paragraph's run-in label, or null (not a variant's run-in). */
function runInLabel(paragraph: string): string | null {
  if (VARIANT_RUN_IN.test(paragraph)) return null;
  const m = RUN_IN_LABEL.exec(paragraph) ?? SHORT_LABEL.exec(paragraph) ?? FRAGMENT_LABEL.exec(paragraph);
  return m && labelShaped(m[1]) ? m[1] : null;
}
const ENDS_MINOR = new RegExp(`^${LABEL_MINOR}$`);
const labelShaped = (label: string) => {
  const words = label.replace(/\([^)]*\)/g, ' ').trim().split(/\s+/);
  return label.length <= 80 && words.length <= 8 && !ENDS_MINOR.test(words[words.length - 1]);
};

/**
 * A run-in label a PDF ran into the middle of a paragraph ("…to AC. Underwater. You have…"), I3: only Title Case words
 * (RUN_IN_LABEL) or a label with a parenthesis, so a short sentence ("The shield hardens.") isn't one.
 */
function midLabel(text: string): string | null {
  if (VARIANT_RUN_IN.test(text)) return null;
  const title = RUN_IN_LABEL.exec(text);
  if (title && labelShaped(title[1])) return title[1];
  const short = SHORT_LABEL.exec(text);
  return short && short[1].includes('(') && labelShaped(short[1]) ? short[1] : null;
}

/**
 * A piece that is only a run-in label (I3, I6), whose label governs the pieces after it (introsOf, J1): a heading inside
 * the item ("#### Pressure Ward"), a bold line ("**Pressure Ward**", "**Pressure Ward.**", which a PDF prints without
 * its emphasis), or a label a PDF column ended after ("Guard (Shield Form Only)."). Without its "." or ":", only Title
 * Case words are a label. A variant's name alone is a variant's run-in instead (startsVariant), and an intro is none
 * (J1): a piece that ends in ":" ("While raging:") or offers what follows ("At night you gain these benefits.").
 */
function labelAlone(text: string, prev = '', next = ''): string | null {
  const heading = HEADING_PARA.exec(text);
  if (heading) return VARIANT_NAME.test(heading[1]) ? null : heading[1].replace(/[.:]$/, '').trim() || null;
  // A list item is a list's ("- Light", "- Shield": spell names), never a label alone.
  const t = text.trim();
  if (LIST_ITEM.test(t) || t.length > 80 || /[.!?:]\s/.test(t) || VARIANT_ALONE.test(t) || !next.trim() || /:$/.test(t) || INTRO_OFFER.test(t)) return null;
  const bare = t.replace(/[.:]$/, '');
  const probe = `${bare}. A`;
  if (/[.:]$/.test(t)) return runInLabel(probe) === bare ? bare : null;
  // With no "." or ":", only Title Case words between paragraphs that aren't short lines too (a list a PDF lost its bullets to, a table's rows).
  if (SHORT_LINE.test(prev.trim()) || SHORT_LINE.test(next.trim())) return null;
  const title = RUN_IN_LABEL.exec(probe);
  return title && title[1] === bare && labelShaped(bare) ? bare : null;
}
/** A run-in label that ends a paragraph of several sentences (I3, midLabel's shapes), as when a column ends right after it. */
function trailingLabel(text: string): string | null {
  const sentences = sentencesOf(text.trim());
  const last = sentences[sentences.length - 1];
  if (sentences.length < 2 || !/[.:]$/.test(last)) return null;
  const bare = last.replace(/[.:]$/, '');
  return midLabel(`${last} A`) === bare ? bare : null;
}
/** A short line with no closing punctuation: a list item's or a table row's words, once a PDF lost their marks. */
const SHORT_LINE = /^(?:[-•]\s+)?[^.!?:]{1,40}$/;

/**
 * A run-in label that limits what its paragraph gives (D1): "Only", a parenthesis ("Guard (Shield Form Only)."), a
 * condition word, or a place, a state or a time ("Underwater.", "Bloodied.", "Night Ward.", "Dim Light."). Fail closed.
 */
const LABEL_LIMIT = new RegExp(
  String.raw`\(|\bonly\b|\b(?:${STATE}|bloodied|rag(?:e|es|ing)|fl(?:y|ying|ight)|airborne|underwater|underground|submerged|swimming|mounted|riding|night(?:time|fall)?|nocturnal|dark(?:ness)?|dim|bright|light|sun(?:light|lit)?|moon(?:light|lit)?|daylight|starlight|twilight|dusk|dawn|shadows?|prone|invisible|hidden|concentrat\w*|form|mode|stance|transformed|unarmou?red|unarmed|outdoors|indoors|outside|aloft|afloat|alone|overhead|${HANDED})\b`,
  'i',
);
/** Whether a label keeps what it governs always on: none of LABEL_LIMIT, a condition word or SITUATIONAL; or an always-on or no-armor phrase leadInHolds accepts ("While Attuned", "While Wearing This Cloak", J1). */
const labelHolds = (label: string, own: ReadonlySet<string>) => (!LABEL_LIMIT.test(label) && !CONDITION_WORD.test(label) && !SITUATIONAL.test(label)) || leadInHolds(label, own);

/**
 * An intro's offer of what follows (D1): the paragraph's last sentence ends with ":" or speaks of "the following …"
 * (not "the following dawn"), "these benefits / properties / traits / effects" or "three benefits".
 */
const OFFER_NOUN = String.raw`(?:benefits?|properties|property|traits?|effects?|features?|powers?|abilities|options|boons?|gifts?|perks?|advantages|qualities|blessings?|spells)`;
const OFFER_COUNT = String.raw`(?:two|three|four|five|six|seven|eight|several|\d+)`;
const OFFER_WORDS = String.raw`(?:additional|other|extra|magical|special|different)`;
const INTRO_OFFER = new RegExp(
  String.raw`\bthe following\b(?!\s+(?:days?|dawns?|dusks?|mornings?|nights?|evenings?|turns?|rounds?|weeks?|months?|years?|rests?|minutes?|hours?)\b)|\b(?:these|those)\s+(?:${OFFER_WORDS}\s+)?${OFFER_NOUN}\b|\b${OFFER_COUNT}\s+(?:${OFFER_WORDS}\s+)?${OFFER_NOUN}\b|\b${OFFER_NOUN}\s+(?:(?:described|listed|detailed|given|shown|explained)\s+)?below\b|\b(?:described|listed|detailed|given|shown|explained)\s+below\b|\bas\s+follows\b`,
  'i',
);
/** The offer itself, taken out of an intro to judge the rest (D1): "you gain the following benefits", "this weapon has the following properties", "the following benefits apply", "these benefits". */
const OFFER = new RegExp(
  String.raw`(?:(?:(?:each|every|all)(?:\s+one)?\s+of\s+)?(?:you|it|they|(?:the|this|these|that|its)\s+(?:${L}+\s+){0,3}?${L}+)\s+(?:also\s+)?(?:gains?|ha(?:ve|s)(?:\s+access\s+to)?|gets?|grants?|provides?|offers?|confers?|bestows?|gives?|possess(?:es)?|enjoys?|receives?|benefits?\s+from|(?:can|may)\s+(?:use|cast|choose)(?:\s+(?:one|any)\s+of)?)\s+(?:you\s+)?)?(?:the\s+following|these|those|${OFFER_COUNT}|the(?=(?:\s+${OFFER_WORDS})*\s+${OFFER_NOUN}\s+(?:(?:described|listed|detailed|given|shown|explained)\s+)?below\b))(?:\s+${OFFER_WORDS})*\s+${OFFER_NOUN}(?:\s+(?:apply|applies|function|work))?|(?:(?:its|(?:the|this)\s+${L}+'s)\s+)?(?:benefits|properties|powers|traits|effects)\s+(?:are|include)(?:\s+as\s+follows)?`,
  'iu',
);
/** A choice among benefits (I10). */
const CHOICE = /\b(?:choose|chooses|chosen|choosing|choice|select|selects|pick|picks|one\s+of\s+(?:the\s+following|these|those|them))\b/i;
/** Words after an offer that only say where it goes on ("as well", "detailed below", "as follows", "from it"). */
const OFFER_TRAIL = /^(?:[\s,]+(?:as\s+well|too|also|as\s+follows|below|(?:detailed|described|listed|given|shown|explained)\s+(?:below|here|in\s+the\s+table)|from\s+(?:it|them|(?:the|this|these)\s+[\p{L}'-]+)))+/iu;

/** Whether an intro sentence keeps what it offers always on: what is left once its offer is taken out holds (D1). */
function introHolds(sentence: string, own: ReadonlySet<string>): boolean {
  const s = sentence.replace(/[‘’]/g, "'").replace(/[\s:.;!]+$/, '');
  // A choice ("Choose one of the following benefits", "…one of the following properties of your choice"): each alternative holds only when chosen (I10).
  if (CHOICE.test(s)) return false;
  const m = OFFER.exec(s);
  const lead = (m ? s.slice(0, m.index) : s).replace(/[\s,;]+$/, '').trim();
  const trail = m ? s.slice(m.index + m[0].length).replace(OFFER_TRAIL, '') : '';
  return (lead === '' || leadInHolds(lead, own)) && (trail.trim() === '' || tailHolds(trail, false, own));
}

/** Words that join a sentence about the bonus to the one before ("However, the bonus…", "Additionally, the bonus…"). */
const ABOUT_PREFIX = String.raw`(?:(?:however|but|still|also|additionally|in addition|furthermore|moreover|note that),?\s+)?`;
/**
 * What refers back to a bonus (D2, I2): bonus(es), benefit(s), protection, property, effect(s), ward, power, magic after a
 * determiner ("This benefit", "These benefits", "Both bonuses", "Neither bonus", "The +1 bonus", "The Armor Class
 * bonus", "The cloak's magic", "this protection"), or after "each / either / both / neither / all / none / any of these
 * (those, the, its, your, their)" ("Each of these bonuses", "Neither of the benefits"); never "your Proficiency Bonus",
 * "a Bonus Action", "all other properties", "the following benefits".
 */
const REF_NOUN = String.raw`(?:bonus(?:es)?|benefits?|protection|propert(?:y|ies)|effects?|wards?|powers?|magic|enchantments?)`;
const REF_WORDS = String.raw`(?:(?!(?:${NOT_ITEM}|other|proficiency|following)${WORD_END})(?:${L}+|\+\d)\s+){0,3}?${REF_NOUN}${WORD_END}`;
const REF_BODY = String.raw`(?:(?:each|either|both|neither|all|none|any)\s+of\s+(?:these|those|the|its|your|their)\s+${REF_WORDS}|(?:the|this|that|these|those|its|each|either|both|neither|your|their)\s+${REF_WORDS})(?!\s+actions?\b)`;
/** Where a reference may stand as a subject whatever its verb: a clause's start, or after a lead-in's comma ("While you are Bloodied, this bonus…"). */
const CLAUSE_START = String.raw`(?:^|[,;]\s+(?:(?:and|but|or)\s+)?)`;
const REF_AT = new RegExp(String.raw`${CLAUSE_START}${ABOUT_PREFIX}(${REF_BODY}|${REF_NOUN}${WORD_END}(?!\s+actions?\b))`, 'iu');
/** Words a verb never is (I2): after a reference, one of these makes it an object or part of a longer phrase ("the weapon's bonus to your Armor Class"). */
const NOT_VERB = String.raw`(?:to|of|for|from|with|in|into|on|onto|at|by|than|as|and|or|nor|but|that|which|who|whom|whose|the|a|an|this|these|those|its|your|their|again|here|there|within|without|against|under|over|between|through|throughout|during|after|before|upon|beneath|below|above|toward|towards|like|per|via|plus|instead|until|unless|while|whilst|when|whenever|if|you|it|they)`;
/** A reference as a subject wherever it stands in its clause (I2): a verb follows it ("In sunlight the bonus doesn't apply.", "By day the cloak's magic fails."). */
const REF_SUBJECT = new RegExp(String.raw`(?<![\p{L}'-])(${REF_BODY})(?=\s+(?!${NOT_VERB}${WORD_END})[\p{L}])`, 'iu');
/** "It works only…", "They apply only…", "This works only…", "These end if…", "Neither applies…": a pronoun about the bonus, as a subject, perhaps after a lead-in ("In sunlight they don't work."). */
const NEG_WORD = String.raw`(?:doesn't|does\s+not|don't|do\s+not|won't|will\s+not|can't|cannot|never|no\s+longer)`;
const OPENER_WORD = String.raw`(?:about|above|across|after|against|along|amid|among|around|at|before|behind|below|beneath|beside|besides|between|beyond|by|despite|during|except|for|from|in|inside|into|near|on|once|onto|outside|over|past|since|through|throughout|till|toward|towards|under|underneath|unless|until|upon|when|whenever|where|wherever|while|whilst|with|within|without|whether|although|though|because|if|provided|providing|as\s+long\s+as|so\s+long\s+as|underwater|underground|outdoors|indoors|aloft|afloat|mounted|nightly|daily)`;
const PRONOUN_AT = new RegExp(
  String.raw`${CLAUSE_START}${ABOUT_PREFIX}(?:${OPENER_WORD}\s+(?:[\p{L}'-]+\s+){0,6}?)?((?:it|this|they|these|both|neither|each|either)\s+(?:(?:only|also|still|${NEG_WORD})\s+)*(?:applies|apply|works|work|functions|function|operates|operate|lasts|last|ends|end|holds|hold|stops|stop|ceases|cease|expires|expire|fails|fail|fades|fade|(?:is|are|isn't|aren't)\s+(?:only\s+)?(?:active|inactive|suppressed|lost|negated|halved|reduced|in\s+effect|effective|unavailable)|ha(?:s|ve)\s+no\s+effect)\b)`,
  'iu',
);
/** Having the bonus, as an object: "You gain this benefit only while…", "You can't benefit from this bonus while…", "The cloak grants this protection only at night.", "You can't use this benefit while…" (I2). */
const GAINS_IT = new RegExp(String.raw`(?<!${L})(?:benefit\s+from|gain|gains|receive|receives|get|gets|have|has|grant|grants|give|gives|enjoy|enjoys|use|uses|using)\s+(${REF_BODY})`, 'iu');
/**
 * Losing or ending the bonus, as an object, which limits it whatever else the words say (I2): "…, but you lose it while you
 * are Bloodied", "You lose this benefit while…", "Bright Light cancels this benefit.", "Sunlight dispels this protection…",
 * "…you lose access to this benefit."
 */
const LOSES_IT = new RegExp(
  String.raw`(?<!${L})(?:(?:lose|loses|lost|losing)(?:\s+access\s+to)?|forfeit|forfeits|end|ends|suppress|suppresses|negate|negates|cancels?|cancel(?:l)?ed|dispels?|dispelled|nullif(?:y|ies|ied)|den(?:y|ies|ied)(?:\s+you)?)\s+(?:(it|them)${WORD_END}|(${REF_BODY}))|(?<!${L})(?:remove|removes|removed)\s+(${REF_BODY})`,
  'iu',
);
/** A reference that names a target (D2): "The Armor Class bonus", "the AC bonus", "the saving throw bonus", "the bonus to attack rolls". */
const REF_TARGETS: readonly (readonly [BonusTarget, RegExp])[] = [
  ['ac', /\b(?:AC|Armor Class)\b/i],
  ['savingThrows', /\bsav(?:ing throws?|es?)\b/i],
  ['attack', /\battacks?\b/i],
  ['damage', /\bdamage\b/i],
];
const REF_TO_TARGET = /^\s+(?:to|on)\s+(?:your\s+)?(?:AC|Armor Class|saving throws?|attack(?:\s+rolls?)?|damage(?:\s+rolls?)?)\b/i;
/**
 * The item's own magic, as a reference that limits every bonus of the item (D2, I1): "the cloak's magic", "its protection",
 * "their magic", "Its bonus", "this item's powers", "the enchantment" (an item's name before "'s" is checked by namesItem).
 */
const ITEM_REF = new RegExp(String.raw`^(?:its|their)\s+(?:${L}+\s+){0,2}?${REF_NOUN}$|'s\s+(?:${L}+\s+){0,2}?${REF_NOUN}$|^(?:the|this|that)\s+enchantments?$`, 'iu');

/** How often a property can be used (I1): never a limit on a bonus ("can't be used again until the next dawn", "until you use this property again"). */
const REUSE =
  /\b(?:can't|cannot|can\s+not|won't|may\s+not)\s+be\s+used\s+(?:[\p{L}'-]+\s+){0,3}?again\b|\b(?:can't|cannot|can\s+not|may\s+not)\s+use\s+(?:it|them|this|that|these|those)(?:\s+[\p{L}'-]+){0,3}?\s+again\b|\buntil\s+(?:you\s+)?(?:use|used|activate)\s+(?:it|this|that|these|those)(?:\s+[\p{L}'-]+){0,3}?\s+again\b|\bthis\s+way\s+again\b|\bonce\s+used\b|\bonce\s+(?:this|the)\s+(?:property|ability|power|feature)\s+(?:is|has\s+been)\s+used\b/iu;
/**
 * The item spent for good (I1): "…loses its properties and becomes a nonmagical Quarterstaff", "…crumbles to dust and is
 * destroyed", "…is destroyed", "…becomes an ordinary garment": no situation the bonus holds in. "In sunlight, the cloak
 * becomes nonmagical" is a state, a restriction (STATE_PRED); so is any loss "until…", "while…", "for 1 hour", or in a
 * place, a time or a state ("In sunlight, the cloak becomes a nonmagical cloak.", "…underwater", "…at night"), as an
 * event ("On a 1, …", "When its last charge is expended, …") isn't.
 */
const PERMANENT_LOSS = /\bbecomes?\s+an?\s+(?:nonmagical|ordinary|mundane)\s+[\p{L}'-]+|\b(?:is|are|be)\s+(?:permanently\s+)?destroyed\b|\bcrumbles?\b|\bturns?\s+(?:in)?to\s+(?:dust|ash(?:es)?)\b|\bpermanently\b|\bforever\b/iu;
const TEMPORARY = new RegExp(
  String.raw`\b(?:until|till|while|whilst|unless|whenever|during|in|inside|within|near|without|underwater|underground|outdoors|indoors|outside|aloft|afloat|at|by\s+(?:day|night|daylight|moonlight|sunlight)|as\s+long\s+as|so\s+long\s+as|(?:each|every)\s+time|for\s+(?:\d+|one|an?|the\s+next))\b`,
  'i',
);
/** Words every reuse limit and every permanent loss holds: a cheap test before REUSE and PERMANENT_LOSS, which most texts fail (G3). */
const REUSE_HINT = /again|once/iu;
const LOSS_HINT = /nonmagical|ordinary|mundane|destroyed|crumble|dust|ash|permanently|forever/iu;
const isReuse = (text: string) => REUSE_HINT.test(text) && REUSE.test(text);
const isLoss = (text: string) => LOSS_HINT.test(text) && PERMANENT_LOSS.test(text);
const permanent = (text: string) => isLoss(text) && !TEMPORARY.test(text);
/** Words that limit a bonus wherever they stand in words about it, unless negated ("only", "until", "ends", "lost", "applies to ranged attacks"). */
const LIMIT_WORDS =
  /\bonly\b|\b(?:except|unless|until|till|expires?|lasts?|ends?|ended|ending|stops?|ceases?|suppress(?:ed|es)?|negated?|halved|removed|decreases?|reduced?|drops?|forfeits?|unavailable)\b|\bno\s+longer\b|\blos(?:e|es|t|ing)\b|\bappl(?:y|ies)\s+(?:only\s+)?to\b(?!\s+(?:all|every|each|any|you|your)\b)/gi;
/** A negation that negates the bonus applying or working (D2): "doesn't apply", "does not work", "isn't active", "has no effect", "no longer functions". */
const NEGATED_WORKING = new RegExp(
  String.raw`(?:n't|\bnot|\bnever|\bcannot|\bno\s+longer)\s+(?:(?:be|been|always)\s+)?(?:apply|applies|applied|work|works|function|functions|operate|operates|active|in\s+effect|effective)\b|\bha(?:s|ve)\s+no\s+effect\b`,
  'i',
);
/** A negation just before a word ("can't be suppressed", "doesn't end", "never ends"): that word doesn't limit. */
const NEGATED_BEFORE = /(?:n't|\bnot|\bnever|\bcannot)\s+(?:\S+\s+){0,2}$/i;
/** "The bonus increases to +3 when…", "The attack bonus becomes +2 at night": more in some situations, never less. */
const INCREASE = new RegExp(
  String.raw`^${ABOUT_PREFIX}(?:the|this|that|its|your|each)\s+(?:(?!${NOT_ITEM}${WORD_END})${L}+\s+){0,2}?bonus\s+(?:(?:increases|rises|improves|grows)\s+(?:to|by)\s+\+?\d|becomes\s+\+\d)\b`,
  'iu',
);

/**
 * Whether words about a bonus limit it (D2): a condition word ("works in Dim Light", "applies while you're Bloodied"),
 * a negation of the bonus applying or working ("doesn't apply", "has no effect"), or a restriction that isn't negated
 * ("applies only while…", "lasts 1 hour", "ends when…", "applies to ranged attacks"; not "can't be suppressed",
 * "doesn't stack with…", "doesn't count as wearing armor"). Saying the bonus grows ("The bonus increases to +3 when you
 * use the weapon to attack a Construct") sets no condition. `from`: where the words about the bonus start.
 */
function limits(text: string, from = 0, own?: ReadonlySet<string>): boolean {
  // "While you wear this cloak, the bonus applies…", "…applies only while you wear the cloak", "…lasts as long as you
  // hold it", "…ends if you remove the cloak": the item worn or held sets no condition.
  const t = own ? withoutWorn(text, own) : text;
  if ((SITUATIONAL.test(t) || IF.test(t) || AGAINST.test(t) || MORE_CONDITIONS.test(t)) && !INCREASE.test(text.slice(from))) return true;
  if (NEGATED_WORKING.test(t)) return true;
  // A negated "extend", "protect", "help" or "apply" scoped to attacks, rolls, saves, spells or creatures ("…doesn't extend to ranged attacks", J7).
  if (NEG_IN.test(t) && SCOPED_TO.test(t.replace(/\bextends?\b/gi, 'applies'))) return true;
  for (const m of execAll(LIMIT_WORDS, t)) if (!NEGATED_BEFORE.test(t.slice(0, m.index))) return true;
  return false;
}
/** Conditions SITUATIONAL leaves to the grammar elsewhere (I1, I2): "by night", "between dusk and dawn", "under a full moon", "upon…", "after dark". */
const MORE_CONDITIONS =
  /\b(?:between|beneath|under|underneath|upon|throughout|outside|after|before|except|till)\b|\bby\s+(?:day|night|daylight|moonlight|sunlight|starlight|torchlight|candlelight|lamplight|dark(?:ness)?|dusk|dawn|twilight|the\s+light\b)|\bover\s+(?:water|land|the\s+\w+)\b|\bon\s+(?:a|an|the|your|each|every|any)\s+[\p{L}'-]+/iu;

/** Words about the item worn, held or attuned taken out of a text (with an "only", "lasts" or "ends if you remove" that goes with them). */
function withoutWorn(text: string, own: ReadonlySet<string>): string {
  let out = '';
  let from = 0;
  for (const m of MAY_BE_WORN.test(text) ? execAll(ALWAYS_ON_ANYWHERE, text) : []) {
    if (m.index < from || !namesAll(m.slice(1), own)) continue;
    out += `${text.slice(from, m.index).replace(RESTATES, '')} `;
    from = m.index + m[0].length;
  }
  out += text.slice(from);
  // "…ends if you remove the cloak." with nothing after it.
  const removed = REMOVED.exec(out);
  const item = removed ? itemAt(out.slice(removed.index + removed[0].length)) : null;
  if (removed && item && namesItem(item.phrase, own) && /^\s*[.!;]?\s*$/.test(out.slice(removed.index + removed[0].length + item.length))) out = out.slice(0, removed.index);
  return out;
}
/** A cheap test before the long pattern: an always-on phrase can only stand where one of these words does. */
const MAY_BE_WORN = /\b(?:while|whilst|when|whenever|as\s+long\s+as|once)\b/i;
/** "only while you wear it", "lasts as long as you hold the staff": the word before an always-on phrase that only restates it. */
const RESTATES = /(?:(?:lasts?|remains?|persists?|holds?)\s+)?(?:only\s+)?$/i;
/** "ends if you remove the cloak", "ends when you doff it", "is lost if you are no longer attuned to it": the item no longer worn (then itemAt), with nothing after it. */
const REMOVED = new RegExp(
  String.raw`(?<!${L})(?:ends?|stops?|ceases?|(?:is|are)\s+lost)\s+(?:early\s+)?(?:if|when|whenever|once)\s+(?:you\s+)?(?:remove|doff|take\s+off|stop\s+(?:wearing|holding|carrying|wielding)|(?:are|is)\s+no\s+longer\s+(?:wearing|holding|carrying|wielding|attuned\s+to)|end\s+your\s+attunement\s+to)\s+`,
  'iu',
);

/** What a sentence that limits a bonus limits (D2): a target's bonuses, its paragraph's, or the item's (with the no-armor condition it sets for AC). */
interface Limit {
  scope: 'target' | 'paragraph' | 'item';
  targets?: BonusTarget[];
  acOnly?: AcCondition;
  /** About several ("These benefits…", "Both bonuses…", "They…"). */
  plural?: boolean;
  /** A reference to a bonus ("the bonus", "these bonuses"), not to a property or a benefit (O3). */
  bonusRef?: boolean;
  /** A reference to a benefit, a protection or a ward (O3): it reaches back from a plain paragraph, not from a run-in's. */
  benefitRef?: boolean;
}

/** A cheap test before the long patterns: a reference names one of these nouns, or a pronoun one of these verbs. */
const MAY_REFER =
  /\b(?:bonus(?:es)?|benefits?|protection|propert(?:y|ies)|effects?|wards?|powers?|magic|enchantments?|appl(?:y|ies)|works?|functions?|operates?|lasts?|ends?|holds?|stops?|ceases?|expires?|fails?|fades?|active|inactive|suppressed|lost|negated|halved|reduced|effective|unavailable)\b/i;
/** The reference in words about a bonus, if any: where it is, the targets it names, and whether it is the item's own magic (PRONOUN_AT, REF_AT, REF_SUBJECT, LOSES_IT, GAINS_IT). */
function refIn(text: string, own: ReadonlySet<string>): { index: number; text: string; targets: BonusTarget[]; item: boolean } | null {
  if (!MAY_REFER.test(text)) return null;
  const at = (m: RegExpExecArray, group: string) => m.index + m[0].length - group.length;
  const pronoun = PRONOUN_AT.exec(text);
  if (pronoun) return { index: at(pronoun, pronoun[1]), text: pronoun[1], targets: [], item: false };
  const subject = REF_SUBJECT.exec(text);
  const ref = REF_AT.exec(text);
  const first = subject && (!ref || subject.index <= at(ref, ref[1])) ? subject : ref;
  const lost = first ? null : LOSES_IT.exec(text);
  const gained = first || lost ? null : GAINS_IT.exec(text);
  const words = first?.[1] ?? lost?.[2] ?? lost?.[3] ?? lost?.[1] ?? gained?.[1];
  if (!words) return null;
  const index = first ? (first === subject ? first.index : at(first, words)) : gained ? at(gained, words) : (lost?.index ?? 0);
  const after = text.slice(index + words.length);
  const named = /\bbonus(?:es)?$|\bbenefits?$/i.test(words) ? REF_TARGETS.filter(([, re]) => re.test(words.replace(/\b(?:bonus(?:es)?|benefits?)$/i, ''))).map(([t]) => t) : [];
  const to = REF_TO_TARGET.exec(after);
  const targets = named.length ? named : to ? REF_TARGETS.filter(([, re]) => re.test(to[0])).map(([t]) => t) : [];
  return { index, text: words, targets, item: itemRef(words, after, own) };
}

/** Whether a reference is the item's own magic (I1): "its protection", "the cloak's magic", "the enchantment", "the magic of this cloak". */
function itemRef(words: string, after: string, own: ReadonlySet<string>): boolean {
  const w = words.replace(/[‘’]/g, "'").trim();
  if (ITEM_REF.test(w) && !/'s\s/i.test(w)) return true;
  const owner = /^(?:(?:each|either|both|neither|all|none|any)\s+of\s+)?((?:the|this|that|these|those|both|either)\s+[\p{L}'-]+(?:\s+[\p{L}'-]+){0,3}?)'s\s/iu.exec(w);
  if (owner) return /^(?:the|this)\s+item$/i.test(owner[1]) || (isItemPhrase(owner[1]) && namesItem(owner[1], own)) || /^th(?:is|ese)\s+[\p{L}'-]+$/iu.test(owner[1]);
  // "The magic of this cloak…", "The powers of the ring…".
  const of = /(?:magic|powers?|properties|benefits|protection|enchantments?)$/i.test(w) && /^\s+of\s/i.test(after) ? itemAt(after.replace(/^\s+of\s+/i, '')) : null;
  return of !== null && namesItem(of.phrase, own);
}

/**
 * Whether words name the bonus (refIn) and limit it (limits); an example ("For example, you could reduce the bonus…") never
 * does, and a main clause that is a reuse limit is left out of them (J5: "…this benefit ends, and you can't use it again
 * until…" still limits).
 */
function limitsBonus(text: string, own: ReadonlySet<string>): boolean {
  if (EXAMPLE.test(text)) return false;
  const t = withoutSpent(text, false);
  const ref = t.trim() ? refIn(t, own) : null;
  return ref !== null && (LOSES_IT.test(t) || limits(t, ref.index, own));
}

/** A choice among bonuses stated after them (O4): "choose one of these bonuses", "pick one of the two benefits", "select which of the bonuses applies", "choose one of the following bonuses: the bonus to Armor Class or…" ("the following" or "below" before any other noun offers what follows). */
const CHOOSES = new RegExp(
  String.raw`\b(?:choose|chooses|chosen|choosing|select|selects|pick|picks)\s+(?:one|either|any\s+one|which)\s+(?:of\s+)?(?:these|those|the\s+two|the|its|your|both)\s+(?!(?:following|below)${WORD_END}(?!\s+bonus(?:es)?${WORD_END}))(?:${L}+\s+){0,2}?(?:bonus(?:es)?|benefits?|propert(?:y|ies)|effects?|powers?|options?|wards?|protections?)${WORD_END}`,
  'iu',
);
/** The words every CHOOSES match holds, a cheap test before it (G3). */
const CHOOSES_HINT = /choos|select|pick/iu;
/** An alternative to another bonus, in a sentence that states one (O4): "Alternatively, you can have a +1 bonus to saving throws instead." (not "instead of"). */
const ALTERNATIVE = /\balternatively\b|\binstead\b(?!\s+of\b)/i;

/**
 * The limit that words about a bonus set, if any (D2, I2): a reference back to the bonus that limits it (limitsBonus) marks
 * that target's bonuses when it names one ("The Armor Class bonus applies only…"), the item's when it is the item's own
 * magic ("Its protection works only…", "By day the cloak's magic fails."), else its paragraph's ("This benefit applies
 * only…", "Each of these bonuses…", "Bright Light cancels this benefit.", O4's "choose one of these bonuses"). A main
 * clause that is a reuse limit ("…can't be used again until the next dawn") or a permanent loss ("…loses its properties and
 * becomes a nonmagical Quarterstaff") limits nothing, and the clauses beside it are judged without it (J5).
 */
function referenceLimit(text: string, own: ReadonlySet<string>): Limit | null {
  if (EXAMPLE.test(text)) return null;
  const t = withoutSpent(text, true).replace(/^[\s,;]+(?:(?:and|but|or)\s+)?/i, '');
  if (!t.trim()) return null;
  if (CHOOSES_HINT.test(t) && CHOOSES.test(t)) return { scope: 'paragraph', plural: true, bonusRef: true };
  const ref = refIn(t, own);
  if (!ref || !(LOSES_IT.test(t) || limits(t, ref.index, own))) return null;
  if (ref.item) return { scope: 'item', plural: true };
  const plural = /^(?:(?:these|those|both|each|neither|either|all|none|any|they)\b|\S+(?:es|s)$)/i.test(ref.text.trim()) || /\b(?:bonuses|benefits|properties|effects|powers|wards)$/i.test(ref.text);
  const bonusRef = /\bbonus(?:es)?$/i.test(ref.text.trim());
  const benefitRef = /\b(?:benefits?|protection|wards?)$/i.test(ref.text.trim());
  return ref.targets.length ? { scope: 'target', targets: ref.targets, plural, bonusRef, benefitRef } : { scope: 'paragraph', plural, bonusRef, benefitRef };
}

/**
 * Where a sentence's main clauses start (I1): its start, ";", ", and/but/or/yet", ", though/although/whereas", and
 * ", which/whose" (whose subject is the words before it).
 */
const CLAUSE_SPLIT = /;\s*|,\s*(?:and|but|or|yet)\b,?\s*|,\s*(?:though|although|even\s+though|whereas)\s+|,\s+(?=(?:which|whose)\s)/gi;
/** A text's main clauses, split where any of `cuts` matches (CLAUSE_SPLIT). */
function clausesOf(text: string, cuts: readonly RegExp[] = [CLAUSE_SPLIT]): string[] {
  const at = cuts.flatMap((re) => execAll(re, text)).sort((a, b) => a.index - b.index);
  const out: string[] = [];
  let from = 0;
  for (const m of at) {
    if (m.index < from) continue;
    out.push(text.slice(from, m.index));
    from = m.index + m[0].length;
  }
  out.push(text.slice(from));
  return out;
}
/** A reuse limit joined to the clause before it by a bare "and" or "but" ("…ends if you are Bloodied and can't be used again until…"): a clause of its own (J5). */
const REUSE_JOIN =
  /\s+(?:and|but)(?:\s+then)?\s+(?=(?:can't|cannot|can\s+not|won't|may\s+not)\s+(?:be\s+used|use)\b)|,\s*(?:(?:after|at)\s+which(?:\s+(?:point|time))?|whereupon)\s+(?=(?:it|this|that|they|these|those|you)\b)|,\s+(?=(?:can't|cannot|can\s+not|won't|may\s+not)\s+(?:be\s+used|use)\b)/giu;
/**
 * A text without its main clauses that are a reuse limit (and, with `lost`, a permanent loss), J5: one reuse clause never
 * cancels the limits beside it ("When you are Bloodied, this benefit ends, and you can't use it again until…" still ends
 * it). The text as it was when no clause goes.
 */
function withoutSpent(text: string, lost: boolean): string {
  // A clause's reuse limit or loss is one of the text's too: a text with neither has nothing to drop (G3).
  if (!isReuse(text) && !(lost && isLoss(text))) return text;
  const parts = clausesOf(text, [CLAUSE_SPLIT, REUSE_JOIN]);
  const kept = parts.filter((p) => !isReuse(p) && !(lost && permanent(p)));
  return kept.length === parts.length ? text : kept.join('; ');
}
/** A cheap test before restrictionOf: the words a restriction needs. */
const MAY_RESTRICT =
  /n't\b|\b(?:not|never|nor|cannot|longer|only|no|powerless|inert|dormant|nonmagical|ineffective|inactive|useless|ordinary|mundane|suppress\w*|cancel\w*|negat\w*|dispel\w*|nullif\w*|disabled?|stops?|ceases?|loses?|lost|fails?|failed|falters?|faltered|sputters|gutters|refuses?|refused|unable|renders?|rendered|strips?|stripped)\b|\bof\s+(?:all\s+(?:of\s+)?)?(?:its|their)\s+(?:magic|powers?|properties|enchantments?|abilities)\b/i;
/** A negation in what is said of the item (not of "stack", "count as wearing armor" or "be suppressed", which limit nothing). */
const HARMLESS_NEG = /(?:n't|\bnot|\bnever|\bcannot)\s+(?:(?:be|been)\s+)?(?:stack\w*|count\w*\s+as\s+wearing|suppress\w*|dispel\w*|negat\w*|cancel\w*|removed?\s+by)\b/gi;
const NEG_IN = /n't\b|\b(?:not|never|cannot|no\s+longer)\b/i;
/** The item working, which "only" restricts ("works only", "only functions", "protects you only…"). */
const WORKS_VERB = /\b(?:works?|work(?:ing|ed)|functions?|function(?:ing|ed)|operates?|operat(?:ing|ed)|applies|apply|protects?|helps?|is\s+(?:active|effective|in\s+effect)|are\s+(?:active|effective|in\s+effect))\b/i;
/** The item working, whose negation restricts it with no condition (J7): "doesn't work", "never functions"; a negated "protect", "help" or "apply" needs a condition word or "only". */
const WORKS_ITSELF = /\b(?:works?|work(?:ing|ed)|functions?|function(?:ing|ed)|operates?|operat(?:ing|ed)|is\s+(?:active|effective|in\s+effect)|are\s+(?:active|effective|in\s+effect))\b/i;
/** Failing to work said without a negation (O2): "fails to function", "refuses to work", "is unable to function". */
const FAILS_TO = /\b(?:fails?|failed|refuses?|refused|(?:is|are|was|were)\s+unable)\s+to\s+(?:work|function|operate)\b/i;
/** The item failing, as what is said of it right after it (O2's family): "The cloak fails in sunlight.", "…this cloak, which falters underwater." */
const FAILS_ALONE = /^\s*(?:(?:also|still|then|often|always|simply|quickly|soon|eventually)\s+)?(?:fails|failed|falters|faltered|sputters|gutters)(?=\s*(?:[.,;:!]|$)|\s+(?:in|at|on|when|whenever|while|whilst|if|during|under|underwater|outside|indoors|outdoors|unless|until|within|near|by|after|before)\b)/i;
/** A negated works-verb anywhere after the item (J3's backstop): "doesn't function", "can't ever work", "no longer operates". */
const NEG_WORKS = /(?:n't|\bnot|\bnever|\bcannot|\bno\s+longer)\s+(?:[\p{L}'-]+\s+){0,2}?(?:work|works|working|function|functions|functioning|operate|operates|operating)\b/iu;
/**
 * A state of the item that restricts it by itself (I1), as what is said of it (J7): "is powerless", "becomes nonmagical",
 * "goes dormant", "is rendered inert", "becomes a nonmagical cloak", "is just an ordinary cloak" (O2), "has no effect",
 * "provides / grants / offers no …", "stops / ceases working / functioning", "loses its magic / power". A state word in a
 * by-phrase or an object ("can't be damaged by nonmagical weapons") is none.
 */
const STATE_WORD = String.raw`(?:powerless|inert|dormant|nonmagical|ineffective|inactive|suppressed|disabled|useless)`;
const COPULA = String.raw`(?:is|are|was|were|be|been|being|becomes?|became|becoming|remains?|remained|stays?|stayed|turns?|turned|goes|go|went|grows?|grew|falls?|fell|lies|lie|lay|sits?|sat|(?:functions?|acts?|counts?|serves?|behaves?)\s+as|(?:is|are|was|were|be|been)\s+treated\s+as)`;
const STATE_ADVERB = String.raw`(?:completely|entirely|wholly|utterly|totally|fully|temporarily|briefly|momentarily|largely|mostly|effectively|simply|then|instead|also|still|now|again|rendered|left|made|mere|all\s+but|as|[\p{L}]{2,}ly)`;
const STATE_PRED = new RegExp(
  String.raw`\b${COPULA}\s+(?:an?\s+)?(?:${STATE_ADVERB}\s+(?:and\s+)?){0,3}(?:an?\s+)?${STATE_WORD}\b|\b${COPULA}\s+(?:just|merely|only|simply|nothing\s+more\s+than|no\s+more\s+than)\s+(?:an?\s+)?(?:ordinary|mundane|normal|nonmagical|common)\b|\b${COPULA}\s+(?:${STATE_ADVERB}\s+)?(?:mundane\b|an?\s+(?:ordinary|mundane)\s+[\p{L}'-]+)|\bha(?:s|ve)\s+no\s+(?:effect|power|magic)\b|\b(?:provides?|grants?|offers?|gives?|confers?)\s+no\b|\b(?:stops?|ceases?|cease[sd]|stopped)\s+(?:working|functioning|to\s+(?:work|function))\b|\blos(?:es?|t|ing)\s+(?:all\s+(?:of\s+)?)?(?:its|their)\s+(?:magic(?:al)?(?:\s+(?:power|powers|properties|abilities))?|powers?|properties|enchantments?|protection|potency)\b`,
  'iu',
);
/** A state word that opens an aside ("The cloak, powerless in sunlight, …"). */
const STATE_ALONE = new RegExp(String.raw`^(?:${STATE_ADVERB}\s+)?${STATE_WORD}\b`, 'i');
/**
 * What restricts the item as its object (I1, O2): something suppresses, cancels, negates, dispels, nullifies or disables it
 * ("Wearing armor or using a Shield suppresses the bracers."), renders it powerless, inert or useless ("Sunlight renders the
 * cloak powerless."), strips it of its magic, or the wearer gains no benefit from it ("You gain no benefit from these bracers
 * while you wear armor or use a shield.").
 */
const SUPPRESSES =
  /(?<![\p{L}'-])(?:(suppress(?:es|ed)?|cancels?|cancel(?:l)?ed|negates?|negated|dispels?|dispelled|nullif(?:y|ies|ied)|disables?|disabled)|(renders?|rendered|leaves|left|makes|made)|(strips?|stripped)|((?:gain|gains|get|gets|receive|receives)\s+no\s+(?:benefits?|bonus(?:es)?|protection)\s+from|(?:can't|cannot|can\s+not|don't|do\s+not|doesn't|does\s+not|won't|will\s+not)\s+(?:gain\s+any\s+|get\s+any\s+|receive\s+any\s+)?benefits?\s+from))\s+/giu;
const RENDERED = new RegExp(String.raw`^\s+(?:${STATE_ADVERB}\s+)?(?:powerless|inert|useless|nonmagical|dormant|ineffective|inactive|mundane|ordinary)\b`, 'i');
const STRIPPED = /^\s+of\s+(?:all\s+(?:of\s+)?)?(?:its|their)\s+(?:magic(?:al)?|powers?|properties|enchantments?|abilities)\b/i;
/** The item's magic as an object ("its magic", "their powers"), and the rest of "the cloak's magic" after the item phrase. */
const ITS_MAGIC = /^(?:its|their)\s+(?:magic(?:al)?\s+)?(?:magic|powers?|properties|enchantments?|protection|abilities)\b/i;
const ITEMS_MAGIC = /^'s\s+(?:magic(?:al)?\s+)?(?:magic|powers?|properties|enchantments?|protection|abilities)\b/i;
/**
 * Armor worn, as what restricts an item that works only without it (I1): "If you wear armor or use a Shield, …", "If you
 * are wearing armor or using a shield, …", "…if you wear armor or carry a shield", "Wearing armor or using a Shield …".
 */
const SHIELD_USE = String.raw`(?:(?:are\s+)?(?:using|wielding|holding|carrying|bearing)|use|wield|hold|carry|bear)\s+(?:a\s+)?shield`;
const ARMOR_ON = new RegExp(
  String.raw`(?:(?:if|while|whilst|when|whenever|as\s+long\s+as)\s+you(?:'re|\s+are)?\s+(?:(?:are\s+)?(?:wearing|donning|clad\s+in)|wear|don)|(?:^|\b)(?:wearing|donning))\s+(?:any\s+)?armou?r(?:\s*,?\s*(?:or|and|and\/or)\s+(?:you(?:'re|\s+are)?\s+)?(${SHIELD_USE}|(?:a\s+)?shield))?${WORD_END}`,
  'iu',
);

/** The no-armor condition an item's restriction sets for AC (I1), if that is all it says: its armor worn (ARMOR_ON) where it doesn't work, or "only if you wear no armor…". */
function noArmorOf(text: string, positive: boolean): AcCondition | undefined {
  const t = text.replace(/[\s.,;:!]+$/, '').trim();
  if (positive) {
    // "…work only if you wear no armor and use no Shield", "only while you wear no armor", "only work if you don't wear armor".
    const only = /\bonly\s+(?:(?:works?|functions?|operates?|applies|apply)\s+)?/i.exec(t);
    const cond = only ? t.slice(only.index + only[0].length) : '';
    const m = NO_ARMOR_AT_START.exec(cond);
    return m && harmlessAfter(cond.slice(m[0].length)) ? (NO_SHIELD.test(cond) ? 'no-armor-no-shield' : 'no-armor') : undefined;
  }
  const m = ARMOR_ON.exec(t);
  if (!m) return undefined;
  const rest = `${t.slice(0, m.index)} ${t.slice(m.index + m[0].length)}`;
  // Nothing else conditional left ("…doesn't work if you wear armor or use a Shield.", "If you wear armor, …").
  if (SITUATIONAL.test(rest.replace(/^\s*(?:if|while|whilst|when|whenever)\b/i, '')) || IF.test(rest) || MORE_CONDITIONS.test(rest) || AGAINST.test(rest)) return undefined;
  return m[1] ? 'no-armor-no-shield' : 'no-armor';
}

/** An item's name as its text prints it, lower case, without a parenthesis ("Cloak of the Deep" → "cloak of the deep"; J3). */
const nameOf = (name: string) => name.replace(/[‘’]/g, "'").replace(/\([^)]*\)/g, ' ').split(',')[0].replace(/\s+/g, ' ').trim().toLowerCase();
/** Where an item subject may start (I1, J3): a pronoun or a determiner ("it", "this", "the"; "a" or "an" only before the item's name). */
const SUBJECT_START = /(?<![\p{L}'-])(?=(?:it|this|these|that|those|the|both|either|such|any|a|an)(?![\p{L}'-]))/giu;
/** A verb next ("This cloak works…", "the bracers don't…"), not a preposition or an object's words. */
const VERB_NEXT = new RegExp(String.raw`^\s+(?!${NOT_VERB}${WORD_END})[\p{L}]`, 'iu');
const REF_WORD = new RegExp(String.raw`^${REF_NOUN}$`, 'iu');
const THIS_REF = new RegExp(String.raw`^th(?:is|ese)\s+${REF_NOUN}$`, 'iu');
/** The most places a clause's item subject may start at that are judged (G3). */
const MAX_SUBJECTS = 64;
/** Where an item subject may start in a clause: SUBJECT_START, and wherever the item's name stands (J3). */
function subjectStarts(clause: string, name: string): number[] {
  const at = execAll(SUBJECT_START, clause).map((m) => m.index);
  if (name) {
    const lower = clause.toLowerCase();
    for (let i = lower.indexOf(name); i >= 0; i = lower.indexOf(name, i + 1)) if (!/[\p{L}'-]/u.test(lower.charAt(i - 1))) at.push(i);
  }
  return [...new Set(at)].sort((a, b) => a - b);
}
/**
 * The length of the item named at a text's start, as a subject (I1, J3), or 0: its name, perhaps after "the", "this" or
 * "a" ("The Cloak of the Deep", "A Ring of the Reed"), "it", an item phrase that names it or "the item" (O2), or "this/these
 * <any noun>" (not a reference noun: fail closed, "This garment works only at night.").
 */
function itemSubjectAt(t: string, own: ReadonlySet<string>, name: string): number {
  if (name) {
    const det = /^(?:(?:the|this|these|that|those|a|an)\s+)?/i.exec(t)?.[0] ?? '';
    const after = t.slice(det.length);
    if (after.slice(0, name.length).toLowerCase() === name && !/^[\p{L}'-]/u.test(after.slice(name.length))) return det.length + name.length;
  }
  if (/^an?\s/i.test(t)) return 0;
  if (/^it(?![\p{L}'-])/iu.test(t)) return 2;
  // "Such a cloak doesn't function in sunlight.", "Any such ring…": the item's kind, so the item.
  const such = /^(?:such\s+an?|any\s+such)\s+/i.exec(t);
  if (such) {
    const kind = itemAt(`the ${t.slice(such[0].length)}`);
    return kind && namesItem(kind.phrase, own) ? such[0].length + kind.length - 4 : 0;
  }
  if (/^(?:such|any)\s/i.test(t)) return 0;
  const item = itemAt(t);
  const noun = item?.phrase.toLowerCase().split(/\s+/).pop()?.replace(/'s$/, '') ?? '';
  // For a restriction, "the <noun of the list>" is the item too ("The blade doesn't function in sunlight." in a longsword; fail closed).
  if (item && (namesItem(item.phrase, own) || /^the\s+items?$/i.test(item.phrase) || (/^(?:the|that|those)\s/i.test(item.phrase) && item.phrase.includes(' ') && NOUN_FORMS.has(noun)) || (/^th(?:is|ese)\s+[\p{L}'-]+$/iu.test(item.phrase) && !THIS_REF.test(item.phrase)))) return item.length;
  const any = /^th(?:is|ese)\s+([\p{L}'-]+)/iu.exec(t);
  return any && !NOT_ITEM_WORD.test(any[1]) && !REF_WORD.test(any[1]) ? any[0].length : 0;
}
/** The rest of the item's own name after the noun its phrase ends at (J3): "The Cloak" + " of the Deep", 2014 "the ring" + " of dusk wardens". */
function withNameTail(t: string, n: number, name: string): number {
  if (!name) return n;
  const words = name.split(' ');
  const noun = t.slice(0, n).trimEnd().split(/\s+/).pop()?.toLowerCase() ?? '';
  const at = words.indexOf(noun);
  if (at < 0 || at === words.length - 1) return n;
  const tail = ` ${words.slice(at + 1).join(' ')}`;
  return t.slice(n, n + tail.length).toLowerCase() === tail && !/^[\p{L}'-]/u.test(t.slice(n + tail.length)) ? n + tail.length : n;
}
/**
 * What may stand between an item subject and its verb (J3): a second subject ("and its hood", "and their clasps") and an
 * aside of up to eight words set off by commas, parentheses or dashes (", however,", ", woven from shadow,", "(a relic of
 * the Shadowfell)", "— like all such relics —").
 */
const SECOND_SUBJECT = /^\s+and\s+(?:its|their|the|this|these)\s+(?:[\p{L}'-]+\s+){0,2}?[\p{L}'-]+(?=\s)/iu;
const ASIDE = /^\s*(?:,\s*([^,;:()—–\s](?:[^,;:()—–]{0,78}[^,;:()—–\s])?)\s*,|\(\s*([^()\s](?:[^()]{0,78}[^()\s])?)\s*\)|[—–]\s*([^—–\s](?:[^—–]{0,78}[^—–\s])?)\s*[—–]|\s-\s+([^-\s](?:[^-]{0,78}[^-\s])?)\s+-)/u;
/** Words before an item subject that only join it to what came before (J3): "But", "Yet", "And", "So", a connective. */
const JOINER_LEAD = /^(?:(?:but|yet|and|so|or|nor|then|thus|instead|in\s+addition|additionally|also|furthermore|moreover|however|likewise|similarly|besides|still)\b,?\s*)+/i;
/** An opening parenthesis or quotation mark (O1). */
const OPENING_MARK = /^[(["“‘]+\s*/;
/** A run-in label with a colon (O1): "Weakness: …", "Curse (Sunlight): …". */
const COLON_LABEL = /^([^.!?:;,()]{1,60}?(?:\([^()]{1,40}\))?):\s*/;

/** An item subject of a clause (I1): the lead-in before it, an aside after it (J3), what is said of it, and a colon run-in label before it that holds as a label (O1). */
interface ItemSubject { lead: string; paren: string; rest: string; label?: string }

/**
 * The lead-in before an item subject (I1, J3, O1), or null when the words there aren't one: nothing, anything up to a
 * comma ("If you wear armor or use a Shield, …"), or with no comma a phrase that opens with a preposition or a
 * subordinator ("In sunlight this cloak…", "When you are Bloodied the cloak…"); "But", "Yet", "So" or a connective before
 * any of these, with or without a comma; a run-in label with a colon, as a lead-in with a comma ("Weakness: The cloak…");
 * an opening "(" or quotation mark. Right after a bare subordinator, the item is its clause's ("If the weapon is on your
 * person, …").
 */
function leadBefore(raw: string, own: ReadonlySet<string>): string | null {
  let l = raw.trim().replace(OPENING_MARK, '');
  const label = COLON_LABEL.exec(l);
  if (label && label[1].trim().split(/\s+/).length <= 8) l = labelHolds(label[1].trim(), own) ? l.slice(label[0].length).trim() : `${label[1].trim()}, ${l.slice(label[0].length)}`.trim();
  l = l.replace(JOINER_LEAD, '').trim();
  if (l && !/,$/.test(l) && (l.includes(',') || !OPENER_AT_START.test(l) || SUBORDINATOR.test(l))) return null;
  return l.replace(/[\s,]+$/, '').trim();
}

/** The item as the subject of a main clause (I1, J3), after any lead-in: each candidate (at `starts`), with its lead-in, its aside and what is said of it. */
function itemSubjectsIn(clause: string, before: string, own: ReadonlySet<string>, name: string, starts: readonly number[]): ItemSubject[] {
  // "…while you wear this cloak, which doesn't function in sunlight."
  const which = /^\s*(?:which|whose\s+[\p{L}'-]+)\s+/iu.exec(clause);
  if (which) return endsWithItem(before, own) ? [{ lead: '', paren: '', rest: clause.slice(which[0].length) }] : [];
  const out: ItemSubject[] = [];
  for (const at of starts) {
    const lead = leadBefore(clause.slice(0, at), own);
    if (lead === null) continue;
    const t = clause.slice(at);
    const n = itemSubjectAt(t, own, name);
    if (!n) continue;
    let rest = t.slice(withNameTail(t, n, name));
    rest = rest.slice(SECOND_SUBJECT.exec(rest)?.[0].length ?? 0);
    let paren = '';
    const aside = ASIDE.exec(rest);
    const words = aside ? (aside[1] ?? aside[2] ?? aside[3] ?? aside[4] ?? '').trim() : '';
    if (aside && words.split(/\s+/).length <= 8) {
      paren = words;
      // A verb may follow a closing dash directly ("The cloak—like all such relics—works only at night.").
      rest = ` ${rest.slice(aside[0].length).trimStart()}`;
    }
    const colon = COLON_LABEL.exec(clause.slice(0, at).trim().replace(OPENING_MARK, ''))?.[1].trim() ?? '';
    const label = colon !== '' && colon.split(/\s+/).length <= 8 && labelHolds(colon, own) ? colon : '';
    if (VERB_NEXT.test(rest)) out.push({ lead, paren, rest, ...(label ? { label } : {}) });
  }
  return out;
}
const SUBORDINATOR = /^(?:if|when|whenever|while|whilst|unless|until|till|once|although|though|because|as\s+long\s+as|so\s+long\s+as|provided(?:\s+that)?|providing|whether|where|wherever|since|after|before|as|even\s+if|even\s+when)$/i;
const OPENER_AT_START = new RegExp(String.raw`^(?:in\s+addition,?\s+)?${OPENER_WORD}${WORD_END}`, 'iu');
/** Whether a text ends with the item ("…while you wear this cloak", "…made with it"), for a ", which…" after it. */
function endsWithItem(text: string, own: ReadonlySet<string>): boolean {
  const s = text.replace(/[\s,]+$/, '');
  if (/(?<![\p{L}'-])(?:it|them)$/iu.test(s)) return true;
  const words = [...s.matchAll(/\S+/g)];
  for (let k = 2; k <= Math.min(6, words.length); k++) {
    const w = words[words.length - k];
    if (!/^(?:this|these|that|those|the|both|either)$/i.test(w[0])) continue;
    const phrase = s.slice(w.index);
    return isItemPhrase(phrase) && namesItem(phrase, own);
  }
  return false;
}

/**
 * Whether what is said of an item subject restricts it (I1, J3, J7): a negated verb, "only" or a state (powerless, inert,
 * "becomes nonmagical", "has no effect", "provides no protection", "stops working", "loses its magic", "fails to
 * function"), and a condition word, in what is said or in its aside, or a lead-in the always-on grammar doesn't hold
 * ("In sunlight, this cloak doesn't work.", "This cloak works only at night", "The cloak, however, doesn't function in
 * sunlight"); a negated "work", "function" or "operate", or a state, needs no condition ("This cloak doesn't work."); a
 * negated "protect", "help" or "apply" does ("The armor doesn't protect you from psychic damage." holds). Armor worn as
 * that condition, alone, sets the no-armor condition for AC.
 */
function restrictsItem(s: ItemSubject, own: ReadonlySet<string>): Limit | null {
  const said = s.rest.replace(HARMLESS_NEG, ' ');
  // What is said of the item itself, not in a relative clause about something else ("…lined with blue silk that never fades").
  const itsOwn = said.split(/\b(?:that|which|who|whom|whose)\b/i)[0];
  const fails = FAILS_TO.test(itsOwn) || FAILS_ALONE.test(itsOwn);
  const neg = fails || NEG_IN.test(itsOwn);
  const only = /\bonly\b/i.test(itsOwn);
  const state = STATE_PRED.test(itsOwn) || STATE_ALONE.test(s.paren);
  if (!neg && !only && !state) return null;
  // An aside is judged with what is said ("The cloak, once donned, doesn't function while…", "The cloak, in sunlight, has no effect").
  const whole = s.paren ? `${s.paren}, ${said}` : said;
  const t = withoutWorn(whole, own);
  // "After the tenth time, it cracks and becomes useless.": a state after its uses are spent is a permanent loss, no situation.
  const spent = state && !neg && !only && /^(?:after|once)\s+(?:the|its|their)\s+(?:[\p{L}'-]+\s+)?(?:time|use)s?$/iu.test(s.lead);
  const leadFails = s.lead !== '' && !spent && !leadInHolds(s.lead, own);
  const condition = SITUATIONAL.test(t) || IF.test(t) || AGAINST.test(t) || MORE_CONDITIONS.test(t) || CONDITION_WORD.test(t.replace(/\bonly\b/gi, ' ')) || (neg && SCOPED_TO.test(t));
  // "…only work on dry land", "…works only for its owner": the item working only so, whatever qualifies it (fail closed).
  const onlySo = only && WORKS_VERB.test(itsOwn) && /[\p{L}\d]/u.test(withoutWorn(said, own).replace(/\b(?:only|also|still|works?|functions?|operates?|applies|apply|protects?|helps?|you|is|are|active|effective|in\s+effect)\b/gi, ''));
  // "Daytime: The cloak is inert.": a state after a colon run-in label that holds as a label, and isn't an always-on phrase, is a loss in what the label names (fail closed).
  const labelState = state && !neg && !only && s.label !== undefined && !leadInHolds(s.label, own);
  if (!(leadFails || condition || onlySo || labelState || (neg && (WORKS_ITSELF.test(itsOwn) || fails || state)))) return null;
  // "…only if you wear no armor and use no Shield": the no-armor condition the app models, for AC; so is armor worn where it doesn't work.
  const acOnly = (only ? noArmorOf(said, true) : undefined) ?? (neg || state ? noArmorOf(leadFails ? `${s.lead}, ${whole}` : whole, false) : undefined);
  return { scope: 'item', acOnly, plural: true };
}

/** What a negated "protect", "help" or "apply" is scoped to that makes it a condition (J7): attacks, hits, rolls, saves, spells or a kind of creature ("doesn't protect you from ranged attacks"); a damage type ("…from Psychic damage") is none. */
const SCOPED_TO =
  /\b(?:protects?|protecting|helps?|helping|appl(?:y|ies))\b[^.;]*?\b(?:from|against|on|to|with|versus|vs\.?)\s+(?:[\p{L}'-]+\s+){0,3}?(?:attacks?|hits?|rolls?|saving\s+throws?|saves?|spells?|creatures?|enemies|foes|Undead|Fiends?|Fey|Dragons?|Constructs?|Aberrations?|Celestials?|Elementals?|Giants?|Humanoids?|Monstrosit(?:y|ies)|Oozes?|Plants?|Beasts?)\b/iu;
/** "Neither the cloak nor its clasp functions…": a works-verb after "nor" (J3's backstop). */
const NOR_WORKS = /\bnor\s+(?:[\p{L}'-]+\s+){0,3}?(?:works?|functions?|operates?)\b/iu;
/** "The garment doesn't function in sunlight.": "the <any noun>" opening a clause (after any lead-in up to a comma) with a negated works-verb right after it. */
const SOME_THING_FAILS = /^(?:[^,;]{0,80},\s*)?(?:the|that)\s+(?!(?:spells?|effects?|abilit(?:y|ies)|tricks?|commands?|illusions?|charms?|disguises?|attacks?|clasps?|straps?|buckles?|locks?|latch(?:es)?|hinges?)\b)[\p{L}'-]+\s+(?:doesn't|does\s+not|don't|do\s+not|won't|will\s+not|can't|cannot|never|no\s+longer)\s+(?:work|function|operate)\b/iu;
/** A clause's own subject before the item ("You can remove this cloak only…"): the item is then its object, for J3's backstop. */
const SUBJECT_PRONOUN = /(?<![\p{L}'-])(?:you|they|we|he|she)(?![\p{L}-])/iu;
/** A "that" that opens a clause after a subject of its own ("You find that …", "Sages say that …"). */
const THAT_CLAUSE = /(?<![\p{L}'-])that\s+$/iu;
/** "only" as an adverb, not an adjective ("the only cloak of its kind", "its only flaw"). */
const ONLY_ADVERB = /(?<!\b(?:the|an|its|their|his|her|your|my|our|one)\s+)\b(?:only\s+(?:works?|functions?|operates?|applies|protects?|helps?|while|whilst|when|whenever|if|in|at|on|by|during|underwater|between|after|before|under|within|against|until)\b|(?:works?|functions?|operates?|applies|protects?|helps?|shields?|guards?|is\s+active|is\s+effective)\s+(?:[\p{L}'-]+\s+){0,3}?only\b)/iu;
/**
 * J3's fail-closed backstop: a clause that names the item first, with no subject before it (an item phrase, its name,
 * "this/these <noun>"; not "it"), then a negated works-verb, a state or "only", restricts the item though no subject was
 * found ("Weakness: the cloak doesn't function in sunlight.", "The cloak, a relic of the kings who ruled the north long
 * ago, works only at night."). A subject before it makes the item its object ("You can remove this cloak only…"), unless
 * a "that" opens the item's own clause ("You find that this cloak works only at night.").
 */
function unreadRestriction(clause: string, own: ReadonlySet<string>, name: string, starts: readonly number[]): Limit | null {
  let end = -1;
  const pronoun = clause.search(SUBJECT_PRONOUN);
  for (const at of starts) {
    const t = clause.slice(at);
    // "that" before another subject's start opens a clause ("…that this cloak works…"), and stands for no item itself.
    if (/^that\s/i.test(t) && starts.includes(at + 5)) continue;
    if (pronoun >= 0 && pronoun < at && !THAT_CLAUSE.test(clause.slice(pronoun, at))) return null;
    if (/^it(?![\p{L}'-])/iu.test(t)) continue;
    // A mention right after a preposition is an object, not a subject ("in excess of this number"), unless a quantifier takes it ("Each of these cloaks…").
    const ahead = clause.slice(0, at);
    if (/(?<![\p{L}'-])(?:of|in|on|at|to|for|from|with|by|than|into|onto|over|under|about)\s+$/iu.test(ahead) && !/(?<![\p{L}'-])(?:each|every|one|all|none|any|either|neither|both|some|most|two|three)\s+of\s+$/iu.test(ahead)) {
      const phrase = itemAt(t)?.phrase;
      const kind = /(?<![\p{L}'-])([\p{L}'-]+)\s+of\s+$/iu.exec(ahead)?.[1].toLowerCase() ?? '';
      if (!(phrase && namesItem(phrase, own)) && !NOUN_FORMS.has(kind) && !own.has(kind)) continue;
    }
    const n = itemSubjectAt(t, own, name);
    if (n) {
      end = at + withNameTail(t, n, name);
      break;
    }
  }
  // "In sunlight, the garment doesn't function.": a negated works-verb right after "the <any noun>" that opens the clause.
  if (end < 0) return SOME_THING_FAILS.test(clause) && !SUBJECT_PRONOUN.test(clause.split(/\bthe\s/i)[0]) ? { scope: 'item', acOnly: noArmorOf(clause, false), plural: true } : null;
  // A mention inside a leading "If/When/Once/After …," clause: only that clause is said of it ("If one of the stones in a pair is destroyed, the other one becomes nonmagical."),
  // not the other one's words after it; a later part of the main clause still is ("…, the other properties stop working and the cloak becomes powerless.").
  const leadEnd = /^\s*(?:if|when|whenever|once|after|before|unless|until)(?![\p{L}'-])/iu.test(clause) ? clause.indexOf(',', end) : -1;
  const comma = leadEnd > end && /^,\s*(?:the\s+other|another|the\s+second|the\s+remaining)(?![\p{L}'-])/iu.test(clause.slice(leadEnd)) ? leadEnd : -1;
  const later = comma > end ? /(?:,\s*|\s+)(?:and|but|or|nor|yet|so|then|while|whilst)\s+/iu.exec(clause.slice(comma + 1)) : null;
  const after = (comma > end ? `${clause.slice(end, comma)}${later ? ` ${clause.slice(comma + 1 + later.index)}` : ''}` : clause.slice(end)).replace(HARMLESS_NEG, ' ');
  const fails = NEG_WORKS.test(after) || FAILS_TO.test(after) || NOR_WORKS.test(after);
  const state = STATE_PRED.test(after);
  const only = ONLY_ADVERB.test(after);
  if (!fails && !state && !only) {
    if (comma <= end) return null;
    // The main clause on its own, past the other one's subject: a mention of the item there is its own ("…, the other properties, like the cloak itself, stop working").
    const main = clause.slice(comma + 1);
    return unreadRestriction(main, own, name, subjectStarts(main, name).filter((s) => !/^(?:the\s+other|another|the\s+second|the\s+remaining)(?![\p{L}'-])/iu.test(main.slice(s))));
  }
  const acOnly = (only ? noArmorOf(after, true) : undefined) ?? (fails || state ? noArmorOf(clause, false) : undefined);
  return { scope: 'item', acOnly, plural: true };
}

/** Another creature as the subject of "gains no benefit from <item>" (O2): "Other creatures", "Creatures other than you", "Your allies", "A thief", "A creature that steals the armor"; the wearer ("you", "the wearer", "its bearer", "a creature wearing it") isn't one. */
const OTHER_CREATURE =
  /(?:^|[,;:]\s*|\b(?:if|when|while|whilst|unless|and|but|so)\s+)(?:(?:other|another|any\s+other)\s+(?:creatures?|beings?|people|persons?|wearers?|users?)|(?:(?:an?|any|the)\s+)?creatures?\s+other\s+than\s+you|anyone\s+(?:else|other\s+than\s+you|but\s+you)|(?:no\s+one|everyone)\s+else|others|(?:your|its)\s+(?:allies|companions|enemies|foes)|(?:an?|any|the)\s+(?:thief|enemy|foe)|thieves|(?:(?:an?|any|the)\s+creature|creatures)\s+(?:that|who)\s+(?!(?:is\s+|are\s+)?(?:wear|hold|carr|wield|bear|attun|don))[^,;]{1,60}?)\s+$/i;
/** "No mortal magic can render…", "Not even an Antimagic Field renders…", "Only a Wish spell can render…" (O2): nothing short of a Wish spell, a deity, divine magic or an artifact restricts the item; "Only sunlight renders…" and "Only fire magic renders…" still do. */
const NONE_BUT_MAGIC =
  /^(?:[^,;]{0,80},\s*)?(?:(?:nothing|no(?!\s+longer)\b|none|not\s+even|neither)(?!\s+(?:but|except|save|other\s+than)\b)|(?:only|nothing\s+(?:but|except|save|other\s+than))\s+(?:an?\s+|the\s+)?(?:wish(?:\s+spells?)?|divine\s+(?:magic|intervention)|deity|deities|gods?|artifacts?)(?![\p{L}'-]))/iu;
/**
 * A main clause that restricts the item itself (I1), whatever stands before it: the item as its subject (itemSubjectsIn,
 * judged by restrictsItem), or as the object of what suppresses, cancels, negates or dispels it, renders it powerless or
 * strips it of its magic, or of "gain no benefit from" (O2); with no subject found, J3's backstop. Not a reuse limit, a
 * permanent loss, "can't be suppressed", "doesn't stack", "doesn't count as wearing armor". Pure.
 */
function restrictionOf(clause: string, before: string, own: ReadonlySet<string>, name: string): Limit | null {
  if (isReuse(clause) || permanent(clause)) return null;
  for (const m of execAll(SUPPRESSES, clause)) {
    const after = clause.slice(m.index + m[0].length);
    const n = /^(?:it|them)(?![\p{L}'-])/iu.exec(after)?.[0].length ?? itemSubjectAt(after, own, name);
    // The item, or its magic ("renders the cloak's magic inert", "renders its magic useless").
    const end = n ? withNameTail(after, n, name) : (ITS_MAGIC.exec(after)?.[0].length ?? 0);
    const tail = ITEMS_MAGIC.exec(after.slice(end))?.[0].length ?? 0;
    const named = end > 0 || (m[1] !== undefined && /^(?:its|their)\s+(?:magic|powers?|properties|enchantment)\b/i.test(after));
    if (!named || (m[4] === undefined && (NEGATED_BEFORE.test(clause.slice(0, m.index)) || /\bbe\s+$/i.test(clause.slice(0, m.index))))) continue;
    const before = clause.slice(0, m.index);
    if (m[4] !== undefined && OTHER_CREATURE.test(before)) continue;
    if (m[4] === undefined && NONE_BUT_MAGIC.test(before)) continue;
    if (m[2] !== undefined && !RENDERED.test(after.slice(end + tail))) continue;
    if (m[3] !== undefined && !STRIPPED.test(after.slice(end))) continue;
    return { scope: 'item', acOnly: noArmorOf(m[1] !== undefined ? clause.slice(0, m.index) : clause, false), plural: true };
  }
  // A clause with more item subjects than prose ever has is no clause a reader can judge: a restriction (fail closed, G3).
  const starts = subjectStarts(clause, name);
  if (starts.length > MAX_SUBJECTS) return { scope: 'item', plural: true };
  // Whatever verb takes the item and "of its magic" ("Sunlight robs the cloak of its magic.", "…deprives the ring of its power"), O2's family.
  for (const at of starts) {
    const t = clause.slice(at);
    const n = itemSubjectAt(t, own, name);
    if (n && at > 0 && STRIPPED.test(t.slice(withNameTail(t, n, name))) && !NEGATED_BEFORE.test(clause.slice(0, at))) return { scope: 'item', acOnly: noArmorOf(clause, false), plural: true };
  }
  const subjects = itemSubjectsIn(clause, before, own, name, starts);
  if (!subjects.length) return unreadRestriction(clause, own, name, starts);
  for (const s of subjects) {
    const r = restrictsItem(s, own);
    if (r) return r;
  }
  return null;
}

/** An item reference as a main clause's subject that limits it (J6): "The cloak's magic fails in sunlight", "This cloak's protection works only at night". */
function itemReferenceIn(clause: string, own: ReadonlySet<string>): Limit | null {
  const t = withoutSpent(clause, true);
  const ref = t.trim() ? refIn(t, own) : null;
  return ref?.item && (LOSES_IT.test(t) || limits(t, ref.index, own)) ? { scope: 'item', plural: true } : null;
}

/**
 * The restrictions on the item in a sentence's main clauses (I1), before or after any bonus in it; in a sentence that holds
 * a bonus, also an item reference that limits a clause other than the bonus's own (J6).
 */
function restrictionsIn(sentence: string, own: ReadonlySet<string>, name: string, hasBonus: boolean): Limit[] {
  if (EXAMPLE.test(sentence)) return [];
  const restrict = MAY_RESTRICT.test(sentence);
  const refer = hasBonus && MAY_REFER.test(sentence);
  if (!restrict && !refer) return [];
  const parts = clausesOf(sentence);
  const out: Limit[] = [];
  parts.forEach((clause, k) => {
    const r = restrict ? restrictionOf(clause, k > 0 ? parts[k - 1] : '', own, name) : null;
    if (r) out.push(r);
    const ref = refer && !/\+\s?\d/.test(clause) ? itemReferenceIn(clause, own) : null;
    if (ref) out.push(ref);
  });
  return out;
}

/** A later clause that goes on with the bonus's own: "…, but only while…", "…, and not underwater", "…, except in Dim Light". */
const GOES_ON = /^(?:only|not|never|except|save)\b/i;
/** The same with a condition word ("…, or in Dim Light", "…, though while you're Bloodied"), unless a new clause follows it ("…; if the cloak is torn, it mends by dawn"). */
const GOES_ON_IF = /^(?:though|although)\b/i;
const NEW_CLAUSE = /,\s+(?:it|they|he|she|the|this|these|that|those|its|their|each|every|any|an?)\s+[\p{L}'-]+/iu;

export type BonusTarget = 'ac' | 'savingThrows' | 'attack' | 'damage';

/** One "+N bonus to …" phrase, with the sentence it stands in. */
interface BonusPhrase {
  n: number;
  targets: BonusTarget[];
  phrase: string;
  /** The sentence, apostrophes straightened (as it is judged). */
  sentence: string;
  /** The words a note quotes (the sentence as printed, or the one that limits the bonus). */
  printed: string;
  /** One variant's bonus (an item whose rarity varies), or one value of a by-rarity list. */
  variant: boolean;
  situational: boolean;
  /** Worded so the app never applies it (LOOSE): only a record that applies it gets a note. */
  loose: boolean;
  /** The piece (pieces()) it stands in. */
  piece: number;
  /** A no-armor condition the item's text sets for it elsewhere ("These bracers work only if you wear no armor…"). */
  acOnly?: AcCondition;
}

function targetsOf(text: string): BonusTarget[] {
  const t = text.toLowerCase();
  return [
    ...(/\b(?:ac|armor class)\b/.test(t) ? (['ac'] as const) : []),
    ...(/\bsaving throws\b/.test(t) ? (['savingThrows'] as const) : []),
    ...(/\battack\b/.test(t) ? (['attack'] as const) : []),
    ...(/\bdamage\b/.test(t) ? (['damage'] as const) : []),
  ];
}

/** A clause of a sentence (`text`, ending at `end`) and the match's own benefit in it (`own`, to `ownTo`). */
interface Clause { text: string; own: string; end: number; ownTo: number }

/** The last match of a global regex in a text. */
const lastMatch = (text: string, re: RegExp) => execAll(re, text).pop();

/** The clause of a sentence a match stands in (`text`) and the match's own benefit in that clause (`own`). */
function clauseOf(sentence: string, index: number, length: number): Clause {
  let start = 0;
  for (const b of execAll(CLAUSE_BREAK, sentence.slice(0, index))) start = b.index + b[0].length;
  const after = sentence.slice(index + length);
  const brk = new RegExp(CLAUSE_BREAK.source, 'i').exec(after);
  const end = index + length + (brk ? brk.index : after.length);
  let ownFrom = start;
  let ownTo = end;
  for (const b of execAll(BENEFIT_BREAK, sentence)) {
    const at = b.index;
    if (at < start || at >= end) continue;
    if (at + b[0].length <= index) ownFrom = Math.max(ownFrom, at + b[0].length);
    else if (at >= index + length) ownTo = Math.min(ownTo, at);
  }
  return { text: sentence.slice(start, end), own: sentence.slice(ownFrom, ownTo), end, ownTo };
}

/** Verbs a bonus is given by ("you gain a +1 bonus", "this cloak grants you a +1 bonus", "you have a +2 bonus"). */
const BONUS_VERB = String.raw`(?:gain|gains|have|has|get|gets|grant|grants|give|gives|confer|confers|provide|provides|bestow|bestows|receive|receives|enjoy|enjoys|offer|offers|impart|imparts)`;
/** Others named with the wearer ("you and your allies"): the wearer has the bonus too ("you or an ally" is a choice, so it isn't). */
const WITH_OTHERS = String.raw`\s*,?\s*and\s+(?:(?:your|each|any|one|all|every|an?|the)\s+)?(?:(?!(?:you|your|and|or)${WORD_END})${L}+\s+){0,2}?(?:allies|ally|companions?|familiars?|creatures?|friends?|mounts?|steeds?|others?|party)`;
/** Who a bonus may be given to (D4): absent, you ("grants you"), you and others, or the wearer ("grants its wearer"). */
const RECIPIENT = String.raw`(?:you(?:${WITH_OTHERS})?|(?:the|its|their)\s+(?:wearer|bearer|wielder|user|owner))`;
const VERB_AT_END = new RegExp(String.raw`(?<!${L})${BONUS_VERB}(?:\s+${RECIPIENT})?(?:\s+(?:a|an)(?:\s+(?:additional|extra))?)?\s*$`, 'iu');
const VERB_G = new RegExp(String.raw`(?<!${L})${BONUS_VERB}${WORD_END}`, 'giu');
/**
 * A bonus listed after another benefit of the same verb ("…a +1 bonus to AC and a +1 bonus to saving throws", "…Resistance
 * to Cold damage and a +1 bonus…"), joined by ",", "and", "as well as" or "plus"; never "or", which offers a choice (I10).
 */
const COORDINATED = /(?:,\s*(?:and|as\s+well\s+as|plus)?|\s+and|\s+as\s+well\s+as|\s+plus)\s+(?:(?:a|an)\s+)?$/i;
/** Words between a subject and its verb that set no condition ("you also gain", "you still have"). */
const ADVERBS_AT_END = /(?:\s+(?:also|still|additionally|likewise|always))+\s*$/i;
/** A parenthetical between a subject and its verb ("The shield, once activated, grants…", "This ring, while worn, grants…"). */
const PAREN_AT_END = /,\s*([^,;]{1,80}?)\s*,\s*$/;
/** The wearer, by name ("the wearer gains…", "its bearer has…"). */
const WEARER_AT_END = new RegExp(String.raw`(?<!${L})(?:the|its|their|this|that|any)\s+(?:wearer|bearer|wielder|user|owner|holder|carrier)$`, 'iu');
const YOU_AT_END = new RegExp(String.raw`(?<!${L})you(?:${WITH_OTHERS})?$`, 'iu');
const YOU_AND_AT_END = new RegExp(String.raw`(?<!${L})you${WITH_OTHERS}\s+(?:within|in)\s+\d+\s+(?:feet|ft\.?)\s+of\s+you$`, 'iu');
/** "you", "it" or an item after a preposition is no subject ("allies within 10 feet of you gain…"). */
const AFTER_PREPOSITION = /(?:^|\s)(?:of|to|for|near|around|behind|beside|with|from|by|at|toward|towards|than|like|including|except|besides|within|beyond|before|after|under|over|above|below|against|on|in|into|onto|upon|about|among|between|beneath|through|across|past|inside|outside)\s*$/i;
/** "…can be wielded as a magic Quarterstaff that", "…functions as a magic Mace that": the item in a weapon's form. */
const AS_WEAPON = new RegExp(String.raw`\s+as\s+an?\s+(?:magic\s+)?(?:${L}+\s+){0,2}?${L}+\s+(?:that|which)$`, 'iu');
const AS_WEAPON_VERB = /\s+(?:(?:has|holds)\s+\d+\s+charges,?\s+and\s+)?(?:can\s+be\s+(?:wielded|used)|functions|serves|acts|counts|is\s+wielded)$/i;

/** Who a bonus's clause gives it to (D4), and where its subject starts. */
interface Subject { kind: 'you' | 'wearer' | 'item'; from: number; paren: string; /** Where its verb starts (the subject's words end). */ to: number }

/** The subject at the end of a text (before its verb): you, the wearer, or the item (namesItem). */
function subjectAtEnd(text: string, own: ReadonlySet<string>): { kind: Subject['kind']; from: number } | null {
  const s = text.trimEnd();
  const pick = (kind: Subject['kind'], from: number): { kind: Subject['kind']; from: number } | null => {
    const before = s.slice(0, from);
    if (kind === 'item') {
      // I11: "Each of these rings", "Both of these gauntlets" (the item); "Wearing this ring", "Attuning to this amulet"
      // (its wearer's, given by the item); "The wearer of this cloak", "Anyone who wears this cloak" (the wearer).
      const each = /(?:^|\s)((?:each|both|either|all|any|every\s+one)\s+of)\s*$/i.exec(before);
      if (each) return { kind, from: each.index + each[0].indexOf(each[1]) };
      const gerund = /(?:^|\s)((?:wearing|holding|carrying|wielding|bearing|donning|attuning\s+to|being\s+attuned\s+to))\s*$/i.exec(before);
      if (gerund) return { kind, from: gerund.index + gerund[0].indexOf(gerund[1]) };
      const wearerOf = /(?:^|\s)((?:the|its)\s+(?:wearer|bearer|wielder|user|owner|holder)\s+of|(?:anyone|whoever|everyone)\s+(?:(?:who|that)\s+)?(?:wears|holds|carries|wields|bears|is\s+attuned\s+to))\s*$/i.exec(before);
      if (wearerOf) return { kind: 'wearer', from: wearerOf.index + wearerOf[0].indexOf(wearerOf[1]) };
    }
    return AFTER_PREPOSITION.test(before) ? null : { kind, from };
  };
  // "you and allies within 10 feet of you" (I11): the first "you", with the others.
  const youAnd = YOU_AND_AT_END.exec(s);
  if (youAnd) return pick('you', youAnd.index);
  const you = YOU_AT_END.exec(s);
  if (you) return pick('you', you.index);
  const wearer = WEARER_AT_END.exec(s);
  if (wearer) return pick('wearer', wearer.index);
  // "This cloak's wearer gains…" (I11).
  const possessive = /(?<![\p{L}'-])((?:this|these|that|those|the|both|either)\s+(?:[\p{L}'-]+\s+){0,3}?[\p{L}'-]+)'s\s+(?:wearer|bearer|wielder|user|owner|holder)$/iu.exec(s);
  if (possessive) return isItemPhrase(possessive[1]) && namesItem(possessive[1], own) ? pick('wearer', possessive.index) : null;
  const it = /(?<![\p{L}'-])it$/iu.exec(s);
  if (it) return pick('item', it.index);
  // "This staff … can be wielded as a magic Quarterstaff that grants…", "…it functions as a magic Mace that grants…".
  const as = AS_WEAPON.exec(s);
  if (as) {
    const main = s.slice(0, as.index).replace(AS_WEAPON_VERB, '');
    return main.length < as.index ? subjectAtEnd(main, own) : null;
  }
  // "…this cloak, which grants…".
  const which = /,\s*(?:which|that)$/i.exec(s);
  if (which) {
    const before = subjectAtEnd(s.slice(0, which.index), own);
    return before?.kind === 'item' ? before : null;
  }
  // An item phrase: the nearest determiner decides ("this black iron helm", "the ring"; not "your hounds").
  const words = [...s.matchAll(/\S+/g)];
  for (let k = 2; k <= Math.min(6, words.length); k++) {
    const w = words[words.length - k];
    if (!/^(?:this|these|that|those|the|both|either)$/i.test(w[0])) continue;
    const phrase = s.slice(w.index);
    return isItemPhrase(phrase) && namesItem(phrase, own) ? pick('item', w.index ?? 0) : null;
  }
  return null;
}

/**
 * Who a bonus at `at` is given to (D4): its clause's subject must be you ("you", "you and your allies"), the wearer
 * ("the wearer", "its bearer") or the item ("this cloak", "it", "the <item's own noun>", "a magic Quarterstaff that"
 * the item is wielded as), right before its verb ("gain", "has", "grants"; "also" may stand between, and a
 * parenthetical, `paren`), and the item may give it only to you or the wearer ("grants you", "grants its wearer"); you
 * and the wearer receive it ("gain", "have"), the item gives it ("grants"; "has" only its own attack and damage rolls). A
 * bonus listed after another benefit takes that benefit's verb. Anything else is another creature's, or a shape the
 * reader doesn't know: null, so it isn't applied (fail closed).
 */
function subjectOf(sentence: string, at: number, own: ReadonlySet<string>, weaponTargets = false): Subject | null {
  let pre = sentence.slice(0, at);
  let verb = VERB_AT_END.exec(pre);
  if (!verb && COORDINATED.test(pre)) {
    const earlier = lastMatch(pre.replace(COORDINATED, ''), VERB_G);
    // The words between that verb and the bonus are other benefits (I10), not "your choice of", "either" or a condition.
    if (earlier && benefitsBefore(pre.slice((earlier.index ?? 0) + earlier[0].length), own)) {
      pre = pre.slice(0, (earlier.index ?? 0) + earlier[0].length);
      verb = VERB_AT_END.exec(pre);
    }
  }
  if (!verb) return null;
  let s = pre.slice(0, verb.index).replace(ADVERBS_AT_END, '');
  let paren = '';
  const p = PAREN_AT_END.exec(s);
  if (p) {
    paren = p[1];
    s = s.slice(0, p.index);
  }
  const subject = subjectAtEnd(s, own);
  if (!subject) return null;
  // Who has it: you or the wearer gain, have, get or receive it; the item grants, gives or confers it, and "has" one
  // only for its own attack and damage rolls ("This weapon has a +1 bonus to attack rolls…"; an item that "has" or
  // "gains" a bonus to AC or saving throws is an object's, as "it gains" after another creature is that creature's).
  const word = verb[0].trim().split(/\s+/)[0].toLowerCase();
  const receives = RECEIVING.test(word);
  // An item phrase "has" a bonus (I11: "This armor has a +1 bonus to Armor Class"); a bare "it has" only for its own attack and damage rolls.
  const phrase = !/^(?:it|them)$/i.test(s.slice(subject.from).trim());
  if (subject.kind === 'item' ? receives && !(/^ha(?:s|ve)$/.test(word) && (weaponTargets || phrase)) : !receives) return null;
  return { ...subject, paren, to: verb.index };
}
/**
 * Whether the words between a verb and a bonus listed after it are other benefits of that verb (I10): "you gain [Resistance
 * to Cold damage and] a +1 bonus…", "you gain [a +1 bonus to Armor Class while you wear this cloak, and] a +1 bonus…";
 * each perhaps with its always-on phrases, joined by ",", "and", "as well as" or "plus".
 */
function benefitsBefore(text: string, own: ReadonlySet<string>): boolean {
  let rest = text.replace(/^\s+(?:you(?:\s+and\s+[^,]{1,40}?)?\s+|(?:the|its|their)\s+(?:wearer|bearer|wielder)\s+)?/i, ' ').replace(/(?:^|\s)(?:an?|additional|extra)\s*$/i, ' ');
  for (let i = 0; i < 8; i++) {
    const t = rest.replace(/^\s+/, '');
    const n = benefitAt(t);
    if (!n) return false;
    rest = t.slice(n);
    for (let k = 0; k < 3; k++) {
      const u = rest.replace(/^[\s,]+/, '');
      const h = held(u, own, HELD_WEAPON);
      if (!h) break;
      rest = u.slice(h);
    }
    const join = /^\s*(?:,\s*(?:and\s+|as\s+well\s+as\s+|plus\s+)?|\s+(?:and|as\s+well\s+as|plus)\s+)/i.exec(rest);
    if (!join) return false;
    rest = rest.slice(join[0].length);
    if (!rest.trim()) return true;
  }
  return false;
}

/** Verbs by which the subject itself has the bonus ("you gain", "the wearer has"), not gives it. */
const RECEIVING = /^(?:gain|gains|have|has|get|gets|receive|receives|enjoy|enjoys)$/;

/** Whether a text opens with a subject the reader knows (you, it, they, the wearer, the item), perhaps after a connective. */
const PRONOUN_SUBJECT = /^(?:you(?:'(?:re|ll|d|ve))?|it|they|(?:the|its)\s+(?:wearer|bearer|wielder|user))(?![\p{L}'-])/iu;
function startsWithSubject(text: string, own: ReadonlySet<string>): boolean {
  const t = withoutConnective(text.trimStart());
  if (PRONOUN_SUBJECT.test(t)) return true;
  const m = ITEM_AT_START.exec(t);
  return m !== null && namesItem(m[1], own);
}

/**
 * The lead-in of a bonus's clause (D3): everything between the clause's start and its subject (`before`: the
 * sentence up to the subject), whatever word starts it and with or without a comma ("Between dusk and dawn", "By
 * moonlight", "Under a full moon", "…, and by night"). After an earlier main clause (", you …", or a sentence that
 * opens with its subject), it runs from where that clause ends (its last ", and", ", but", ", or", ";" or bare
 * "and") to the subject, and is empty when the clause follows it directly ("…, and you gain", "…, you gain"). With
 * no earlier main clause, it is the sentence's whole opening ("While you wear it, carry it, or hold it").
 */
function leadInOf(before: string, own: ReadonlySet<string>): string {
  if (AFTER_MAIN_BREAK.test(before)) return '';
  const b = before.replace(/[\s,]+$/, '');
  const earlier = lastMatch(b, /,\s+(?:you(?:'(?:re|ll|d|ve))?|it|they)\s/gi);
  if (!earlier && !startsWithSubject(b, own)) return b.trim();
  const clause = earlier ? b.slice((earlier.index ?? 0) + earlier[0].length) : b;
  const end = lastMatch(clause, MAIN_BREAK) ?? lastMatch(clause, BARE_BREAK);
  return end ? clause.slice((end.index ?? 0) + end[0].length).trim() : '';
}

/**
 * The openings of a sentence's main clauses before a bonus's subject at `subjectFrom` (I7), which govern the bonus's
 * clause when it has no lead-in of its own ("While underwater, you can breathe, and you gain…"): each main clause (the
 * sentence, or what follows ";" or ", and/but/or") that opens with a preposition or a subordinator ("By", "Between",
 * "Under", "After", "In", "At", "While", "When", "If", "Until", "Once", "As long as", …), or with one word and a comma
 * ("Underwater, …"), has an opening: to its first comma ("Between dusk and dawn, its runes glow, and you gain…"), or
 * with no comma, to the clause's end or the bonus's subject ("By night ravens circle the cloak, and it grants…", "By
 * night the runes glow and you gain…"). An always-on phrase there is such an opening, and holds ("While you wear these
 * boots, your steps make no sound, and you gain…", "When worn, its hood hides your face, and you gain…"); a clause
 * that opens with its subject has none ("Its blade is etched with runes, and you gain…").
 */
function openingsOf(sentence: string, subjectFrom: number): string[] {
  const head = sentence.slice(0, subjectFrom);
  const out: string[] = [];
  const breaks = execAll(MAIN_BREAK, head);
  const starts = [0, ...breaks.map((m) => m.index + m[0].length)];
  starts.forEach((from, k) => {
    const end = k < breaks.length ? breaks[k].index : head.length;
    const clause = withoutConnective(head.slice(from, end).trimStart());
    if (!OPENS_CLAUSE.test(clause)) return;
    const [first, ...parts] = clause.split(/,\s+/);
    const opening = first.replace(/[\s,]+$/, '').trim();
    if (opening) out.push(opening);
    // J4: every lead-in after it before the clause's main subject is an opening of its own ("While you wear this cloak, if
    // you are Bloodied, you can't be Frightened, and…", "When worn, at night, its hood…"); an aside goes on past it.
    for (const raw of parts) {
      const part = raw.replace(/[\s,]+$/, '').trim();
      if (part === '' || withoutConnective(part).trim() === '' || ASIDE_WORDS.test(part)) continue;
      if (!LEAD_PART.test(part) && !loneCondition(part)) break;
      out.push(part);
    }
  });
  return out;
}
/** A time a phrase recurs at, as an opening (J4): "Each night", "Every dawn", "Each time you…". */
const EACH_TIME = String.raw`(?:each|every)\s+(?:other\s+)?(?:night|day|dawn|dusk|morning|evening|afternoon|midnight|noon|sunrise|sunset|round|turn|minute|hour|week|month|year|season|time|full\s+moon|new\s+moon|(?:long\s+|short\s+)?rest)s?`;
/** An inverted condition (J4): "should you become Bloodied", "were you to fall", "had it…". */
const INVERSION = String.raw`(?:should|were|had)\s+(?:you|it|they|the|this|your|its|their)`;
/** A clause that opens with a preposition, a subordinator or a condition adverb, "Each/Every <time>", or with one word before a comma (I7, J4). */
const OPENS_CLAUSE = new RegExp(String.raw`^(?:${OPENER_WORD}${WORD_END}|${EACH_TIME}${WORD_END}|${INVERSION}${WORD_END}|[\p{L}'-]+,\s)`, 'iu');
/** A lead-in after an opening's comma (J4): it opens with a preposition, a subordinator, "even if" or "Each/Every <time>". */
const LEAD_PART = new RegExp(String.raw`^(?:${OPENER_WORD}|even\s+(?:if|when|though)|${EACH_TIME}|${INVERSION})${WORD_END}`, 'iu');
/** Words that only stand aside in a sentence ("of course", "in turn", "too"), never a lead-in or a main clause. */
const ASIDE_WORDS = /^(?:of\s+course|in\s+turn|as\s+well|too|naturally|indeed|alas|unfortunately|fortunately|though|thus|then)$/i;
/** A lone condition word or phrase as a lead-in (J4): a few words with a condition word and no subject ("raging alone", "two-handed"). */
const loneCondition = (part: string) => part.split(/\s+/).length <= 4 && CONDITION_WORD.test(part) && !/(?<![\p{L}'-])(?:you|it|they|its|your|their|this|these|the)(?![\p{L}'-])/iu.test(part);

/**
 * Whether what follows an always-on phrase (or a benefit) keeps it always on (I8, I9): nothing, a concession ("even if
 * you are Unconscious"), "too", "(in addition to the Shield's normal bonus)", or another benefit ("as well as Resistance to
 * Cold damage", "and Advantage on…", "and spell attack rolls"; benefitAt) with nothing after it but more of the same and
 * always-on phrases (tailHolds, with `own`). Anything else is a condition ("…while you wear this cloak and are
 * Invisible", "…this staff upright", "…as well as the matching boots", a second object of wear or hold; "…and
 * Resistance to Cold damage between dusk and dawn"): a list of what is harmless, not of conditions.
 */
function harmlessAfter(rest: string, own?: ReadonlySet<string>, weapon = false): boolean {
  // A pointer to elsewhere in the book ("(see the table)", "(described below)") says nothing about when.
  let r = rest.replace(/\s*\((?:see|described|detailed|shown|listed)\b[^()]{0,60}\)/gi, '').replace(/^[\s,]+|[\s,.;:!)"”']+$/g, '');
  // One benefit after another, each perhaps with its always-on phrases (with `own`); a long run fails closed.
  for (let step = 0; step < 16; step++) {
    if (r === '' || /^(?:as well|too|also)$/i.test(r)) return true;
    const concession = /^even if\b(.*)$/is.exec(r);
    if (concession) return !CONDITION_WORD.test(concession[1]) && !MORE_CONDITIONS.test(concession[1]);
    // "(in addition to the Shield's normal bonus)", "in addition to its other properties": a benefit beside it, never another object (I9).
    const addition = /^\(?\s*in addition to\s+([^()]*)/is.exec(r);
    if (addition) {
      const n = benefitAt(addition[1]) || BENEFIT_NP.exec(addition[1])?.[0].length || 0;
      if (!n || !harmlessAfter(addition[1].slice(n), own, weapon)) return false;
      r = r.slice(addition[0].length);
    } else {
      // "as well as Resistance to Cold damage", "and Advantage on…", "and spell attack rolls" (I8, I9).
      const join = /^(?:as\s+well\s+as|and|plus)\s+/i.exec(r);
      const n = join ? benefitAt(r.slice(join[0].length)) : 0;
      if (!join || !n) return false;
      r = r.slice(join[0].length + n);
    }
    if (own) r = withoutHeld(r, weapon, own);
    r = r.replace(/^[\s,)]+/, '');
  }
  return false;
}

/** Words of a benefit's object (I8): never a condition word, a joining word or another benefit's head. */
const OBJECT_WORD = String.raw`(?!(?:while|whilst|when|whenever|if|unless|until|till|in|at|by|on|during|after|before|between|under|over|within|without|beneath|upon|only|except|as|so|that|which|who|whose|where|near|inside|outside|throughout|once|provided|providing|from|underwater|underground|outdoors|indoors|aloft|afloat|mounted|alone|overhead|and|or|but|plus|nor|then|you|your|it|its|they|their|Advantage|Disadvantage|Resistance|Immunity|Vulnerability|proficiency)${WORD_END})(?!an?\s+\+\d)[\p{L}\d'’()-]+`;
const OBJECT = String.raw`${OBJECT_WORD}(?:(?:\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+|\s+)${OBJECT_WORD}){0,7}`;
/** The object of a check or a save it raises ("Dexterity (Stealth) checks", "saving throws against being Frightened"). */
const ROLLS = String.raw`(?:${OBJECT_WORD}\s+){0,3}?(?:checks?|saving\s+throws?|throws?|rolls?|tests?|Initiative)(?:\s+(?:against|to\s+(?:avoid|resist|end|escape))\s+(?:being\s+)?${OBJECT})?`;
/**
 * A benefit at a text's start (I8, I9): a "+N bonus to …", Advantage on checks or saves (perhaps "against …"), Resistance,
 * Immunity or Vulnerability to …, proficiency with or in …, more rolls ("spell attack rolls"), a Speed or a sense ("a Swim
 * Speed equal to your Speed", "Darkvision out to 60 feet"); its length, or 0.
 */
const BENEFIT_AT = new RegExp(
  String.raw`^(?:(?:an?\s+)?(?:additional\s+|extra\s+)?\+\s?\d(?!\d)(?:\s+bonus)?\s+to\s+(?:all\s+)?(?:your\s+)?(?:AC|Armor Class|attack(?:\s+rolls)?|damage(?:\s+rolls)?|saving throws|ability checks|spell\s+attack\s+rolls)(?:(?:,\s*|\s+and\s+|,\s+and\s+)(?:to\s+)?(?:AC|Armor Class|attack(?:\s+rolls)?|damage(?:\s+rolls)?|saving throws|ability checks|spell\s+attack\s+rolls))*(?:\s+against\s+${OBJECT})?|(?:Advantage|Disadvantage)\s+on\s+${ROLLS}|(?:Resistance|Immunity|Vulnerability)\s+to\s+(?:being\s+)?${OBJECT}|proficiency\s+(?:with|in)\s+${OBJECT}|(?:to\s+)?${ROLLS}|(?:an?\s+)?(?:Climb|Fly|Swim|Burrow|Climbing|Flying|Swimming|Burrowing|walking)\s+Speed\s+(?:equal\s+to\s+your\s+(?:walking\s+)?Speed|of\s+\d+\s+feet)|(?:Darkvision|Blindsight|Tremorsense|Truesight)\s+(?:with\s+a\s+range\s+of|out\s+to|of)\s+\d+\s+feet)`,
  'iu',
);
const benefitAt = (text: string) => BENEFIT_AT.exec(text)?.[0].length ?? 0;
/** A bonus or a benefit named beside the item's (I9): "the Shield's normal bonus (to AC)", "its other properties". */
const BENEFIT_NP = /^(?:the|its|your|their|a|an|this|that)\s+(?:[\p{L}'’-]+\s+){0,3}?(?:bonus(?:es)?|benefits?|propert(?:y|ies)|protection)(?:\s+to\s+(?:your\s+)?(?:AC|Armor Class|saving throws|attack rolls|damage rolls))?/iu;

const HELD = [ALWAYS_ON_AT_START, NO_ARMOR_AT_START];
const HELD_WEAPON = [...HELD, WEAPON_USE];
const HELD_LEAD = [...HELD, PLACE_AT_START];

/**
 * The length of an always-on or no-armor phrase (for attack and damage rolls, also WEAPON_USE; for a lead-in, also
 * where the item is, PLACE_AT_START) that opens a text, when its item phrases name the item (namesItem); 0 when
 * there's none.
 */
function held(text: string, own: ReadonlySet<string>, list = HELD): number {
  for (const re of list) {
    const m = re.exec(text);
    if (m && namesAll(m.slice(1), own)) return m[0].length;
  }
  return 0;
}

/** Whether a clause leading into a bonus keeps it always on: the item worn, held or attuned (harmlessAfter), where it is ("In your hands"), "In addition", "Even if…", or the no-armor condition the app models. */
function leadInHolds(lead: string, own: ReadonlySet<string>): boolean {
  const rest = withoutConnective(lead.replace(/[‘’]/g, "'")).trim();
  if (rest === '') return true;
  // "Even if you are Prone", "Whatever its gem", "Regardless of its color": every case, no condition.
  const concession = /^(?:even\s+(?:if|when|whenever|while|whilst|though|in|at|on|underwater|under|during|after|before|without|with|by)|whatever|whichever|regardless\s+of|no\s+matter|whether\s+or\s+not|at\s+all\s+times|in\s+any\s+light)\b(.*)$/is.exec(rest);
  if (concession) return !CONDITION_WORD.test(concession[1]);
  const n = held(rest, own, HELD_LEAD);
  return n > 0 && harmlessAfter(rest.slice(n));
}

/**
 * Whether what follows a bonus's targets in its own benefit keeps it whole: always-on and no-armor phrases,
 * and for attack and damage rolls "made with this magic weapon", "with these arrows" or "you make with it",
 * then a harmless leftover. Anything else names which rolls or saves it is for, or when ("saving throws made
 * to maintain Concentration", "saving throws to end the Charmed condition", "ability checks and saving throws
 * that use Strength", "damage rolls made with such weapons", "attack rolls made with the torch"): fail closed.
 */
function tailHolds(tail: string, weapon: boolean, own: ReadonlySet<string>): boolean {
  return harmlessAfter(withoutHeld(tail, weapon, own), own, weapon);
}
/** A text without the always-on and no-armor phrases (and, for attack and damage rolls, "made with this weapon") that open it. */
function withoutHeld(text: string, weapon: boolean, own: ReadonlySet<string>): string {
  let rest = text;
  for (let i = 0; i < 4; i++) {
    const t = rest.replace(/^[\s,]+/, '');
    const n = held(t, own, weapon ? HELD_WEAPON : HELD);
    if (!n) break;
    rest = t.slice(n);
  }
  return rest;
}

/**
 * Whether a later clause of the sentence limits the bonus before it: one that goes on with the bonus's own
 * clause, opening with "only", "not", "except", "though" or a condition word (", but only while you are in Dim
 * Light", ", and only against spells", ", or in Dim Light"; an always-on alternative holds: ", or while you hold
 * it"), one about the bonus that limits it ("; the bonus applies only while you are Bloodied", "; it doesn't work
 * underwater"), one that loses it (", but you lose it while Bloodied", "…lose this benefit…"), or ", which…" right
 * after the bonus that names a condition (", which works only in dim light"; one after something else counts only
 * with "only"). A new main clause ("…, and you have Resistance to Cold damage while you are Bloodied") and the
 * lead-in of one ("…, and while you are Bloodied, you have…") are their own.
 */
function laterClauseLimits(sentence: string, matchEnd: number, clauseEnd: number, own: ReadonlySet<string>): boolean {
  const rest = sentence.slice(clauseEnd);
  const breaks = execAll(CLAUSE_BREAK, rest);
  const rightAfter = sentence.slice(matchEnd, clauseEnd).trim() === '';
  return breaks.some((b, i) => {
    const from = (b.index ?? 0) + b[0].length;
    const next = breaks[i + 1];
    const text = rest.slice(from, next?.index ?? rest.length).trim();
    if (LOSES_IT.test(text) || limitsBonus(text, own)) return true;
    if (next && /^,\s+you\s+$/i.test(next[0])) return false;
    if (/^,\s+(?:which|whose)\s+$/i.test(b[0])) return i === 0 && rightAfter ? limits(text, 0, own) : /\bonly\b/i.test(text);
    if (GOES_ON.test(text) || ((GOES_ON_IF.test(text) || CONDITION_WORD.exec(text)?.index === 0) && !NEW_CLAUSE.test(text))) {
      const n = held(text, own);
      return !(n > 0 && harmlessAfter(text.slice(n)));
    }
    return false;
  });
}

/**
 * Whether a bonus holds only in some situations (see SITUATIONAL), by grammar that fails closed: its subject must be
 * you, the wearer or the item, giving it to you (subjectOf, D4); its clause's lead-in, a parenthetical after its
 * subject, and the sentence's opening when the clause has no lead-in of its own, must each say the item is worn, held,
 * carried or attuned, or where it is (leadInHolds, D3); what follows its targets must keep it whole (tailHolds); no
 * later clause may limit it (laterClauseLimits); and what remains of its clause, once its always-on phrases are taken
 * out, must name no condition (SITUATIONAL). An always-on phrase in the clause with more after it ("…when you wield
 * this weapon with two hands") holds only then, and so does one about another object ("while you hold the torch").
 */
function situationalIn(sentence: string, c: Clause, at: number, length: number, weapon: boolean, own: ReadonlySet<string>): boolean {
  if (EXAMPLE.test(sentence) || AGAINST.test(c.own)) return true;
  const subject = subjectOf(sentence, at, own, weapon && !targetsOf(sentence.slice(at, at + length)).some((t) => t === 'ac' || t === 'savingThrows'));
  if (!subject) return true;
  if (subject.paren && !leadInHolds(subject.paren, own)) return true;
  const lead = leadInOf(sentence.slice(0, subject.from), own);
  const leads = lead ? [lead] : [];
  // A connective or a concession sets no condition of its own ("…, and in addition, you…"): the openings still govern (I7).
  if (!lead || /^(?:even if\b|$)/i.test(withoutConnective(lead).trim())) leads.push(...openingsOf(sentence, subject.from).filter((o) => o !== lead));
  if (leads.some((l) => !leadInHolds(l, own))) return true;
  if (!tailHolds(sentence.slice(at + length, c.ownTo), weapon, own)) return true;
  // What follows the clause's last benefit is the whole clause's (I8): "…a +1 bonus to Armor Class and Resistance to Cold
  // damage between dusk and dawn", "…and a +1 bonus to saving throws by night" hold only then; more benefits, always-on
  // phrases and "made with this weapon" keep it whole.
  if (c.ownTo < c.end && !harmlessAfter(sentence.slice(c.ownTo, c.end), own, weapon)) return true;
  // A bonus under "either", "your choice of", "choose" or "one of the following" in its clause is one alternative (I10).
  if (CHOICE.test(c.text.slice(0, Math.max(0, at - (c.end - c.text.length)))) || /\beither\b/i.test(sentence.slice(Math.max(0, at - 60), at))) return true;
  if (laterClauseLimits(sentence, at + length, c.end, own)) return true;
  let conditional = false;
  const judge = (phrase: string, ...args: unknown[]) => {
    // The arguments after the match: its item phrases (capture groups), then the offset and the whole text.
    const i = args.findIndex((a) => typeof a === 'number');
    const offset = args[i] as number;
    const whole = args[i + 1] as string;
    // Another object worn or held: its "while" stays, a condition.
    if (!namesAll(args.slice(0, i), own)) return phrase;
    const before = withoutConnective(whole.slice(0, offset).trim());
    const after = whole.slice(offset + phrase.length);
    // Opening the clause: the main clause must follow ("When worn, this ring…"), not more of the condition ("When worn by a Paladin, …").
    if (before === '') conditional ||= !/^\s*(?:,|$|you\b|this\b|the\b|it\b|these\b)/i.test(after);
    // Set off by commas, the clause goes on after it ("This ring, while worn, grants…").
    else conditional ||= !harmlessAfter(after) && !(before.endsWith(',') && /^\s*,/.test(after));
    return ' ';
  };
  // The subject's own words after its first are no condition ("you and allies within 10 feet of you gain…").
  const start = c.end - c.text.length;
  const head = subject.from + (/^\S+/.exec(sentence.slice(subject.from))?.[0].length ?? 0);
  const clause = subject.to > start && head < subject.to ? `${c.text.slice(0, Math.max(0, head - start))}${' '.repeat(subject.to - Math.max(start, head))}${c.text.slice(subject.to - start)}` : c.text;
  const text = clause.replace(ALWAYS_ON_ANYWHERE, judge).replace(NO_ARMOR_ANYWHERE, judge);
  return conditional || SITUATIONAL.test(text) || IF.test(text);
}

/** One piece of an item's prose (a paragraph, or one variant's part of one), as pieces() reads it. */
interface Piece {
  text: string;
  /** One variant's, for bonuses. */
  variant: boolean;
  /** One variant's, for charges (after the last variant, "Each ring …" is the item's again). */
  variantCharges: boolean;
  /** The variant run-in it belongs to (its piece's index), or -1. */
  variantOf: number;
  /** Its own run-in label, if any (not a variant's). */
  label: string | null;
  /** The labels that govern it (I3): a piece that is only a label's (a heading, a bold line, a PDF column's end) that can limit it, and its own. */
  labels: string[];
  /** A list item, or a run-in (a label or a variant's), or what a piece that is only a label governs. */
  runIn: boolean;
  /** Only a label (labelAlone), or only a variant's name: no text of its own. */
  alone: boolean;
}

/**
 * An item's prose in pieces, each marked when it is one variant's: from a variant's run-in (or its name alone, as a
 * heading or a bold line, I6) on, the text is that variant's (split off where a PDF joined several into one
 * paragraph), until a paragraph about every kind of the item ("Whatever its gem, …", "Each kind of …", "Each of them
 * …"). `variant` is for bonuses; `variantCharges` is for charges, where after the last variant a paragraph about every
 * one of the item ("Each ring …", "Every staff …", "Each such ring …", "Each one …", "These boots …"; not "Each time
 * …") or about "the ring" or "this cloak" is the item's again ("Each ring has 3 charges.", "The ring has 3 charges."),
 * by the list's nouns and the item's own. A variant's own paragraphs often open the same way ("The shield grants…"),
 * so for bonuses they stay the variant's. A piece that is only a label (a heading, a bold line, a label a PDF column
 * ended after) governs the next piece (I3): that piece takes its label and is a run-in.
 */
function pieces(paragraphs: readonly string[], nouns: readonly string[], ownForms: ReadonlySet<string> = new Set()): Piece[] {
  const own = ownOpenersFor(nouns);
  const split = paragraphs.flatMap((p) => (RARITY_PAREN.test(p) ? p.split(AT_VARIANT) : [p]));
  const last = split.reduce((at, text, i) => (startsVariant(text) ? i : at), -1);
  // A variant's own name ("Sapphire (Very Rare). …"): "The sapphire has 3 charges." after it is that variant's.
  const variantWords = new Set(split.flatMap((text) => (startsVariant(text) ? variantName(text).split(/\s+/).flatMap(forms) : [])));
  const aboutItem = (text: string) => {
    if (EVERY_ONE.test(text)) return true;
    const m = EVERY_ITEM.exec(text) ?? ABOUT_ITEM.exec(text) ?? own?.every.exec(text) ?? own?.about.exec(text);
    return !!m && !variantWords.has(m[0].trim().split(/\s+/).pop()?.toLowerCase().replace(/'s$/, '') ?? '');
  };
  let variant = false;
  let variantCharges = false;
  let variantOf = -1;
  let pending: string[] = [];
  let governNext = false;
  return split.map((text, i): Piece => {
    const starts = startsVariant(text);
    if (starts) {
      variant = variantCharges = true;
      variantOf = i;
      pending = [];
    } else if (WHOLE_ITEM.test(text)) {
      variant = variantCharges = false;
      variantOf = -1;
    } else if (i > last && aboutItem(text)) variantCharges = false;
    const alone = starts ? null : labelAlone(text, split[i - 1] ?? '', split[i + 1] ?? '');
    const label = starts ? null : (alone ?? runInLabel(text));
    const labels = [...pending, ...(label !== null ? [label] : [])];
    const governedByLabel = governNext;
    // A label alone, or a run-in label a column ended a paragraph with ("…out to 60 feet. Pressure Ward." | "You have…"), governs the next piece.
    const trailing = alone === null && !starts && i + 1 < split.length ? trailingLabel(text) : null;
    // What a chain of labels alone passes on is only what can limit (G3): its first failing label, and the no-armor ones.
    governNext = alone !== null || trailing !== null;
    pending = alone !== null ? passedOn(labels, ownForms) : trailing !== null ? [trailing] : [];
    const isAlone = alone !== null || (starts && !VARIANT_RUN_IN.test(text));
    return { text, variant, variantCharges, variantOf: variant ? variantOf : -1, label, labels, runIn: starts || label !== null || governedByLabel || LIST_ITEM.test(text), alone: isAlone };
  });
}

/** The no-armor condition a label or an intro that holds by it sets for its piece's bonuses ("If you wear no armor:", "**While Wearing No Armor**", J1), with one set already. */
const armorOf = (label: string, set: AcCondition | undefined): AcCondition | undefined => (NO_ARMOR.test(label) ? stricter(NO_SHIELD.test(label) ? 'no-armor-no-shield' : 'no-armor', set) : set);
/** The labels a label alone passes on to the piece after it (G3): its first failing label, and those that set the no-armor condition. */
function passedOn(labels: readonly string[], own: ReadonlySet<string>): string[] {
  const failing = labels.find((l) => !labelHolds(l, own));
  const armor = [...new Set(labels.filter((l) => l !== failing && NO_ARMOR.test(l)))];
  return [...(failing !== undefined ? [failing] : []), ...armor];
}

/** The intros of an item's pieces (D1, I4): what governs each piece, each intro's own failing sentence, and what each intro offers. */
interface Intros {
  /** For each piece, the sentence of an intro that doesn't hold and governs it. */
  governed: (string | null)[];
  /** For an intro's own piece, its sentence and where it stands, when it doesn't hold. */
  self: (readonly [number, string] | null)[];
  /** For an intro's own piece, the pieces it offers, whether or not it holds (I4). */
  range: (readonly number[] | null)[];
  /** For each piece, the intro piece that offers it, or -1. */
  offeredBy: number[];
  /** For each piece, the labels of the pieces that are only a label (a heading, a bold line, a label a column ended after) whose range it is in (J1). */
  labels: string[][];
  /** For each piece, the no-armor condition an intro that holds by it sets for what it offers ("If you wear no armor, you gain the following benefits:"). */
  noArmor: (AcCondition | undefined)[];
}

/**
 * The intros of an item's pieces (D1, I4, I6): an intro is a piece with a sentence that offers what follows (INTRO_OFFER,
 * the last such, or a last one that ends with ":"; fail closed, as "…, you gain the following benefits. Each lasts
 * until…" still offers them). It offers the run-in and list pieces after it, up to the first that is neither (after
 * "the following …", "…below", "as follows" or a ":", the piece right after it whatever it is; after one of those
 * followed by a paragraph that is neither a list item nor a run-in, which a list that lost its bullets to a PDF looks
 * like, every piece up to the next intro). One that doesn't hold governs what it offers, and the rest of its own piece:
 * each bonus there is judged with what is left of the intro once its offer is taken out (introHolds). "While you are
 * underwater, you gain the following benefits." makes them hold only underwater; "While wearing this cloak, you gain the
 * following benefits." keeps them always on, though a limit in its paragraph still reaches them (I4, limited).
 */
function introsOf(list: readonly Piece[], own: ReadonlySet<string>): Intros {
  const governed: (string | null)[] = list.map(() => null);
  const offeredBy = list.map(() => -1);
  const intro = list.map((piece): readonly [number, string] | null => {
    if (piece.alone) return null;
    const sentences = sentencesOf(piece.text);
    const last = sentences.length - 1;
    if (/:\s*$/.test(sentences[last])) return [last, sentences[last]];
    for (let i = last; i >= 0; i--) if (INTRO_OFFER.test(sentences[i])) return [i, sentences[i]];
    return null;
  });
  // A piece that is only a label and its ":" ("Benefits:", "While raging:", "While attuned:") holds as a label does (J1: always-on labels hold).
  const colonLabel = (text: string) => {
    const t = text.trim();
    if (!/:$/.test(t) || t.length > 80 || /[.!?:]\s/.test(t) || LIST_ITEM.test(t)) return null;
    const bare = t.slice(0, -1).trim();
    // Only a label that names what follows ("Benefits:", "Magical Properties:") or an always-on or no-armor phrase; any other is judged as an intro (fail closed: "Wild Shape:", "Versus Fiends:").
    return runInLabel(`${bare}. A`) === bare && (OFFER_LABEL.test(bare) || leadInHolds(bare, own) || NO_ARMOR.test(bare)) ? bare : null;
  };
  const self = intro.map((it, i) => {
    if (!it) return null;
    const label = colonLabel(list[i].text);
    return (label !== null ? labelHolds(label, own) : introHolds(it[1], own)) ? null : it;
  });
  const range = intro.map((it, i): readonly number[] | null => {
    if (!it) return null;
    const sentence = it[1];
    // What "the following …", "…below" or a ":" offers starts right after it, whatever its form ("these benefits" may look back instead).
    const forward = /:\s*$/.test(sentence) || FORWARD_OFFER.test(sentence);
    const next = list[i + 1];
    // A list a PDF printed without its bullets can't be told from the prose after it: after a ":" whose next paragraph
    // isn't a marked list item, or an intro whose next paragraph is neither a list item nor a run-in, every paragraph up
    // to the next intro is what it offers (fail closed, I6).
    const unmarked = next !== undefined && !LIST_ITEM.test(next.text) && (/:\s*$/.test(sentence) || !next.runIn);
    const out: number[] = [];
    let j = i + 1;
    for (; j < list.length && ((forward && j === i + 1) || list[j].runIn || (unmarked && intro[j] === null)); j++) out.push(j);
    // O5: one that doesn't hold, or holds by the no-armor condition, goes on past plain paragraphs that another run-in, list
    // item or heading follows (a run-in's or a list item's second paragraph), up to the next intro, variant or whole-item paragraph.
    if (self[i] || NO_ARMOR.test(sentence)) {
      for (let k = j; k < list.length && intro[k] === null && !startsVariant(list[k].text) && !WHOLE_ITEM.test(list[k].text); k++) {
        if (!list[k].runIn) continue;
        for (; j <= k; j++) out.push(j);
      }
    }
    return out;
  });
  const noArmor = list.map((): AcCondition | undefined => undefined);
  range.forEach((r, i) => {
    const sentence = intro[i]?.[1] ?? '';
    // An intro that holds by the no-armor condition ("If you wear no armor, you gain the following benefits:") sets it for what it offers.
    const armor: AcCondition | undefined = !self[i] && NO_ARMOR.test(sentence) ? (NO_SHIELD.test(sentence) ? 'no-armor-no-shield' : 'no-armor') : undefined;
    for (const j of r ?? []) {
      if (offeredBy[j] === -1) offeredBy[j] = i;
      if (self[i]) governed[j] ??= self[i]?.[1] ?? null;
      if (armor) noArmor[j] = stricter(armor, noArmor[j]);
    }
  });
  // J1: a piece that is only a label (a heading, a bold line, a label a column ended after) governs as an intro does: the
  // next piece, then every list item or run-in after it; after an unmarked paragraph, every piece up to the next intro,
  // label alone or variant. A variant's name alone is that variant's run-in instead.
  const labels: string[][] = list.map(() => []);
  list.forEach((piece, i) => {
    const label = piece.alone ? piece.label : null;
    const next = list[i + 1];
    if (label === null || next === undefined) return;
    const unmarked = !LIST_ITEM.test(next.text) && next.label === null && !next.alone;
    // A run-in label a column ended after ("Night Sight." alone: not a heading, nor a bold line or a heading printed plain,
    // which has no period) governs its own text only, up to the next run-in.
    const cut = !HEADING_PARA.test(piece.text) && /\.\s*$/.test(piece.text);
    let j = i + 1;
    for (; j < list.length; j++) {
      const p = list[j];
      if (j > i + 1 && (p.alone || startsVariant(p.text) || (unmarked ? intro[j] !== null || (cut && p.label !== null) : !p.runIn))) break;
      labels[j].push(label);
    }
    // As O5 for an intro: a label that doesn't hold goes on past plain paragraphs that a list item or run-in follows (a list
    // item's or a run-in's second paragraph), up to the next intro, label alone, variant or whole-item paragraph.
    if (!unmarked && (!labelHolds(label, own) || NO_ARMOR.test(label))) {
      for (let k = j; k < list.length && !list[k].alone && intro[k] === null && !startsVariant(list[k].text) && !WHOLE_ITEM.test(list[k].text); k++) {
        if (!list[k].runIn) continue;
        for (; j <= k; j++) labels[j].push(label);
      }
    }
  });
  return { governed, self, range, offeredBy, labels, noArmor };
}
/** A colon label that only names what follows ("Benefits:", "Magical Properties:", "Attuned Benefits:", "Its Powers:"). */
const OFFER_LABEL = new RegExp(String.raw`^(?:(?:its|their|magic(?:al)?|special|additional|other|attuned|general|item)\s+)?${OFFER_NOUN}$`, 'iu');
/** An offer of what follows (I6): "the following …", "…below", "described / listed below", "as follows". */
const FORWARD_OFFER = /\bthe following\b|\b(?:described|listed|detailed|given|shown|explained)?\s*below\b|\bas follows\b/i;

/** Every "+N bonus to …" phrase of an item's prose (itemParagraphs), judged (readPhrases), kept for the second read. */
function bonusPhrases(paragraphs: readonly string[], nouns: readonly string[], name: string): readonly BonusPhrase[] {
  // Most items state no "+N" at all: nothing to read or limit.
  if (!paragraphs.some((p) => /\+\s?\d/.test(p))) return [];
  const key = `${nouns.join(' ')}\u0001${name}\u0001${paragraphs.join('\u0000')}`;
  const known = phrasesCache.get(key);
  if (known) return known;
  const out = readPhrases(paragraphs, nouns, nameOf(name));
  remember(phrasesCache, key, out);
  return out;
}

/**
 * Every "+N bonus to …" phrase of an item's prose, judged, and every other "+N" a record could be grounded by
 * (LOOSE). A bonus is situational when it is one variant's, when a run-in label limits it (I3) or an intro that doesn't
 * hold governs it (D1, I4), when its own sentence says so (situationalIn), when a restriction on the item in any clause
 * (restrictionsIn, I1) or a sentence about the bonus (referenceLimit, I2) limits it (limited, I4), or when a PDF cut its
 * sentence at a paragraph's end where a sentence can't end (D5: "…a +2 bonus to Armor" is noted, never applied).
 */
function readPhrases(paragraphs: readonly string[], nouns: readonly string[], name: string): BonusPhrase[] {
  const own = ownFormsOf(paragraphs, nouns);
  const list = pieces(paragraphs, nouns, own);
  const intros = introsOf(list, own);
  let out: BonusPhrase[] = [];
  const found: FoundLimit[] = [];
  const withBonus = new Set<number>();
  list.forEach((piece, pi) => {
    // The labels that govern the piece (I3, J1): once one fails, it governs the whole piece; a later one may add a limit, never lift one.
    const labels = [...piece.labels, ...intros.labels[pi]];
    // The first that fails, and the no-armor condition the ones that hold set, kept as labels are added (G3).
    let failing = labels.find((l) => !labelHolds(l, own));
    let armorOnly = labels.reduce<AcCondition | undefined>((a, l) => armorOf(l, a), intros.noArmor[pi]);
    let seen = false;
    const sentences = sentencesOf(piece.text);
    const self = intros.self[pi];
    sentences.forEach((printed, si) => {
      // Judged without its list marker ("- You have a +1 bonus…" opens with its subject).
      const sentence = printed.replace(/[‘’]/g, "'").replace(si === 0 ? LIST_ITEM : /^$/, '');
      // A run-in label a PDF ran into the paragraph ("…to AC. Underwater. You have…") governs what follows it, as one that opens it does.
      if (si > 0 && printed.length <= 90) {
        const mid = midLabel(`${printed} ${sentences[si + 1] ?? ''}`);
        if (mid !== null && printed.startsWith(mid)) {
          failing ??= labelHolds(mid, own) ? undefined : mid;
          armorOnly = armorOf(mid, armorOnly);
        }
      }
      const labelFails = failing !== undefined;
      const label = failing ?? null;
      // An intro that doesn't hold governs the pieces after it, and the rest of its own.
      const governed = intros.governed[pi] ?? (self && si > self[0] ? self[1] : null);
      const strict = new Map<number, BonusTarget[]>();
      let clauseEnd = 0;
      const matches = execAll(BONUS, sentence);
      // A sentence with more bonuses than prose ever lists is no sentence a reader can judge: each is left out (fail closed, G3).
      const crowded = matches.length > MAX_BONUSES;
      for (const m of matches) {
        const at = m.index;
        const targets = targetsOf(m[2]);
        strict.set(at, targets);
        const c = clauseOf(sentence, at, m[0].length);
        clauseEnd = Math.max(clauseEnd, c.end);
        const variant = piece.variant || RUN_BEFORE.test(sentence.slice(0, at));
        const weapon = targets.includes('attack') || targets.includes('damage');
        const itself = variant || crowded || situationalIn(sentence, c, at, m[0].length, weapon, own);
        const situational = itself || labelFails || governed !== null;
        // "…a +5 bonus to your Armor Class against the triggering attack" (a Reaction's, most often): applied when it always holds, else noted only when a record applies it, as LOOSE ones are.
        const yours = /\byour\b/i.test(m[2]);
        // The note quotes what makes it situational: its own sentence, else the intro or the label that governs it.
        const quoted = itself ? printed : governed !== null ? governed : labelFails && !printed.startsWith(label ?? '') ? `${label ?? ''}. ${printed}` : printed;
        const phrase = { n: Number(m[1]), phrase: m[0].trim(), sentence, printed: quoted, variant, piece: pi };
        // The no-armor condition is modelled for Armor Class only: a bonus to anything else it qualifies holds only then.
        const others: BonusTarget[] = NO_ARMOR.test(sentence) || armorOnly ? targets.filter((t) => t !== 'ac') : [];
        if (others.length < targets.length) out.push({ ...phrase, targets: targets.filter((t) => !others.includes(t)), situational, loose: situational && yours, ...(armorOnly ? { acOnly: armorOnly } : {}) });
        if (others.length) out.push({ ...phrase, targets: others, situational: true, loose: yours });
      }
      for (const m of execAll(LOOSE, sentence)) {
        const at = m.index;
        const read = strict.get(at) ?? [];
        const targets = LOOSE_TARGETS.filter(([t, re]) => re.test(m[2]) && !read.includes(t)).map(([t]) => t);
        if (!targets.length) continue;
        const variant = piece.variant || RUN_BEFORE.test(sentence.slice(0, at));
        // A bonus to some saves only is one the app would get wrong: noted even when no record applies it.
        const scoped = targets.includes('savingThrows') && SCOPED_SAVES.test(m[2]);
        out.push({ n: Number(m[1]), targets, phrase: m[0].trim(), sentence, printed, variant, situational: true, loose: !scoped, piece: pi });
        clauseEnd = Math.max(clauseEnd, (m.index ?? 0) + m[0].length);
      }
      const hasBonus = strict.size > 0 || out.some((b) => b.piece === pi && b.sentence === sentence);
      if (hasBonus) withBonus.add(pi);
      // The item restricted in any of the sentence's main clauses (I1), and a sentence about the bonus (D2, I2): the whole
      // of one with no bonus, or what follows the last bonus's clause.
      const ref = hasBonus ? (clauseEnd < sentence.length ? referenceLimit(sentence.slice(clauseEnd), own) : null) : referenceLimit(sentence, own);
      // A table's cells a PDF printed as a line ("Magic | 0 | | Dispel Magic | 3 |") say nothing about a bonus.
      const table = (sentence.match(/\s\|\s/g)?.length ?? 0) >= 2;
      const limitsHere = table ? [] : [...restrictionsIn(sentence, own, name, hasBonus), ...(ref ? [ref] : [])];
      // An alternative to another bonus ("Alternatively, you can have a +1 bonus to saving throws instead."): a choice, so every bonus it stands beside holds only when chosen (O4).
      if (hasBonus && !table && ALTERNATIVE.test(sentence)) limitsHere.push({ scope: 'paragraph', plural: true, bonusRef: true });
      // The first sentence of its piece, after its run-in label if any.
      const opens = !seen && (si === 0 || (si === 1 && piece.label !== null && sentences[0].startsWith(piece.label)));
      for (const limit of limitsHere) found.push({ ...limit, piece: pi, printed, first: opens });
      seen ||= hasBonus;
    });
    // A sentence a PDF cut at the paragraph's end, where a sentence can't end ("…while you hold this", "…a +2 bonus to
    // Armor"), and that nothing joined again: its target, or its condition, may be lost, so its bonuses hold only maybe.
    if (!ENDS_SENTENCE.test(piece.text) && CANT_END.test(piece.text)) {
      const printed = lastSentence(piece.text);
      const sentence = printed.replace(/[‘’]/g, "'");
      out = out.map((b) => (b.piece === pi && b.sentence === sentence ? { ...b, situational: true } : b));
      const cut = CUT_BONUS.exec(piece.text);
      if (cut && !BONUS_AT_END.test(piece.text)) {
        const targets: BonusTarget[] = cut[2] ? ['ac'] : cut[3] ? ['savingThrows'] : ['ac', 'savingThrows', 'attack', 'damage'];
        out.push({ n: Number(cut[1]), targets, phrase: cut[0].trim(), sentence, printed, variant: piece.variant, situational: true, loose: false, piece: pi });
      }
    }
  });
  const walk = walkOf(list, intros, withBonus);
  for (const limit of found) out = limited(out, limit, list, intros, withBonus, walk);
  return out;
}

/** What limited() reads of an item's pieces, found once for all its limits (G3): where each walk back ends, and each intro's offer as a set. */
interface Walk {
  /** For each piece, where the walk back from it past pieces with no bonus and no intro of their own ends (limited). */
  stops: readonly number[];
  /** For each intro piece, the pieces it offers. */
  offers: readonly (ReadonlySet<number> | null)[];
}
/**
 * The walk back from each piece (G3): at the first piece at or before it that has a bonus, is offered or is an intro, at
 * the item's first piece, or at the piece of another variant before the walk's own.
 */
function walkOf(list: readonly Piece[], intros: Intros, withBonus: ReadonlySet<number>): Walk {
  const stops: number[] = [];
  list.forEach((piece, k) => {
    const passes = !withBonus.has(k) && intros.offeredBy[k] < 0 && intros.range[k] === null;
    stops.push(k === 0 || !passes ? k : list[k - 1].variantOf !== piece.variantOf ? k - 1 : stops[k - 1]);
  });
  return { stops, offers: intros.range.map((r) => (r === null ? null : new Set(r))) };
}
/** The most "+N bonus to …" phrases one sentence is judged with. */
const MAX_BONUSES = 24;
/** A limit and where it was found: its piece, its sentence as printed, and whether it opens its piece. */
type FoundLimit = Limit & { piece: number; printed: string; first: boolean };

/**
 * The bonuses with one limit applied (D2, I4): every bonus of the item (of its variant, inside a variant's pieces), with
 * the no-armor condition it sets for AC and the other targets situational; or the bonuses of its piece (only those for
 * its targets when it names some), with:
 * - when its piece is an intro's, every bonus the intro offers ("…you gain the following benefits. They last only while
 *   you are in Dim Light or Darkness.");
 * - when its piece has no bonus of its own and follows run-in or list pieces an intro offered, those pieces, wherever it
 *   stands in its piece (a closing "The shadows are fickle. They work only in Dim Light or Darkness.");
 * - otherwise, when it opens its piece (after its label) with a reference back and no bonus before it, as when a new
 *   paragraph or a PDF's column break parts it from its bonus, the piece before only (so Defender's "The adjusted
 *   bonuses remain in effect until…" never reaches its +3 two paragraphs up);
 * the run-ins it follows found past pieces with no bonus and no intro (a column break that split a closing paragraph);
 * of the same variant. Pure.
 */
function limited(phrases: readonly BonusPhrase[], limit: FoundLimit, list: readonly Piece[], intros: Intros, withBonus: ReadonlySet<number>, walk: Walk): BonusPhrase[] {
  const at = list[limit.piece];
  const sameVariant = (piece: number) => list[piece].variantOf === at.variantOf;
  const offers = walk.offers[limit.piece];
  // A heading, a bold line or a label alone belongs to the paragraph after it (J2): the limit's previous piece is the one before them.
  let prev = limit.piece - 1;
  while (prev >= 0 && list[prev].alone) prev--;
  // The run-ins it follows, past pieces with no bonus and no intro of their own (a PDF's column break inside a closing paragraph).
  const ran = prev < 0 || !sameVariant(prev) ? prev : walk.stops[prev];
  // O3: a limit that opens a piece with no bonus of its own reaches the piece before. Later in that piece, only a reference
  // to a bonus does ("The band is cold to the touch. These bonuses apply only while…"), or, in a plain paragraph, one to a
  // benefit, a protection or a ward; "the effect", "the property" or a pronoun there is the paragraph's own (SRD Cloak of
  // Displacement's "…the property ceases to function…"), and in a run-in's piece so is "this benefit".
  const reaches = limit.first || (limit.scope !== 'item' && !withBonus.has(limit.piece) && (limit.bonusRef === true || (at.label === null && limit.benefitRef === true)));
  // The intro whose run-ins it follows, if any: it reaches every one of them up to where the walk ended; else the piece before.
  const by = !withBonus.has(limit.piece) && ran >= 0 ? intros.offeredBy[ran] : -1;
  const back = by < 0 && reaches ? prev : -1;
  const offered = (piece: number) => offers?.has(piece) === true || (by >= 0 && piece > by && piece <= ran && intros.offeredBy[piece] === by) || (back >= 0 && piece === back);
  const inScope = (b: BonusPhrase) =>
    limit.scope === 'item' ? at.variantOf === -1 || sameVariant(b.piece) : b.piece === limit.piece || (offered(b.piece) && sameVariant(b.piece));
  return phrases.flatMap((b) => {
    if (!inScope(b)) return [b];
    if (limit.scope === 'item' && limit.acOnly) {
      const others = b.targets.filter((t) => t !== 'ac');
      const printed = b.situational ? b.printed : limit.printed;
      const ac: BonusPhrase[] = b.targets.includes('ac') ? [{ ...b, targets: ['ac'], acOnly: stricter(limit.acOnly, b.acOnly), printed }] : [];
      return [...ac, ...(others.length ? [{ ...b, targets: others, situational: true, printed }] : [])];
    }
    const hit = limit.targets ? b.targets.filter((t) => limit.targets?.includes(t)) : b.targets;
    if (!hit.length) return [b];
    const rest = b.targets.filter((t) => !hit.includes(t));
    return [{ ...b, targets: hit, situational: true, printed: b.situational ? b.printed : limit.printed }, ...(rest.length ? [{ ...b, targets: rest }] : [])];
  });
}

/** The item's prose about itself, without its variants' text (where "has N charges" counts for the item). */
export function ownProse(paragraphs: readonly string[], nouns: readonly string[] = []): string {
  return pieces(paragraphs, nouns)
    .filter((p) => !p.variantCharges)
    .map((p) => p.text)
    .join('\n');
}

/** The sentence a phrase stands in, as printed: whole when short, else cut at words around the phrase. */
function around(sentence: string, phrase: string): string {
  if (sentence.length <= 110) return sentence;
  const at = Math.max(0, sentence.indexOf(phrase));
  const from = at > 40 ? sentence.lastIndexOf(' ', at - 35) + 1 : 0;
  const stop = at + phrase.length + 50;
  const to = stop < sentence.length ? Math.max(at + phrase.length, sentence.lastIndexOf(' ', stop)) : sentence.length;
  return `${from > 0 ? '…' : ''}${sentence.slice(from, to).trim()}${to < sentence.length ? '…' : ''}`;
}

/** A bonus the text gives only in some situations, or only for one variant (for a note to check it). */
export interface SituationalBonus {
  n: number;
  targets: BonusTarget[];
  excerpt: string;
  variant: boolean;
  /** Worded so the app never reads it ("+2 bonus to spell attack rolls"): a note only when a record applies it. */
  loose: boolean;
}

/** What the offline reader makes of an item's bonuses: what it always gives (`flat`, and the AC's no-armor condition), and the rest. */
export interface BonusReading {
  flat: Partial<Record<BonusTarget, number>>;
  acCondition: AcCondition;
  /** The sentence that gives the flat AC bonus, as printed (for a note about its condition). */
  acExcerpt: string;
  situational: SituationalBonus[];
}

/** The bonuses of an item's prose (itemParagraphs), as the parser reads them (pure). */
export function bonusReading(paragraphs: readonly string[], nouns: readonly string[] = [], name = ''): BonusReading {
  const phrases = bonusPhrases(paragraphs, nouns, name);
  const b = bonuses(phrases);
  return {
    flat: { ...(b.ac ? { ac: b.ac } : {}), ...(b.save ? { savingThrows: b.save } : {}), ...(b.attack ? { attack: b.attack } : {}), ...(b.damage ? { damage: b.damage } : {}) },
    acCondition: b.condition,
    acExcerpt: b.acExcerpt,
    situational: phrases
      .filter((p) => p.situational)
      .map((p) => ({ n: p.n, targets: p.targets, excerpt: around(p.printed, p.phrase), variant: p.variant, loose: p.loose })),
  };
}

/** The stricter of two no-armor conditions. */
const stricter = (a: AcCondition, b: AcCondition | undefined): AcCondition => (b === 'no-armor-no-shield' || a === 'no-armor-no-shield' ? 'no-armor-no-shield' : b === 'no-armor' || a === 'no-armor' ? 'no-armor' : 'always');

/**
 * Flat bonuses from "+N bonus to …" phrases (the first that states each), leaving out the ones that
 * hold only in some situations and one variant's bonus; bonusText joins every phrase used with "; ".
 */
function bonuses(phrases: readonly BonusPhrase[]): Bonus {
  const out: Bonus = { ac: 0, save: 0, attack: 0, damage: 0, text: '', condition: 'always', acExcerpt: '' };
  const texts: string[] = [];
  for (const b of phrases) {
    if (b.situational) continue;
    let used = false;
    if (b.targets.includes('ac') && !out.ac) {
      out.ac = b.n;
      out.acExcerpt = around(b.printed, b.phrase);
      used = true;
      const own: AcCondition = NO_ARMOR.test(b.sentence) ? (NO_SHIELD.test(b.sentence) ? 'no-armor-no-shield' : 'no-armor') : 'always';
      out.condition = stricter(own, b.acOnly);
    }
    if (b.targets.includes('savingThrows') && !out.save) {
      out.save = b.n;
      used = true;
    }
    if (b.targets.includes('attack') && !out.attack) {
      out.attack = b.n;
      used = true;
    }
    if (b.targets.includes('damage') && !out.damage) {
      out.damage = b.n;
      used = true;
    }
    if (used && !texts.includes(b.phrase)) texts.push(b.phrase);
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
  const text = itemText(candidate.blocks);
  const { line } = typeLine(text);
  const sub = line ? parseMagicItemSubtitle(line) : null;
  const rarityWord = sub ? (sub.rarity === 'varies' ? (RARITY.test(sub.rarityText) ? 'varies' : 'unknown') : sub.rarity) : 'unknown';
  const paragraphs = itemParagraphs(text);
  const nouns = itemNouns(candidate.name, line);
  const b = bonuses(bonusPhrases(paragraphs, nouns, candidate.name));
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
    chargesText: /\b(?:has|have)\s+\d+\s+charges\b/i.exec(ownProse(paragraphs, nouns))?.[0] ?? '',
    notes: '',
  };
  const missing: string[] = KEY_FIELDS.filter((f) => !wire[f]);
  if (wire.category === 'other') missing.push('category');
  if (wire.rarity === 'unknown') missing.push('rarity');
  return { wire, missing };
}
