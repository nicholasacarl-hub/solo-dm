/**
 * Text from the player's imported books must never leave their device. Anything the DM reads from
 * an imported source (rules lookups) is wrapped in these markers, so exports and cloud saves can
 * redact it while the live session keeps the full text.
 */
const OPEN = '<imported-content';
const CLOSE = '</imported-content>';

/** Wrap text that came from an imported (non-SRD, non-homebrew) source. */
export function wrapImported(sourceName: string, text: string): string {
  const safeName = sourceName.replace(/["<>]/g, '');
  return `${OPEN} source="${safeName}">\n${text}\n${CLOSE}`;
}

const PATTERN = /<imported-content source="([^"]*)">[\s\S]*?<\/imported-content>/g;

/** Replace every wrapped block with a short placeholder naming the source. */
export function redactImported(text: string): string {
  return text.replace(PATTERN, (_match, source: string) => `[Text from the player's imported book "${source}" was left out of this copy.]`);
}

/** True when the text contains wrapped imported content. */
export function hasImported(text: string): boolean {
  return text.includes(OPEN);
}
