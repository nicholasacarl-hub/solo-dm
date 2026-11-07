import { cn } from '@/lib/cn';
import { useGame } from '@/state/gameStore';
import { useSettings } from '@/state/settingsStore';
import type { DmLogEntry } from '@/types';
import { Markdown } from '@/ui/components/Markdown';
import { isBusyPhase, sendToDm } from '../dmStatus';

/** DM narration in the story style, with suggested actions and (optionally) the DM's notes. */
export function DmEntry({ entry, showChoices }: { entry: DmLogEntry; showChoices: boolean }) {
  const serif = useSettings((s) => s.narrationFont === 'serif');
  const hasText = entry.text.trim().length > 0;
  const choices = showChoices && !entry.streaming ? (entry.choices ?? []) : [];

  if (!hasText && !entry.streaming && !entry.reasoning && choices.length === 0) return null;

  return (
    <article aria-label="The DM" aria-busy={entry.streaming || undefined}>
      {(hasText || entry.streaming) && (
        // While streaming, the last paragraph is made inline so the caret sits at the end of the text.
        <div className={cn(entry.streaming && '[&>.narration]:inline [&>.narration>p:last-child]:inline')}>
          {hasText && (
            <Markdown variant="narration" className={cn(serif && 'narration-serif')}>
              {entry.text}
            </Markdown>
          )}
          {entry.streaming && <StreamingCaret />}
        </div>
      )}
      {entry.reasoning && (
        <details className="group mt-3 rounded-xl border border-border bg-surface/60 text-sm">
          <summary className="cursor-pointer list-none px-3 py-2 text-muted select-none hover:text-text [&::-webkit-details-marker]:hidden">
            <span className="mr-1.5 inline-block transition-transform group-open:rotate-90" aria-hidden>
              ›
            </span>
            DM&apos;s notes (may contain spoilers)
          </summary>
          <div className="border-t border-border px-3 py-2">
            <Markdown>{entry.reasoning}</Markdown>
          </div>
        </details>
      )}
      {choices.length > 0 && <Choices choices={choices} />}
    </article>
  );
}

function StreamingCaret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-[1.05em] w-[0.45em] translate-y-[0.18em] animate-pulse rounded-[1px] bg-accent"
    />
  );
}

/** Suggested actions from a ```choices block: one tap sends it as the player's turn. */
function Choices({ choices }: { choices: string[] }) {
  const busy = useGame((s) => isBusyPhase(s.dm.phase));
  return (
    <div role="group" aria-label="Suggested actions" className="mt-4 flex flex-wrap gap-2">
      {choices.map((choice) => (
        <button
          key={choice}
          type="button"
          disabled={busy}
          onClick={() => void sendToDm(choice)}
          className={cn(
            'rounded-full border border-accent/35 bg-accent-soft/50 px-3.5 py-1.5 text-left text-sm text-text transition-colors',
            'hover:border-accent hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          {choice}
        </button>
      ))}
    </div>
  );
}
