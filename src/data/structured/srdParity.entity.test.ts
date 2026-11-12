/**
 * SRD parity for the entity kinds (spec §3.9, §8.2): every SRD 5.2.1 spell, monster and magic item
 * (CC-BY-4.0, public/srd/compendium.json) goes through segment → parseOffline → normalize, in SRD-style
 * Markdown and as a PDF text layer, and is compared with the data the build script shipped; so do the
 * SRD's weapon, armor and shield tables, against the equipment catalog (public/srd/builder.json).
 * Prints the worst fields on failure.
 *
 * The PDF dialect is flatten()'s output, except that a monster's ability table is first printed the way
 * a PDF text layer shows the 2024 stat block grid ("Str 21 +5 +5 Dex 9 −1 +3 …"): flatten() drops a
 * table's header row, and the parser deliberately doesn't guess the columns of a header-less
 * "Score 21 9 15 …" row (the fixture's flattened Glimmerwing Drake goes to Claude because of it).
 */
import { describe, expect, it } from 'vitest';
import builderRaw from '../../../public/srd/builder.json?raw';
import compendiumRaw from '../../../public/srd/compendium.json?raw';
import { chunkDocument, guessKind } from '@/data/chunk';
import { pdfPagesToMarkdown, type PdfTextRun } from '@/data/pdfLayout';
import { nameKey } from '@/lib/id';
import type { BuilderData, CompendiumEntry, ItemBonuses, StructuredKind } from '@/types';
import { normalize, normalizeItemRows } from './normalize';
import { parseOffline } from './parse';
import { flatten } from './parse/flatten';
import { segment } from './segment';
import type { Wire } from './wire';

const SRD = (JSON.parse(compendiumRaw) as CompendiumEntry[]).filter((e) => ['spell', 'monster', 'magic-item'].includes(e.kind));
const CHAPTER: Partial<Record<StructuredKind, string>> = { spell: 'Spells', monster: 'Monsters', 'magic-item': 'Magic Items' };
const CTX = { knownSpellNames: new Set<string>(), knownClassNames: new Set<string>() };

/** The 2024 ability table as a PDF text layer prints it: two lines of "Str 21 +5 +5 Dex 9 −1 +3 Con 15 +2 +6". */
function pdfAbilityGrid(md: string): string {
  return md.replace(/^\|[^\n]*Str\.[^\n]*\n\|[-| ]+\|\n((?:\|[^\n]*\n?)+)/m, (_table, body: string) => {
    const rows = body.trim().split('\n').map((r) => r.split('|').slice(1, -1).map((c) => c.replace(/\*/g, '').trim()));
    const row = (label: string) => rows.find((r) => r[0].toLowerCase() === label) ?? [];
    const [score, mod, save] = [row('score'), row('modifier'), row('saving throw')];
    const cell = (i: number) => `${['Str', 'Dex', 'Con', 'Int', 'Wis', 'Cha'][i]} ${score[i + 1]} ${mod[i + 1]} ${save[i + 1]}`;
    return `${[0, 1, 2].map(cell).join(' ')}\n\n${[3, 4, 5].map(cell).join(' ')}\n`;
  });
}

type Dialect = 'markdown' | 'pdf';
function entriesFor(kind: StructuredKind, dialect: Dialect): CompendiumEntry[] {
  return SRD.filter((e) => e.kind === kind).map((e, i) => {
    const text = dialect === 'markdown' ? e.text : flatten(kind === 'monster' ? pdfAbilityGrid(e.text) : e.text);
    return { id: `lib:srd-parity:${i + 1}`, sourceId: 'srd-parity', sourceName: 'Parity', kind: guessKind(e.name, text), name: e.name, text, path: [CHAPTER[kind] ?? '', e.name] };
  });
}

type Data = Record<string, unknown>;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Field comparisons per kind: [field, our value → comparable, shipped value → comparable]. */
const FIELDS: Record<string, [string, (ours: Data) => unknown, (srd: Data) => unknown][]> = {
  monster: [
    ['size', (d) => d.size, (s) => s.size],
    ['type', (d) => d.type, (s) => s.type],
    ['tags', (d) => d.tags, (s) => s.tags],
    ['alignment', (d) => String(d.alignment ?? '').toLowerCase(), (s) => String(s.alignment ?? '').toLowerCase()],
    ['ac', (d) => d.ac, (s) => s.ac],
    ['hp', (d) => d.hp, (s) => s.hp],
    ['hitDice', (d) => d.hitDice, (s) => s.hitDice],
    ['speeds', (d) => d.speeds, (s) => s.speeds],
    ['initiative', (d) => d.initiative, (s) => s.initiative],
    ['cr', (d) => d.cr, (s) => s.cr],
    ['xp', (d) => d.xp, (s) => s.xp],
    ['pb', (d) => d.pb, (s) => s.pb],
    ['abilities', (d) => d.abilities, (s) => s.abilities],
    ['passivePerception', (d) => d.passivePerception, (s) => s.passivePerception],
    ['legendary', (d) => Boolean(d.legendary), (s) => Boolean(s.legendary)],
  ],
  spell: [
    ['level', (d) => d.level, (s) => s.level],
    ['school', (d) => d.school, (s) => s.school],
    ['classes', (d) => d.classes, (s) => s.classes],
    ['ritual', (d) => d.ritual, (s) => s.ritual],
    ['concentration', (d) => d.concentration, (s) => s.concentration],
    ['castingTime', (d) => d.castingTime, (s) => s.castingTime],
    ['range', (d) => d.range, (s) => s.range],
    ['components', (d) => d.components, (s) => s.components],
    ['duration', (d) => d.duration, (s) => s.duration],
  ],
  'magic-item': [
    // The SRD build files magic shields under armor; this app keeps them apart ('shield').
    ['category', (d) => (d.category === 'shield' ? 'armor' : d.category === 'ammunition' ? 'weapon' : d.category), (s) => s.category],
    ['rarity', (d) => d.rarity, (s) => s.rarity],
    ['attunement', (d) => d.attunement, (s) => s.attunement],
    ['baseItem', (d) => d.baseItem, (s) => s.baseItem],
  ],
};

/** Fields read from Open5e by the build (not from the Markdown): reported, not counted. */
const INFO_FIELDS: Record<string, [string, (ours: Data) => unknown, (srd: Data) => unknown][]> = {
  spell: [
    ['saveAbility', (d) => d.saveAbility, (s) => s.saveAbility],
    ['attack', (d) => Boolean(d.attack), (s) => Boolean(s.attackRoll)],
    ['damage', (d) => d.damage, (s) => s.damage],
  ],
};

interface Measure { rate: number; total: number; read: number; agreeing: number; worst: string[]; info: string[] }

function measure(kind: StructuredKind, dialect: Dialect): Measure {
  const entries = entriesFor(kind, dialect);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const shipped = new Map(SRD.filter((e) => e.kind === kind).map((e) => [nameKey(e.name), (e.data ?? {}) as Data]));
  const { candidates, spellLists } = segment(entries, CTX);
  const fieldMisses = new Map<string, string[]>();
  const infoMisses = new Map<string, number>();
  let read = 0;
  let agreeing = 0;
  const seen = new Set<string>();
  for (const c of candidates) {
    if (c.kind !== kind) continue;
    const srd = shipped.get(nameKey(c.name));
    if (!srd || seen.has(nameKey(c.name))) continue;
    seen.add(nameKey(c.name));
    const { wire, missing } = parseOffline(c);
    const n = normalize(c.kind, wire, { blocks: c.blocks, entriesById: byId, origin: 'parser', spellLists, missing });
    if (!n.data) {
      fieldMisses.set('(not read)', [...(fieldMisses.get('(not read)') ?? []), c.name]);
      continue;
    }
    read += 1;
    const ours = n.data as unknown as Data;
    let ok = true;
    for (const [field, mine, theirs] of FIELDS[kind] ?? []) {
      if (!same(mine(ours), theirs(srd))) {
        ok = false;
        fieldMisses.set(field, [...(fieldMisses.get(field) ?? []), `${c.name}: ${JSON.stringify(mine(ours))} vs ${JSON.stringify(theirs(srd))}`]);
      }
    }
    for (const [field, mine, theirs] of INFO_FIELDS[kind] ?? []) if (!same(mine(ours), theirs(srd))) infoMisses.set(field, (infoMisses.get(field) ?? 0) + 1);
    if (ok) agreeing += 1;
  }
  const total = shipped.size;
  const worst = [...fieldMisses.entries()].sort((a, b) => b[1].length - a[1].length).map(([f, list]) => `${f} (${list.length}): ${list.slice(0, 4).join(' | ')}`);
  return { rate: agreeing / total, total, read, agreeing, worst, info: [...infoMisses.entries()].map(([f, n]) => `${f}: ${n} differ from Open5e`) };
}

const TARGETS: [StructuredKind, Dialect, number][] = [
  ['spell', 'markdown', 0.98],
  ['monster', 'markdown', 0.98],
  ['magic-item', 'markdown', 0.98],
  ['spell', 'pdf', 0.9],
  ['monster', 'pdf', 0.6],
  ['magic-item', 'pdf', 0.85],
];

describe('SRD parity (entity kinds)', () => {
  it.each(TARGETS)('%s in %s agrees with the shipped data at least as often as the target', (kind, dialect, target) => {
    const m = measure(kind, dialect);
    const report = `${kind}/${dialect}: ${m.agreeing}/${m.total} agree (${(m.rate * 100).toFixed(1)}%), ${m.read} read\n${m.worst.join('\n')}\n${m.info.join('\n')}`;
    expect(m.total, report).toBeGreaterThan(0);
    expect(m.rate, report).toBeGreaterThanOrEqual(target);
  });
});

// ---------------------------------------------------------------------------
// Gear (§3.9: GFM tables ≥ 95%; a PDF text layer loses its tables, so those wait for Claude)
// ---------------------------------------------------------------------------

const GEAR_TABLES = (JSON.parse(compendiumRaw) as CompendiumEntry[]).filter((e) => e.id === 'srd:rule:weapons' || e.id === 'srd:rule:armor');
const CATALOG = (JSON.parse(builderRaw) as BuilderData).equipment.filter((o) => o.category === 'weapon' || o.category === 'armor' || o.category === 'shield');
const GEAR_FIELDS = [
  'category', 'costGp', 'weight', 'weaponCategory', 'weaponType', 'range', 'damage', 'damageType', 'properties', 'mastery',
  'armorClass', 'dexCap', 'strengthRequirement', 'stealthDisadvantage', 'armorType', 'description',
] as const;

function measureGear(dialect: Dialect): Omit<Measure, 'info'> {
  const entries = GEAR_TABLES.map((e, i) => ({
    ...e,
    id: `lib:srd-parity:${i + 1}`,
    sourceId: 'srd-parity',
    sourceName: 'Parity',
    text: dialect === 'markdown' ? e.text : flatten(e.text),
  }));
  const entriesById = new Map(entries.map((e) => [e.id, e]));
  const read = new Map<string, Data>();
  for (const c of segment(entries, CTX).candidates) {
    if (c.kind !== 'item') continue;
    const { wire, missing } = parseOffline(c);
    const rows = normalizeItemRows(wire as Wire<'item'>, { blocks: c.blocks, entriesById, origin: 'parser', spellLists: [], missing });
    for (const row of rows) if (row.data) read.set(nameKey(row.name), row.data as unknown as Data);
  }
  const misses = new Map<string, string[]>();
  let agreeing = 0;
  for (const shipped of CATALOG) {
    const ours = read.get(nameKey(shipped.name));
    if (!ours) {
      misses.set('(not read)', [...(misses.get('(not read)') ?? []), shipped.name]);
      continue;
    }
    const theirs = shipped as unknown as Data;
    const wrong = GEAR_FIELDS.filter((field) => !same(ours[field], theirs[field]));
    for (const field of wrong) misses.set(field, [...(misses.get(field) ?? []), `${shipped.name}: ${JSON.stringify(ours[field])} vs ${JSON.stringify(theirs[field])}`]);
    if (!wrong.length) agreeing += 1;
  }
  const worst = [...misses.entries()].sort((a, b) => b[1].length - a[1].length).map(([f, list]) => `${f} (${list.length}): ${list.slice(0, 4).join(' | ')}`);
  return { rate: agreeing / CATALOG.length, total: CATALOG.length, read: read.size, agreeing, worst };
}

describe('SRD parity (gear tables)', () => {
  it('reads the SRD weapon, armor and shield tables in Markdown as the shipped catalog has them, at least 95% of rows', () => {
    const m = measureGear('markdown');
    const report = `gear/markdown: ${m.agreeing}/${m.total} agree (${(m.rate * 100).toFixed(1)}%), ${m.read} read\n${m.worst.join('\n')}`;
    expect(m.total, report).toBe(51);
    expect(m.rate, report).toBeGreaterThanOrEqual(0.95);
  });

  it('reads no gear offline from a PDF text layer, whose tables are lost: those wait for Claude', () => {
    const m = measureGear('pdf');
    expect(m.read, m.worst.join('\n')).toBe(0);
  });
});

/**
 * What each SRD 5.2.1 item that states a "+N bonus to …" gives in the app when read offline (the shipped
 * data has no bonuses to compare with). Bonuses the item always grants are applied; one that holds only
 * in some situations, or for one variant, isn't (SRD 5.2.1 "Magic Items": Arrow-Catching Shield's bonus
 * against ranged attacks, Defender's transfer, one Ioun Stone, Rod of Alertness's minute, Bracers of
 * Archery's bows), and the record says so.
 */
const SRD_BONUSES: Record<string, ItemBonuses | null> = {
  'Arrow-Catching Shield': null,
  'Berserker Axe': { attack: 1, damage: 1 },
  'Bracers of Archery': null,
  'Bracers of Defense': { ac: 2, acOnlyWhen: 'no-armor-no-shield' },
  'Cloak of Protection': { ac: 1, savingThrows: 1 },
  'Dagger of Venom': { attack: 1, damage: 1 },
  Defender: { attack: 3, damage: 3 },
  'Demon Armor': { ac: 1 },
  'Dragon Scale Mail': { ac: 1 },
  'Dragon Slayer': { attack: 1, damage: 1 },
  'Dwarven Plate': { ac: 2 },
  'Dwarven Thrower': { attack: 3, damage: 3 },
  'Elven Chain': { ac: 1 },
  'Energy Bow': { attack: 1, damage: 1 },
  'Giant Slayer': { attack: 1, damage: 1 },
  'Glamoured Studded Leather': { ac: 1 },
  'Gloves of Swimming and Climbing': null,
  'Gloves of Thievery': null,
  'Hammer of Thunderbolts': { attack: 1, damage: 1 },
  'Holy Avenger': { attack: 3, damage: 3 },
  'Ioun Stone': null,
  'Luck Blade': { savingThrows: 1, attack: 1, damage: 1 },
  'Mace of Smiting': { attack: 1, damage: 1 },
  'Nine Lives Stealer': { attack: 2, damage: 2 },
  'Quarterstaff of the Acrobat': { attack: 2, damage: 2 },
  'Ring of Protection': { ac: 1, savingThrows: 1 },
  'Robe of Stars': { savingThrows: 1 },
  'Rod of Alertness': null,
  'Rod of Lordly Might': { attack: 3, damage: 3 },
  'Scarab of Protection': { ac: 1 },
  'Scimitar of Speed': { attack: 2, damage: 2 },
  'Shield of the Cavalier': { ac: 2 },
  'Staff of Power': { ac: 2, savingThrows: 2, attack: 2, damage: 2 },
  'Staff of Striking': { attack: 3, damage: 3 },
  'Staff of the Magi': { attack: 2, damage: 2 },
  'Staff of the Woodlands': { attack: 2, damage: 2 },
  'Staff of Thunder and Lightning': { attack: 2, damage: 2 },
  'Stone of Good Luck (Luckstone)': { savingThrows: 1 },
  'Sun Blade': { attack: 2, damage: 2 },
  'Talisman of Pure Good': null,
  'Talisman of Ultimate Evil': null,
  'Vorpal Sword': { attack: 3, damage: 3 },
};
const SRD_BONUS_NOTES = new Set(['Arrow-Catching Shield', 'Bracers of Archery', 'Defender', 'Ioun Stone', 'Rod of Alertness']);

describe('SRD parity (magic item bonuses)', () => {
  const dialects = {
    markdown: (md: string) => md,
    pdf: (md: string) => flatten(md),
    // A PDF that joined the type line and the first paragraph.
    joined: (md: string) => flatten(md).replace(/^([^\n]+)\n\n/, '$1 '),
  };
  it.each(Object.keys(dialects) as (keyof typeof dialects)[])('applies the bonuses an SRD item always grants, and notes the rest (%s)', (dialect) => {
    const stating = SRD.filter((e) => e.kind === 'magic-item' && /\+\d\s+bonus\s+to\b/i.test(e.text));
    const wrong: string[] = [];
    for (const [i, e] of stating.entries()) {
      const text = dialects[dialect](e.text);
      const entry: CompendiumEntry = { id: `lib:srd-bonus:${i + 1}`, sourceId: 'srd-bonus', sourceName: 'Bonus', kind: guessKind(e.name, text), name: e.name, text, path: ['Magic Items', e.name] };
      const c = segment([entry], CTX).candidates[0];
      if (!c) {
        wrong.push(`${e.name}: not detected`);
        continue;
      }
      const n = normalize('magic-item', parseOffline(c).wire as Wire<'magic-item'>, { blocks: c.blocks, entriesById: new Map([[entry.id, entry]]), origin: 'parser', spellLists: [] });
      const bonuses = (n.data as { bonuses?: ItemBonuses } | null)?.bonuses ?? null;
      if (!same(bonuses, SRD_BONUSES[e.name] ?? null)) wrong.push(`${e.name}: ${JSON.stringify(bonuses)} vs ${JSON.stringify(SRD_BONUSES[e.name] ?? null)}`);
      const noted = n.warnings.some((w) => w.field === 'bonuses');
      if (noted !== SRD_BONUS_NOTES.has(e.name)) wrong.push(`${e.name}: ${noted ? 'a note it shouldn’t have' : 'no note'}`);
    }
    expect(stating.map((e) => e.name).sort()).toEqual(Object.keys(SRD_BONUSES).sort());
    expect(wrong).toEqual([]);
  });

  /**
   * Every SRD item printed as one flowing two-column PDF book (an item goes on in the next column or on the next
   * page, under a running header, with page numbers), `perColumn` lines to a column, read back by
   * pdfPagesToMarkdown and chunkDocument. A column or page break can cut a sentence ("…a +1 bonus to Armor Class
   * while you" | "wear this armor.", "…a +2 bonus to Armor" | "Class, saving throws…"): read together again, each
   * item gives what it gives in Markdown.
   */
  function twoColumnBook(entries: readonly CompendiumEntry[], perColumn = 52, width = 46): CompendiumEntry[] {
    const PER_COLUMN = perColumn;
    const line = (str: string, x: number, y: number, fontSize = 10): PdfTextRun => ({ str, x, y, width: str.length * fontSize * 0.5, fontSize, hasEOL: true });
    const wrap = (text: string) =>
      text.split(/\s+/).filter(Boolean).reduce<string[]>((lines, word) => {
        const last = lines.length ? lines[lines.length - 1] : undefined;
        if (last !== undefined && `${last} ${word}`.length <= width) lines[lines.length - 1] = `${last} ${word}`;
        else lines.push(word);
        return lines;
      }, []);
    const pages: PdfTextRun[][] = [];
    let page: PdfTextRun[] = [];
    let column = 0;
    let row = 0;
    const startPage = () => {
      page = [line('Compendium of Curios', 50, 800, 8)];
      column = 0;
      row = 0;
    };
    const endPage = () => pages.push([...page, line(String(pages.length + 1), 300, 30, 8)]);
    const nextColumn = () => {
      if (column === 0) {
        column = 1;
        row = 0;
      } else {
        endPage();
        startPage();
      }
    };
    const put = (str: string, fontSize: number, gap: number) => {
      if (row + gap + 1 > PER_COLUMN) nextColumn();
      else if (row > 0) row += gap;
      page.push(line(str, column === 0 ? 50 : 320, 760 - row * 12, fontSize));
      row += 1;
    };
    startPage();
    put('Magic Items', 18, 0);
    for (const e of entries) {
      const paragraphs = e.text.split(/\n\s*\n/).map((p) => wrap(p.replace(/^\s*[-*]\s+/gm, '').replace(/[*_]/g, '')));
      // An item's name stays with its type line.
      if (row > 0 && row + 4 > PER_COLUMN) nextColumn();
      put(e.name, 13, 1);
      paragraphs.forEach((lines, i) => lines.forEach((l, j) => put(l, 10, j === 0 && i > 0 ? 1 : 0)));
    }
    endPage();
    return chunkDocument(pdfPagesToMarkdown(pages), { sourceId: 'srd-book', sourceName: 'Book' });
  }

  it('applies the same bonuses, and notes the rest, when every SRD item is printed as a flowing two-column PDF book', () => {
    const items = SRD.filter((e) => e.kind === 'magic-item');
    const book = twoColumnBook(items);
    const candidates = segment(book, CTX).candidates.filter((c) => c.kind === 'magic-item');
    const wrong: string[] = [];
    let cut = 0;
    for (const name of Object.keys(SRD_BONUSES)) {
      const c = candidates.find((x) => x.name === name);
      if (!c) {
        wrong.push(`${name}: not detected`);
        continue;
      }
      // How often the book cut one of these items' sentences at a column or page break.
      const paragraphs = book.find((e) => e.name === name)?.text.split(/\n\n/) ?? [];
      if (paragraphs.some((p, i) => i > 0 && !/[.!?:|]\s*$/.test(paragraphs[i - 1]) && /^\p{Ll}/u.test(p))) cut++;
      const n = normalize('magic-item', parseOffline(c).wire as Wire<'magic-item'>, { blocks: c.blocks, entriesById: new Map(book.map((e) => [e.id, e])), origin: 'parser', spellLists: [] });
      const bonuses = (n.data as { bonuses?: ItemBonuses } | null)?.bonuses ?? null;
      if (!same(bonuses, SRD_BONUSES[name])) wrong.push(`${name}: ${JSON.stringify(bonuses)} vs ${JSON.stringify(SRD_BONUSES[name])}`);
      if (n.warnings.some((w) => w.field === 'bonuses') !== SRD_BONUS_NOTES.has(name)) wrong.push(`${name}: a note ${SRD_BONUS_NOTES.has(name) ? 'missing' : 'it shouldn’t have'}`);
    }
    expect(wrong).toEqual([]);
    // The book does cut some of them (Dwarven Plate, Elven Chain and Staff of Power in this layout).
    expect(cut).toBeGreaterThanOrEqual(2);
  });

  /**
   * Every column height from 30 to 70 lines at 46 characters a line; at 40, 50 and 56 characters, every tenth height; and
   * every layout the round-5 layout review found Defender, Sun Blade, Dwarven Plate, Glamoured Studded Leather or Shield
   * of the Cavalier misread in ("…+2 bonus to Armor Class." | "The adjusted bonuses…", "…instead of" | "Slashing damage.",
   * "…+2 bonus to" | "Armor Class. …"). A scratch sweep read 14 widths from 34 to 60 at every height (574 layouts) the same.
   */
  const LAYOUTS: [number, number][] = [
    ...Array.from({ length: 41 }, (_, i): [number, number] => [46, 30 + i]),
    ...[40, 50, 56].flatMap((w) => [30, 40, 50, 60, 70].map((h): [number, number] => [w, h])),
    [34, 69], [38, 35], [40, 38], [42, 33], [42, 45], [44, 33], [44, 66], [50, 38], [48, 34], [48, 41], [52, 53], [54, 45], [56, 30], [58, 38],
  ];
  it('does so at every column height from 30 to 70 lines and at several line widths, wherever the breaks fall (46×59 cuts Staff of Power at "Armor" | "Class")', () => {
    const items = SRD.filter((e) => e.kind === 'magic-item');
    const names = new Set(Object.keys(SRD_BONUSES));
    const wrong: string[] = [];
    let capitalCuts = 0;
    for (const [width, per] of LAYOUTS) {
      const book = twoColumnBook(items, per, width);
      const byId = new Map(book.map((e) => [e.id, e]));
      // Only the items that state a bonus are read (the rest of the book still sets where the breaks fall).
      const candidates = segment(book.filter((e) => names.has(e.name)), CTX).candidates.filter((c) => c.kind === 'magic-item');
      for (const name of names) {
        const c = candidates.find((x) => x.name === name);
        if (!c) {
          wrong.push(`w${width} h${per} ${name}: not detected`);
          continue;
        }
        const paragraphs = book.find((e) => e.name === name)?.text.split(/\n\n/) ?? [];
        if (paragraphs.some((p, i) => i > 0 && !/[.!?:|]\s*$/.test(paragraphs[i - 1]) && /^\p{Lu}/u.test(p))) capitalCuts++;
        const n = normalize('magic-item', parseOffline(c).wire as Wire<'magic-item'>, { blocks: c.blocks, entriesById: byId, origin: 'parser', spellLists: [] });
        const bonuses = (n.data as { bonuses?: ItemBonuses } | null)?.bonuses ?? null;
        if (!same(bonuses, SRD_BONUSES[name])) wrong.push(`w${width} h${per} ${name}: ${JSON.stringify(bonuses)} vs ${JSON.stringify(SRD_BONUSES[name])}`);
        if (n.warnings.some((w) => w.field === 'bonuses') !== SRD_BONUS_NOTES.has(name)) wrong.push(`w${width} h${per} ${name}: a note ${SRD_BONUS_NOTES.has(name) ? 'missing' : 'it shouldn’t have'}`);
      }
    }
    expect(wrong).toEqual([]);
    // Some heights cut an item before a capital ("Armor" | "Class", "a magic" | "Quarterstaff").
    expect(capitalCuts).toBeGreaterThanOrEqual(2);
  });
});
