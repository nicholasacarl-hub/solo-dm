/**
 * A hero's imported classes' editions (data/options/editions.ts), which the engine's class rules read: kept in step
 * with the class's own record, never taken from another book's class of the name; and Draconic Resilience's Hit
 * Points owed once a 2024 book's Sorcerer plays by the SRD's rules (SRD 5.2.1 Draconic Sorcery). Invented books only.
 */
import { describe, expect, it } from 'vitest';
import { sampleCharacter } from '@/test/fixtures';
import { EXPECTED_MERGED, importedRef } from '@/test/structuredFixtures';
import type { Character, ClassLevel, ClassOption, OptionSource, SourceFormat } from '@/types';
import { hitPointsOwedForEditions, withClassEditions } from './editions';

const wick = EXPECTED_MERGED.classes.find((c) => c.id === 'lib:gloam:class:wickwright') as ClassOption;
const fingerprint = wick.features.find((f) => f.ref?.bookFingerprint)?.ref?.bookFingerprint as string;
const entry = (format?: SourceFormat, patch: Partial<ClassLevel> = {}): ClassLevel => ({
  classId: wick.id,
  name: 'Wickwright',
  level: 2,
  hitDie: 8,
  casterType: 'half',
  ref: { ...importedRef({ entryId: wick.id, kind: 'class', entryName: 'Wickwright', part: undefined, bookFingerprint: fingerprint }), ...(format ? { format } : {}) },
  ...patch,
});
const hero = (...classes: ClassLevel[]): Character => ({ ...sampleCharacter(), classes: [{ classId: 'srd:class:fighter', name: 'Fighter', level: 1, hitDie: 10, casterType: 'none' }, ...classes] });
const of = (book: ClassOption, sourceId: string, format: SourceFormat, bookFingerprint: string): ClassOption => ({
  ...book,
  id: `lib:${sourceId}:class:wickwright`,
  source: { ...(book.source as OptionSource), sourceId, format },
  features: book.features.map((f) => ({ ...f, ...(f.ref ? { ref: { ...f.ref, sourceId, bookFingerprint } } : {}) })),
});

describe('withClassEditions', () => {
  it("records each imported class's edition from its own record: a hero made before refs did, an Edition changed in review", () => {
    expect(wick.source?.format).toBe('2024');
    expect(withClassEditions(hero(entry()), EXPECTED_MERGED.classes).classes[1].ref?.format).toBe('2024');
    expect(withClassEditions(hero(entry('2014')), EXPECTED_MERGED.classes).classes[1].ref?.format).toBe('2024');
    const older = { ...wick, source: { ...(wick.source as OptionSource), format: '2014' as const } };
    expect(withClassEditions(hero(entry('2024')), [older]).classes[1].ref?.format).toBe('2014');
  });

  it("never takes another book's class of the name: a class whose book is off or gone keeps what it has", () => {
    // The hero's book is off; another book's Wickwright, in another edition, is on.
    const otherBook = of(wick, 'ember', '2014', 'fp-ember');
    for (const format of ['2024', '2014'] as const) {
      const kept = hero(entry(format));
      expect(withClassEditions(kept, [otherBook])).toBe(kept);
    }
    // Nor fill a missing one from it.
    const unknown = hero(entry());
    expect(withClassEditions(unknown, [otherBook])).toBe(unknown);
  });

  it("fills a missing edition from a copy of the same book's text (moved to another device), never overwrites one", () => {
    const moved = of(wick, 'g2', '2024', fingerprint);
    expect(withClassEditions(hero(entry()), [moved]).classes[1].ref?.format).toBe('2024');
    const recorded = hero(entry('2014'));
    expect(withClassEditions(recorded, [moved])).toBe(recorded);
  });

  it('returns the same character when nothing changes', () => {
    const current = hero(entry('2024'));
    expect(withClassEditions(current, EXPECTED_MERGED.classes)).toBe(current);
  });
});

describe('hitPointsOwedForEditions', () => {
  const sorcerer = (format: SourceFormat | undefined, level: number): ClassLevel => ({
    ...entry(format, { classId: 'lib:lamp:class:sorcerer', name: 'Sorcerer', level, hitDie: 6, casterType: 'full' }),
  });
  const resilient = (c: Character): Character => ({ ...c, features: [...c.features, { id: 'dr', name: 'Draconic Resilience', source: 'subclass', description: '' }] });

  it("owes Draconic Resilience's Hit Points once, when a hero made before refs recorded editions gets its book Sorcerer's", () => {
    // SRD 5.2.1 Draconic Sorcery, Sorcerer 5: 3 at level 3, then 1 at each of levels 4 and 5.
    expect(hitPointsOwedForEditions(resilient(hero(sorcerer(undefined, 5))), resilient(hero(sorcerer('2024', 5))))).toBe(5);
    // A 2014 book's Sorcerer plays by its own rules: nothing.
    expect(hitPointsOwedForEditions(resilient(hero(sorcerer(undefined, 5))), resilient(hero(sorcerer('2014', 5))))).toBe(0);
  });

  it('owes nothing without the feature or a change, and nothing for an Edition changed in review, either way or back again', () => {
    expect(hitPointsOwedForEditions(hero(sorcerer(undefined, 5)), hero(sorcerer('2024', 5)))).toBe(0);
    const same = resilient(hero(sorcerer('2024', 5)));
    expect(hitPointsOwedForEditions(same, same)).toBe(0);
    // 2024 → Older → 2024: the maximum kept what was given, so the way back owes nothing either.
    const [newer, older] = [resilient(hero(sorcerer('2024', 5))), resilient(hero(sorcerer('2014', 5)))];
    expect(hitPointsOwedForEditions(newer, older)).toBe(0);
    expect(hitPointsOwedForEditions(older, newer)).toBe(0);
  });
});
