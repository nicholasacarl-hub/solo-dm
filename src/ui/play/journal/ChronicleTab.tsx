import { History } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useGame } from '@/state/gameStore';
import { useSettings } from '@/state/settingsStore';
import { Markdown } from '@/ui/components/Markdown';
import { EmptyState } from '@/ui/components/ui';
import { usePlayView } from '../playView';

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** Recaps of finished sessions, newest first. */
export function ChronicleTab() {
  const sessions = useGame((s) => s.sessions);
  const spoilers = usePlayView((s) => s.showSpoilers);
  const serif = useSettings((s) => s.narrationFont === 'serif');
  const ended = sessions.filter((s) => s.status === 'ended').sort((a, b) => b.number - a.number);

  if (ended.length === 0) {
    return (
      <EmptyState icon={<History className="size-7" aria-hidden />} title="No chronicle yet" className="py-8!">
        When a session ends, the DM&apos;s recap is kept here.
      </EmptyState>
    );
  }

  return (
    <ol className="flex flex-col gap-3" aria-label="Session recaps">
      {ended.map((s) => (
        <li key={s.id} className="rounded-xl border border-border bg-surface p-3">
          <h4 className="flex items-baseline justify-between gap-2">
            <span className="font-display text-xs font-semibold tracking-[0.14em] uppercase">Session {s.number}</span>
            <span className="text-xs text-faint">{dateFormat.format(s.endedAt ?? s.startedAt)}</span>
          </h4>
          {s.recap ? (
            <Markdown variant="narration" className={cn('mt-1.5 text-[0.9375rem]', serif && 'narration-serif')}>
              {s.recap}
            </Markdown>
          ) : (
            <p className="mt-1 text-sm text-muted italic">No recap was written for this session.</p>
          )}
          {spoilers && s.dmNotes && (
            <details className="mt-2 rounded-lg bg-arcane-soft px-2.5 py-1.5 text-xs text-arcane">
              <summary className="cursor-pointer font-semibold">DM notes</summary>
              <div className="mt-1 text-text">
                <Markdown>{s.dmNotes}</Markdown>
              </div>
            </details>
          )}
        </li>
      ))}
    </ol>
  );
}
