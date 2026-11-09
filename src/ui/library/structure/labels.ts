/**
 * The words for structured imports (spec §4.3) and the three privacy promises (§4.10): one place, so the
 * book page, the library row, the consent and the builder hints say the same thing. Text always carries
 * the meaning; tone and icon only repeat it (theme tones from ui.tsx's Badge).
 *
 * CONTRACT (Day 0). Owner: E3; E4's builder hints use it too.
 */
import { BookMarked, Circle, CircleCheck, CircleX, Clock, Eye, FileText, History, LoaderCircle, ShieldAlert, TriangleAlert, type LucideIcon } from 'lucide-react';
import { MODELS, type RecordWarning, type StructuredKind, type StructuredRecord } from '@/types';
import type { BadgeTone } from '@/ui/components/ui';

// ---------------------------------------------------------------------------
// Record states
// ---------------------------------------------------------------------------

export type RecordState =
  | 'not-read'      // data === null (needs-claude)
  | 'waiting'       // runState queued
  | 'reading'       // runState running
  | 'clean'         // pending, high confidence
  | 'check'         // pending, warnings to check
  | 'needs-fix'     // pending, any block warning
  | 'failed'        // runState failed
  | 'refused'       // runState refused
  | 'in-use'        // accepted, book switched on
  | 'accepted-off'  // accepted, book switched off
  | 'text-only';    // rejected

export interface StateStyle {
  label: string;
  tone: BadgeTone;
  /** LoaderCircle is the spinner (animate it with `animate-spin motion-reduce:animate-none`). */
  icon: LucideIcon;
}

export const RECORD_STATES: Readonly<Record<RecordState, StateStyle>> = {
  'not-read': { label: 'Not read yet', tone: 'neutral', icon: Circle },
  waiting: { label: 'Waiting', tone: 'neutral', icon: Clock },
  reading: { label: 'Reading…', tone: 'neutral', icon: LoaderCircle },
  clean: { label: 'To review · Clean read', tone: 'info', icon: Eye },
  check: { label: 'To review · Check', tone: 'gold', icon: TriangleAlert },
  'needs-fix': { label: 'Needs a fix', tone: 'danger', icon: CircleX },
  failed: { label: "Couldn't read", tone: 'danger', icon: CircleX },
  refused: { label: 'Claude declined', tone: 'danger', icon: ShieldAlert },
  'in-use': { label: 'In use', tone: 'success', icon: CircleCheck },
  'accepted-off': { label: 'Accepted · book switched off', tone: 'neutral', icon: CircleCheck },
  'text-only': { label: 'Text only', tone: 'neutral', icon: FileText },
};

/** "Older edition" (an adaptation applies). */
export const OLDER_EDITION: StateStyle = { label: 'Older edition', tone: 'gold', icon: History };
/** The book badge on imported builder options (titles over 24 chars are cut; the full title goes in the accessible name). */
export const BOOK_BADGE = { tone: 'info' as BadgeTone, icon: BookMarked, maxChars: 24 };

const hasBlock = (warnings: readonly RecordWarning[]) => warnings.some((w) => w.severity === 'block');

/**
 * The one state a record shows, in this order: being read now, a decision the player made (text only,
 * accepted), a failed or declined read, not read at all, then what review needs.
 */
export function recordState(record: Pick<StructuredRecord, 'status' | 'data' | 'warnings' | 'confidence' | 'runState'>, opts: { bookEnabled: boolean }): RecordState {
  if (record.runState === 'running') return 'reading';
  if (record.runState === 'queued') return 'waiting';
  if (record.status === 'rejected') return 'text-only';
  if (record.status === 'accepted') return opts.bookEnabled ? 'in-use' : 'accepted-off';
  if (record.runState === 'failed') return 'failed';
  if (record.runState === 'refused') return 'refused';
  if (record.data === null) return 'not-read';
  if (hasBlock(record.warnings)) return 'needs-fix';
  return record.confidence === 'high' ? 'clean' : 'check';
}

/** Fields the player should check: distinct fields named by `warn` warnings (unnamed ones count once each). */
export function fieldsToCheck(warnings: readonly RecordWarning[]): number {
  const warns = warnings.filter((w) => w.severity === 'warn');
  return new Set(warns.map((w, i) => w.field ?? `#${i}`)).size;
}

/** The state's words for a record: "To review · Check 2 fields", "Needs a fix", "In use"… */
export function recordStateLabel(record: Pick<StructuredRecord, 'status' | 'data' | 'warnings' | 'confidence' | 'runState'>, opts: { bookEnabled: boolean }): string {
  const state = recordState(record, opts);
  if (state !== 'check') return RECORD_STATES[state].label;
  const n = fieldsToCheck(record.warnings);
  return n > 0 ? `To review · Check ${n} ${n === 1 ? 'field' : 'fields'}` : 'To review';
}

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

/** A model's display name: its MODELS label, else the id spelled out ("claude-opus-5" → "Claude Opus 5"). */
export function modelName(id: string): string {
  const known = MODELS.find((m) => m.id === id);
  if (known) return known.label;
  const words: string[] = [];
  const version: string[] = [];
  for (const part of id.split('-')) {
    if (/^\d+$/.test(part)) version.push(part);
    else if (!version.length) words.push(part.charAt(0).toUpperCase() + part.slice(1));
  }
  return [...words, version.join('.')].filter(Boolean).join(' ');
}

/** "Read on this device" / "Read by Claude Sonnet 5.5 (answered by Claude Opus 5 as a fallback)" / "From a pack" / "Entered by you", + " · edited". */
export function originLabel(record: Pick<StructuredRecord, 'origin' | 'extraction' | 'edited'>): string {
  let label: string;
  switch (record.origin) {
    case 'parser':
      label = 'Read on this device';
      break;
    case 'claude': {
      const asked = record.extraction?.requestedModel;
      const answered = record.extraction?.model;
      label = asked ? `Read by ${modelName(asked)}` : 'Read by Claude';
      if (asked && answered && answered !== asked) label += ` (answered by ${modelName(answered)} as a fallback)`;
      break;
    }
    case 'pack':
      label = 'From a pack';
      break;
    default:
      label = 'Entered by you';
  }
  return record.edited ? `${label} · edited` : label;
}

// ---------------------------------------------------------------------------
// Kinds, filters, counts
// ---------------------------------------------------------------------------

export const KIND_LABELS: Readonly<Record<StructuredKind, { one: string; many: string; title: string; titleMany: string }>> = {
  class: { one: 'class', many: 'classes', title: 'Class', titleMany: 'Classes' },
  subclass: { one: 'subclass', many: 'subclasses', title: 'Subclass', titleMany: 'Subclasses' },
  species: { one: 'species', many: 'species', title: 'Species', titleMany: 'Species' },
  background: { one: 'background', many: 'backgrounds', title: 'Background', titleMany: 'Backgrounds' },
  feat: { one: 'feat', many: 'feats', title: 'Feat', titleMany: 'Feats' },
  spell: { one: 'spell', many: 'spells', title: 'Spell', titleMany: 'Spells' },
  'magic-item': { one: 'magic item', many: 'magic items', title: 'Magic item', titleMany: 'Magic items' },
  item: { one: 'piece of gear', many: 'pieces of gear', title: 'Gear', titleMany: 'Gear' },
  monster: { one: 'monster', many: 'monsters', title: 'Monster', titleMany: 'Monsters' },
};

/** "1 class", "16 subclasses", "40 pieces of gear". */
export function kindCount(kind: StructuredKind, n: number): string {
  return `${n} ${n === 1 ? KIND_LABELS[kind].one : KIND_LABELS[kind].many}`;
}

/** The review list's filters (URL `?f=`, spec §4.2) and their chip labels. */
export type ReviewFilter = 'review' | 'fix' | 'failed' | 'unread' | 'used' | 'text' | 'all';
export const REVIEW_FILTERS: Readonly<Record<ReviewFilter, string>> = {
  review: 'To review',
  fix: 'Needs a fix',
  failed: "Couldn't read",
  unread: 'Not read yet',
  used: 'In use',
  text: 'Text only',
  all: 'All',
};

/** The builder's pending-review hint (spec §4.7): "3 more classes from “The Gloamwood Almanac” are waiting for your review in the Library." */
export function reviewHint(n: number, kind: StructuredKind, bookTitle: string): string {
  return `${kindCount(kind, n).replace(/^(\d+) /, '$1 more ')} from “${bookTitle}” ${n === 1 ? 'is' : 'are'} waiting for your review in the Library.`;
}

// ---------------------------------------------------------------------------
// The three promises (fixed copy, spec §4.10): in full in Library › About and the book page's
// "How your book stays private" popover; the title (first sentence) alone in the ImportDialog and the consent.
// ---------------------------------------------------------------------------

export const PRIVACY_PROMISES: readonly { title: string; body: string }[] = [
  {
    title: 'Your book stays on this device.',
    body: "Solo DM has no server. Your book's text goes to Anthropic, with your own API key, only when you ask: when Claude structures entries (after you've seen the cost), when it transcribes photos, and when the DM looks rules up during play. If illustrations are on, the names of options you use (a species, a class) appear in picture prompts sent to OpenAI; their text never does.",
  },
  {
    title: "Nothing changes your game until you've checked it.",
    body: "Structured entries wait for your review. The builder, combat, the battle map, spell lists and inventory use them only after you accept them, and you can move any of them back. (As before, the DM can search all of a book's text, and spells the importer recognized on its own keep appearing in spell lists, marked “not reviewed”.)",
  },
  {
    title: "Your campaign saves never carry your book's text.",
    body: 'Anything copied from a book onto your character remembers where it came from. Save files and GitHub backups keep the names and leave the text out; a device that has the book fills it back in. The only file that holds a book\'s text is “Download book data”, which you make yourself.',
  },
];
