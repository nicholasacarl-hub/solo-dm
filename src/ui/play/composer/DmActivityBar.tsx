import { useGame } from '@/state/gameStore';
import { phaseLabel } from '../dmStatus';

/** The slim "The DM is thinking…" bar above the composer. Failures show as an error card in the log. */
export function DmActivityBar() {
  const status = useGame((s) => s.dm);

  if (status.phase === 'idle') return null;

  if (status.phase === 'error') {
    // The error card in the log already shows the message with Retry; announce it for screen
    // readers without repeating it on screen.
    return (
      <div role="alert" className="sr-only">
        {status.error || phaseLabel('error', null)}
      </div>
    );
  }

  return (
    <div role="status" className="flex items-center gap-2.5 px-1 text-sm text-muted">
      <span className="flex items-center gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 animate-pulse rounded-full bg-accent"
            style={{ animationDelay: `${i * 180}ms` }}
          />
        ))}
      </span>
      <span className="truncate">{phaseLabel(status.phase, status.activity)}</span>
    </div>
  );
}
