/**
 * The queue of notes the DM hears with its next turn ("Notes from the app since your last turn"): which notes are new
 * and what a merge keeps. Pure; shared by the game store (memory) and storage (the campaign record, which the Library
 * and other tabs add to), so all of them keep the same notes in the same order.
 *
 * A note is only its text, and one text can be two events: a change made, undone and made again on the sheet ("Player
 * gained Heroic Inspiration", "…spent…", "…gained…") is three notes, or the last thing the DM hears is the undo while
 * the sheet shows the change. So a repeat is a new note, unless it repeats the newest note still waiting: that is the
 * same note sent again (a retry, a second tap), not news.
 */

/** True when `notice` is the newest of the notes still waiting: sending it again is a retry, not a new note. */
export function repeatsNewest(waiting: readonly string[], notice: string): boolean {
  return waiting.length > 0 && waiting[waiting.length - 1] === notice;
}

/**
 * The notes in `stored` beyond `seen`, in order: `stored` less, for each text, as many of its earliest copies as
 * `seen` holds. Other writers only add notes to the end of the stored list (the tab at the table rewrites it, and
 * records what it wrote), so when `seen` is the list as it stood, these are exactly the notes added since, a repeat of
 * one in `seen` included. Copies are matched by count, never by text alone, so a repeat also survives a list that was
 * rewritten meanwhile.
 */
export function noticesAddedSince(stored: readonly string[], seen: readonly string[]): string[] {
  const unmatched = new Map<string, number>();
  for (const notice of seen) unmatched.set(notice, (unmatched.get(notice) ?? 0) + 1);
  return stored.filter((notice) => {
    const left = unmatched.get(notice) ?? 0;
    if (left > 0) unmatched.set(notice, left - 1);
    return left === 0;
  });
}

/** `notices` without the last copy of `notice` (the one that stands for a note the caller already holds). */
export function withoutNewestCopy(notices: readonly string[], notice: string): string[] {
  const at = notices.lastIndexOf(notice);
  return at < 0 ? [...notices] : [...notices.slice(0, at), ...notices.slice(at + 1)];
}
