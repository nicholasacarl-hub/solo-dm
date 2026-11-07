/** Small display formatters shared by the shell screens. */
import type { ClassLevel } from '@/types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "just now", "5 minutes ago", "yesterday", "3 weeks ago" (future times work too). */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const diff = timestamp - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return 'just now';
  if (abs < HOUR) return relative.format(Math.round(diff / MINUTE), 'minute');
  if (abs < DAY) return relative.format(Math.round(diff / HOUR), 'hour');
  const days = Math.round(diff / DAY);
  if (Math.abs(days) < 7) return relative.format(days, 'day');
  if (Math.abs(days) < 30) return relative.format(Math.round(days / 7), 'week');
  if (Math.abs(days) < 365) return relative.format(Math.round(days / 30), 'month');
  return relative.format(Math.round(days / 365), 'year');
}

/** "Wizard 3", or "Fighter 3 / Wizard 2" for a multiclass character. */
export function formatClasses(classes: readonly Pick<ClassLevel, 'name' | 'level'>[]): string {
  return classes.map((c) => `${c.name} ${c.level}`).join(' / ');
}

/** Drop a trailing parenthetical: "Elf (High Elf lineage)" → "Elf". */
export function shortSpecies(species: string): string {
  return species.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/** "Mira Voss · Elf · Wizard 3" (empty parts are skipped). */
export function characterLine(character: {
  name: string;
  species: string;
  classes: readonly Pick<ClassLevel, 'name' | 'level'>[];
}): string {
  return [character.name.trim(), shortSpecies(character.species), formatClasses(character.classes)]
    .filter(Boolean)
    .join(' · ');
}

/** "1 session", "3 sessions". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString('en')} ${count === 1 ? one : many}`;
}

/** "$4", "$0.50", "$0.125". */
export function formatUsd(amount: number): string {
  if (Number.isInteger(amount)) return `$${amount}`;
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  });
}

/** "150k tokens" style compact counts: 1500 → "1.5k", 150000 → "150k". */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  const k = count / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
}

/** "2.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Best-effort readable message from anything thrown. */
export function errorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}

/** True for fetch/DOM aborts (the user pressed Cancel). */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message));
}
