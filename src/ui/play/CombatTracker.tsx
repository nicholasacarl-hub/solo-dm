import { memo, useId, useMemo, useRef, type MouseEvent } from 'react';
import { EyeOff, LocateFixed, Shield, Skull, Swords } from 'lucide-react';
import { CONDITIONS, footprint, healthDescriptor, playerView, spaceDistanceFt, spaceLabel, type Space } from '@/engine';
import { cn } from '@/lib/cn';
import { useGame } from '@/state/gameStore';
import type { ActiveCondition, Character, Combatant, CombatSide, CombatState, ConditionId, HitPoints } from '@/types';
import { Badge, IconButton } from '@/ui/components/ui';
import { capitalize } from './format';
import { usePlayView } from './playView';
import { useIsTouch } from './useMediaQuery';

const SIDE_DOT: Record<CombatSide, string> = {
  player: 'bg-accent',
  // Blue, not green: green and red collapse for deuteranopia (the map's ally tokens are blue too).
  ally: 'bg-info',
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

interface TrackerRow {
  combatant: Combatant;
  /** The creature the player sees acting (D42: never a hidden one). */
  current: boolean;
  /** Hidden from the player, shown only because "Show DM secrets" is on. */
  unseen: boolean;
  /** "F4 · 20 ft" (distance from the hero), "B6" for the hero; null off the map. */
  place: string | null;
}

/** A combatant's space on the battle map (the hero's size comes from the sheet unless overridden, spec §2.3). */
function spaceOf(c: Combatant & { position: NonNullable<Combatant['position']> }, hero: Character | null): Space {
  const size = c.size ?? (c.isPlayer ? hero?.size : undefined) ?? 'Medium';
  return { rect: footprint(c.position, size), elevationFt: c.elevationFt ?? 0, size };
}

function placeChips(combatants: readonly Combatant[], hero: Character | null): Map<string, string> {
  const chips = new Map<string, string>();
  const you = combatants.find((c) => c.isPlayer);
  const yourSpace = you?.position ? spaceOf({ ...you, position: you.position }, hero) : null;
  for (const c of combatants) {
    if (!c.position) continue;
    const space = spaceOf({ ...c, position: c.position }, hero);
    const square = spaceLabel(c.position, space.size);
    chips.set(c.id, c.isPlayer || !yourSpace ? square : `${square} · ${spaceDistanceFt(yourSpace, space)} ft`);
  }
  return chips;
}

/**
 * The tracker as the player sees it (D42, D63): the player view of the fight, so hidden creatures are left out and
 * the current-turn marker stays on the last creature the player saw act. "Show DM secrets" adds the hidden rows back
 * (dimmed, "Unseen") without moving the marker.
 */
function trackerRows(combat: CombatState, hero: Character | null, showSecrets: boolean): { rows: TrackerRow[]; yourTurn: boolean; round: number } {
  // With nobody hidden, the player's view is the fight itself.
  const view = combat.combatants.some((c) => c.hidden) ? playerView(combat) : combat;
  const current = view.combatants[view.turnIndex];
  const shown = showSecrets ? combat.combatants : view.combatants;
  const chips = combat.map ? placeChips(shown, hero) : new Map<string, string>();
  return {
    rows: shown.map((c) => ({
      combatant: c,
      current: c.id === current?.id,
      unseen: c.hidden === true,
      place: chips.get(c.id) ?? null,
    })),
    yourTurn: current?.isPlayer ?? false,
    // The player view's round (K1): a hidden creature first in a new round doesn't tick "Round N" over before anyone
    // the player can see acts.
    round: view.round,
  };
}

/** Read-only initiative tracker. The DM runs it through its combat tools. */
export function CombatTracker({ className }: { className?: string }) {
  const combat = useGame((s) => s.combat);
  const hero = useGame((s) => s.character);
  const showSecrets = usePlayView((s) => s.showSpoilers);
  const titleId = useId();
  const tracker = useMemo(
    () => (combat?.active ? trackerRows(combat, hero, showSecrets) : null),
    [combat, hero, showSecrets],
  );
  if (!combat?.active || !tracker) return null;
  const onMap = combat.map !== undefined;

  return (
    <section
      aria-labelledby={titleId}
      className={cn('overflow-hidden rounded-2xl border border-border bg-surface shadow-card', className)}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Swords className="size-4 shrink-0 text-danger" aria-hidden />
          <h2 id={titleId} className="truncate font-display text-sm font-semibold tracking-wide">
            {combat.encounterName || 'Combat'}
          </h2>
        </div>
        <Badge>Round {tracker.round}</Badge>
      </div>
      {tracker.yourTurn && (
        <p role="status" className="border-b border-border bg-accent-soft px-4 py-2 text-sm font-semibold text-accent">
          Your turn
        </p>
      )}
      <ol aria-label="Initiative order" className="divide-y divide-border">
        {tracker.rows.map((row) => (
          <CombatantRow
            key={row.combatant.id}
            row={row}
            onMap={onMap}
            playerHp={row.combatant.isPlayer ? (hero?.hp ?? null) : null}
            playerAc={row.combatant.isPlayer ? (hero?.armorClass ?? null) : null}
          />
        ))}
      </ol>
    </section>
  );
}

/**
 * On phones the tracker sits under the map in the Combat tab's scrolling panel: bring the map back into view, so
 * "Show on map" shows something (U5). Elsewhere the map is already on screen and nothing scrolls.
 */
function revealMapFrom(button: Element): void {
  const panel = button.closest('#play-panel-combat')?.querySelector<HTMLElement>('[data-map-part="panel"]');
  panel?.scrollIntoView?.({ block: 'nearest' });
}

/**
 * One row. Memoized, and it watches only whether its own creature is highlighted, so the highlight following the
 * pointer over the map re-renders two rows, not the whole tracker (K3).
 */
const CombatantRow = memo(function CombatantRow({
  row: { combatant: c, current, unseen, place },
  onMap,
  playerHp,
  playerAc,
}: {
  row: TrackerRow;
  onMap: boolean;
  playerHp: HitPoints | null;
  playerAc: number | null;
}) {
  const touch = useIsTouch();
  const highlighted = usePlayView((s) => s.highlightedId === c.id);
  /** "Show on map" marked this creature: leaving the row keeps it marked until something else is highlighted. */
  const shown = useRef(false);
  const hp = c.isPlayer ? playerHp : (c.hp ?? null);
  // The hero's AC comes from the sheet too: the combatant's copy dates from the start of the fight.
  const ac = c.isPlayer ? playerAc : (c.ac ?? null);
  // The DM hides this creature's numbers (the default for enemies): its exact HP and its AC, which
  // would give away a disguised creature's stat block or how hard it is to hit.
  const numbersHidden = !c.isPlayer && c.hideHp === true;
  const position = c.position;
  const showOnMap = (e: MouseEvent<HTMLButtonElement>) => {
    const view = usePlayView.getState();
    shown.current = true;
    view.setHighlighted(c.id);
    if (position) view.setCursor(position);
    view.focusMap();
    revealMapFrom(e.currentTarget);
  };
  // Hovering or focusing a row highlights its token on the map (and the map's hover highlights the row).
  const highlight = () => {
    shown.current = false;
    usePlayView.getState().setHighlighted(c.id);
  };
  const unhighlight = () => {
    if (!shown.current && usePlayView.getState().highlightedId === c.id) usePlayView.getState().setHighlighted(null);
  };
  return (
    <li
      aria-current={current ? 'true' : undefined}
      onMouseEnter={highlight}
      onMouseLeave={unhighlight}
      onFocus={highlight}
      onBlur={unhighlight}
      className={cn(
        'flex items-start gap-3 px-4 py-2.5',
        current && 'bg-surface-2 shadow-[inset_3px_0_0_var(--accent)]',
        highlighted && 'outline-2 -outline-offset-2 outline-text/40',
        (c.defeated || unseen) && 'opacity-55',
      )}
    >
      <span
        className={cn(
          'mt-0.5 w-7 shrink-0 text-center text-sm tabular-nums',
          current ? 'font-semibold text-accent' : 'text-muted',
        )}
        title="Initiative"
      >
        <span className="sr-only">Initiative </span>
        {c.initiative}
      </span>
      <div className="min-w-0 flex-1">
        {/* Wraps instead of squeezing the name: the side, the Unseen badge and the square go to the next line when
            the rail is narrow (E1), and only a name too long for a line of its own is cut. */}
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm font-medium">
          <span className={cn('size-2 shrink-0 rounded-full', SIDE_DOT[c.side])} aria-hidden />
          <span className={cn('min-w-0 truncate', c.defeated && 'line-through')}>{c.name}</span>
          <span className="shrink-0 text-xs font-normal text-faint">({SIDE_LABEL[c.side]})</span>
          {current && <span className="sr-only">, current turn</span>}
          {unseen && (
            <Badge className="shrink-0 border-dashed">
              <EyeOff className="size-3" aria-hidden />
              Unseen
            </Badge>
          )}
          {place && (
            <span className="ml-auto shrink-0 pl-1 text-xs font-normal text-muted tabular-nums" title="Square and distance from you">
              <span className="sr-only">On the map: </span>
              {place}
            </span>
          )}
        </p>
        {c.defeated ? (
          <p className="mt-1 flex items-center gap-1 text-xs text-muted">
            <Skull className="size-3.5" aria-hidden />
            Defeated
          </p>
        ) : (
          hp && <HealthLine hp={hp} hidden={numbersHidden} />
        )}
        {c.conditions.length > 0 && (
          <ul aria-label="Conditions" className="mt-1.5 flex flex-wrap gap-1">
            {c.conditions.map((cond) => (
              <li key={cond.id}>
                <ConditionChip condition={cond} details={c.isPlayer} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {ac !== null && !numbersHidden && (
        <span className="mt-0.5 flex shrink-0 items-center gap-1 text-xs text-muted" title="Armor Class">
          <Shield className="size-3.5" aria-hidden />
          <span className="sr-only">Armor Class </span>
          {ac}
        </span>
      )}
      {onMap && position && (
        <IconButton label={`Show ${c.name} on the map`} size={touch ? 'lg' : 'sm'} className="-my-1 -mr-2" onClick={showOnMap}>
          <LocateFixed className="size-4" aria-hidden />
        </IconButton>
      )}
    </li>
  );
});

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

/**
 * A condition on a tracker row. Its duration and source, which the DM wrote, show only on the hero's own row: on a
 * creature's they could name a hidden one or give away the DM's plans; the rules summary shows on every row.
 */
function ConditionChip({ condition, details }: { condition: ActiveCondition; details: boolean }) {
  const info = CONDITIONS[condition.id as ConditionId] as (typeof CONDITIONS)[ConditionId] | undefined;
  const name = info?.name ?? capitalize(condition.id);
  const level = condition.level ? ` ${condition.level}` : '';
  const title = [
    info?.summary,
    details && condition.duration && `Duration: ${condition.duration}`,
    details && condition.source && `From ${condition.source}`,
  ]
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
