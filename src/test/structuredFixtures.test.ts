/**
 * The fixture checks itself: both dialects chunk alike, markers are unique, every scripted answer and
 * expected value passes its schema, every span resolves to the text EXPECTED_MERGED copies, and every
 * excerpt is in the book (except the drake's deliberate HP misreading).
 *
 * Paragraphs are counted with REFERENCE_SPLIT, a direct reading of spec §3.3. When E2 lands
 * splitParagraphs (src/data/structured/paragraphs.ts), switch this file to it: no expectation may change.
 */
import { describe, expect, it } from 'vitest';
import { DATA_SCHEMAS, RECORD_SCHEMA } from '@/data/structured/schemas';
import { WIRE } from '@/data/structured/wire';
import { textFingerprint } from '@/lib/importedContent';
import type { CompendiumEntry, ImportedRef, StructuredKind, TextSpan } from '@/types';
import {
  EXPECTED_DATA,
  EXPECTED_MERGED,
  GLOAMWOOD_CANDIDATES,
  GLOAMWOOD_MARKERS,
  GLOAMWOOD_MD,
  GLOAMWOOD_MIXED,
  GLOAMWOOD_RULE_ENTRIES,
  GLOAMWOOD_SRD_SUBSET,
  SCRIPTED_WIRE,
  SRD_BUILDER_DATA,
  expectedData,
  gloamwoodEntries,
  gloamwoodRecords,
  gloamwoodSnapshot,
  gloamwoodSource,
  type GloamwoodDataName,
} from './structuredFixtures';

const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
/** Spec §3.3 read literally (see the header). */
function REFERENCE_SPLIT(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const joined = current.join('\n').trim();
    if (joined) out.push(joined);
    current = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) flush();
    else if (/^ {0,3}#{1,6}\s/.test(line)) {
      flush();
      out.push(line.trim());
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      if (!SEPARATOR.test(line) && !SEPARATOR.test(lines[i + 1] ?? '')) out.push(line.trim());
    } else if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      out.push(line.trim());
    } else current.push(line);
  }
  flush();
  return out;
}

const md = gloamwoodEntries();
const mixed = gloamwoodEntries('gloam', 'mixed');
const byId = new Map(md.map((e) => [e.id, e]));
const byName = new Map(md.map((e) => [e.name, e]));
const paragraphsOf = (entry: CompendiumEntry) => REFERENCE_SPLIT(entry.text);
const resolve = (span: TextSpan) => {
  const paras = REFERENCE_SPLIT(span.entryIds.map((id) => byId.get(id)?.text ?? '').join('\n\n'));
  return span.from >= 1 && span.to <= paras.length && span.from <= span.to ? paras.slice(span.from - 1, span.to).join('\n\n') : null;
};
/** Emphasis gone, whitespace collapsed, lowercased: the excerpt check of §3.9.2 in miniature. */
const plain = (t: string) => t.replace(/[*_]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

describe('the Gloamwood fixture book', () => {
  it('chunks both dialects into the same entries, paths and paragraph counts', () => {
    expect(md.length).toBe(52);
    expect(mixed.map((e) => [e.id, e.name, e.kind, e.path])).toEqual(md.map((e) => [e.id, e.name, e.kind, e.path]));
    expect(mixed.map((e) => paragraphsOf(e).length)).toEqual(md.map((e) => paragraphsOf(e).length));
  });

  it('flattens only the Wickwright chapter, the Glimmerwing Drake and Mothkin in GLOAMWOOD_MIXED', () => {
    const flatSections = new Set([
      'Mothkin', 'Mothkin Lineages', 'Glimmerwing Drake',
      ...GLOAMWOOD_CANDIDATES.filter((c) => c.name === 'Wickwright' || c.name === 'Order of the Long Wick').flatMap((c) => c.entries),
    ]);
    const changed = mixed.filter((e, i) => e.text !== md[i].text);
    expect(changed.map((e) => e.name).filter((n) => !flatSections.has(n))).toEqual([]);
    expect(changed.map((e) => e.name)).toEqual(expect.arrayContaining(['Mothkin', 'Mothkin Lineages', 'Wickwright Class Features', 'Glimmerwing Drake']));
    for (const e of mixed.filter((x) => flatSections.has(x.name))) expect(e.text, e.name).not.toMatch(/[*_|]/);
  });

  it('places each marker sentence exactly once in each dialect', () => {
    for (const marker of GLOAMWOOD_MARKERS) {
      expect(GLOAMWOOD_MD.split(marker).length - 1, marker).toBe(1);
      expect(GLOAMWOOD_MIXED.split(marker).length - 1, marker).toBe(1);
    }
  });

  it('lists every entry either in a candidate or as plain rules text', () => {
    const used = new Set([...GLOAMWOOD_CANDIDATES.flatMap((c) => c.entries), ...GLOAMWOOD_RULE_ENTRIES]);
    expect(md.map((e) => e.name).filter((n) => !used.has(n))).toEqual([]);
    for (const c of GLOAMWOOD_CANDIDATES) for (const n of c.entries) expect(byName.has(n), n).toBe(true);
  });
});

describe('SCRIPTED_WIRE', () => {
  const candidateOf = (title: string) => GLOAMWOOD_CANDIDATES.find((c) => c.entries[0] === title);

  it('answers every candidate, by the title of its first block, with a valid wire object of its kind', () => {
    expect(Object.keys(SCRIPTED_WIRE).sort()).toEqual(GLOAMWOOD_CANDIDATES.map((c) => c.entries[0]).sort());
    for (const [title, { kind, wire }] of Object.entries(SCRIPTED_WIRE)) {
      expect(candidateOf(title)?.kind, title).toBe(kind);
      const parsed = WIRE[kind].safeParse(wire);
      expect(parsed.success, `${title}: ${parsed.error?.message}`).toBe(true);
    }
  });

  it('copies every excerpt from the book (except the drake hpText misreading), and every span resolves', () => {
    for (const [title, { wire }] of Object.entries(SCRIPTED_WIRE)) {
      const candidate = candidateOf(title)!;
      const blocks = candidate.entries.map((n) => byName.get(n)!);
      const full = plain(blocks.map((b) => b.text).join('\n\n'));
      const visit = (value: unknown, key: string): void => {
        if (typeof value === 'string' && key.endsWith('Text') && value && !(title === 'Glimmerwing Drake' && key === 'hpText')) {
          expect(full.includes(plain(value)), `${title}.${key}: "${value}"`).toBe(true);
        } else if (Array.isArray(value)) value.forEach((v) => visit(v, key));
        else if (value && typeof value === 'object') {
          const o = value as Record<string, unknown>;
          if ('block' in o && 'from' in o && 'to' in o) {
            if (o.block === '') return expect([o.from, o.to]).toEqual([0, 0]);
            const index = Number(String(o.block).slice(1)) - 1;
            expect(index >= 0 && index < blocks.length, `${title}: block ${String(o.block)}`).toBe(true);
            const count = paragraphsOf(blocks[index]).length;
            expect(1 <= Number(o.from) && Number(o.from) <= Number(o.to) && Number(o.to) <= count, `${title}: ${JSON.stringify(o)}`).toBe(true);
            return;
          }
          for (const [k, v] of Object.entries(o)) visit(v, k);
        }
      };
      visit(wire, '');
    }
    expect((SCRIPTED_WIRE['Glimmerwing Drake'].wire as { hpText: string }).hpText).toBe('58 (8d10 + 8)');
  });
});

describe('EXPECTED_DATA and the records', () => {
  const KIND: Record<GloamwoodDataName, StructuredKind> = Object.fromEntries(
    gloamwoodRecords().filter((r) => r.data).map((r) => [r.name, r.kind]),
  ) as Record<GloamwoodDataName, StructuredKind>;

  it('passes DATA_SCHEMAS for every entry, and its spans resolve', () => {
    for (const [name, data] of Object.entries(EXPECTED_DATA)) {
      const result = DATA_SCHEMAS[KIND[name as GloamwoodDataName]].safeParse(data);
      expect(result.success, `${name}: ${result.error?.message}`).toBe(true);
      JSON.stringify(data, (key, value) => {
        if (value && typeof value === 'object' && 'entryIds' in value) expect(resolve(value as TextSpan), `${name}.${key}`).not.toBeNull();
        return value;
      });
    }
  });

  it('builds RECORD_SCHEMA-valid records with the §2.6 ids', () => {
    const records = gloamwoodRecords();
    expect(records).toHaveLength(GLOAMWOOD_CANDIDATES.length + 1);
    for (const r of records) {
      const result = RECORD_SCHEMA.safeParse(r);
      expect(result.success, `${r.name}: ${result.error?.message}`).toBe(true);
      expect(r.publicId).toBe(r.span === 'entry' ? r.entryIds[0] : `lib:gloam:${r.kind}:${r.id.split(':').pop()}`);
    }
    const hookstaff = records.find((r) => r.name === 'Hookstaff')!;
    expect(hookstaff).toMatchObject({ span: 'row', rowIndex: 0, tableRecordId: 'rec:gloam:item:gloamwood-arms', publicId: 'lib:gloam:item:hookstaff' });
    expect(records.find((r) => r.name === 'Ember Warden')).toMatchObject({ parentClassId: 'srd:class:fighter', publicId: 'lib:gloam:subclass:ember-warden' });
  });

  it('re-homes spans onto another source id', () => {
    expect(expectedData('other').Mothkin.traits[0].text.entryIds).toEqual(['lib:other:4']);
  });

  it('gives a snapshot of the accepted, data-bearing records', () => {
    const snap = gloamwoodSnapshot();
    expect(snap.accepted.every((r) => r.status === 'accepted' && r.data !== null)).toBe(true);
    expect(snap.accepted.map((r) => r.name)).not.toContain('Goblin Warrior');
    expect(snap.sources[0].fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('EXPECTED_MERGED', () => {
  const refs: { ref: ImportedRef; description: string; owner: string }[] = [];
  const collect = (owner: string, item: { description?: string; ref?: ImportedRef }) => {
    if (item.ref) refs.push({ ref: item.ref, description: item.description ?? '', owner });
  };
  for (const c of EXPECTED_MERGED.classes) {
    if (c.source) c.features.forEach((f) => collect(c.name, f));
    for (const s of c.subclasses) if (s.source) s.features.forEach((f) => collect(s.name, f));
  }
  for (const s of EXPECTED_MERGED.species) {
    s.traits.forEach((t) => collect(s.name, t));
    s.lineages?.forEach((l) => collect(s.name, l));
  }
  for (const b of EXPECTED_MERGED.backgrounds) if (b.legacyFeature) collect(b.name, b.legacyFeature);
  for (const f of EXPECTED_MERGED.feats) collect(f.name, f);

  it('copies book text only with a ref whose hash, book and location match it', () => {
    expect(refs.length).toBe(27);
    const fingerprint = gloamwoodSource().fingerprint;
    for (const { ref, description, owner } of refs) {
      expect(ref.textHash, `${owner} › ${ref.part}`).toBe(textFingerprint(description));
      expect(ref).toMatchObject({ textCopied: true, bookFingerprint: fingerprint, sourceTitle: 'The Gloamwood Almanac' });
      const entryId = `lib:gloam:${ref.at!.ordinals[0]}`;
      const text = resolve({ entryIds: [entryId], from: ref.at!.from, to: ref.at!.to });
      expect(text, `${owner} › ${ref.part}`).not.toBeNull();
      // featureText: a run-in label equal to the part's name is not part of the description.
      const stripped = text!.replace(/^(?:_\*\*|\*\*\*)([^.*]+)\.(?:\*\*_|\*\*\*) /, (m, label: string) => (label === (ref.part ?? owner) ? '' : m));
      if (!ref.part || !['Ashwing', 'Silverwing'].includes(ref.part)) expect(stripped, `${owner} › ${ref.part}`).toBe(description);
    }
  });

  it('carries the eight markers in copied text', () => {
    const copied = refs.map((r) => r.description).join('\n');
    for (const marker of GLOAMWOOD_MARKERS) expect(copied, marker).toContain(marker);
  });

  it('leaves the SRD subset untouched and frozen; attaches subclasses to clones', () => {
    expect(Object.isFrozen(GLOAMWOOD_SRD_SUBSET.classes[1])).toBe(true);
    const fighter = EXPECTED_MERGED.classes.find((c) => c.id === 'srd:class:fighter')!;
    expect(fighter).not.toBe(GLOAMWOOD_SRD_SUBSET.classes[1]);
    expect(fighter.subclasses.map((s) => s.name)).toEqual(['Champion', 'Ember Warden']);
    expect(GLOAMWOOD_SRD_SUBSET.classes[1].subclasses.map((s) => s.name)).toEqual(['Champion']);
    expect(EXPECTED_MERGED.classes.map((c) => c.name)).toEqual(['Cleric', 'Fighter', 'Wickwright']);
    const warden = EXPECTED_MERGED.equipment.find((e) => e.name === "Warden's Mail")!;
    expect(warden).toMatchObject({ armorClass: 16, category: 'armor', magic: { baseItemId: 'srd:item:chain-mail', bonuses: { ac: 1 } } });
    expect(SRD_BUILDER_DATA.classes).toHaveLength(12);
  });
});
