// @vitest-environment node
/**
 * SRD parity for the option kinds (spec §3.9, §8.2): the SRD 5.2.1's own feats, backgrounds, species and
 * classes (public/srd/, CC-BY-4.0), imported as a book would be — Markdown, and the PDF-like flattened
 * text — through segment → parse → normalize, agree with the shipped builder.json per field at least as
 * often as the coverage table promises. On failure the worst fields are printed.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chunkDocument } from '@/data/chunk';
import { nameKey } from '@/lib/id';
import type { BuilderData, CompendiumEntry, StructuredKind } from '@/types';
import { normalizeBackground } from './normalize/background';
import { normalizeClass } from './normalize/classes';
import { normalizeFeat } from './normalize/feat';
import type { NormalizeContext } from './normalize/index';
import { normalizeSpecies } from './normalize/species';
import { parseBackground } from './parse/background';
import { parseClass } from './parse/classes';
import { parseFeat } from './parse/feat';
import { flatten } from './parse/flatten';
import { parseSpecies } from './parse/species';
import { resolveSpan } from './paragraphs';
import { segment, type Candidate } from './segment';

const read = (file: string) => JSON.parse(readFileSync(new URL(`../../../public/srd/${file}`, import.meta.url), 'utf8')) as unknown;
const compendium = read('compendium.json') as CompendiumEntry[];
const builder = read('builder.json') as BuilderData;
const byKind = (kind: string) => compendium.filter((e) => e.kind === kind);

/** The SRD's option entries as one imported Markdown book. */
function srdBook(): string {
  const section = (title: string, kind: string) => [`# ${title}`, ...byKind(kind).map((e) => `## ${e.name}\n\n${e.text}`)].join('\n\n');
  return [section('Classes', 'class'), section('Species', 'species'), section('Backgrounds', 'background'), section('Feats', 'feat')].join('\n\n');
}

type Score = { field: string; ok: boolean; name: string; got?: unknown; want?: unknown };

function readBook(markdown: string) {
  const entries = chunkDocument(markdown, { sourceId: 'parity', sourceName: 'SRD parity' });
  const entriesById = new Map(entries.map((e) => [e.id, e]));
  const knownSpellNames = new Set(byKind('spell').map((e) => nameKey(e.name)));
  const knownClassNames = new Set(builder.classes.map((c) => nameKey(c.name)));
  const { candidates, spellLists } = segment(entries, { knownSpellNames, knownClassNames });
  const ctx = (c: Candidate, missing: string[]): NormalizeContext => ({ blocks: c.blocks, entriesById, origin: 'parser', spellLists, missing });
  return { candidates, entriesById, ctx };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sortNames = (list: readonly { name: string }[] | undefined) => (list ?? []).map((x) => x.name).sort();

function scoreKind(markdown: string, kind: StructuredKind): Score[] {
  const { candidates, entriesById, ctx } = readBook(markdown);
  const scores: Score[] = [];
  const add = (name: string, field: string, got: unknown, want: unknown) => scores.push({ name, field, ok: same(got, want), got, want });
  const found = (name: string) => candidates.find((c) => c.kind === kind && nameKey(c.name) === nameKey(name));
  if (kind === 'feat') {
    for (const option of builder.feats) {
      const c = found(option.name);
      if (!c) {
        add(option.name, 'detected', false, true);
        continue;
      }
      const parsed = parseFeat(c as Candidate & { kind: 'feat' });
      const out = normalizeFeat(parsed.wire, ctx(c, parsed.missing));
      add(option.name, 'category', out.data?.category, option.category);
      add(option.name, 'prerequisite', out.data?.prerequisite, option.prerequisite);
      add(option.name, 'repeatable', out.data?.repeatable ?? false, option.repeatable ?? false);
      // Compared as words: the PDF layer has no emphasis.
      const words = (t: string | null | undefined) => t?.replace(/[*_]/g, '').replace(/\s+/g, ' ').trim();
      add(option.name, 'text', words(out.data ? resolveSpan(out.data.text, entriesById) : null), words(option.description));
    }
  }
  if (kind === 'background') {
    for (const option of builder.backgrounds) {
      const c = found(option.name);
      if (!c) {
        add(option.name, 'detected', false, true);
        continue;
      }
      const parsed = parseBackground(c as Candidate & { kind: 'background' });
      const d = normalizeBackground(parsed.wire, ctx(c, parsed.missing)).data;
      for (const field of ['abilityScores', 'feat', 'skills', 'tool', 'equipment'] as const) add(option.name, field, d?.[field], option[field]);
    }
  }
  if (kind === 'species') {
    for (const option of builder.species) {
      const c = found(option.name);
      if (!c) {
        add(option.name, 'detected', false, true);
        continue;
      }
      const parsed = parseSpecies(c as Candidate & { kind: 'species' });
      const d = normalizeSpecies(parsed.wire, ctx(c, parsed.missing)).data;
      add(option.name, 'creatureType', d?.creatureType, option.creatureType);
      add(option.name, 'sizes', d?.sizes, option.sizes);
      add(option.name, 'speed', d?.speed, option.speed);
      add(option.name, 'darkvision', d?.darkvision, option.darkvision);
      add(option.name, 'traits', sortNames(d?.traits), sortNames(option.traits));
      add(option.name, 'lineages', sortNames(d?.lineages), sortNames(option.lineages));
    }
  }
  if (kind === 'class') {
    for (const option of builder.classes) {
      const c = found(option.name);
      if (!c) {
        add(option.name, 'detected', false, true);
        continue;
      }
      const parsed = parseClass(c as Candidate & { kind: 'class' }, entriesById);
      const d = normalizeClass(parsed.wire, ctx(c, parsed.missing)).data;
      for (const field of ['hitDie', 'primaryAbilities', 'savingThrows', 'skillChoices', 'weaponProficiencies', 'armorTraining', 'tools', 'casterType', 'spellcastingAbility', 'weaponMasteryCount', 'startingEquipment', 'subclassLevel', 'levelTable'] as const) {
        add(option.name, field, d?.[field], option[field]);
      }
      add(option.name, 'features', d?.features.map((f) => `${f.level} ${f.name}`), option.features.map((f) => `${f.level} ${f.name}`));
    }
  }
  return scores;
}

function report(scores: Score[]): { rate: number; worst: string } {
  const rate = scores.filter((s) => s.ok).length / Math.max(1, scores.length);
  const byField = new Map<string, Score[]>();
  for (const s of scores.filter((x) => !x.ok)) byField.set(s.field, [...(byField.get(s.field) ?? []), s]);
  const worst = [...byField.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 6)
    .map(([field, list]) => `${field} ×${list.length} (e.g. ${list[0].name}: got ${JSON.stringify(list[0].got)?.slice(0, 160)}, want ${JSON.stringify(list[0].want)?.slice(0, 160)})`)
    .join('\n');
  return { rate, worst };
}

const BOOK = srdBook();
const TARGETS: { kind: StructuredKind; markdown: number; flattened?: number }[] = [
  { kind: 'feat', markdown: 0.95, flattened: 0.85 },
  { kind: 'background', markdown: 0.95, flattened: 0.7 },
  { kind: 'species', markdown: 0.8 },
  { kind: 'class', markdown: 0.7 },
];

describe('SRD parity of the option parsers', () => {
  for (const { kind, markdown, flattened } of TARGETS) {
    it(`reads the SRD's ${kind} options from Markdown (≥ ${markdown * 100}%)`, () => {
      const { rate, worst } = report(scoreKind(BOOK, kind));
      expect(rate, `${kind} agreement ${(rate * 100).toFixed(1)}%; worst fields:\n${worst}`).toBeGreaterThanOrEqual(markdown);
    });
    if (flattened !== undefined) {
      it(`reads the SRD's ${kind} options from a flattened PDF text layer (≥ ${flattened * 100}%)`, () => {
        const { rate, worst } = report(scoreKind(flatten(BOOK), kind));
        expect(rate, `${kind} agreement ${(rate * 100).toFixed(1)}%; worst fields:\n${worst}`).toBeGreaterThanOrEqual(flattened);
      });
    }
  }
});
