/**
 * The battle map's controller: the pure reducer (mapReducer) over the view state that must survive remounts
 * (mode, plan, measure, template, cursor live in usePlayView) plus local state (hover, the open card, a commit in
 * flight), and the effects the reducer asks for — committing through the store (commitHeroMove re-checks every
 * gate and replays on the true map), Undo, End turn, Tell the DM and the [Area: …] line. Nothing here writes the
 * game store except those store actions; hover, plans, measuring and templates never do.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { resolveArea, type AreaResult } from '@/engine';
import { useGame, type HeroMoveResult } from '@/state/gameStore';
import type { GridPoint } from '@/types';
import { toast } from '@/ui/components/toast';
import { endTurn } from '../composer/turnWords';
import { usePlayView, type MapPlan } from '../playView';
import { changesSince, movedAnnouncement, planAnnouncement, squareAnnouncement, tokenAt, turnStartAnnouncement } from './announcer';
import { INITIAL_UI, mapReducer, type InputKind, type MapAction, type MapCommand, type MapNotice, type MapUiState, type TapTarget } from './mapReducer';
import { displayBlock, type BattleMapModel } from './model';
import { approachSquare, PreviewCache, type PlanPreview } from './preview';
import { templateLine } from './templates';
import {
  areaMessageLine,
  blockText,
  insideWarning,
  keepMovingWords,
  MOVE_FAILED_TOAST,
  rangeWarning,
  refusalText,
  stopText,
  UNDO_FAILED_TOAST,
  unseenStopText,
  YOU_INSIDE_WARNING,
} from './text';

const ANNOUNCE_DEBOUNCE_MS = 200;
const DEFAULT_OPTIONS: Omit<MapPlan, 'to'> = { prefer: 'safest', dash: false, disengage: false, standUp: false };

type LocalUi = Pick<MapUiState, 'planTarget' | 'hover' | 'inspect' | 'committing' | 'notice' | 'picker'>;

function pickLocal(s: MapUiState): LocalUi {
  return { planTarget: s.planTarget, hover: s.hover, inspect: s.inspect, committing: s.committing, notice: s.notice, picker: s.picker };
}

const LOCAL_KEYS = Object.keys(pickLocal(INITIAL_UI)) as (keyof LocalUi)[];

/** The area template's result on the player view, with its warnings. */
export interface AreaReadout {
  result: AreaResult | null;
  problem: string | null;
  catches: string[];
  warnings: string[];
  line: string | null;
}

export interface MapController {
  ui: MapUiState;
  dispatch(action: MapAction): void;
  /** The current plan's preview, and the mouse-hover preview (move mode, nothing planned). */
  preview: PlanPreview | null;
  hoverPreview: PlanPreview | null;
  area: AreaReadout | null;
  /** The polite live region's text (debounced). */
  announcement: string;
  announce(text: string): void;
  /** Resolve a tap on a square (what it hit, where an enemy approach ends, whether the preview warns). */
  tap(at: GridPoint, corner: { x: number; y: number }, input: InputKind): void;
  inspectAt(at: GridPoint): void;
  hoverAt(at: GridPoint | null): void;
  /** The notice line under the bar ("Too far: 45 ft…"), in the player's words. */
  noticeText: string | null;
  undo(): void;
  endTurn(): void;
  tellDm(): void;
  standUp(): void;
  addAreaToMessage(): void;
  planTo(to: GridPoint, target?: string | null): void;
}

/** A commit the store refused, in the bar's terms (a hidden creature's turn never reads "It isn't your turn"). */
function noticeFor(result: Extract<HeroMoveResult, { ok: false }>, model: Pick<BattleMapModel, 'yourTurn' | 'dmBusy'>): MapNotice {
  if (result.refusal) return { kind: 'refusal', refusal: result.refusal };
  if (result.block === 'refused') return { kind: 'block', block: 'refused' };
  return { kind: 'block', block: displayBlock(result.block, model.yourTurn, model.dmBusy) ?? 'refused' };
}

function heroAnchor(model: BattleMapModel): GridPoint | null {
  const s = model.heroToken?.space;
  return s ? { x: s.x0, y: s.y0 } : null;
}

export function useMapController(model: BattleMapModel): MapController {
  const persisted = usePlayView(
    useShallow((s) => ({ mode: s.mapMode, plan: s.plan, measure: s.measure, template: s.template, cursor: s.cursor })),
  );
  const [local, setLocal] = useState<LocalUi>(() => pickLocal(INITIAL_UI));
  const localRef = useRef(local);
  const modelRef = useRef(model);
  const [announcement, setAnnouncement] = useState('');
  const announceTimer = useRef(0);
  useEffect(() => {
    modelRef.current = model;
  });

  const previews = useMemo(() => new PreviewCache(model), [model]);
  const previewsRef = useRef(previews);
  useEffect(() => {
    previewsRef.current = previews;
  });

  const announce = useCallback((text: string) => {
    window.clearTimeout(announceTimer.current);
    announceTimer.current = window.setTimeout(() => setAnnouncement(text), ANNOUNCE_DEBOUNCE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(announceTimer.current), []);

  const current = useCallback((): MapUiState => {
    const s = usePlayView.getState();
    return { ...localRef.current, mode: s.mapMode, plan: s.plan, measure: s.measure, template: s.template, cursor: s.cursor };
  }, []);

  const dispatchRef = useRef<(a: MapAction) => void>(() => {});

  const runCommit = useCallback(async (plan: MapPlan) => {
    const m = modelRef.current;
    const preview = previewsRef.current.get(plan, { light: true });
    const finish = (notice: MapNotice | null) => dispatchRef.current({ type: 'committed', notice });
    if (preview.status === 'refused' && preview.refusal) {
      finish({ kind: 'refusal', refusal: preview.refusal });
      return;
    }
    try {
      const result = await useGame.getState().commitHeroMove({
        to: plan.to,
        prefer: plan.prefer,
        dash: preview.dash,
        disengage: plan.disengage,
        standUp: plan.standUp,
      });
      if (!result.ok) {
        finish(noticeFor(result, m));
        return;
      }
      finish(null);
      const outcome = result.outcome;
      if (outcome.stoppedFor?.kind === 'opportunity-attack') announce(stopText(outcome.move.to, outcome.stoppedFor.reactorIds.map(m.nameOf)));
      else if (outcome.stoppedFor) announce(unseenStopText(outcome.move.to));
      else announce(movedAnnouncement(outcome.move.to));
    } catch {
      toast.error(MOVE_FAILED_TOAST);
      finish(null);
    }
  }, [announce]);

  const run = useCallback(
    (commands: MapCommand[]) => {
      for (const c of commands) if (c.kind === 'commit') void runCommit(c.plan);
    },
    [runCommit],
  );

  const dispatch = useCallback(
    (action: MapAction) => {
      const before = current();
      const m = modelRef.current;
      const { state: next, commands } = mapReducer(before, action, { canMove: m.canMove, heroId: m.heroId, heroAt: heroAnchor(m), yourTurn: m.yourTurn, block: m.block });
      if (next.mode !== before.mode || next.plan !== before.plan || next.measure !== before.measure || next.template !== before.template || next.cursor !== before.cursor) {
        usePlayView.setState({ mapMode: next.mode, plan: next.plan, measure: next.measure, template: next.template, cursor: next.cursor });
      }
      const nextLocal = pickLocal(next);
      if (LOCAL_KEYS.some((k) => nextLocal[k] !== localRef.current[k])) {
        localRef.current = nextLocal;
        setLocal(nextLocal);
      }
      run(commands);
    },
    [current, run],
  );
  useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  const ui = useMemo<MapUiState>(() => ({ ...local, ...persisted }), [local, persisted]);

  // Plans, measures and templates go when the DM starts working or the turn moves on (spec §7.3).
  const turnKey = `${model.view.round}:${model.currentId}`;
  const seen = useRef({ busy: model.dmBusy, turnKey });
  useEffect(() => {
    const prev = seen.current;
    seen.current = { busy: model.dmBusy, turnKey };
    if ((model.dmBusy && !prev.busy) || turnKey !== prev.turnKey) dispatch({ type: 'reset' });
  }, [model.dmBusy, turnKey, dispatch]);

  // Turn start: one summary of what visibly changed since the hero's last turn.
  const lastTurnView = useRef<typeof model.view | null>(model.yourTurn ? null : model.view);
  const wasYourTurn = useRef(model.yourTurn);
  useEffect(() => {
    const was = wasYourTurn.current;
    wasYourTurn.current = model.yourTurn;
    if (!model.yourTurn && was) lastTurnView.current = model.view;
    if (model.yourTurn && !was && model.block !== 'waiting') {
      const before = lastTurnView.current;
      announce(turnStartAnnouncement(model.budget?.leftFt ?? null, before ? changesSince(before, model.view, model.nameOf) : []));
    }
  }, [model.yourTurn, model.view, model.budget, model.block, model.nameOf, announce]);

  const preview = useMemo(() => (ui.plan && ui.mode === 'move' && model.canMove ? previews.get(ui.plan) : null), [ui.plan, ui.mode, model.canMove, previews]);
  const hoverPreview = useMemo(() => {
    if (ui.plan || ui.mode !== 'move' || !model.canMove || !ui.hover) return null;
    if (tokenAt(model, ui.hover)) return null;
    return previews.get({ ...DEFAULT_OPTIONS, to: ui.hover }, { light: true });
  }, [ui.plan, ui.mode, ui.hover, model, previews]);

  // Say the plan once it settles.
  useEffect(() => {
    if (!preview) return;
    const refusal = preview.refusal ? refusalText(preview.refusal, { name: model.nameOf, budget: model.budget, map: model.map }) : null;
    announce(planAnnouncement(preview, model.nameOf, refusal));
  }, [preview, model, announce]);

  const area = useMemo((): AreaReadout | null => {
    if (ui.mode !== 'area' || !ui.template) return null;
    const result = resolveArea(model.view, model.hero, ui.template.spec, { rangeFt: ui.template.rangeFt, perspective: 'player' });
    if ('problem' in result) return { result: null, problem: result.problem, catches: [], warnings: [], line: null };
    const catches = result.inside.map((h) => model.combatants.get(h.id)?.name ?? '').filter(Boolean);
    const warnings: string[] = [];
    for (const hit of result.inside) {
      const c = model.combatants.get(hit.id);
      if (!c) continue;
      if (c.isPlayer) warnings.push(YOU_INSIDE_WARNING);
      else if (c.side === 'ally') warnings.push(insideWarning(c.name));
    }
    if (ui.template.rangeFt && result.origin.withinRange === false) warnings.push(rangeWarning(ui.template.label, ui.template.rangeFt));
    const heroName = model.combatants.get(model.heroId)?.name ?? model.hero.name;
    const line = areaMessageLine(templateLine(ui.template, heroName, catches, (id) => model.combatants.get(id)?.name ?? 'someone'));
    return { result, problem: null, catches, warnings, line };
  }, [ui.mode, ui.template, model]);

  const tap = useCallback(
    (at: GridPoint, corner: { x: number; y: number }, input: InputKind) => {
      const m = modelRef.current;
      const s = current();
      const token = tokenAt(m, at);
      let target: TapTarget = { kind: 'square' };
      if (token) {
        const role = token.isHero ? 'hero' : token.side === 'enemy' ? 'enemy' : 'other';
        const approach = role === 'enemy' && s.mode === 'move' && m.canMove ? approachSquare(m, token.id, s.plan ?? DEFAULT_OPTIONS) : null;
        target = { kind: 'token', id: token.id, role, approach };
      }
      const options = s.plan ?? DEFAULT_OPTIONS;
      const warned = input === 'mouse' && s.mode === 'move' && m.canMove && target.kind === 'square' ? previewsRef.current.get({ ...options, to: at }, { light: true }).warned : false;
      dispatch({ type: 'tap', at, corner, input, target, warned });
    },
    [current, dispatch],
  );

  const inspectAt = useCallback(
    (at: GridPoint) => {
      const token = tokenAt(modelRef.current, at, { includeDefeated: true });
      dispatch({ type: 'inspect', target: token ? { kind: 'token', id: token.id } : { kind: 'square', at } });
    },
    [dispatch],
  );

  const hoverAt = useCallback(
    (at: GridPoint | null) => {
      const s = current();
      if ((s.hover === null && at === null) || (s.hover && at && s.hover.x === at.x && s.hover.y === at.y)) return;
      dispatch({ type: 'hover', at });
      // The map's hover highlights the tracker row, and the reverse (spec §7.11).
      const token = at ? tokenAt(modelRef.current, at) : null;
      const view = usePlayView.getState();
      if (token) view.setHighlighted(token.id);
      else if (view.highlightedId && s.hover && tokenAt(modelRef.current, s.hover)?.id === view.highlightedId) view.setHighlighted(null);
    },
    [current, dispatch],
  );

  const noticeText = useMemo(() => {
    const n = ui.notice;
    if (!n) return null;
    if (n.kind === 'refusal') return refusalText(n.refusal, { name: model.nameOf, budget: model.budget, map: model.map });
    return blockText(n.block, { stopReactors: (model.pendingStop?.reactorIds ?? []).map(model.nameOf) });
  }, [ui.notice, model]);

  const undo = useCallback(() => {
    void useGame
      .getState()
      .undoHeroMove()
      .then((ok) => {
        if (ok) announce('Move undone.');
      })
      .catch(() => toast.error(UNDO_FAILED_TOAST));
  }, [announce]);

  const tellDm = useCallback(() => {
    const m = modelRef.current;
    const view = usePlayView.getState();
    if (m.pendingStop) {
      const words = keepMovingWords(m.pendingStop.destination);
      if (view.draft.includes(words)) view.focusComposer();
      else view.appendToDraft(words);
      return;
    }
    view.focusComposer();
  }, []);

  const standUp = useCallback(() => {
    void useGame
      .getState()
      .commitHeroMove({ prefer: 'safest', dash: false, disengage: false, standUp: true })
      .then((result) => {
        if (result.ok) announce('You stand up.');
        else dispatchRef.current({ type: 'committed', notice: noticeFor(result, modelRef.current) });
      })
      .catch(() => toast.error(MOVE_FAILED_TOAST));
  }, [announce]);

  const addAreaToMessage = useCallback(() => {
    const m = modelRef.current;
    const s = current();
    if (!s.template) return;
    const result = resolveArea(m.view, m.hero, s.template.spec, { rangeFt: s.template.rangeFt, perspective: 'player' });
    if ('problem' in result) return;
    const catches = result.inside.map((h) => m.combatants.get(h.id)?.name ?? '').filter(Boolean);
    const heroName = m.combatants.get(m.heroId)?.name ?? m.hero.name;
    usePlayView.getState().appendToDraft(areaMessageLine(templateLine(s.template, heroName, catches, (id) => m.combatants.get(id)?.name ?? 'someone')));
  }, [current]);

  const planTo = useCallback((to: GridPoint, target: string | null = null) => dispatch({ type: 'plan-to', to, target }), [dispatch]);

  // The cursor's square, read out as it moves (keyboard).
  const cursor = ui.cursor;
  const lastCursor = useRef(cursor);
  useEffect(() => {
    if (!cursor || (lastCursor.current && lastCursor.current.x === cursor.x && lastCursor.current.y === cursor.y)) {
      lastCursor.current = cursor;
      return;
    }
    lastCursor.current = cursor;
    if (!ui.plan) announce(squareAnnouncement(modelRef.current, cursor));
  }, [cursor, ui.plan, announce]);

  return {
    ui,
    dispatch,
    preview,
    hoverPreview,
    area,
    announcement,
    announce,
    tap,
    inspectAt,
    hoverAt,
    noticeText,
    undo,
    endTurn: () => void endTurn(),
    tellDm,
    standUp,
    addAreaToMessage,
    planTo,
  };
}
