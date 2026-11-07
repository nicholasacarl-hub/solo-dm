import { useId } from 'react';
import { Shield, Skull, Swords } from 'lucide-react';
import { CONDITIONS, healthDescriptor } from '@/engine';
import { cn } from '@/lib/cn';
import { useGame } from '@/state/gameStore';
import type { ActiveCondition, Combatant, CombatSide, ConditionId, HitPoints } from '@/types';
import { Badge } from '@/ui/components/ui';
import { capitalize } from './format';

const SIDE_DOT: Record<CombatSide, string> = {
  player: 'bg-accent',
  ally: 'bg-success',
  enemy: 'bg-danger',
  neutral: 'bg-faint',
};

const SIDE_LABEL: Record<CombatSide, string> = {
  player: 'you',
  ally: 'ally',
  enemy: 'enemy',
  neutral: 'neutral',
};

type Descriptor = ReturnType<typeof healthDescriptor>;

const DESCRIPTOR_TONE: Record<Descriptor, string> = {
  unhurt: 'text-success',
  scratched: 'text-success',
  bloodied: 'text-gold',
  critical: 'text-danger',
  down: 'text-faint',
};

/** Read-only initiative tracker. The DM runs it through its combat tools. */
export function CombatTracker({ className }: { className?: string }) {
  const combat = useGame((s) => s.combat);
  const playerHp = useGame((s) => s.character?.hp ?? null);
  const titleId = useId();
  if (!combat?.active) return null;

  const current = combat.combatants[combat.turnIndex];
  const yourTurn = current?.isPlayer ?? false;

  return (
    <section
      aria-labelledby={titleId}
      className={cn('overflow-hidden rounded-2xl border border-border bg-surface shadow-card', className)}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Swords className="size-4 shrink-0 text-danger" aria-hidden />
          <h2 id={titleId} className="truncate font-display text-sm font-semibold tracking-wide">
            {combat.encounterName || 'Combat'}
          </h2>
        </div>
        <Badge>Round {combat.round}</Badge>
      </header>
      {yourTurn && (
        <p role="status" className="border-b border-border bg-accent-soft px-4 py-2 text-sm font-semibold text-accent">
          Your turn
        </p>
      )}
      <ol aria-label="Initiative order" className="divide-y divide-border">
        {combat.combatants.map((c, i) => (
          <CombatantRow key={c.id} combatant={c} current={i === combat.turnIndex} playerHp={c.isPlayer ? playerHp : null} />
        ))}
      </ol>
    </section>
  );
}

function CombatantRow({
  combatant: c,
  current,
  playerHp,
}: {
  combatant: Combatant;
  current: boolean;
  playerHp: HitPoints | null;
}) {
  const hp = c.isPlayer ? playerHp : (c.hp ?? null);
  return (
    <li
      aria-current={current ? 'true' : undefined}
      className={cn(
        'flex items-start gap-3 px-4 py-2.5',
        current && 'bg-surface-2 shadow-[inset_3px_0_0_var(--accent)]',
        c.defeated && 'opacity-55',
      )}
    >
      <span
        className={cn('mt-0.5 w-7 shrink-0 text-center text-sm tabular-nums', current ? 'font-semibold text-accent' : 'text-muted')}
        title="Initiative"
      >
        <span className="sr-only">Initiative </span>
        {c.initiative}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <span className={cn('size-2 shrink-0 rounded-full', SIDE_DOT[c.side])} aria-hidden />
          <span className={cn('truncate', c.defeated && 'line-through')}>{c.name}</span>
          <span className="shrink-0 text-xs font-normal text-faint">({SIDE_LABEL[c.side]})</span>
          {current && <span className="sr-only">, current turn</span>}
        </p>
        {c.defeated ? (
          <p className="mt-1 flex items-center gap-1 text-xs text-muted">
            <Skull className="size-3.5" aria-hidden />
            Defeated
          </p>
        ) : (
          hp && <HealthLine hp={hp} hidden={!c.isPlayer && c.hideHp === true} />
        )}
        {c.conditions.length > 0 && (
          <ul aria-label="Conditions" className="mt-1.5 flex flex-wrap gap-1">
            {c.conditions.map((cond) => (
              <li key={cond.id}>
                <ConditionChip condition={cond} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {c.ac !== undefined && (
        <span className="mt-0.5 flex shrink-0 items-center gap-1 text-xs text-muted" title="Armor Class">
          <Shield className="size-3.5" aria-hidden />
          <span className="sr-only">Armor Class </span>
          {c.ac}
        </span>
      )}
    </li>
  );
}

function HealthLine({ hp, hidden }: { hp: HitPoints; hidden: boolean }) {
  if (hidden) {
    const descriptor = healthDescriptor(hp);
    return (
      <p className={cn('mt-1 text-xs font-medium', DESCRIPTOR_TONE[descriptor])}>
        <span className="sr-only">Health: </span>
        {capitalize(descriptor)}
      </p>
    );
  }
  const ratio = hp.max > 0 ? Math.max(0, Math.min(1, hp.current / hp.max)) : 0;
  const tone = ratio > 0.5 ? 'bg-success' : ratio > 0.25 ? 'bg-gold' : 'bg-danger';
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3" aria-hidden>
        <div className={cn('h-full rounded-full transition-[width]', tone)} style={{ width: `${ratio * 100}%` }} />
      </div>
      <span className="shrink-0 text-xs text-muted tabular-nums">
        {hp.current}/{hp.max}
        {hp.temp > 0 && <span className="text-info"> +{hp.temp}</span>}
        <span className="sr-only"> hit points{hp.temp > 0 ? ` plus ${hp.temp} temporary` : ''}</span>
      </span>
    </div>
  );
}

function ConditionChip({ condition }: { condition: ActiveCondition }) {
  const info = CONDITIONS[condition.id as ConditionId] as (typeof CONDITIONS)[ConditionId] | undefined;
  const name = info?.name ?? capitalize(condition.id);
  const level = condition.level ? ` ${condition.level}` : '';
  const title = [info?.summary, condition.duration && `Duration: ${condition.duration}`, condition.source && `From ${condition.source}`]
    .filter(Boolean)
    .join(' · ');
  return (
    <span
      title={title || undefined}
      className="inline-flex items-center rounded-full border border-danger/30 bg-danger-soft px-2 py-0.5 text-[0.6875rem] font-medium text-danger"
    >
      {name}
      {level}
    </span>
  );
}
