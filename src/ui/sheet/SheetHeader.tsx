import { ArrowBigUpDash } from 'lucide-react';
import { XP_THRESHOLDS, characterLevel } from '@/engine';
import { cn } from '@/lib/cn';
import { useGame } from '@/state/gameStore';
import type { Character } from '@/types';
import { Badge, Button } from '@/ui/components/ui';
import { portraitDisplay } from '@/ui/components/portrait';

/** "Wizard 3 (Evoker) / Fighter 1". */
export function classSummary(c: Character): string {
  return c.classes.map((k) => `${k.name} ${k.level}${k.subclass ? ` (${k.subclass})` : ''}`).join(' / ');
}

export function Portrait({ portrait, size = 'md', className }: { portrait?: string; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const dims = size === 'lg' ? 'size-16 text-4xl' : size === 'sm' ? 'size-9 text-xl' : 'size-12 text-3xl';
  // Only emoji or images embedded in the save: never a remote URL (it would leak the player's IP).
  const shown = portraitDisplay(portrait);
  return (
    <div aria-hidden className={cn('grid shrink-0 place-items-center overflow-hidden rounded-2xl border border-border bg-surface-2', dims, className)}>
      {shown?.kind === 'image' ? (
        <img src={shown.src} alt="" className="size-full object-cover" />
      ) : (
        <span className="leading-none">{shown?.kind === 'text' ? shown.text : '🧑'}</span>
      )}
    </div>
  );
}

function XpProgress({ c }: { c: Character }) {
  const level = characterLevel(c);
  const start = XP_THRESHOLDS[level - 1] ?? 0;
  const next = level < 20 ? XP_THRESHOLDS[level] : undefined;
  if (next === undefined) return <span className="text-xs text-gold tabular-nums">{c.xp.toLocaleString()} XP · max level</span>;
  const pct = Math.max(0, Math.min(100, ((c.xp - start) / Math.max(1, next - start)) * 100));
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2" title={`${c.xp.toLocaleString()} of ${next.toLocaleString()} XP for level ${level + 1}`}>
      <div
        role="progressbar"
        aria-label="Experience toward the next level"
        aria-valuemin={start}
        aria-valuemax={next}
        aria-valuenow={Math.min(c.xp, next)}
        className="h-1.5 min-w-12 flex-1 overflow-hidden rounded-full bg-surface-3"
      >
        <div className="h-full rounded-full bg-gold" style={{ width: `${pct}%` }} />
      </div>
      <span className="shrink-0 text-xs text-muted tabular-nums">
        {c.xp.toLocaleString()} / {next.toLocaleString()} XP
      </span>
    </div>
  );
}

export function SheetHeader({ character: c, editable, onLevelUp }: { character: Character; editable?: boolean; onLevelUp?: () => void }) {
  const milestone = useGame((s) => s.campaign?.settings.milestoneLeveling ?? true);
  const level = characterLevel(c);
  const next = level < 20 ? XP_THRESHOLDS[level] : undefined;
  const ready = !milestone && next !== undefined && c.xp >= next;
  const subtitle = [c.species, c.background, classSummary(c)].filter(Boolean).join(' · ');
  return (
    <header className="flex items-start gap-3">
      <Portrait portrait={c.portrait} />
      <div className="min-w-0 flex-1">
        <h2 className="truncate font-display text-lg leading-tight font-semibold">{c.name || 'Unnamed hero'}</h2>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted">{subtitle}</p>
        <div className="mt-1.5 flex items-center gap-2">
          <Badge tone="accent">Level {level}</Badge>
          {milestone ? <Badge tone="gold">Milestone</Badge> : <XpProgress c={c} />}
        </div>
      </div>
      {editable && onLevelUp && (
        <Button
          size="sm"
          variant={ready ? 'primary' : 'ghost'}
          icon={<ArrowBigUpDash className="size-4" aria-hidden />}
          onClick={onLevelUp}
          title={ready ? 'You have enough XP to level up' : 'Level up'}
          className="@max-sm:px-2"
        >
          <span className="@max-sm:sr-only">Level up</span>
        </Button>
      )}
    </header>
  );
}
