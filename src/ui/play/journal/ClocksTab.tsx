import { Hourglass } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useGame } from '@/state/gameStore';
import type { Clock } from '@/types';
import { Badge, EmptyState } from '@/ui/components/ui';
import { ClockFace } from '../ClockFace';
import { usePlayView } from '../playView';
import { Group, HiddenNote } from './Group';

const KIND_LABEL: Record<Clock['kind'], { label: string; tone: 'danger' | 'gold' | 'success' }> = {
  threat: { label: 'Threat', tone: 'danger' },
  countdown: { label: 'Countdown', tone: 'gold' },
  progress: { label: 'Project', tone: 'success' },
};

export function ClocksTab() {
  const clocks = useGame((s) => s.clocks);
  const spoilers = usePlayView((s) => s.showSpoilers);
  const visible = clocks.filter((c) => spoilers || !c.secret);
  const open = visible.filter((c) => !c.resolved);
  const resolved = visible.filter((c) => c.resolved);
  const hidden = spoilers ? 0 : clocks.filter((c) => c.secret).length;

  if (visible.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <EmptyState icon={<Hourglass className="size-7" aria-hidden />} title="No clocks running" className="py-8!">
          Looming threats and long projects tick here.
        </EmptyState>
        <HiddenNote count={hidden} singular="clock" plural="clocks" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {open.length > 0 && (
        <Group label="Ticking" count={open.length}>
          {open.map((c) => (
            <ClockRow key={c.id} clock={c} />
          ))}
        </Group>
      )}
      {resolved.length > 0 && (
        <Group label="Resolved" count={resolved.length} defaultOpen={false}>
          {resolved.map((c) => (
            <ClockRow key={c.id} clock={c} />
          ))}
        </Group>
      )}
      <HiddenNote count={hidden} singular="clock" plural="clocks" />
    </div>
  );
}

function ClockRow({ clock }: { clock: Clock }) {
  const kind = KIND_LABEL[clock.kind];
  return (
    <article
      className={cn(
        'flex items-start gap-3 rounded-xl border border-border bg-surface p-3',
        clock.resolved && 'opacity-60',
      )}
    >
      <ClockFace clock={clock} className="size-12" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <h4 className="text-sm font-semibold">{clock.name}</h4>
          <Badge tone={kind.tone}>{kind.label}</Badge>
          {clock.secret && <Badge tone="arcane">DM secret</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-faint tabular-nums">
          {Math.min(clock.filled, clock.segments)} of {clock.segments}
          {clock.resolved ? ' · resolved' : ''}
        </p>
        {clock.consequence && (
          <p className="mt-1 text-sm text-muted">
            <span className="sr-only">When it fills: </span>
            {clock.consequence}
          </p>
        )}
      </div>
    </article>
  );
}
