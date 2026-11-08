import { Clock, Footprints, Info, OctagonX, RotateCcw, Square, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/cn';
import { dm } from '@/dm';
import { useGame } from '@/state/gameStore';
import { useSettings } from '@/state/settingsStore';
import type { ErrorLogEntry, PlayerLogEntry, RecapLogEntry, SessionLogEntry, SystemLogEntry } from '@/types';
import { Markdown } from '@/ui/components/Markdown';
import { Button } from '@/ui/components/ui';
import { isBusyPhase, runDm } from '../dmStatus';
import { isOoc, isXCard } from '../format';

/**
 * The player's words. `pending`: the DM hasn't answered them (its reply was stopped before it said
 * anything, or failed); the DM gets them again with the next message.
 */
export function PlayerEntry({ entry, pending = false }: { entry: PlayerLogEntry; pending?: boolean }) {
  const ooc = isOoc(entry.text);
  const xcard = isXCard(entry.text);
  const text = ooc ? entry.text.replace(/^\s*ooc\s*:\s*/i, '') : entry.text;
  return (
    <div className="flex flex-col items-end">
      <div
        className={cn(
          'max-w-[85%] rounded-2xl rounded-br-md px-4 py-2.5 text-[0.9375rem] leading-relaxed break-words whitespace-pre-wrap',
          xcard
            ? 'border border-danger/40 bg-danger-soft text-text'
            : ooc
              ? 'border border-dashed border-border text-muted'
              : 'bg-surface-2 text-text',
        )}
      >
        {(ooc || xcard) && (
          <span className="mb-0.5 flex items-center gap-1 text-[0.6875rem] font-semibold tracking-wider text-faint uppercase">
            {xcard && <OctagonX className="size-3.5 text-danger" aria-hidden />}
            {xcard ? 'X-card' : 'Out of character'}
          </span>
        )}
        <span className="sr-only">You: </span>
        {text}
      </div>
      {entry.mapNote && <MapNoteChip note={entry.mapNote} />}
      {pending && (
        <p className="mt-1.5 flex items-center gap-1.5 text-right text-xs text-muted">
          <Clock className="size-3.5 shrink-0" aria-hidden />
          Not answered yet. It goes to the DM with your next message.
        </p>
      )}
    </div>
  );
}

/** The hero's moves on the battle map that went with this message: "Moved B6 → C7 → D8 · 10 ft · Disengaged". */
function MapNoteChip({ note }: { note: string }) {
  return (
    <p className="mt-1.5 inline-flex max-w-[85%] items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-muted">
      <Footprints className="size-3.5 shrink-0" aria-hidden />
      <span className="sr-only">On the battle map: </span>
      <span className="min-w-0 break-words">{note}</span>
    </p>
  );
}

/** The DM's note under a reply the player stopped: a small marker on that narration. */
export function StoppedMarker({ entry }: { entry: SystemLogEntry }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted">
      <Square className="size-3 shrink-0 fill-current" aria-hidden />
      <span>{entry.text}</span>
    </p>
  );
}

export function SystemNote({ entry }: { entry: SystemLogEntry }) {
  const warning = entry.level === 'warning';
  return (
    <p
      className={cn(
        'flex items-start justify-center gap-1.5 px-2 text-center text-xs',
        warning ? 'text-gold' : 'text-muted',
      )}
    >
      {warning ? (
        <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      ) : (
        <Info className="mt-px size-3.5 shrink-0" aria-hidden />
      )}
      <span>{entry.text}</span>
    </p>
  );
}

export function SessionDivider({ entry }: { entry: SessionLogEntry }) {
  const label = entry.event === 'start' ? `Session ${entry.sessionNumber}` : `End of session ${entry.sessionNumber}`;
  return (
    <div className="flex items-center gap-3 py-1 text-faint">
      <span className="h-px flex-1 bg-border" aria-hidden />
      <h2 className="font-display text-xs font-semibold tracking-[0.22em] uppercase">{label}</h2>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}

export function RecapCard({ entry }: { entry: RecapLogEntry }) {
  const serif = useSettings((s) => s.narrationFont === 'serif');
  return (
    <section className="rounded-2xl border border-border bg-surface px-5 py-4 shadow-card">
      <h3 className="font-display text-sm font-semibold tracking-[0.12em] text-accent uppercase">Previously…</h3>
      <p className="mb-2 text-xs text-faint">Recap of session {entry.sessionNumber}</p>
      <Markdown variant="narration" className={cn(serif && 'narration-serif')}>
        {entry.text}
      </Markdown>
    </section>
  );
}

/** A failed DM request. Only the latest error (nothing happened since) offers Retry. */
export function ErrorCard({ entry, latest }: { entry: ErrorLogEntry; latest: boolean }) {
  const busy = useGame((s) => isBusyPhase(s.dm.phase));
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
      <p className="flex-1 text-text">{entry.text}</p>
      {entry.retryable && latest && (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          icon={<RotateCcw className="size-3.5" aria-hidden />}
          onClick={() => void runDm(() => dm.retry())}
        >
          Retry
        </Button>
      )}
    </div>
  );
}
