import { describe, expect, it } from 'vitest';
import { nameKey } from '@/lib/id';
import { bookFingerprint, importedPlaceholder, textFingerprint } from '@/lib/importedContent';
import { sampleCharacter } from '@/test/fixtures';
import {
  EXPECTED_DATA,
  EXPECTED_MERGED,
  GLOAMWOOD_SRD_SUBSET,
  GLOAMWOOD_TITLE,
  gloamwoodEntries,
  gloamwoodSource,
  structuredRecord,
} from '@/test/structuredFixtures';
import type { BuilderData, Character, ClassData, ClassFeatureDef, CompendiumEntry, Feature, ImportedRef, LibrarySource, SpeciesTrait } from '@/types';
import { inlineFightingStyles } from '../options/classFeatures';
import { importedOptions, mergeBuilderData } from './merge';
import { featureNeedsRestore, restoreImportedText, type LibraryLookup } from './restore';

const placeholder = importedPlaceholder(GLOAMWOOD_TITLE);

function lookupOf(builder: BuilderData, sources: LibrarySource[] = [], entries: CompendiumEntry[] = []): LibraryLookup {
  const byTitle = new Map<string, LibrarySource[]>();
  for (const s of sources) byTitle.set(nameKey(s.title), [...(byTitle.get(nameKey(s.title)) ?? []), s]);
  return {
    entriesById: new Map(entries.map((e) => [e.id, e])),
    sourcesByFingerprint: new Map(sources.filter((s) => s.fingerprint).map((s) => [s.fingerprint as string, s])),
    sourcesByTitle: byTitle,
    builder,
  };
}

// The book's copied texts, as the builder and level-up copy them (EXPECTED_MERGED holds the defs and refs).
const fighter = EXPECTED_MERGED.classes.find((c) => c.id === 'srd:class:fighter');
const ember = fighter?.subclasses.find((s) => s.name === 'Ember Warden');
const mothkin = EXPECTED_MERGED.species.find((s) => s.name === 'Mothkin');
const ferry = EXPECTED_MERGED.backgrounds.find((b) => b.name === 'Ferry Hand');
const mothsGrace = EXPECTED_MERGED.feats.find((f) => f.name === "Moth's Grace");
if (!ember || !mothkin || !ferry || !mothsGrace) throw new Error('fixture changed');
const emberWard = ember.features[0];
const duskSight = mothkin.traits[0];
const ashwing = mothkin.lineages?.[0] as SpeciesTrait & { ref: NonNullable<SpeciesTrait['ref']> };
const ferrymansRight = ferry.legacyFeature as SpeciesTrait;

const copied: Feature[] = [
  { id: 'f1', name: 'Ember Ward', source: 'subclass', sourceName: 'Ember Warden 3', description: emberWard.description, ref: emberWard.ref },
  { id: 'f2', name: 'Dusk Sight', source: 'species', description: duskSight.description, ref: duskSight.ref },
  { id: 'f3', name: 'Ashwing', source: 'species', description: ashwing.description, ref: ashwing.ref },
  { id: 'f4', name: "Moth's Grace", source: 'feat', description: mothsGrace.description, ref: mothsGrace.ref },
  { id: 'f5', name: "Ferryman's Right", source: 'background', description: ferrymansRight.description, ref: ferrymansRight.ref },
];
const originals = new Map(copied.map((f) => [f.id, f.description]));

/** The character as another device has it after a pull: placeholders, refs marked redacted. */
function pulled(): Character {
  const base = sampleCharacter();
  const left = copied.map((f) => ({ ...f, description: placeholder, ref: f.ref ? { ...f.ref, redacted: true as const } : undefined }));
  return { ...base, features: [...base.features, ...left] };
}
const restoredTexts = (c: Character) => c.features.filter((f) => originals.has(f.id)).map((f) => [f.id, f.description]);

describe('restoreImportedText (spec §7.4)', () => {
  it('restores by option id from this device’s merged data, and drops `redacted`', () => {
    const { character, report } = restoreImportedText(pulled(), lookupOf(EXPECTED_MERGED));
    expect(report).toEqual({ restored: 5, differs: 0, missing: [] });
    expect(restoredTexts(character)).toEqual([...originals]);
    for (const f of character.features.filter((x) => originals.has(x.id))) expect(f.ref?.redacted).toBeUndefined();
  });

  it('restores by fingerprint and location from a book imported but never structured', () => {
    // Imported again under a new source id: same entries, same fingerprint, no records (the SRD alone in the builder).
    const copy = gloamwoodSource('copy');
    expect(copy.fingerprint).toBe(gloamwoodSource().fingerprint);
    const { character, report } = restoreImportedText(pulled(), lookupOf(GLOAMWOOD_SRD_SUBSET, [copy], gloamwoodEntries('copy')));
    expect(report).toEqual({ restored: 5, differs: 0, missing: [] });
    // The table-row lineage too: its text is rebuilt from the row's cells, as the merge builds it.
    expect(restoredTexts(character)).toEqual([...originals]);
  });

  it('never restores at a location whose words changed (the fingerprint must match)', () => {
    const copy = gloamwoodSource('copy');
    const entries = gloamwoodEntries('copy').map((e) => ({ ...e, text: e.text.replace('banked heat', 'banked warmth') }));
    const { report } = restoreImportedText(pulled(), lookupOf(GLOAMWOOD_SRD_SUBSET, [copy], entries));
    expect(report.restored).toBe(4);
    expect(report.missing).toEqual([{ book: GLOAMWOOD_TITLE, entryName: 'Ember Warden', part: 'Ember Ward' }]);
  });

  it('restores by title, kind, name and part from another copy of the book, counting differences', () => {
    const other = { ...gloamwoodSource('other'), fingerprint: 'not-the-same-book' };
    const builder = structuredClone(EXPECTED_MERGED) as BuilderData;
    for (const cls of builder.classes) {
      for (const sub of cls.subclasses) {
        if (sub.source) sub.source = { ...sub.source, sourceId: 'other' };
        if (sub.name === 'Ember Warden') {
          sub.id = 'lib:other:subclass:ember-warden';
          sub.features[0] = { ...sub.features[0], description: `${sub.features[0].description} (Second printing.)` };
        }
      }
    }
    const pulledEmber = { ...pulled(), features: pulled().features.filter((f) => f.id === 'f1') };
    const { character, report } = restoreImportedText(pulledEmber, lookupOf(builder, [other]));
    expect(report).toEqual({ restored: 1, differs: 1, missing: [] });
    expect(character.features[0].description).toBe(`${emberWard.description} (Second printing.)`);
    // Ids in refs are never rewritten.
    expect(character.features[0].ref).toMatchObject({ sourceId: 'gloam', entryId: 'lib:gloam:subclass:ember-warden' });
  });

  it('restores by a unique text match anywhere, and not when two options share it', () => {
    const builder = structuredClone(EXPECTED_MERGED) as BuilderData;
    const feat = builder.feats.find((f) => f.name === "Moth's Grace");
    if (!feat?.source) throw new Error('fixture changed');
    feat.id = 'lib:renamed:35';
    feat.source = { ...feat.source, sourceId: 'renamed', title: 'Gloamwood (old copy)' };
    const one = { ...pulled(), features: pulled().features.filter((f) => f.id === 'f4') };
    expect(restoreImportedText(one, lookupOf(builder)).report).toEqual({ restored: 1, differs: 0, missing: [] });
    builder.feats.push({ ...feat, id: 'lib:third:35', source: { ...feat.source, sourceId: 'third' } });
    expect(restoreImportedText(one, lookupOf(builder)).report.missing).toHaveLength(1);
  });

  it('lists what it could not restore and keeps the placeholder', () => {
    const c = pulled();
    const { character, report } = restoreImportedText(c, lookupOf(GLOAMWOOD_SRD_SUBSET));
    expect(character).toBe(c);
    expect(report.restored).toBe(0);
    expect(report.missing).toEqual([
      { book: GLOAMWOOD_TITLE, entryName: 'Ember Warden', part: 'Ember Ward' },
      { book: GLOAMWOOD_TITLE, entryName: 'Mothkin', part: 'Dusk Sight' },
      { book: GLOAMWOOD_TITLE, entryName: 'Mothkin', part: 'Ashwing' },
      { book: GLOAMWOOD_TITLE, entryName: "Moth's Grace" },
      { book: GLOAMWOOD_TITLE, entryName: 'Ferry Hand', part: "Ferryman's Right" },
    ]);
  });

  it('never overwrites text the player or DM wrote, and leaves SRD features alone', () => {
    const base = sampleCharacter();
    const written: Feature = { ...copied[0], description: 'My own notes on Ember Ward.' };
    const c = { ...base, features: [...base.features, written] };
    const { character, report } = restoreImportedText(c, lookupOf(EXPECTED_MERGED));
    expect(character).toBe(c);
    expect(report).toEqual({ restored: 0, differs: 0, missing: [] });
    // An empty description with copied text comes back too.
    const empty = { ...base, features: [{ ...copied[1], description: '' }] };
    expect(restoreImportedText(empty, lookupOf(EXPECTED_MERGED)).character.features[0].description).toBe(duskSight.description);
  });

  it('P3: a ruling the DM wrote over a pulled placeholder needs nothing, though its ref still says redacted', () => {
    const base = sampleCharacter();
    const ruling: Feature = { ...copied[0], description: 'DM ruling: once per turn, add 1d4 fire damage.', ref: { ...emberWard.ref!, redacted: true } };
    expect(featureNeedsRestore(ruling)).toBe(false);
    expect(featureNeedsRestore({ ...ruling, description: placeholder })).toBe(true);
    const c = { ...base, features: [...base.features, ruling] };
    const { character, report } = restoreImportedText(c, lookupOf(EXPECTED_MERGED, [gloamwoodSource()], gloamwoodEntries()));
    expect(character).toBe(c);
    expect(report).toEqual({ restored: 0, differs: 0, missing: [] });
  });
});

// ---------------------------------------------------------------------------
// P1: a fighting style the class feature prints itself (spec §5.6 fighting-style-inline). The builder and
// level-up copy only the chosen style, as a feature named for it, under the Fighting Style feature's ref
// (part "Fighting Style", the whole feature's span) with the style's own text hash. Invented book.
// ---------------------------------------------------------------------------

const LAMP_TITLE = 'The Lampwarden Codex';
const HOOKED_PULL = 'When you hit a creature with a reach weapon, you can pull it up to 5 feet closer to you.';
const LANTERN_GUARD = 'While you hold a lit lantern, you gain a +1 bonus to Armor Class.';
const STYLES = [`_**Hooked Pull.**_ ${HOOKED_PULL}`, `_**Lantern Guard.**_ ${LANTERN_GUARD}`];

/** A device with the Lampwarden structured (accepted) from its copy of the book: its merged data and Library. */
function lampwarden(sourceId: string, opts: { styles?: readonly string[]; fingerprint?: string; title?: string } = {}) {
  const styles = opts.styles ?? STYLES;
  const title = opts.title ?? LAMP_TITLE;
  const entries: CompendiumEntry[] = [
    { id: `lib:${sourceId}:1`, sourceId, sourceName: title, kind: 'other', name: 'Lampwarden', text: '# Lampwarden\n\nLampwardens keep the lanterns lit along the old roads.' },
    {
      id: `lib:${sourceId}:2`,
      sourceId,
      sourceName: title,
      kind: 'rule',
      name: 'Level 1: Fighting Style',
      text: ['### Level 1: Fighting Style', 'Lampwardens learn one way of fighting by lantern light. Choose one of the options below.', ...styles].join('\n\n'),
    },
  ];
  const fingerprint = opts.fingerprint ?? bookFingerprint(entries.map((e) => e.text));
  const source: LibrarySource = { id: sourceId, title, kind: 'import', format: 'markdown', enabled: true, entryCount: entries.length, createdAt: 1, updatedAt: 1, fingerprint };
  const { spellcastingAbility: _ability, spellNames: _spells, ...wickwright } = EXPECTED_DATA.Wickwright as ClassData;
  const data: ClassData = { ...wickwright, casterType: 'none', features: [{ level: 1, name: 'Fighting Style', text: { entryIds: [`lib:${sourceId}:2`], from: 1, to: 2 + styles.length } }] };
  const record = structuredRecord('class', 'Lampwarden', { entryIds: entries.map((e) => e.id), span: 'section', status: 'accepted', data }, sourceId);
  const entriesById = new Map(entries.map((e) => [e.id, e]));
  const merged = mergeBuilderData(GLOAMWOOD_SRD_SUBSET, importedOptions({ version: 1, sources: [source], entriesById, accepted: [record] }));
  const def = merged.data.classes.find((c) => c.name === 'Lampwarden')?.features.find((f) => f.name === 'Fighting Style');
  if (merged.problems.length || !def?.ref) throw new Error('lampwarden fixture: the class did not merge');
  return { def: def as ClassFeatureDef & { ref: ImportedRef }, source, entries, lookup: lookupOf(merged.data, [source], entries) };
}

/** The hero's Fighting Style and chosen Hooked Pull as copied on the first device, as another device pulls them. */
function pulledLampwarden(refFor?: (def: ClassFeatureDef & { ref: ImportedRef }) => ImportedRef): Character {
  const { def } = lampwarden('lw');
  const pull = inlineFightingStyles(def).find((s) => s.name === 'Hooked Pull');
  if (pull?.description !== HOOKED_PULL) throw new Error('lampwarden fixture: no Hooked Pull');
  const pullRef = refFor ? refFor(def) : { ...def.ref, textHash: textFingerprint(HOOKED_PULL), textCopied: true };
  const left = (ref: ImportedRef) => ({ description: importedPlaceholder(LAMP_TITLE), ref: { ...ref, redacted: true as const } });
  const base = sampleCharacter();
  return {
    ...base,
    features: [
      ...base.features,
      { id: 'f-style', name: 'Fighting Style', source: 'class', sourceName: 'Lampwarden 1', ...left(def.ref) },
      { id: 'f-pull', name: 'Hooked Pull', source: 'class', sourceName: 'Fighting Style (Lampwarden 1)', ...left(pullRef) },
    ],
  };
}
const textOf = (c: Character, id: string) => c.features.find((f) => f.id === id)?.description;

describe('P1: an inline fighting style restores only its own text, never the whole Fighting Style feature', () => {
  it('P1: by option id (step 1) the style gets its own words and the class feature its whole text', () => {
    const device = lampwarden('lw');
    const { character, report } = restoreImportedText(pulledLampwarden(), device.lookup);
    expect(report).toEqual({ restored: 2, differs: 0, missing: [] });
    expect(textOf(character, 'f-pull')).toBe(HOOKED_PULL);
    expect(textOf(character, 'f-style')).toBe(device.def.description);
    expect(textOf(character, 'f-style')).toContain(LANTERN_GUARD);
    for (const id of ['f-pull', 'f-style']) expect(character.features.find((f) => f.id === id)?.ref?.redacted).toBeUndefined();
  });

  it('P1: from the book imported but never structured (step 2: its fingerprint and location)', () => {
    const copy = lampwarden('copy');
    const { character, report } = restoreImportedText(pulledLampwarden(), lookupOf(GLOAMWOOD_SRD_SUBSET, [copy.source], copy.entries));
    expect(report).toEqual({ restored: 2, differs: 0, missing: [] });
    expect(textOf(character, 'f-pull')).toBe(HOOKED_PULL);
  });

  it('P1: from another copy by title (step 3) or the same words anywhere (step 4); a copy that reads differently gives only that style', () => {
    const other = lampwarden('other', { fingerprint: 'another-printing' });
    expect(textOf(restoreImportedText(pulledLampwarden(), other.lookup).character, 'f-pull')).toBe(HOOKED_PULL);
    const renamedBook = lampwarden('renamed', { fingerprint: 'another-printing', title: 'Lampwarden Codex (old copy)' });
    expect(textOf(restoreImportedText(pulledLampwarden(), renamedBook.lookup).character, 'f-pull')).toBe(HOOKED_PULL);
    const reprint = `When you hit a creature with a reach weapon, you can pull it up to 10 feet closer to you.`;
    const second = lampwarden('second', { fingerprint: 'another-printing', styles: [`_**Hooked Pull.**_ ${reprint}`, STYLES[1]] });
    const { character, report } = restoreImportedText(pulledLampwarden(), second.lookup);
    expect(textOf(character, 'f-pull')).toBe(reprint);
    expect(report).toEqual({ restored: 2, differs: 2, missing: [] });
  });

  it('P1: stays missing when the copy no longer prints that style (a renamed one with the same words still comes back)', () => {
    const without = lampwarden('lw', { styles: ['_**Hook and Drag.**_ When you hit, you drag the target along with you.', STYLES[1]] });
    const { character, report } = restoreImportedText(pulledLampwarden(), without.lookup);
    expect(textOf(character, 'f-pull')).toBe(importedPlaceholder(LAMP_TITLE));
    expect(report.missing).toEqual([{ book: LAMP_TITLE, entryName: 'Lampwarden', part: 'Fighting Style' }]);
    const renamed = lampwarden('lw', { styles: [`_**Hook and Pull.**_ ${HOOKED_PULL}`, STYLES[1]] });
    expect(textOf(restoreImportedText(pulledLampwarden(), renamed.lookup).character, 'f-pull')).toBe(HOOKED_PULL);
  });

  it('P1: a ref that names the style itself as its part, at the style’s own paragraph, restores at every step', () => {
    const ownPart = (def: ClassFeatureDef & { ref: ImportedRef }): ImportedRef => ({
      ...def.ref,
      part: 'Hooked Pull',
      at: { ordinals: def.ref.at?.ordinals ?? [], from: 3, to: 3 },
      textHash: textFingerprint(HOOKED_PULL),
      textCopied: true,
    });
    // Step 1 alone (this device's merged data, no Library to fall back on): the style is a part of the class.
    const builderOnly = lookupOf(lampwarden('lw').lookup.builder);
    const byId = restoreImportedText(pulledLampwarden(ownPart), builderOnly);
    expect(textOf(byId.character, 'f-pull')).toBe(HOOKED_PULL);
    expect(byId.report).toEqual({ restored: 2, differs: 0, missing: [] });
    const copy = lampwarden('copy');
    const unstructured = restoreImportedText(pulledLampwarden(ownPart), lookupOf(GLOAMWOOD_SRD_SUBSET, [copy.source], copy.entries));
    expect(textOf(unstructured.character, 'f-pull')).toBe(HOOKED_PULL);
    expect(unstructured.report).toEqual({ restored: 2, differs: 0, missing: [] });
  });
});
