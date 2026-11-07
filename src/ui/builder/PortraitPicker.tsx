import { useRef, type KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';
import { PORTRAITS } from './flavor';

/** Emoji portrait grid (a radio group with arrow-key navigation). */
export function PortraitPicker({ value, onChange, label = 'Portrait' }: { value: string; onChange: (emoji: string) => void; label?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const options = PORTRAITS.includes(value as (typeof PORTRAITS)[number]) || !value ? [...PORTRAITS] : [value, ...PORTRAITS];
  const selected = Math.max(0, options.indexOf(value));
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (i + step + options.length) % options.length;
    refs.current[next]?.focus();
    onChange(options[next]);
  };
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-8 gap-1.5 sm:grid-cols-12">
      {options.map((emoji, i) => (
        <button
          key={emoji}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={emoji === value}
          aria-label={`Portrait ${emoji}`}
          tabIndex={i === selected ? 0 : -1}
          onClick={() => onChange(emoji)}
          onKeyDown={(e) => onKeyDown(e, i)}
          className={cn(
            'grid aspect-square place-items-center rounded-xl border text-2xl transition-colors',
            emoji === value ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:bg-surface-2',
          )}
        >
          <span aria-hidden>{emoji}</span>
        </button>
      ))}
    </div>
  );
}
