/**
 * Merged builder data (spec §5.1): the Gloamwood fixture's accepted options merged onto an SRD subset.
 * Original invented content only (src/test/structuredFixtures.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_MERGED,
  GLOAMWOOD_SRD_SUBSET,
  GLOAMWOOD_TITLE,
  gloamwoodSnapshot,
  gloamwoodSource,
  structuredRecord,
} from '@/test/structuredFixtures';
import type { BuilderData, ClassData, ImportedRef, StructuredRecord } from '@/types';
import { importedOptions, mergeBuilderData } from './merge';

const merged = () => mergeBuilderData(GLOAMWOOD_SRD_SUBSET, importedOptions(gloamwoodSnapshot()));

/** Every ref in a value, with the path that leads to it. */
function refsIn(value: unknown, path = ''): { path: string; ref: ImportedRef }[] {
  if (!value || typeof value !== 'object') return [];
  const out: { path: string; ref: ImportedRef }[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === 'ref' && child && typeof child === 'object') out.push({ path, ref: child as ImportedRef });
    else out.push(...refsIn(child, `${path}/${key}`));
  }
  return out;
}

describe('mergeBuilderData(importedOptions(snapshot))', () => {
  it('equals the hand-written merged data of the fixture', () => {
    const { data, problems } = merged();
    expect(problems).toEqual([]);
    expect(data).toEqual(EXPECTED_MERGED);
  });

  it('attaches Ember Warden to a clone of the SRD Fighter and never changes the SRD object', () => {
    expect(Object.isFrozen(GLOAMWOOD_SRD_SUBSET.classes[1])).toBe(true);
    const before = JSON.stringify(GLOAMWOOD_SRD_SUBSET);
    const { data } = merged();
    const fighter = data.classes.find((c) => c.id === 'srd:class:fighter');
    expect(fighter).not.toBe(GLOAMWOOD_SRD_SUBSET.classes[1]);
    expect(fighter?.subclasses.map((s) => s.name)).toEqual(['Champion', 'Ember Warden']);
    expect(GLOAMWOOD_SRD_SUBSET.classes[1].subclasses.map((s) => s.name)).toEqual(['Champion']);
    expect(JSON.stringify(GLOAMWOOD_SRD_SUBSET)).toBe(before);
    // Untouched SRD lists are the same arrays' items, not copies.
    expect(data.feats.slice(0, GLOAMWOOD_SRD_SUBSET.feats.length)).toEqual(GLOAMWOOD_SRD_SUBSET.feats);
  });

  it('returns the SRD object itself when nothing is imported', () => {
    const empty = { ...gloamwoodSnapshot(), accepted: [] };
    const { data, problems } = mergeBuilderData(GLOAMWOOD_SRD_SUBSET, importedOptions(empty));
    expect(data).toBe(GLOAMWOOD_SRD_SUBSET);
    expect(problems).toEqual([]);
  });

  it('leaves out a subclass whose class is not accepted, with a problem', () => {
    const snapshot = gloamwoodSnapshot();
    const accepted = snapshot.accepted.filter((r) => r.name !== 'Wickwright');
    const { data, problems } = mergeBuilderData(GLOAMWOOD_SRD_SUBSET, importedOptions({ ...snapshot, accepted }));
    expect(data.classes.map((c) => c.name)).toEqual(['Cleric', 'Fighter']);
    expect(problems).toEqual([
      {
        recordId: 'rec:gloam:subclass:order-of-the-long-wick',
        sourceTitle: GLOAMWOOD_TITLE,
        kind: 'subclass',
        name: 'Order of the Long Wick',
        message: "Its class, Wickwright, isn't accepted yet or its book is switched off.",
      },
    ]);
  });

  it('keeps an imported "Fighter" next to the SRD Fighter (ids differ)', () => {
    const snapshot = gloamwoodSnapshot();
    const wick = snapshot.accepted.find((r) => r.name === 'Wickwright') as StructuredRecord<'class'>;
    const fighter = structuredRecord('class', 'Fighter', {
      ...wick,
      id: 'rec:gloam:class:fighter',
      name: 'Fighter',
      publicId: 'lib:gloam:class:fighter',
      data: { ...(wick.data as ClassData), primaryAbilityRule: 'any' },
    });
    const { data } = mergeBuilderData(GLOAMWOOD_SRD_SUBSET, importedOptions({ ...snapshot, accepted: [...snapshot.accepted, fighter] }));
    const fighters = data.classes.filter((c) => c.name === 'Fighter');
    expect(fighters.map((c) => c.id)).toEqual(['srd:class:fighter', 'lib:gloam:class:fighter']);
    expect(fighters[1].source?.title).toBe(GLOAMWOOD_TITLE);
    expect(fighters[0].source).toBeUndefined();
  });

  it('puts a ref with textHash, location and the book fingerprint on every copied text', () => {
    const { data } = merged();
    const imported: Partial<BuilderData> = {
      classes: data.classes.map((c) => ({ ...c, features: c.source ? c.features : [], subclasses: c.subclasses.filter((s) => s.source) })),
      species: data.species,
      backgrounds: data.backgrounds,
      feats: data.feats.filter((f) => f.source),
    };
    const refs = refsIn(imported);
    // Class features 4 + Order 2 + Ember Warden 3 + Dusk Domain 3; species 5 + 5; Ferryman's Right; 4 feats.
    expect(refs.length).toBe(12 + 10 + 1 + 4);
    const fingerprint = gloamwoodSource().fingerprint;
    for (const { path, ref } of refs) {
      expect({ path, textCopied: ref.textCopied, fingerprint: ref.bookFingerprint }).toEqual({ path, textCopied: true, fingerprint });
      expect(ref.textHash, path).toMatch(/^[0-9a-f]{16}$/);
      expect(ref.at?.ordinals.length, path).toBe(1);
    }
  });

  it('moves early older-format features only on the attached copy', () => {
    const options = importedOptions(gloamwoodSnapshot());
    const dusk = options.subclasses.find((s) => s.option.name === 'Dusk Domain');
    expect(dusk?.option.features.map((f) => f.level)).toEqual([1, 2, 6]);
    expect(dusk?.option.source?.adaptations).toEqual([]);
    const cleric = mergeBuilderData(GLOAMWOOD_SRD_SUBSET, options).data.classes.find((c) => c.id === 'srd:class:cleric');
    const attached = cleric?.subclasses.find((s) => s.name === 'Dusk Domain');
    expect(attached?.features.map((f) => [f.level, f.ref?.level])).toEqual([
      [3, 3],
      [3, 3],
      [6, 6],
    ]);
    expect(attached?.firstLevel).toBe(1);
    expect(attached?.source?.adaptations.map((a) => a.code)).toEqual(['subclass-early-features', 'subclass-overlap']);
  });

  it("gives Warden's Mail the Chain Mail's stats and its +1 as magic (applied once, by the engine)", () => {
    const { data } = merged();
    const chainMail = data.equipment.find((e) => e.id === 'srd:item:chain-mail');
    const mail = data.equipment.find((e) => e.name === "Warden's Mail");
    expect(mail).toMatchObject({ category: 'armor', armorClass: chainMail?.armorClass, armorType: 'heavy', strengthRequirement: 13 });
    expect(mail?.magic).toEqual({ rarity: 'rare', attunement: false, bonuses: { ac: 1 }, baseItemId: 'srd:item:chain-mail' });
    // Items without a fixed base and without AC or save bonuses stay out of the catalog.
    expect(data.equipment.some((e) => e.name === 'Lantern of Hollow Light')).toBe(false);
  });
});
