/**
 * Reading labeled values out of entry text for the entity parsers (spec §3.9): stat-block and spell
 * labels in SRD-style Markdown ("- **AC** 17", "**Casting Time:** Action", "**AC** 17 **Initiative** +2
 * (12)") and in a PDF text layer (no emphasis, no list markers: "AC 17 Initiative +2 (12)").
 * Values come back as printed, with Markdown emphasis left out (the excerpt rule of §3.7).
 *
 * Owner: E2. Pure.
 */

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Markdown emphasis and inline-code marks removed, whitespace collapsed. */
export const plain = (text: string): string => text.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();

/** A line without its list marker or quote marker. */
export const unbullet = (line: string): string => line.replace(/^\s*(?:>\s*)?(?:[-*+•]\s+|\d+[.)]\s+)?/, '');

/** Non-empty lines of a text, list markers removed (table rows kept as they are). */
export function textLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith('|') ? l : unbullet(l)));
}

/** The first non-empty line that isn't a heading, emphasis removed ("_Large Dragon, Unaligned_" → "Large Dragon, Unaligned"). */
export function firstTextLine(text: string): string {
  return plain(textLines(text).find((l) => !/^#{1,6}\s/.test(l) && !l.startsWith('|')) ?? '');
}

export interface LabelOptions {
  /**
   * Labels that may also start mid-line without emphasis ("AC 17 Initiative +2 (12)"), each with the
   * pattern its value must start with.
   */
  inline?: Readonly<Record<string, RegExp>>;
}

interface Token { label: string; start: number; end: number }

/**
 * Values of `labels` in a text, first occurrence of each: a bold label anywhere in a line ("**AC** 17
 * **Initiative** +2"), a plain label at a line start ("Casting Time: Action"), or a plain inline label
 * from `opts.inline` mid-line when its value pattern follows. A value runs to the next label on the
 * line. Keys are the labels as given (matched case-insensitively).
 */
export function labeledValues(text: string, labels: readonly string[], opts: LabelOptions = {}): Map<string, string> {
  const sorted = [...labels].sort((a, b) => b.length - a.length);
  const alternation = sorted.map(escape).join('|');
  const canonical = (found: string) => sorted.find((l) => l.toLowerCase() === found.toLowerCase().replace(/\s+/g, ' ')) ?? found;
  const bold = new RegExp(String.raw`(\*\*|__)[ \t]*(${alternation})[ \t]*:?[ \t]*\1[ \t]*:?`, 'gi');
  const start = new RegExp(String.raw`^[*_]{0,3}[ \t]*(${alternation})[ \t]*[*_]{0,3}[ \t]*(?::[*_]{0,3}[ \t]*|[ \t]+|$)`, 'i');
  const inline = Object.entries(opts.inline ?? {});
  const out = new Map<string, string>();
  for (const line of textLines(text)) {
    if (line.startsWith('|')) continue;
    const tokens: Token[] = [];
    for (const m of line.matchAll(bold)) tokens.push({ label: canonical(m[2]), start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    if (!tokens.length || tokens[0].start > 0) {
      const m = start.exec(line);
      if (m && !tokens.some((t) => t.start === 0)) tokens.unshift({ label: canonical(m[1]), start: 0, end: m[0].length });
    }
    for (const [label, valueStart] of inline) {
      const re = new RegExp(String.raw`(?:^|\s)(${escape(label)})[ \t]*:?[ \t]+(?=${valueStart.source})`, 'gi');
      for (const m of line.matchAll(re)) {
        const at = (m.index ?? 0) + m[0].indexOf(m[1]);
        if (tokens.some((t) => at >= t.start && at < t.end) || tokens.some((t) => t.start === at)) continue;
        tokens.push({ label: canonical(label), start: at, end: (m.index ?? 0) + m[0].length });
      }
    }
    tokens.sort((a, b) => a.start - b.start);
    tokens.forEach((t, i) => {
      if (out.has(t.label)) return;
      const value = plain(line.slice(t.end, tokens[i + 1]?.start ?? line.length));
      if (value) out.set(t.label, value);
    });
  }
  return out;
}

/** The paragraphs of a text that aren't label lines or headings: its prose (descriptions). */
export function proseParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^#{1,6}\s/.test(p) && !p.startsWith('|') && !/^\s*[-*+•]\s+\*\*/.test(p));
}

/** The first match of `re` in `text` as printed (emphasis removed), or ''. */
export function excerpt(text: string, re: RegExp): string {
  const m = re.exec(plain(text));
  return m ? m[0].trim() : '';
}
