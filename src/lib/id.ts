/** Random unique id (UUID v4). */
export function newId(): string {
  return crypto.randomUUID();
}

/** Lowercase, dash-separated slug: "Fire Bolt" -> "fire-bolt". */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Case- and punctuation-insensitive comparison key for names. */
export function nameKey(text: string): string {
  return slugify(text);
}
