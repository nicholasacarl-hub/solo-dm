/**
 * The review's name-collision notice (spec §3.9.2): what accepting a record that shares an SRD name does,
 * by kind. Invented names only.
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
  const RULE = "If its Edition is 2024, the lists a player chooses from show it in place of the SRD's.";

  it('says what a 2024 option does in the lists a player chooses from', () => {
    expect(notice('class', 'Lamp Warden', '2024')).toBe(
      `The SRD also has a class called “Lamp Warden”. Once you accept this one, combat and the DM use this book's version when they look that name up. ${RULE} Both stay in the Library.`,
    );
    for (const kind of ['subclass', 'species', 'feat'] as const) expect(notice(kind, { subclass: 'Wick Oath', species: 'Mothfolk', feat: 'Lamp Ward' }[kind], '2014')).toContain(RULE);
  });

  it('stays true when review changes the Edition or a feat’s category (the notice is kept as written)', () => {
    expect(notice('class', 'Lamp Warden', '2014')).toBe(notice('class', 'Lamp Warden', '2024'));
    expect(notice('feat', 'Lamp Ward', '2024', { category: 'general' })).toBe(notice('feat', 'Lamp Ward', '2014', { category: 'origin' }));
  });

  it('says nothing about lists for a kind no list offers (a monster)', () => {
    const text = notice('monster', 'Gloom Drake', '2024');
    expect(text).toContain('combat and the DM use this book');
    expect(text).not.toContain('lists');
  });
});
