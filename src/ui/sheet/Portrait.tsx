import { cn } from '@/lib/cn';
import { portraitDisplay } from '@/ui/components/portrait';

const SIZES = {
  sm: 'size-9 text-xl',
  md: 'size-12 text-3xl',
  lg: 'size-16 text-4xl',
  xl: 'size-32 text-6xl',
} as const;

/** The hero's portrait: an emoji or an image embedded in the save. Decorative (the name is shown beside it). */
export function Portrait({ portrait, size = 'md', className }: { portrait?: string; size?: keyof typeof SIZES; className?: string }) {
  // Only emoji or images embedded in the save: never a remote URL (it would leak the player's IP).
  const shown = portraitDisplay(portrait);
  return (
    <div aria-hidden className={cn('grid shrink-0 place-items-center overflow-hidden rounded-2xl border border-border bg-surface-2', SIZES[size], className)}>
      {shown?.kind === 'image' ? (
        <img src={shown.src} alt="" className="size-full object-cover" />
      ) : (
        <span className="leading-none">{shown?.kind === 'text' ? shown.text : '🧑'}</span>
      )}
    </div>
  );
}
