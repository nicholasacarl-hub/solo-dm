/**
 * What a character portrait may show. A portrait is an emoji (or a few characters) or an image
 * embedded in the save itself (data:image/…). Never a URL: portraits come from save files that may
 * have been shared, and loading a remote image would tell its server the player's IP.
 */
export type PortraitDisplay = { kind: 'image'; src: string } | { kind: 'text'; text: string } | null;

/** null = nothing safe to show (empty, too long, or a link); callers fall back to their default. */
export function portraitDisplay(portrait: string | null | undefined): PortraitDisplay {
  const value = portrait?.trim();
  if (!value) return null;
  if (/^data:image\//i.test(value)) return { kind: 'image', src: value };
  if (value.length > 16 || /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) return null;
  return { kind: 'text', text: value };
}
