import { describe, expect, it } from 'vitest';
import { bookPageSearch, readBookPageState } from './useBookPageState';

describe('book page URL state', () => {
  it('reads defaults from an empty query', () => {
    expect(readBookPageState(new URLSearchParams())).toEqual({ view: 'review', recordId: null, filter: 'review', kind: null, q: '', setup: false });
  });

  it('reads every parameter and ignores unknown values', () => {
    const state = readBookPageState(new URLSearchParams('view=entries&c=rec%3Agloam%3Aspell%3Aashen-choir&f=fix&k=spell&q=ash&setup=1'));
    expect(state).toEqual({ view: 'entries', recordId: 'rec:gloam:spell:ashen-choir', filter: 'fix', kind: 'spell', q: 'ash', setup: true });
    expect(readBookPageState(new URLSearchParams('f=bogus&k=dragon&view=nope'))).toMatchObject({ filter: 'review', kind: null, view: 'review' });
  });

  it('writes a patch on top of the current state, leaving defaults out', () => {
    const current = new URLSearchParams('f=fix&k=monster');
    expect(bookPageSearch(current, { recordId: 'rec:gloam:monster:glimmerwing-drake' })).toBe('?c=rec%3Agloam%3Amonster%3Aglimmerwing-drake&f=fix&k=monster');
    expect(bookPageSearch(current, { filter: 'review', kind: null })).toBe('');
    expect(bookPageSearch(new URLSearchParams('setup=1'), { setup: false })).toBe('');
  });
});
