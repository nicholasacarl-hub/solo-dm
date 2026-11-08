/**
 * The battle map as text (spec §7.9): you, every creature the player can see by distance (with Show on map and Move
 * next to), the terrain near you, and a Move to square field — the complete path for a player using neither a
 * pointer nor sight. Everything comes from the player view.
 */
import { useId, useMemo, useState } from 'react';
import { healthDescriptor, parseSquare, rectsLabel, snapDirection, spaceLabel } from '@/engine';
import type { GridPoint, GridRect, TerrainFeature } from '@/types';
import { Button, Input } from '@/ui/components/ui';
import { useIsTouch } from '../useMediaQuery';
import type { BattleMapModel } from './model';
import { previewMove } from './preview';
import { blockText, capitalize, conditionLabel, coverName, moveReadout, refusalText, turnPillText } from './text';
import { SIDE_WORD } from './tokenStyle';

const TERRAIN_WORD: Record<TerrainFeature['kind'], string> = {
  wall: 'wall',
  door: 'door',
  difficult: 'difficult terrain',
  'shallow-water': 'shallow water',
  'deep-water': 'deep water',
  pit: 'pit',
  hazard: 'hazard',
  'half-cover': 'half cover',
  'three-quarters-cover': 'three-quarters cover',
  obscured: 'heavily obscured',
};

function gap(a: GridRect, b: GridRect): number {
  return 5 * Math.max(0, b.x0 - a.x1, a.x0 - b.x1, b.y0 - a.y1, a.y0 - b.y1);
}

function direction(from: GridRect, to: GridRect): string {
  const dx = (to.x0 + to.x1) / 2 - (from.x0 + from.x1) / 2;
  const dy = (to.y0 + to.y1) / 2 - (from.y0 + from.y1) / 2;
  return dx === 0 && dy === 0 ? '—' : snapDirection(dx, dy);
}

export function PositionsList({
  model,
  onShow,
  onMoveTo,
  onMoveNextTo,
}: {
  model: BattleMapModel;
  onShow(id: string): void;
  onMoveTo(square: GridPoint): void;
  /** Plan a move next to a creature (the bar shows the plan). */
  onMoveNextTo?(id: string): void;
}) {
  const touch = useIsTouch();
  const titleId = useId();
  const fieldId = useId();
  const readoutId = useId();
  const [text, setText] = useState('');
  const hero = model.heroToken;
  const heroSpace = hero?.space ?? null;
  const btn = touch ? 'lg' : 'sm';
  // Touch targets of at least 44px on phones (spec §7.9), kept narrow enough for the table's last column.
  const rowBtn = touch ? 'px-3! text-sm!' : undefined;

  const creatures = useMemo(
    () =>
      model.snapshot.tokens
        .filter((t) => !t.isHero)
        .sort((a, b) => (a.distanceFromHeroFt ?? Infinity) - (b.distanceFromHeroFt ?? Infinity) || a.name.localeCompare(b.name)),
    [model.snapshot.tokens],
  );

  const terrain = useMemo(() => {
    if (!heroSpace) return [];
    return model.map.terrain
      .map((f) => ({ f, feet: Math.min(...f.rects.map((r) => gap(heroSpace, r))) }))
      .filter((x) => x.feet <= 30)
      .sort((a, b) => a.feet - b.feet);
  }, [model.map.terrain, heroSpace]);

  const parsed = text.trim() ? parseSquare(text, { width: model.map.width, height: model.map.height }) : null;
  const target = parsed?.ok ? parsed.value : null;
  const preview = target && model.canMove ? previewMove(model, { to: target, prefer: 'safest', dash: false, disengage: false, standUp: false }) : null;
  const readout = !parsed
    ? null
    : !parsed.ok
      ? parsed.problem
      : !model.canMove
        ? null
        : preview?.refusal
          ? refusalText(preview.refusal, { name: model.nameOf, budget: model.budget, map: model.map })
          : preview
            ? `${moveReadout(target as GridPoint, preview.costFt, preview.leftFt)}${preview.chips.length ? ` · ${preview.chips.map((c) => c.text).join(' · ')}` : ''}`
            : null;

  const conditions = [...model.hero.conditions.map((k) => conditionLabel(k.id, k.level)), ...(model.hero.exhaustion ? [conditionLabel('exhaustion', model.hero.exhaustion)] : [])];

  return (
    // tabIndex -1: where focus returns when the action bar's focused button goes (U1).
    <section aria-labelledby={titleId} tabIndex={-1} data-map-part="list" className="flex h-full flex-col gap-4 overflow-y-auto p-3 text-sm outline-none scroll-thin focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ring)]">
      <h2 id={titleId} className="sr-only">
        Positions on the battle map
      </h2>
      <div>
        <h3 className="mb-1 font-semibold">You</h3>
        <p className="text-muted">
          {hero?.space ? spaceLabel({ x: hero.space.x0, y: hero.space.y0 }, hero.size) : 'Not on the map'}
          {hero?.places.length ? ` (${hero.places.join(', ')})` : ''} · {turnPillText({ yourTurn: model.yourTurn, currentName: model.currentId ? (model.combatants.get(model.currentId)?.name ?? null) : null, budget: model.budget })}
          {conditions.length ? ` · ${conditions.join(', ')}` : ''}
        </p>
      </div>
      <div>
        <h3 className="mb-1 font-semibold">Creatures by distance</h3>
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full min-w-[40rem] text-left text-xs">
            <thead className="text-faint">
              <tr>
                <th scope="col" className="py-1 pr-2 font-medium">Name</th>
                <th scope="col" className="py-1 pr-2 font-medium">Side</th>
                <th scope="col" className="py-1 pr-2 font-medium">Square</th>
                <th scope="col" className="py-1 pr-2 font-medium">Distance</th>
                <th scope="col" className="py-1 pr-2 font-medium">Direction</th>
                <th scope="col" className="py-1 pr-2 font-medium">Health</th>
                <th scope="col" className="py-1 pr-2 font-medium">Conditions</th>
                <th scope="col" className="py-1 pr-2 font-medium">Line of sight</th>
                <th scope="col" className="py-1 pr-2 font-medium">Cover from you</th>
                <th scope="col" className="py-1 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {creatures.map((t) => {
                const c = model.combatants.get(t.id);
                const hp = c?.hp;
                const health = t.defeated ? 'down' : hp ? (c?.hideHp ? healthDescriptor(hp) : `${hp.current}/${hp.max}`) : '—';
                const cover = t.coverFromHero && t.coverFromHero.degree !== 'none' ? capitalize(coverName(t.coverFromHero.degree)) : 'None';
                return (
                  <tr key={t.id}>
                    <th scope="row" className="py-1.5 pr-2 font-medium">
                      {t.name}
                    </th>
                    <td className="py-1.5 pr-2">{SIDE_WORD[t.side]}</td>
                    <td className="py-1.5 pr-2 tabular-nums">{t.space ? spaceLabel({ x: t.space.x0, y: t.space.y0 }, t.size) : '—'}</td>
                    <td className="py-1.5 pr-2 tabular-nums">{t.distanceFromHeroFt !== null ? `${t.distanceFromHeroFt} ft` : '—'}</td>
                    <td className="py-1.5 pr-2">{heroSpace && t.space ? direction(heroSpace, t.space) : '—'}</td>
                    <td className="py-1.5 pr-2">{capitalize(health)}</td>
                    <td className="py-1.5 pr-2">{(c?.conditions ?? []).map((k) => conditionLabel(k.id, k.level)).join(', ') || '—'}</td>
                    <td className="py-1.5 pr-2">{t.heroCanSee ? 'Yes' : 'No'}</td>
                    <td className="py-1.5 pr-2">{cover}</td>
                    <td className="py-1 whitespace-nowrap">
                      <div className="flex gap-1">
                        <Button size={btn} variant="ghost" className={rowBtn} onClick={() => onShow(t.id)} aria-label={`Show ${t.name} on the map`}>
                          Show on map
                        </Button>
                        {onMoveNextTo && model.canMove && t.side === 'enemy' && !t.defeated && (
                          <Button size={btn} variant="secondary" className={rowBtn} onClick={() => onMoveNextTo(t.id)} aria-label={`Move next to ${t.name}`}>
                            Move next to
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div>
        <h3 className="mb-1 font-semibold">Terrain within 30 ft</h3>
        {terrain.length === 0 ? (
          <p className="text-muted">Open ground.</p>
        ) : (
          <ul className="flex flex-col gap-0.5 text-muted">
            {terrain.map(({ f, feet }) => (
              <li key={f.id}>
                {f.label ? `${capitalize(f.label)} (${TERRAIN_WORD[f.kind]}${f.kind === 'door' ? `, ${f.door ?? 'closed'}` : ''})` : capitalize(TERRAIN_WORD[f.kind])} {rectsLabel(f.rects)} · {feet} ft
              </li>
            ))}
          </ul>
        )}
      </div>
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!target || !preview || preview.refusal) return;
          onMoveTo(target);
          // The result is announced by the map's live region; a field still holding the square would re-read a
          // plan to where you now stand (U2).
          setText('');
        }}
      >
        <label htmlFor={fieldId} className="font-semibold">
          Move to square
        </label>
        <div className="flex items-center gap-2">
          <div className="w-28 shrink-0">
            <Input
              id={fieldId}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="E6"
              autoComplete="off"
              className={touch ? 'min-h-11' : undefined}
              aria-describedby={readout ? readoutId : undefined}
            />
          </div>
          <Button type="submit" variant="primary" size={btn} disabled={!target || !preview || preview.refusal !== null}>
            {preview?.dash ? 'Dash and move' : 'Move'}
          </Button>
        </div>
        {/* Always mounted (U2): a live region inserted together with its text is often not announced. */}
        <p id={readoutId} className="text-xs text-muted" aria-live="polite" data-testid="list-readout">
          {readout}
        </p>
        {/* Why you can't move right now, in the bar's words (U2): the DM working, a stop to tell the DM about… */}
        {model.block && (
          <p className="text-xs text-faint">{capitalize(blockText(model.block, { stopReactors: (model.pendingStop?.reactorIds ?? []).map(model.nameOf) }))}</p>
        )}
      </form>
    </section>
  );
}
