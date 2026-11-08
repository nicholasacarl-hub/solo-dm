/**
 * Where the battle map sits (D58, D59): the desktop dock above the story (collapsed to the 44px BattleBar, normal or
 * large; the composer stays visible), the phone Combat tab (activity, the map, the tracker; two columns in phone
 * landscape by CSS), and the phone Story tab's BattleChip that switches to it.
 */
import { useEffect, useMemo, useRef } from 'react';
import { ChevronDown, ChevronRight, Map as MapIcon, Swords } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { playerView } from '@/engine';
import { cn } from '@/lib/cn';
import { heroMoveBlock, useGame } from '@/state/gameStore';
import { Button } from '@/ui/components/ui';
import { CombatTracker } from '../CombatTracker';
import { DmActivityBar } from '../composer/DmActivityBar';
import { isBusyPhase } from '../dmStatus';
import { PanelBoundary } from '../PanelBoundary';
import { usePlayView } from '../playView';
import { useIsTouch } from '../useMediaQuery';
import { BattleMapPanel } from './BattleMapPanel';
import { shownHeroBudget, turnRecordHidden } from './model';
import { battleChipText, possessive } from './text';

export interface BattleSummary {
  encounter: string;
  round: number;
  /** The player's view shows the hero acting (D42: also while a hidden creature acts right after the hero). */
  yourTurn: boolean;
  currentName: string | null;
  leftFt: number | null;
}

/** A light summary of the mapped fight for the collapsed dock and the phone chip (player view only). */
export function useBattleSummary(): BattleSummary | null {
  const { combat, hero, rawBlock } = useGame(useShallow((s) => ({ combat: s.combat, hero: s.character, rawBlock: heroMoveBlock(s) })));
  return useMemo(() => {
    if (!combat?.active || !combat.map) return null;
    const view = playerView(combat);
    const current = view.combatants[view.turnIndex];
    const yourTurn = current?.isPlayer === true;
    const budget = yourTurn && current ? shownHeroBudget(view, hero, current.id, rawBlock === 'not-your-turn', turnRecordHidden(combat)) : null;
    return {
      encounter: combat.encounterName || 'Combat',
      // The player view's round, like every other "whose turn" surface (D42).
      round: view.round,
      yourTurn,
      currentName: current && !current.isPlayer ? current.name : null,
      leftFt: budget ? budget.leftFt : null,
    };
  }, [combat, hero, rawBlock]);
}

/** Whether a fight on a battle map is on the table. */
export function useMappedFight(): boolean {
  return useGame((s) => Boolean(s.combat?.active && s.combat.map));
}

/**
 * Plans, measurements and area templates belong to the moment they were made (spec §7.3): they go when the DM
 * starts working or the turn the player sees moves on — also while the map is off screen (the phone Story tab, the
 * collapsed dock), so a stale plan never comes back with the map. Mounted once by the Play table.
 *
 * The keyboard cursor, the highlight and Measure / Area mode belong to one fight's map: a new fight, a new map or
 * the end of the fight starts them afresh, so a cursor can't be left off a smaller map (U10). The list view is a way
 * of playing, not part of a moment, and stays.
 */
export function useMapPlanExpiry(): void {
  const turnKey = useGame((s) => {
    const c = s.combat;
    if (!c?.active || !c.map) return null;
    const view = playerView(c);
    return `${view.round}:${view.combatants[view.turnIndex]?.id ?? ''}`;
  });
  const busy = useGame((s) => isBusyPhase(s.dm.phase));
  /** The fight and its map, like the camera's key: null without a mapped fight. */
  const mapKey = useGame((s) => (s.combat?.active && s.combat.map ? `${s.combat.startedAt}:${s.combat.map.id}` : null));
  const seen = useRef({ turnKey, busy, mapKey });
  useEffect(() => {
    const prev = seen.current;
    seen.current = { turnKey, busy, mapKey };
    if (mapKey !== prev.mapKey) {
      usePlayView.setState({ plan: null, measure: null, template: null, cursor: null, highlightedId: null, mapMode: 'move' });
      return;
    }
    if ((busy && !prev.busy) || turnKey !== prev.turnKey) {
      const view = usePlayView.getState();
      if (view.plan || view.measure || view.template) usePlayView.setState({ plan: null, measure: null, template: null });
    }
  }, [turnKey, busy, mapKey]);
}

/** The collapsed dock: "⚔ Ambush in the warehouse · Round 2 · Your turn · 30 ft [Show map ▾]". */
export function BattleBar({ onExpand }: { onExpand(): void }) {
  const summary = useBattleSummary();
  const touch = useIsTouch();
  if (!summary) return null;
  const turn = summary.yourTurn
    ? `Your turn${summary.leftFt !== null ? ` · ${summary.leftFt} ft` : ''}`
    : summary.currentName
      ? `${possessive(summary.currentName)} turn`
      : '';
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 text-sm">
      <Swords className="size-4 shrink-0 text-danger" aria-hidden />
      <p className="min-w-0 flex-1 truncate">
        <span className="font-semibold">{summary.encounter}</span>
        <span className="text-muted"> · Round {summary.round}</span>
        {turn && <span className={summary.yourTurn ? 'font-semibold text-accent' : 'text-muted'}> · {turn}</span>}
      </p>
      <Button size={touch ? 'md' : 'sm'} variant="secondary" className={touch ? 'min-h-11' : undefined} onClick={onExpand} icon={<ChevronDown className="size-4" aria-hidden />}>
        Show map
      </Button>
    </div>
  );
}

/** Desktop: the dock above StoryColumn while a mapped fight is on (D59). */
export function MapDock() {
  const mapped = useMappedFight();
  const dock = usePlayView((s) => s.mapDock);
  if (!mapped) return null;
  if (dock === 'collapsed') return <BattleBar onExpand={() => usePlayView.getState().setMapDock('normal')} />;
  return (
    <section
      aria-label="Battle map"
      className={cn('shrink-0 border-b border-border bg-surface', dock === 'large' ? 'h-[clamp(20rem,62vh,44rem)]' : 'h-[clamp(16rem,42vh,30rem)]')}
    >
      <PanelBoundary name="battle map">
        <BattleMapPanel variant="dock" />
      </PanelBoundary>
    </section>
  );
}

/** Phone: the Combat tab during a mapped fight — activity, the turn pill and the map, the action bar, the tracker (D58). */
export function CombatTabPanel() {
  return (
    <section id="play-panel-combat" role="tabpanel" aria-labelledby="play-tab-combat" className="combat-tab h-full overflow-y-auto overscroll-contain scroll-thin">
      <div data-map-part="activity" className="px-3 pt-2 empty:hidden">
        <DmActivityBar />
      </div>
      <PanelBoundary name="battle map">
        <BattleMapPanel variant="tab" />
      </PanelBoundary>
      <div data-map-part="side" className="px-3 pt-3 pb-6">
        <PanelBoundary name="combat tracker">
          <CombatTracker />
        </PanelBoundary>
      </div>
    </section>
  );
}

/** Phone Story tab: "Battle map · your turn · 25 ft ▸" → the Combat tab. */
export function BattleChip() {
  const summary = useBattleSummary();
  if (!summary) return null;
  const text = battleChipText({ yourTurn: summary.yourTurn, currentName: summary.currentName, leftFt: summary.leftFt });
  return (
    <button
      type="button"
      onClick={() => usePlayView.getState().setMobileTab('combat')}
      className={cn(
        'flex h-11 w-full items-center gap-2 rounded-xl border px-3 text-left text-sm font-medium transition-colors',
        summary.yourTurn ? 'border-accent/40 bg-accent-soft text-accent' : 'border-border bg-surface text-text hover:bg-surface-2',
      )}
    >
      <MapIcon className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <ChevronRight className="size-4 shrink-0" aria-hidden />
    </button>
  );
}

