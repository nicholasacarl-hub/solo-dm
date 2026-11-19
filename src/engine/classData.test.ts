/**
 * SRD class lookups (SRD 5.2.1 "Classes"): an imported class with an SRD class's name is not that SRD
 * class for its numbers (hit die, level-up reminders); a 2024 book's class plays by its rules (rulesClassFor).
 */
import { describe, expect, it } from 'vitest';
import type { ImportedRef, SourceFormat } from '@/types';
import { findSrdClass, isLibraryId, rulesClassFor, srdClassFor } from './classData';

describe('srdClassFor', () => {
  it('finds SRD classes by id, and by name for entries without an SRD id', () => {
    expect(srdClassFor({ classId: 'srd:class:fighter', name: 'Fighter' })?.name).toBe('Fighter');
    expect(srdClassFor({ classId: 'class:fighter', name: 'Fighter' })?.name).toBe('Fighter');
    expect(findSrdClass('srd:class:wizard')?.hitDie).toBe(6);
  });

  it('never gives an imported class the SRD class of the same name', () => {
    expect(isLibraryId('lib:gloam:class:fighter')).toBe(true);
    expect(srdClassFor({ classId: 'lib:gloam:class:fighter', name: 'Fighter' })).toBeUndefined();
    expect(srdClassFor({ classId: 'lib:gloam:7', name: 'Barbarian' })).toBeUndefined();
  });
});

describe('rulesClassFor', () => {
  const ref = (format?: SourceFormat): ImportedRef => ({
    sourceId: 'lamp', sourceTitle: 'The Lamp Folio', entryId: 'lib:lamp:class:monk', kind: 'class', entryName: 'Monk', textHash: '', textCopied: false, ...(format ? { format } : {}),
  });
  const bookMonk = (format?: SourceFormat, name = 'Monk') => ({ classId: 'lib:lamp:class:monk', name, ref: ref(format) });

  it("gives a 2024 book's class the SRD class of its name (SRD 5.2.1 is drawn from the 2024 rules)", () => {
    expect(rulesClassFor({ classId: 'srd:class:monk', name: 'Monk' })?.name).toBe('Monk');
    expect(rulesClassFor(bookMonk('2024'))?.name).toBe('Monk');
    expect(rulesClassFor(bookMonk('2024', 'MONK'))?.id).toBe('srd:class:monk');
    // Its numbers (hit die, reminders) still come from its own data.
    const entry = bookMonk('2024');
    expect(srdClassFor(entry)).toBeUndefined();
  });

  it("never an older-edition or other book's class, one without an edition, or a name no SRD class has", () => {
    for (const format of ['2014', 'other', undefined] as const) expect(rulesClassFor(bookMonk(format))).toBeUndefined();
    expect(rulesClassFor({ classId: 'lib:lamp:class:monk', name: 'Monk' })).toBeUndefined();
    expect(rulesClassFor(bookMonk('2024', 'Lampwright'))).toBeUndefined();
  });
});
