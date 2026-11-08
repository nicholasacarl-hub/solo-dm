/**
 * Token labels (spec §7.7): the initials of up to two words plus a trailing number — "Goblin 2" → "G2",
 * "Bandit Captain" → "BC", "Mira Voss" → "MV" — at most 4 characters. When two creatures would share a label,
 * their first words grow a letter at a time ("Ba1" / "Br1") until the labels differ (or can't grow). Deterministic:
 * the same names in the same order always give the same labels.
 */

const MAX_LABEL = 4;

interface Parts {
  words: string[];
  number: string;
}

function parts(name: string): Parts {
  const trimmed = name.replace(/\s+/g, ' ').trim();
  const numbered = /^(.*?)\s*(\d+)$/.exec(trimmed);
  const base = numbered ? numbered[1] : trimmed;
  const words = base
    .split(/[\s\-–—_/]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  return { words, number: numbered ? numbered[2] : '' };
}

/** The label with `letters` letters of the first word (1 = plain initials), the second word's initial and the number. */
function labelWith(p: Parts, letters: number): string {
  const [first = '', second] = p.words;
  const tail = second ? second[0].toUpperCase() : '';
  const room = Math.max(1, MAX_LABEL - p.number.length - tail.length);
  const head = first.slice(0, Math.min(letters, room));
  const lead = head ? head[0].toUpperCase() + head.slice(1).toLowerCase() : '';
  return (`${lead}${tail}${p.number}` || '?').slice(0, MAX_LABEL);
}

/** Labels for every creature on the map, keyed by id (pass them in initiative order). */
export function tokenLabels(creatures: readonly { id: string; name: string }[]): Map<string, string> {
  const parsed = creatures.map((c) => ({ id: c.id, parts: parts(c.name), letters: 1 }));
  for (let round = 0; round < MAX_LABEL; round++) {
    const current = parsed.map((c) => labelWith(c.parts, c.letters));
    const counts = new Map<string, number>();
    for (const l of current) counts.set(l, (counts.get(l) ?? 0) + 1);
    let grew = false;
    parsed.forEach((c, i) => {
      if ((counts.get(current[i]) ?? 0) < 2) return;
      if (labelWith(c.parts, c.letters + 1) === current[i]) return;
      c.letters += 1;
      grew = true;
    });
    if (!grew) break;
  }
  // Whatever still clashes (identical names) keeps its label: the card and the list tell them apart.
  return new Map(parsed.map((c) => [c.id, labelWith(c.parts, c.letters)]));
}
