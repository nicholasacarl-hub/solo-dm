/**
 * A 2024 book's option in place of the SRD option of the same name (options/replaced.ts): invented
 * books and options only.
 */
import { describe, expect, it } from 'vitest';
import type { OptionSource, SourceFormat } from '@/types';
import { replacesSrd, withoutReplacedSrd } from './replaced';

const book = (sourceId: string, format: SourceFormat): OptionSource => ({ sourceId, title: `The ${sourceId} Folio`, recordId: `rec:${sourceId}:x`, format, adaptations: [] });
const srd = (name: string): { id: string; name: string; source?: OptionSource } => ({ id: `srd:x:${name.toLowerCase()}`, name });
const from = (sourceId: string, format: SourceFormat, name: string) => ({ id: `lib:${sourceId}:x:${name.toLowerCase()}`, name, source: book(sourceId, format) });
const ids = (list: readonly { id: string }[]) => list.map((o) => o.id);

describe('withoutReplacedSrd', () => {
  const srdWarden = srd('Lamp Warden');
  const srdDrifter = srd('Drifter');
  const newWarden = from('ember', '2024', 'Lamp Warden');

  it('leaves out the SRD option a 2024 book’s option of the same name stands in for, whatever the case or spacing', () => {
    const shouting = { ...newWarden, name: '  LAMP   warden ' };
    expect(ids(withoutReplacedSrd([srdWarden, srdDrifter, newWarden]))).toEqual([srdDrifter.id, newWarden.id]);
    expect(ids(withoutReplacedSrd([srdWarden, srdDrifter, shouting]))).toEqual([srdDrifter.id, shouting.id]);
  });

  it('keeps the SRD option beside an older-edition or other-format book’s, and every book’s own options', () => {
    const olderWarden = from('ash', '2014', 'Lamp Warden');
    const otherWarden = from('reed', 'other', 'Lamp Warden');
    expect(ids(withoutReplacedSrd([srdWarden, olderWarden, otherWarden]))).toEqual([srdWarden.id, olderWarden.id, otherWarden.id]);
    // Two 2024 books with the name: both stay (their badges tell them apart); only the SRD's leaves.
    const secondWarden = from('cinder', '2024', 'Lamp Warden');
    expect(ids(withoutReplacedSrd([srdWarden, newWarden, secondWarden, olderWarden]))).toEqual([newWarden.id, secondWarden.id, olderWarden.id]);
  });

  it('never hides a kept id (the chosen option’s card stays), and ignores empty keeps', () => {
    expect(ids(withoutReplacedSrd([srdWarden, newWarden], [srdWarden.id]))).toEqual([srdWarden.id, newWarden.id]);
    expect(ids(withoutReplacedSrd([srdWarden, newWarden], [null, undefined, '']))).toEqual([newWarden.id]);
  });

  it('returns a copy of the list when no 2024 book shares a name', () => {
    const list = [srdWarden, srdDrifter];
    const out = withoutReplacedSrd(list);
    expect(out).toEqual(list);
    expect(out).not.toBe(list);
  });

  it('replacesSrd: only an imported option in the 2024 format', () => {
    expect(replacesSrd(newWarden)).toBe(true);
    expect(replacesSrd(srdWarden)).toBe(false);
    expect(replacesSrd(from('ash', '2014', 'Lamp Warden'))).toBe(false);
    expect(replacesSrd(from('reed', 'other', 'Lamp Warden'))).toBe(false);
  });
});
