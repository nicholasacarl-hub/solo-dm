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

/**
 * Case- and punctuation-insensitive comparison key for names. Falls back to a normalized,
 * lowercased form for names without Latin letters or digits ("Иван", "龍の灯台"), which would
 * otherwise all slugify to the same empty key.
 */
export function nameKey(text: string): string {
  return slugify(text) || text.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}
