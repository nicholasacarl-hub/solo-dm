/**
 * Where to end a cut of `text` so it never splits a surrogate pair: `end`, or one unit earlier when the units at
 * `end - 1` and `end` are the two halves of one character (an emoji). A lone half is not valid text, and a request
 * carrying one can be refused.
 */
export function safeEnd(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return end;
  const high = text.charCodeAt(end - 1);
  const low = text.charCodeAt(end);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? end - 1 : end;
}

/** Characters (code points), not UTF-16 units: an emoji counts once. Linear, no allocation. */
export function codePoints(text: string): number {
  let n = text.length;
  for (let i = 0; i < text.length - 1; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n--;
        i++;
      }
    }
  }
  return n;
}
