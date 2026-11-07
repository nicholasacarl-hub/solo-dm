/**
 * Small display helpers for the Play screen. Formatting only — rules math lives in src/engine.
 */
import { MODELS, type Scene } from '@/types';

const MINUS = '−';

/** "+3", "+0", "−1" (true minus sign). */
export function signed(n: number): string {
  if (n < 0) return `${MINUS}${Math.abs(n)}`;
  return `+${n}`;
}

/** " + 3" / " − 1" / "" — for "d20 + 5" style expressions. */
export function joinedModifier(n: number): string {
  if (n === 0) return '';
  return n < 0 ? ` ${MINUS} ${Math.abs(n)}` : ` + ${n}`;
}

/** 850 -> "850", 18_400 -> "18k", 1_250_000 -> "1.3M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** 0 -> "$0.00", 0.004 -> "<$0.01", 3.1 -> "$3.10", 123.4 -> "$123". */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  if (n >= 100) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

/** "prone" -> "Prone", "magic-item" -> "Magic item". */
export function capitalize(text: string): string {
  const spaced = text.replace(/[-_]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** "Claude Opus 5.5" -> "Opus 5.5"; unknown ids are shown as-is. */
export function modelLabel(id: string): string {
  const info = MODELS.find((m) => m.id === id);
  return info ? info.label.replace(/^Claude\s+/, '') : id;
}

/** The scene chip: "Saltmarsh Docks · dusk · fog rolling in". */
export function sceneSummary(scene: Scene | null | undefined): string {
  if (!scene) return '';
  return [scene.location, scene.timeOfDay, scene.weather].filter((part) => part && part.trim()).join(' · ');
}

/**
 * Markdown to plain text for screen-reader announcements and previews. Not a full parser:
 * it drops emphasis markers, headings, code fences and link targets.
 */
export function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'Something went wrong.';
}

export const OOC_PREFIX = 'OOC: ';

export function isOoc(text: string): boolean {
  return /^\s*ooc\s*:/i.test(text);
}

/** Prefix "OOC: " unless the text already starts with it. */
export function withOocPrefix(text: string): string {
  return isOoc(text) ? text.trim() : `${OOC_PREFIX}${text.trim()}`;
}

export const X_CARD_MESSAGE = '[X-card] Please steer away from the current content.';

export function isXCard(text: string): boolean {
  return text.trim().startsWith('[X-card]');
}

export function vetoNotice(name: string): string {
  return `The player vetoed homebrew "${name}". Retire or rework it.`;
}
