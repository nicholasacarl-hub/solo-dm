import { cn } from '@/lib/cn';
import type { Clock } from '@/types';

const KIND_FILL: Record<Clock['kind'], string> = {
  threat: 'var(--danger)',
  countdown: 'var(--gold)',
  progress: 'var(--success)',
};

function point(cx: number, cy: number, r: number, angle: number): [number, number] {
  return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
}

/** One pie wedge from angle a0 to a1 (radians, 0 = 3 o'clock). */
function wedgePath(a0: number, a1: number, r = 46, c = 50): string {
  const [x0, y0] = point(c, c, r, a0);
  const [x1, y1] = point(c, c, r, a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${c} ${c} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
}

/** A segmented progress clock (Blades-style "fronts"): filled wedges clockwise from 12 o'clock. */
export function ClockFace({ clock, className }: { clock: Pick<Clock, 'segments' | 'filled' | 'kind' | 'name'>; className?: string }) {
  const segments = Math.max(1, Math.round(clock.segments));
  const filled = Math.min(segments, Math.max(0, Math.round(clock.filled)));
  const fill = KIND_FILL[clock.kind];
  const step = (2 * Math.PI) / segments;
  const start = -Math.PI / 2;

  return (
    <svg
      viewBox="0 0 100 100"
      role="img"
      aria-label={`${clock.name}: ${filled} of ${segments} segments filled`}
      className={cn('shrink-0', className)}
    >
      <circle cx={50} cy={50} r={47} fill="var(--surface-2)" stroke="var(--border)" strokeWidth={2} />
      {segments === 1 ? (
        filled === 1 && <circle cx={50} cy={50} r={46} fill={fill} />
      ) : (
        Array.from({ length: segments }, (_, i) => (
          <path
            key={i}
            d={wedgePath(start + i * step, start + (i + 1) * step)}
            fill={i < filled ? fill : 'transparent'}
            fillOpacity={i < filled ? 0.85 : 0}
            stroke="var(--surface)"
            strokeWidth={3}
            strokeLinejoin="round"
          />
        ))
      )}
      <circle cx={50} cy={50} r={47} fill="none" stroke="var(--border)" strokeWidth={2} />
    </svg>
  );
}
