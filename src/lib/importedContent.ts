/**
 * Text from the player's imported books must never leave their device. Anything the DM reads from
 * an imported source (rules lookups) is wrapped in these markers, so exports and cloud saves can
 * redact it while the live session keeps the full text.
 */
const OPEN = '<imported-content';
const CLOSE = '</imported-content>';

/**
 * Wrap text that came from an imported (non-SRD, non-homebrew) source. A closing marker inside the text is
 * escaped, so imported text can't end the wrapper early and leak its tail past redaction (spec §7.2).
 */
export function wrapImported(sourceName: string, text: string): string {
  const safeName = sourceName.replace(/["<>]/g, '');
  const safeText = text.replace(/<\/imported-content/gi, '&lt;/imported-content');
  return `${OPEN} source="${safeName}">\n${safeText}\n${CLOSE}`;
}

// A wrapper left open (its text cut before the closing marker) runs to the end of its string.
const PATTERN = /<imported-content source="([^"]*)">[\s\S]*?(?:<\/imported-content>|$)/g;

/** Replace every wrapped block with a short placeholder naming the source. */
export function redactImported(text: string): string {
  return text.replace(PATTERN, (_match, source: string) => `[Text from the player's imported book "${source}" was left out of this copy.]`);
}

/**
 * Text cut inside a wrapped passage (its closing marker cut off) closed again, so a copy removes that passage and
 * nothing after it: redactImported runs a wrapper left open to the end of its string.
 */
export function closeCutWrapper(text: string): string {
  const open = text.lastIndexOf(OPEN);
  return open >= 0 && !text.includes(CLOSE, open) ? `${text} ${CLOSE}` : text;
}

/**
 * The opening marker (and a space) of the wrapped passage a cut at `at` starts inside: one opened before `at` and not
 * yet closed there, a cut inside its opening marker included. '' when the cut is outside every passage. An excerpt
 * from `at` on, prefixed with it (and closed by closeCutWrapper), stays wrapped, so a copy removes that passage.
 */
export function wrapperOpenAt(text: string, at: number): string {
  if (at <= 0) return '';
  const open = text.lastIndexOf(OPEN, at - 1);
  if (open < 0) return '';
  const close = text.indexOf(CLOSE, open);
  if (close >= 0 && close < at) return '';
  const tag = /^<imported-content source="[^"]*">/.exec(text.slice(open, open + 300));
  return `${tag ? tag[0] : `${OPEN} source="">`} `;
}

/** True when the text contains wrapped imported content. */
export function hasImported(text: string): boolean {
  return text.includes(OPEN);
}

// ---------------------------------------------------------------------------
// Structured imports (spec §7.2): placeholders and text fingerprints (the fixtures' refs and records
// carry real hashes).
// ---------------------------------------------------------------------------

const PLACEHOLDER = /^\[Text from the player's imported book "[^"]*" was left out of this copy\.\]$/;

/** Exactly redactImported's sentence for a passage wrapped with this source title. */
export function importedPlaceholder(sourceTitle: string): string {
  return `[Text from the player's imported book "${sourceTitle.replace(/["<>]/g, '')}" was left out of this copy.]`;
}

/** True when the text is (only) the placeholder sentence. */
export function isImportedPlaceholder(text: string | undefined): boolean {
  return typeof text === 'string' && PLACEHOLDER.test(text.trim());
}

/**
 * Book text a copy left out (an export or GitHub save) that this device hasn't filled back in: copied text
 * (`ref.textCopied`) whose description is empty or the placeholder. A `ref.redacted` left on text written
 * since (the DM's ruling over a pulled placeholder) doesn't count: that text is the DM's or the player's, it
 * shows as written and is never overwritten (spec §7.4). The DM's sheet text and restore ask this.
 */
export function copiedTextMissing(x: { description?: string; ref?: { textCopied: boolean; redacted?: true } }): boolean {
  return Boolean(x.ref?.textCopied) && (!x.description?.trim() || isImportedPlaceholder(x.description));
}

/** A `ref.redacted` over text written there since (the DM's ruling over a pulled placeholder): it no longer says anything true. */
export function staleRedaction(x: { description?: string; ref?: { redacted?: true } }): boolean {
  return Boolean(x.ref?.redacted && x.description?.trim() && !isImportedPlaceholder(x.description));
}

/** FNV-1a 64-bit over NFKC-normalized, whitespace-collapsed text (UTF-8 bytes); 16 hex chars. Sync; not a security hash. */
export function textFingerprint(text: string): string {
  const bytes = new TextEncoder().encode(text.normalize('NFKC').replace(/\s+/g, ' ').trim());
  // The 64-bit state as four 16-bit limbs, low first; the FNV prime is 2^40 + 0x1b3.
  let h0 = 0x2325;
  let h1 = 0x8422;
  let h2 = 0x9ce4;
  let h3 = 0xcbf2;
  for (const byte of bytes) {
    h0 ^= byte;
    const t0 = h0 * 0x1b3;
    let t1 = h1 * 0x1b3;
    let t2 = h2 * 0x1b3 + (h0 << 8);
    let t3 = h3 * 0x1b3 + (h1 << 8);
    t1 += t0 >>> 16;
    t2 += t1 >>> 16;
    t3 += t2 >>> 16;
    h0 = t0 & 0xffff;
    h1 = t1 & 0xffff;
    h2 = t2 & 0xffff;
    h3 = t3 & 0xffff;
  }
  return [h3, h2, h1, h0].map((h) => h.toString(16).padStart(4, '0')).join('');
}

/** A book's fingerprint: textFingerprint over its entries' texts in ordinal order, joined by "\n\u0000\n". */
export function bookFingerprint(texts: readonly string[]): string {
  return textFingerprint(texts.join('\n\u0000\n'));
}
