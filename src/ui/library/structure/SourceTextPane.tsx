/**
 * The book's text beside the fields (spec §4.4): "Excerpts" shows each paragraph with the words the
 * fields used marked (focusing a field scrolls to and emphasizes its excerpt); "Formatted" shows the
 * text as the Library renders it. Marks are built from plain-text slices, never raw HTML; the
 * excerpts are also listed as text ("Used by: HP"), including any that aren't in the text.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import type { CandidateBlock } from '@/data';
import { cn } from '@/lib/cn';
import type { CompendiumEntry, Excerpt, StructuredKind } from '@/types';
import { Markdown } from '@/ui/components/Markdown';
import { placeExcerpts, plainParagraph, slicesOf, type Highlight } from './excerpts';
import { dataPathsFor, wireFieldsFor } from './forms/fieldMap';
import { labelForPath } from './forms/formSpecs';
import { ViewToggle } from './ViewToggle';

type Mode = 'excerpts' | 'formatted';

function fieldLabel(kind: StructuredKind, field: string): string {
  const path = dataPathsFor(kind, field)[0] ?? field;
  return labelForPath(kind, path);
}

/** A line of source text with the excerpts placed on it marked (plain-text slices, never raw HTML). */
function MarkedText({ text, highlights, kind, active }: { text: string; highlights: readonly Highlight[]; kind: StructuredKind; active: ReadonlySet<string> }) {
  return (
    <>
      {slicesOf(text, highlights).map((s, k) => {
        if (!s.highlight) return <span key={k}>{s.text}</span>;
        const isActive = s.highlight.fields.some((f) => active.has(f));
        const names = [...new Set(s.highlight.fields.map((f) => fieldLabel(kind, f)))].join(', ');
        return (
          <mark
            key={k}
            data-active={isActive ? 'true' : undefined}
            title={`Used by: ${names}`}
            className={cn('rounded-sm px-0.5 text-text', isActive ? 'bg-accent-soft ring-2 ring-accent' : 'bg-gold-soft')}
          >
            {s.text}
            <span className="sr-only"> (used by {names})</span>
          </mark>
        );
      })}
    </>
  );
}

export function SourceTextPane({
  kind,
  blocks,
  excerpts,
  activeField,
  entriesById,
}: {
  kind: StructuredKind;
  blocks: readonly CandidateBlock[];
  excerpts: readonly Excerpt[];
  /** The data path of the focused field. */
  activeField: string | null;
  entriesById: ReadonlyMap<string, CompendiumEntry>;
}) {
  const [mode, setMode] = useState<Mode>('excerpts');
  const rootRef = useRef<HTMLDivElement>(null);
  const active = useMemo(() => new Set(activeField ? wireFieldsFor(kind, activeField) : []), [kind, activeField]);
  // Reading order: each block's title, then its paragraphs. Each excerpt is marked once, where it first appears.
  const lines = useMemo(() => blocks.flatMap((b) => [b.title, ...b.paragraphs.map(plainParagraph)]), [blocks]);
  const placement = useMemo(() => placeExcerpts(lines, excerpts), [lines, excerpts]);
  const firstLine = useMemo(() => {
    let at = 0;
    return blocks.map((b) => {
      const start = at;
      at += 1 + b.paragraphs.length;
      return start;
    });
  }, [blocks]);
  const used = excerpts.filter((e) => e.text.trim());

  useEffect(() => {
    if (!activeField || mode !== 'excerpts') return;
    const mark = rootRef.current?.querySelector<HTMLElement>('mark[data-active="true"]');
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    mark?.scrollIntoView?.({ block: 'center', behavior: still ? 'auto' : 'smooth' });
  }, [activeField, mode]);

  return (
    <div ref={rootRef} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-xs font-semibold tracking-[0.14em] text-muted uppercase">Source text</h3>
        <ViewToggle<Mode>
          label="Show the text as"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'excerpts', label: 'Excerpts' },
            { value: 'formatted', label: 'Formatted' },
          ]}
        />
      </div>
      {blocks.length === 0 && <p className="text-sm text-muted">This entry's text isn't in the Library on this device.</p>}
      {blocks.map((block, b) => (
        <section key={block.entryIds.join(' ')} aria-label={block.title} className="min-w-0">
          {mode === 'formatted' ? (
            <>
              {blocks.length > 1 && <h4 className="mb-1.5 font-serif text-base font-semibold">{block.title}</h4>}
              {block.entryIds.map((id) => {
                const entry = entriesById.get(id);
                return entry ? <Markdown key={id}>{entry.text}</Markdown> : null;
              })}
            </>
          ) : (
            <>
              {/* The title is text too: a subclass's class, say, is often read from its heading. */}
              <h4 className="mb-1.5 font-serif text-base font-semibold [overflow-wrap:anywhere]">
                <MarkedText text={block.title} highlights={placement.lines[firstLine[b]] ?? []} kind={kind} active={active} />
              </h4>
              {block.paragraphs.length === 0 ? (
                <p className="text-sm text-muted">This entry's paragraphs couldn't be read.</p>
              ) : (
                <ol className="flex flex-col gap-2 font-serif text-[0.95rem] leading-relaxed">
                  {block.paragraphs.map((p, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="mt-0.5 shrink-0 font-sans text-[11px] text-faint tabular-nums select-none" aria-hidden>
                        ¶{i + 1}
                      </span>
                      <p className="min-w-0 [overflow-wrap:anywhere]">
                        <MarkedText text={plainParagraph(p)} highlights={placement.lines[firstLine[b] + 1 + i] ?? []} kind={kind} active={active} />
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </section>
      ))}
      {used.length > 0 && (
        <section aria-label="What the fields used" className="rounded-xl border border-border bg-surface-2/60 p-3 text-xs">
          <h4 className="mb-1.5 font-medium text-muted">What the fields used</h4>
          <ul className="flex flex-col gap-1">
            {used.map((e, i) => {
              const places = placement.places.get(e) ?? 0;
              const notFound = places === 0 || !e.grounded;
              return (
                <li key={`${e.field}-${i}`} className={cn('flex items-start gap-1.5', active.has(e.field) && 'font-medium')}>
                  {notFound ? (
                    <TriangleAlert className="mt-px size-3.5 shrink-0 text-gold" aria-hidden />
                  ) : (
                    <CircleCheck className="mt-px size-3.5 shrink-0 text-success" aria-hidden />
                  )}
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    Used by: {fieldLabel(kind, e.field)} — “{e.text}”{notFound ? ' (not found in the text)' : places > 1 ? ` (found in ${places} places; the first is marked)` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
