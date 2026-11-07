import { useState } from 'react';
import { ArrowBigUpDash, Dna, Paintbrush } from 'lucide-react';
import { XP_THRESHOLDS, characterLevel } from '@/engine';
import { useGame } from '@/state/gameStore';
import type { Character } from '@/types';
import { Badge, Button } from '@/ui/components/ui';
import { useImagesAvailability } from '@/ui/play/images/availability';
import { Portrait } from './Portrait';
import { PortraitDialog } from './PortraitDialog';
import { activeTransformations } from './TransformationsSection';

export { Portrait } from './Portrait';

/** "Wizard 3 (Evoker) / Fighter 1". */
export function classSummary(c: Character): string {
  return c.classes.map((k) => `${k.name} ${k.level}${k.subclass ? ` (${k.subclass})` : ''}`).join(' / ');
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

/** The portrait; with illustrations on, also the way to have a new one painted. */
function PortraitControl({ character }: { character: Character }) {
  const images = useImagesAvailability();
  const [painting, setPainting] = useState(false);
  if (!images.ok) return <Portrait portrait={character.portrait} />;
  return (
    <>
      <button
        type="button"
        onClick={() => setPainting(true)}
        aria-label="Paint portrait"
        title="Paint portrait"
        className="group relative shrink-0 rounded-2xl"
      >
        <Portrait portrait={character.portrait} className="transition-colors group-hover:border-accent" />
        <span
          aria-hidden
          className="absolute -right-1 -bottom-1 grid size-5 place-items-center rounded-full border border-border bg-surface text-accent shadow-sm group-hover:bg-accent-soft"
        >
          <Paintbrush className="size-3" />
        </span>
      </button>
      <PortraitDialog open={painting} onClose={() => setPainting(false)} character={character} />
    </>
  );
}

/** What the hero is becoming, at a glance (the Features tab has the details). */
function TransformedNote({ character, onShow }: { character: Character; onShow?: () => void }) {
  const active = activeTransformations(character);
  if (active.length === 0) return null;
  const text = active.map((t) => (t.stage ? `${t.name} (${t.stage})` : t.name)).join(' · ');
  const classes = 'mt-1 flex max-w-full min-w-0 items-center gap-1 text-xs font-medium text-arcane';
  const icon = <Dna className="size-3.5 shrink-0" aria-hidden />;
  if (!onShow) {
    return (
      <p className={classes}>
        {icon}
        <span className="truncate">
          <span className="sr-only">Transformed: </span>
          {text}
        </span>
      </p>
    );
  }
  return (
    <button
      type="button"
      onClick={onShow}
      aria-label={`Transformed: ${text}`}
      title="See transformations"
      className={`${classes} rounded-md text-left hover:underline`}
    >
      {icon}
      <span className="truncate">{text}</span>
    </button>
  );
}

export function SheetHeader({
  character: c,
  editable,
  onLevelUp,
  onShowTransformations,
}: {
  character: Character;
  editable?: boolean;
  onLevelUp?: () => void;
  /** Open the sheet where transformations are listed (the Features tab). */
  onShowTransformations?: () => void;
}) {
  const milestone = useGame((s) => s.campaign?.settings.milestoneLeveling ?? true);
  const level = characterLevel(c);
  const next = level < 20 ? XP_THRESHOLDS[level] : undefined;
  const ready = !milestone && next !== undefined && c.xp >= next;
  const subtitle = [c.species, c.background, classSummary(c)].filter(Boolean).join(' · ');
  return (
    <header className="flex items-start gap-3">
      {editable ? <PortraitControl character={c} /> : <Portrait portrait={c.portrait} />}
      <div className="min-w-0 flex-1">
        <h2 className="truncate font-display text-lg leading-tight font-semibold">{c.name || 'Unnamed hero'}</h2>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted">{subtitle}</p>
        <TransformedNote character={c} onShow={onShowTransformations} />
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
