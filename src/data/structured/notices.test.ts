/**
 * The review's name-collision notice (spec §3.9.2): what accepting a record that shares an SRD name does,
 * by its edition and kind. Invented names only.
 */
import { describe, expect, it } from 'vitest';
import { SRD_SOURCE_ID, type StructuredKind } from '@/types';
import { nameNotices, noticeIndex } from './notices';

const index = noticeIndex([
  { sourceId: SRD_SOURCE_ID, sourceName: 'SRD 5.2.1', name: 'Lamp Warden', kind: 'class' },
  { sourceId: SRD_SOURCE_ID, sourceName: 'SRD 5.2.1', name: 'Wick Oath', kind: 'subclass' },
  { sourceId: SRD_SOURCE_ID, sourceName: 'SRD 5.2.1', name: 'Mothfolk', kind: 'species' },
  { sourceId: SRD_SOURCE_ID, sourceName: 'SRD 5.2.1', name: 'Lamp Ward', kind: 'feat' },
  { sourceId: SRD_SOURCE_ID, sourceName: 'SRD 5.2.1', name: 'Gloom Drake', kind: 'monster' },
]);
const notice = (kind: StructuredKind, name: string, format: string, extra: Record<string, unknown> = {}) =>
  nameNotices({ kind, name, sourceId: 'gloam', data: { format, ...extra } }, index).find((w) => w.code === 'name-collision')?.message ?? '';

describe('nameNotices: a record named like an SRD entry', () => {
  it("says a 2024 option takes the SRD's place where it is chosen, and an older one sits beside it", () => {
    expect(notice('class', 'Lamp Warden', '2024')).toContain(`The character builder and level-up offer it in place of the SRD's (the builder's "SRD" filter still shows the SRD's).`);
    expect(notice('class', 'Lamp Warden', '2014')).toContain("The character builder and level-up offer it beside the SRD's.");
    expect(notice('class', 'Lamp Warden', '2014')).not.toContain('in place of');
  });

  it('names only the places that list the kind: level-up for a subclass or a General feat, the builder for a species or an Origin feat', () => {
    expect(notice('subclass', 'Wick Oath', '2024')).toContain("Level-up offers it in place of the SRD's.");
    expect(notice('subclass', 'Wick Oath', '2024')).not.toContain('builder');
    expect(notice('species', 'Mothfolk', '2014')).toContain("The character builder offers it beside the SRD's.");
    expect(notice('feat', 'Lamp Ward', '2024', { category: 'general' })).toContain("Level-up offers it in place of the SRD's.");
    expect(notice('feat', 'Lamp Ward', '2024', { category: 'origin' })).toContain(`The character builder offers it in place of the SRD's (the builder's "SRD" filter still shows the SRD's).`);
    expect(notice('feat', 'Lamp Ward', '2024', { category: 'fighting-style' })).toContain('The character builder and level-up offer it');
  });

  it('says nothing about lists for a kind no list offers (a monster)', () => {
    const text = notice('monster', 'Gloom Drake', '2024');
    expect(text).toContain('combat and the DM use this book');
    expect(text).not.toContain('character builder');
  });
});
