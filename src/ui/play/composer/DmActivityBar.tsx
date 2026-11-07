import { RotateCcw, TriangleAlert } from 'lucide-react';
import { dm } from '@/dm';
import { useGame } from '@/state/gameStore';
import { Button } from '@/ui/components/ui';
import { phaseLabel, runDm } from '../dmStatus';

/** The slim "The DM is thinking…" bar above the composer; shows failures with Retry. */
export function DmActivityBar() {
  const status = useGame((s) => s.dm);

  if (status.phase === 'idle') return null;

  if (status.phase === 'error') {
    return (
      <div role="alert" className="flex items-center gap-2 rounded-xl bg-danger-soft px-3 py-2 text-sm text-text">
        <TriangleAlert className="size-4 shrink-0 text-danger" aria-hidden />
        <span className="min-w-0 flex-1">{status.error || phaseLabel('error', null)}</span>
        {status.retryable && (
          <Button
            size="sm"
            variant="secondary"
            icon={<RotateCcw className="size-3.5" aria-hidden />}
            onClick={() => void runDm(() => dm.retry())}
          >
            Retry
          </Button>
        )}
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
