/**
 * The review's name-collision notice (spec §3.9.2): what accepting a record that shares an SRD name does,
 * by its edition and kind. Invented names only.
 */
import { describe, expect, it } from 'vitest';
import { SRD_SOURCE_ID } from '@/types';
import { nameNotices, noticeIndex } from './notices';

const index = noticeIndex([
  { sourceId: SRD_SOURCE_ID, sourceName: 'SRD 5.2.1', name: 'Lamp Warden', kind: 'class' },
  { sourceId: SRD_SOURCE_ID, sourceName: 'SRD 5.2.1', name: 'Gloom Drake', kind: 'monster' },
]);
const notice = (kind: 'class' | 'monster', name: string, format: string) =>
  nameNotices({ kind, name, sourceId: 'gloam', data: { format } }, index).find((w) => w.code === 'name-collision')?.message ?? '';

describe('nameNotices: a record named like an SRD entry', () => {
  it("says a 2024 option takes the SRD's place in the builder and level-up, and an older one sits beside it", () => {
    expect(notice('class', 'Lamp Warden', '2024')).toContain("The character builder and level-up offer it in place of the SRD's");
    expect(notice('class', 'Lamp Warden', '2014')).toContain("The character builder offers it beside the SRD's.");
    expect(notice('class', 'Lamp Warden', '2014')).not.toContain('in place of');
  });

  it('says nothing about lists for a kind no list offers (a monster)', () => {
    const text = notice('monster', 'Gloom Drake', '2024');
    expect(text).toContain('combat and the DM use this book');
    expect(text).not.toContain('character builder');
  });
});
