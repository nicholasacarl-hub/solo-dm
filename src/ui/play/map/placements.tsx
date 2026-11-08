/**
 * Where the battle map sits (D58, D59): the desktop dock above the story (collapsed to the 44px BattleBar, normal or
 * large; the composer stays visible), the phone Combat tab (activity, the map, the tracker; two columns in phone
 * landscape by CSS), and the phone Story tab's BattleChip that switches to it.
 */
import { useMemo } from 'react';
import { ChevronDown, ChevronRight, Map as MapIcon, Swords } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { playerView, turnBudget } from '@/engine';
import { cn } from '@/lib/cn';
import { heroMoveBlock, useGame } from '@/state/gameStore';
import { Button } from '@/ui/components/ui';
import { CombatTracker } from '../CombatTracker';
import { DmActivityBar } from '../composer/DmActivityBar';
import { PanelBoundary } from '../PanelBoundary';
import { usePlayView } from '../playView';
import { BattleMapPanel } from './BattleMapPanel';
import { battleChipText, possessive } from './text';

export interface BattleSummary {
  encounter: string;
  round: number;
  yourTurn: boolean;
  /** A hidden creature's turn while the player's view still shows the hero (D42). */
  waiting: boolean;
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
    const waiting = yourTurn && rawBlock === 'not-your-turn';
    const budget = yourTurn && !waiting && current ? turnBudget(view, hero, current.id) : null;
    return {
      encounter: combat.encounterName || 'Combat',
      round: combat.round,
      yourTurn,
      waiting,
      currentName: current && !current.isPlayer ? current.name : null,
      leftFt: budget ? budget.leftFt : null,
    };
  }, [combat, hero, rawBlock]);
}

/** Whether a fight on a battle map is on the table. */
export function useMappedFight(): boolean {
  return useGame((s) => Boolean(s.combat?.active && s.combat.map));
}

/** The collapsed dock: "⚔ Ambush in the warehouse · Round 2 · Your turn · 30 ft [Show map ▾]". */
export function BattleBar({ onExpand }: { onExpand(): void }) {
  const summary = useBattleSummary();
  if (!summary) return null;
  const turn = summary.waiting
    ? 'Waiting for the DM…'
    : summary.yourTurn
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
        {turn && <span className={summary.yourTurn && !summary.waiting ? 'font-semibold text-accent' : 'text-muted'}> · {turn}</span>}
      </p>
      <Button size="sm" variant="secondary" onClick={onExpand} icon={<ChevronDown className="size-4" aria-hidden />}>
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
  const text = battleChipText({ yourTurn: summary.yourTurn, waiting: summary.waiting, currentName: summary.currentName, leftFt: summary.leftFt });
  return (
    <button
      type="button"
      onClick={() => usePlayView.getState().setMobileTab('combat')}
      className={cn(
        'flex h-11 w-full items-center gap-2 rounded-xl border px-3 text-left text-sm font-medium transition-colors',
        summary.yourTurn && !summary.waiting ? 'border-accent/40 bg-accent-soft text-accent' : 'border-border bg-surface text-text hover:bg-surface-2',
      )}
    >
      <MapIcon className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <ChevronRight className="size-4 shrink-0" aria-hidden />
    </button>
  );
}

