import { cn } from '@/lib/cn';

/**
 * A d20 seen face-on: hexagonal silhouette, the front triangle and the edges of its neighbours.
 * Colour comes from `currentColor` (set a text-* class).
 */
export function D20Face({
  value,
  className,
  label,
}: {
  value: number | string;
  className?: string;
  /** Accessible name; omit when the number is already stated in nearby text. */
  label?: string;
}) {
  const text = String(value);
  return (
    <svg
      viewBox="0 0 100 100"
      className={cn('shrink-0', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <polygon
        points="50,2 93,26 93,74 50,98 7,74 7,26"
        fill="currentColor"
        fillOpacity={0.07}
        stroke="currentColor"
        strokeWidth={3.5}
        strokeLinejoin="round"
      />
      <g stroke="currentColor" strokeOpacity={0.32} strokeWidth={2} strokeLinecap="round">
        <line x1={50} y1={22} x2={50} y2={2} />
        <line x1={50} y1={22} x2={93} y2={26} />
        <line x1={50} y1={22} x2={7} y2={26} />
        <line x1={80} y1={72} x2={93} y2={26} />
        <line x1={80} y1={72} x2={93} y2={74} />
        <line x1={80} y1={72} x2={50} y2={98} />
        <line x1={20} y1={72} x2={50} y2={98} />
        <line x1={20} y1={72} x2={7} y2={74} />
        <line x1={20} y1={72} x2={7} y2={26} />
      </g>
      <polygon
        points="50,22 80,72 20,72"
        fill="currentColor"
        fillOpacity={0.12}
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinejoin="round"
      />
      <text
        x={50}
        y={57}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={text.length > 1 ? 23 : 27}
        fontWeight={700}
        fill="currentColor"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {text}
      </text>
    </svg>
  );
}
