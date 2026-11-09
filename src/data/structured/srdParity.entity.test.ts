/**
 * SRD parity for the entity kinds (spec §3.9, §8.2): every SRD 5.2.1 spell, monster and magic item
 * (CC-BY-4.0, public/srd/compendium.json) goes through segment → parseOffline → normalize, in SRD-style
 * Markdown and as a PDF text layer, and is compared with the data the build script shipped. Prints the
 * worst fields on failure.
 *
 * The PDF dialect is flatten()'s output, except that a monster's ability table is first printed the way
 * a PDF text layer shows the 2024 stat block grid ("Str 21 +5 +5 Dex 9 −1 +3 …"): flatten() drops a
 * table's header row, and the parser deliberately doesn't guess the columns of a header-less
 * "Score 21 9 15 …" row (the fixture's flattened Glimmerwing Drake goes to Claude because of it).
 */
import { describe, expect, it } from 'vitest';
import compendiumRaw from '../../../public/srd/compendium.json?raw';
import { guessKind } from '@/data/chunk';
import { nameKey } from '@/lib/id';
import type { CompendiumEntry, StructuredKind } from '@/types';
import { normalize } from './normalize';
import { parseOffline } from './parse';
import { flatten } from './parse/flatten';
import { segment } from './segment';

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
