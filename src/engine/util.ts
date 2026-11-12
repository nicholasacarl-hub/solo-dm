/**
 * Small helpers shared by the engine modules (not part of the public engine API).
 */
import type { GameEvent, GameEventType } from '@/types';
import { nameKey } from '@/lib/id';

export function gameEvent(type: GameEventType, message: string): GameEvent {
  return { type, message };
}

export function warning(message: string): GameEvent {
  return { type: 'warning', message };
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** A finite number truncated to an integer; anything else becomes `fallback`. */
export function toInt(n: unknown, fallback = 0): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** Copy with a strictly increasing updatedAt. */
export function touch<T extends { updatedAt: number }>(obj: T): T {
  return { ...obj, updatedAt: Math.max(Date.now(), obj.updatedAt + 1) };
}

/** 12345 -> "12,345" (locale-independent, so prompt text stays deterministic). */
export function formatInt(n: number): string {
  const digits = Math.abs(Math.trunc(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `-${digits}` : digits;
}

/** "a, b and c" */
export function listJoin(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Fuzzy name matching (features, items, spells, attacks, combatants)
// ---------------------------------------------------------------------------

/** Crude singular form so "Torches" finds "Torch" and "daggers" finds "Dagger". */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(ches|shes|xes|sses|zes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function nameWords(text: string): string[] {
  return nameKey(text).split('-').filter(Boolean).map(stem);
}

function sameWords(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((w, i) => w === b[i]);
}

export interface NameMatch<T> {
  /** The single best match, if the query is unambiguous. */
  match?: T;
  /** Everything that matched at the best tier (more than one = ambiguous). */
  candidates: T[];
}

/**
 * Case- and punctuation-insensitive lookup in tiers: exact name, same words (plural-insensitive),
 * name starts with the query's words, name contains all of the query's words. Exact matches win even
 * when duplicated; looser tiers only match when exactly one item qualifies.
 */
export function matchByName<T>(items: readonly T[], query: string, getName: (item: T) => string): NameMatch<T> {
  const key = nameKey(query);
  if (!key) return { candidates: [] };
  const exact = items.filter((item) => nameKey(getName(item)) === key);
  if (exact.length > 0) return { match: exact[0], candidates: exact };

  const q = nameWords(query);
  const tiers: Array<(w: string[]) => boolean> = [
    (w) => sameWords(w, q),
    (w) => q.length <= w.length && q.every((word, i) => w[i] === word),
    (w) => q.every((word) => w.includes(word)),
  ];
  for (const test of tiers) {
    const hits = items.filter((item) => test(nameWords(getName(item))));
    if (hits.length === 1) return { match: hits[0], candidates: hits };
    if (hits.length > 1) return { candidates: hits };
  }
  return { candidates: [] };
}

/** Warning text for a failed lookup ("No feature named …" / "… matches several features: …"). */
export function lookupProblem<T>(kind: string, query: string, found: NameMatch<T>, getName: (item: T) => string): string {
  if (found.candidates.length > 1) {
    const names = found.candidates.slice(0, 5).map(getName).join(', ');
    return `"${query}" matches several ${kind}s (${names}) — use the full name.`;
  }
  return `No ${kind} named "${query}".`;
}
