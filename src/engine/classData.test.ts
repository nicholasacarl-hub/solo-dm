/**
 * SRD class lookups (SRD 5.2.1 "Classes"): an imported class with an SRD class's name is not that SRD
 * class, so it gets no SRD reminders, critical range, Unarmored Defense or Hit Point rules.
 */
import { describe, expect, it } from 'vitest';
import { findSrdClass, isLibraryId, srdClassFor } from './classData';

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
