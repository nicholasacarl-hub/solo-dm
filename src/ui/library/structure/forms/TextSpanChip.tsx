/**
 * A feature's text is a paragraph span of the book (spec §2.2 TextSpan). The chip names it
 * ("¶2–4 of ‘Level 3: Ember Ward’"), expands to the exact words that will be attached, and turns red
 * with the reason when it doesn't resolve. "Change…" opens the SpanPicker.
 */
import { useId, useState } from 'react';
import { ChevronDown, ChevronRight, CircleX, Pilcrow } from 'lucide-react';
import { resolveSpan, type CandidateBlock } from '@/data';
import { cn } from '@/lib/cn';
import type { CompendiumEntry, TextSpan } from '@/types';
import { Button } from '@/ui/components/ui';
import { Markdown } from '@/ui/components/Markdown';
import { blockForSpan, blockTitle } from '../bookData';
import { SpanPicker } from './SpanPicker';

export function spanRange(span: Pick<TextSpan, 'from' | 'to'>): string {
  return span.from === span.to ? `¶${span.from}` : `¶${span.from}–${span.to}`;
}

/** Why a span doesn't resolve, or null when it does. */
export function spanProblem(
  span: TextSpan,
  blocks: readonly CandidateBlock[],
  entriesById: ReadonlyMap<string, CompendiumEntry>,
): string | null {
  const block = blockForSpan(span.entryIds, blocks, entriesById);
  if (!block) return "Its text isn't in this book any more.";
  if (span.from < 1 || span.to < span.from) return 'The paragraphs are out of order.';
  if (block.paragraphs.length > 0 && span.to > block.paragraphs.length) {
    return `Paragraph ${span.to} doesn't exist: ‘${block.title}’ has ${block.paragraphs.length}.`;
  }
  return null;
}

export function TextSpanChip({
  span,
  blocks,
  entriesById,
  onChange,
  disabled,
  id,
  fieldPath,
  describedBy,
  onFocus,
  owner,
}: {
  span: TextSpan;
  blocks: readonly CandidateBlock[];
  entriesById: ReadonlyMap<string, CompendiumEntry>;
  onChange(next: TextSpan): void;
  disabled?: boolean;
  id?: string;
  /** The data path, for "Go to field". */
  fieldPath?: string;
  describedBy?: string;
  onFocus?(): void;
  /** What the text belongs to ("Wick Sense"): names "Change…" for screen readers among many rows. */
  owner?: string;
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const panelId = useId();
  const first = entriesById.get(span.entryIds[0] ?? '');
  const title = first ? blockTitle(first) : 'a missing entry';
  const problem = spanProblem(span, blocks, entriesById);
  const text = problem ? null : resolveSpan(span, entriesById);
  const paragraphs = span.from === span.to ? `paragraph ${span.from}` : `paragraphs ${span.from} to ${span.to}`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          id={id}
          data-field-path={fieldPath}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`Text: ${paragraphs} of ${title}${problem ? ` (${problem})` : ''}`}
          aria-describedby={describedBy}
          onFocus={onFocus}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            'inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-lg border px-2.5 text-left text-sm transition-colors',
            problem ? 'border-danger/60 bg-danger-soft text-danger' : 'border-border bg-surface-2 text-text hover:border-faint',
          )}
        >
          {open ? <ChevronDown className="size-3.5 shrink-0" aria-hidden /> : <ChevronRight className="size-3.5 shrink-0" aria-hidden />}
          {problem ? <CircleX className="size-3.5 shrink-0" aria-hidden /> : <Pilcrow className="size-3.5 shrink-0 text-muted" aria-hidden />}
          <span className="min-w-0 truncate">
            {spanRange(span)} of ‘{title}’
          </span>
        </button>
        <Button size="sm" variant="ghost" disabled={disabled} aria-label={owner ? `Change the text of ${owner}` : undefined} onClick={() => setPicking(true)}>
          Change…
        </Button>
      </div>
      {problem && <p className="text-xs text-danger">{problem}</p>}
      {open && (
        <div id={panelId} className="rounded-xl border border-border bg-surface-2/60 px-3 py-2 text-sm">
          {text ? (
            <>
              <p className="mb-1 text-xs text-muted">The words that will be attached:</p>
              <Markdown>{text}</Markdown>
            </>
          ) : (
            <p className="text-xs text-muted">{problem ?? 'The text of these paragraphs couldn’t be read.'}</p>
          )}
        </div>
      )}
      <SpanPicker
        open={picking}
        span={span}
        blocks={blocks}
        entriesById={entriesById}
        onClose={() => setPicking(false)}
        onPick={(next) => {
          setPicking(false);
          onChange(next);
        }}
      />
    </div>
  );
}
