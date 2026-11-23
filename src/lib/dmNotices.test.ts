import { describe, expect, it } from 'vitest';
import { noticesAddedSince, repeatsNewest, withoutNewestCopy } from './dmNotices';

const gained = 'Player gained Heroic Inspiration';
const spent = 'Player spent Heroic Inspiration';

describe('repeatsNewest', () => {
  it('is a retry only when the notice is the newest one waiting', () => {
    expect(repeatsNewest([], gained)).toBe(false);
    expect(repeatsNewest([gained], gained)).toBe(true);
    expect(repeatsNewest([spent, gained], gained)).toBe(true);
    // Made, undone and made again: a new notice, so the DM's last word is the change, not the undo.
    expect(repeatsNewest([gained, spent], gained)).toBe(false);
  });
});

describe('noticesAddedSince', () => {
  it('is what was added after the list the caller saw, a repeat of a notice it saw included', () => {
    expect(noticesAddedSince([gained, spent, gained], [gained, spent])).toEqual([gained]);
    expect(noticesAddedSince([gained, spent], [gained, spent])).toEqual([]);
    expect(noticesAddedSince(['A', 'B', 'A', 'C'], ['A'])).toEqual(['B', 'A', 'C']);
    expect(noticesAddedSince([gained, gained], [])).toEqual([gained, gained]);
  });

  it('leaves out what the caller saw that is gone (delivered), and matches copies by count, not text', () => {
    expect(noticesAddedSince([], [gained, spent])).toEqual([]);
    expect(noticesAddedSince(['C'], [gained, spent])).toEqual(['C']);
    // Rewritten since the caller looked (another tab saved): one copy of each it saw is matched, the repeat is kept.
    expect(noticesAddedSince([spent, gained, gained], [gained, spent])).toEqual([gained]);
  });
});

describe('withoutNewestCopy', () => {
  it('takes out the last copy only', () => {
    expect(withoutNewestCopy([gained, spent, gained], gained)).toEqual([gained, spent]);
    expect(withoutNewestCopy([gained, spent], 'Player renamed a quest.')).toEqual([gained, spent]);
    expect(withoutNewestCopy([], gained)).toEqual([]);
  });
});
