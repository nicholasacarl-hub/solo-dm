/**
 * The map's action bar (spec §7.4): the plan's readout with its warning chips and Move / Dash and move (D61), the
 * result of a move with Undo, Tell the DM and End turn, the stop after an Opportunity Attack (D34), a card for what
 * was tapped, the measure readout, the area template bar, the waiting banner (D54) and the first-fight tip (D65).
 */
import type { ReactNode } from 'react';
import { ChevronRight, Undo2 } from 'lucide-react';
import { healthDescriptor, spaceLabel, type SnapshotToken } from '@/engine';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/components/ui';
import { useIsTouch } from '../useMediaQuery';
import { TemplateBar } from './AreaPicker';
import { FirstFightTip, WaitingBanner, waitingVisible } from './banners';
import { SquareCard, TokenCard } from './cards';
import { measureInfo } from './measure';
import type { BattleMapModel } from './model';
import type { PlanPreview } from './preview';
import {
  blockText,
  capitalize,
  moveReadout,
  movedText,
  refusalText,
  shortRouteChip,
  stoodText,
  stopText,
  unseenStopText,
} from './text';
import { SIDE_WORD } from './tokenStyle';
import type { MapController } from './useMapController';

function Chip({ children, warn = false }: { children: ReactNode; warn?: boolean }) {
  return (
    <li
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        warn ? 'bg-danger-soft text-danger' : 'bg-surface-2 text-muted',
      )}
    >
      {children}
    </li>
  );
}

function ToggleChip({ pressed, onClick, children, touch }: { pressed: boolean; onClick(): void; children: ReactNode; touch: boolean }) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={pressed}
        onClick={onClick}
        className={cn(
          'inline-flex items-center rounded-full border px-2.5 text-xs font-semibold transition-colors',
          touch ? 'min-h-11' : 'min-h-7',
          pressed ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-surface text-text hover:bg-surface-2',
        )}
      >
        {children}
      </button>
    </li>
  );
}

function MiniCard({ token, model }: { token: SnapshotToken; model: BattleMapModel }) {
  const c = model.combatants.get(token.id);
  const health = token.defeated ? 'down' : c?.hp ? healthDescriptor(c.hp) : null;
  return (
    <p className="text-xs text-muted">
      <span className="font-semibold text-text">{token.name}</span> · {SIDE_WORD[token.side]}
      {health ? ` · ${health}` : ''}
      {token.space ? ` · ${spaceLabel({ x: token.space.x0, y: token.space.y0 }, token.size)}` : ''}
    </p>
  );
}

function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center justify-end gap-2', className)}>{children}</div>;
}

function PlanBar({ model, controller, preview, btn, touch }: { model: BattleMapModel; controller: MapController; preview: PlanPreview; btn: 'sm' | 'lg'; touch: boolean }) {
  const { ui, dispatch } = controller;
  const plan = ui.plan;
  if (!plan) return null;
  const target = ui.planTarget ? model.tokens.get(ui.planTarget) : undefined;
  const cancel = (
    <Button size={btn} variant="ghost" className={compact(btn)} onClick={() => dispatch({ type: 'cancel' })}>
      Cancel
    </Button>
  );
  if (preview.status === 'refused' && preview.refusal) {
    return (
      <div className="flex flex-col gap-1.5">
        {target && <MiniCard token={target} model={model} />}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-danger">{refusalText(preview.refusal, { name: model.nameOf, budget: model.budget, map: model.map })}</p>
          {cancel}
        </div>
      </div>
    );
  }
  const b = model.budget;
  const offerStand = !!b?.prone && !b.stoodUp;
  const offerDisengage = preview.stopReactors.length > 0 || plan.disengage;
  const hasChips = preview.chips.length > 0 || offerDisengage || offerStand || plan.dash || preview.alternative !== null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <div className="min-w-0 flex-1">
        {target && <MiniCard token={target} model={model} />}
        <p className="text-sm font-semibold tabular-nums" data-testid="plan-readout">
          {moveReadout(plan.to, preview.costFt, preview.leftFt)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {cancel}
        <Button
          size={btn}
          variant="primary"
          className={compact(btn)}
          onClick={() => dispatch({ type: 'confirm' })}
          disabled={ui.committing}
          icon={<ChevronRight className="size-4" aria-hidden />}
        >
          {preview.dash ? 'Dash and move' : 'Move'}
        </Button>
      </div>
      {hasChips && (
        <ul className="flex basis-full flex-wrap items-center gap-1.5" aria-label="About this move">
          {preview.chips.map((c) => (
            <Chip key={c.text} warn={c.warn}>
              {c.text}
            </Chip>
          ))}
          {offerDisengage && (
            <ToggleChip touch={touch} pressed={plan.disengage} onClick={() => dispatch({ type: 'plan-option', patch: { disengage: !plan.disengage } })}>
              Disengage (uses your action)
            </ToggleChip>
          )}
          {offerStand && b && (
            <ToggleChip touch={touch} pressed={plan.standUp} onClick={() => dispatch({ type: 'plan-option', patch: { standUp: !plan.standUp } })}>
              Stand up first ({b.standCostFt} ft)
            </ToggleChip>
          )}
          {plan.dash && (
            <ToggleChip touch={touch} pressed onClick={() => dispatch({ type: 'plan-option', patch: { dash: false } })}>
              Dash
            </ToggleChip>
          )}
          {preview.alternative && (
            <ToggleChip touch={touch} pressed={false} onClick={() => dispatch({ type: 'plan-option', patch: { prefer: preview.alternative?.prefer ?? 'safest' } })}>
              {preview.alternative.prefer === 'shortest' ? shortRouteChip(preview.alternative.provokes) : 'Safe route'}
            </ToggleChip>
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * Big targets on phones (48px tall), but narrow enough that a bar's buttons share one row at 390px. `!` because the
 * button's own size classes would otherwise win (cn doesn't merge Tailwind classes).
 */
function compact(btn: 'sm' | 'lg'): string | undefined {
  return btn === 'lg' ? 'px-3! text-sm!' : undefined;
}

function TurnButtons({ controller, btn, undo, end = true }: { controller: MapController; btn: 'sm' | 'lg'; undo: boolean; end?: boolean }) {
  const pad = compact(btn);
  return (
    <Row className="ml-auto">
      {undo && (
        <Button size={btn} variant="ghost" className={pad} onClick={controller.undo} icon={<Undo2 className="size-4" aria-hidden />}>
          Undo
        </Button>
      )}
      <Button size={btn} variant="primary" className={pad} onClick={controller.tellDm} icon={<ChevronRight className="size-4" aria-hidden />}>
        Tell the DM
      </Button>
      {end && (
        <Button size={btn} variant="secondary" className={pad} onClick={controller.endTurn}>
          End turn
        </Button>
      )}
    </Row>
  );
}

export function MapActionBar({ model, controller, variant }: { model: BattleMapModel; controller: MapController; variant: 'dock' | 'tab' }) {
  const touch = useIsTouch();
  const btn: 'sm' | 'lg' = touch || variant === 'tab' ? 'lg' : 'sm';
  const { ui, dispatch } = controller;
  const notice = controller.noticeText ? <p className="text-sm font-medium text-danger">{controller.noticeText}</p> : null;

  if (ui.inspect) {
    if (ui.inspect.kind === 'token') {
      const token = model.tokens.get(ui.inspect.id);
      if (token) {
        return (
          <TokenCard
            token={token}
            model={model}
            onClose={() => dispatch({ type: 'close-card' })}
            onMeasure={() => dispatch({ type: 'measure-from', from: { id: token.id } })}
            onMoveNextTo={() => controller.tap({ x: token.space?.x0 ?? 0, y: token.space?.y0 ?? 0 }, { x: 0, y: 0 }, 'keyboard')}
          />
        );
      }
    } else {
      const at = ui.inspect.at;
      return <SquareCard square={at} model={model} onClose={() => dispatch({ type: 'close-card' })} onMoveHere={model.canMove ? () => controller.planTo(at) : undefined} />;
    }
  }

  if (ui.mode === 'measure') {
    const info = measureInfo(model, ui.measure ?? { from: { id: model.heroId }, to: null }, ui.hover);
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 flex-1 text-sm font-medium" data-testid="measure-readout">
          {info?.text ?? (touch ? 'Tap a square or a creature to measure to it.' : 'Point at a square or a creature to measure to it.')}
        </p>
        <Row>
          {ui.measure?.to && (
            <Button size={btn} variant="ghost" onClick={() => dispatch({ type: 'measure-swap' })}>
              Swap
            </Button>
          )}
          {ui.measure && (
            <Button size={btn} variant="secondary" onClick={() => dispatch({ type: 'measure-clear' })}>
              Clear
            </Button>
          )}
        </Row>
      </div>
    );
  }

  if (ui.mode === 'area') return <TemplateBar model={model} controller={controller} />;

  if (ui.committing) return <p className="text-sm text-muted">Moving…</p>;

  if (controller.preview) return <PlanBar model={model} controller={controller} preview={controller.preview} btn={btn} touch={touch} />;

  if (model.yourTurn && model.pendingStop) {
    const reactors = model.pendingStop.reactorIds.map(model.nameOf);
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 basis-60 text-sm font-medium">{stopText(model.pendingStop.at, reactors)}</p>
        <TurnButtons controller={controller} btn={btn} undo={model.canUndo} end={false} />
        {notice && <div className="basis-full">{notice}</div>}
      </div>
    );
  }

  const last = model.yourTurn ? model.unseenMoves.at(-1) : undefined;
  if (last) {
    const left = model.budget?.leftFt ?? null;
    const text = last.revealedHidden ? unseenStopText(last.to) : last.kind === 'stand' ? stoodText(left) : movedText(last.to, left);
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 basis-40 text-sm font-medium" data-testid="moved-readout">
          {text}
        </p>
        <TurnButtons controller={controller} btn={btn} undo={model.canUndo} />
        {notice && <div className="basis-full">{notice}</div>}
      </div>
    );
  }

  if (!model.yourTurn) {
    if (!notice && !waitingVisible(model)) return null;
    return (
      <div className="flex flex-col gap-2">
        {notice}
        <WaitingBanner model={model} />
      </div>
    );
  }

  // The hero's turn. A standing reason not to move (the DM's question, no session…) shows as a quiet line; while the
  // DM works, nothing (the activity bar says so) unless a tap asked to move (the notice).
  const blocked = model.block && model.block !== 'dm-busy' ? capitalize(blockText(model.block, { stopReactors: [] })) : null;
  const quiet = blocked && blocked !== controller.noticeText ? blocked : null;
  if (!notice && !quiet && !model.canMove) return null;
  return (
    <div className="flex flex-col gap-2">
      {notice}
      {quiet && <p className="text-sm text-muted">{quiet}</p>}
      {model.canMove && (
        // The tip beside End turn, or above it when the bar is narrow (phone landscape's side column).
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="min-w-0 flex-1 basis-56">
            <FirstFightTip fallback={<p className="text-xs text-faint">{touch ? 'Tap a square to plan a move.' : 'Click a square to move there.'}</p>} />
          </div>
          <Button size={btn} variant="secondary" className={compact(btn)} onClick={controller.endTurn}>
            End turn
          </Button>
        </div>
      )}
    </div>
  );
}
