/**
 * The info cards in the action bar: a creature (from the player view: health as the tracker shows it, conditions in
 * full, where it stands, distance, sight, cover both ways, reach) and a square (terrain, places, effects, how far
 * and how much movement it takes).
 */
import type { ReactNode } from 'react';
import { Ruler, X } from 'lucide-react';
import { healthDescriptor, spaceLabel, squareLabel, type SnapshotToken } from '@/engine';
import type { GridPoint, GridRect } from '@/types';
import { Button, IconButton } from '@/ui/components/ui';
import { useIsTouch } from '../useMediaQuery';
import { directionWords, placesAt, terrainWords } from './announcer';
import type { BattleMapModel } from './model';
import { capitalize, conditionLabel, coverName, possessive } from './text';
import { SIDE_WORD } from './tokenStyle';

const SHAPE_DOT: Record<string, string> = {
  player: 'rounded-full bg-accent',
  ally: 'rounded-full bg-info',
  enemy: 'rotate-45 bg-danger',
  neutral: 'rounded-full border border-dashed border-faint bg-surface-3',
};

function CardFrame({ title, onClose, children, actions }: { title: ReactNode; onClose(): void; children: ReactNode; actions?: ReactNode }) {
  const touch = useIsTouch();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 text-sm font-semibold">{title}</div>
        <IconButton label="Close" size={touch ? 'md' : 'sm'} onClick={onClose} className="-my-1 -mr-1">
          <X className="size-4" aria-hidden />
        </IconButton>
      </div>
      <div className="flex flex-col gap-0.5 text-xs text-muted">{children}</div>
      {actions && <div className="mt-1 flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

function coverLine(degree: string, by: readonly string[]): string {
  return `${coverName(degree as 'none')}${by.length ? ` (${by.join(', ')})` : ''}`;
}

export function TokenCard({
  token,
  model,
  onMoveNextTo,
  onMeasure,
  onClose,
}: {
  token: SnapshotToken;
  model: BattleMapModel;
  onMoveNextTo(): void;
  onMeasure(): void;
  onClose(): void;
}) {
  const touch = useIsTouch();
  const c = model.combatants.get(token.id);
  const isHero = token.isHero;
  const hp = isHero ? model.hero.hp : (c?.hp ?? null);
  const exact = isHero || (!!hp && c?.hideHp !== true);
  const conditions = isHero
    ? [...model.hero.conditions.map((k) => conditionLabel(k.id, k.level)), ...(model.hero.exhaustion ? [conditionLabel('exhaustion', model.hero.exhaustion)] : [])]
    : (c?.conditions ?? []).map((k) => conditionLabel(k.id, k.level));
  const where = token.space ? spaceLabel({ x: token.space.x0, y: token.space.y0 }, token.size) : 'not on the map';
  const places = token.places.length ? ` (${token.places.join(', ')})` : '';
  const name = isHero ? 'You' : token.name;
  const lines: string[] = [];
  if (token.defeated) lines.push('Down');
  else if (hp) lines.push(exact ? `${hp.current} of ${hp.max} hit points${hp.temp ? ` (+${hp.temp} temporary)` : ''}` : capitalize(healthDescriptor(hp)));
  if (conditions.length) lines.push(conditions.join(', '));
  if (!isHero && token.distanceFromHeroFt !== null) {
    const parts = [`${token.distanceFromHeroFt} ft from you`, token.heroCanSee ? 'you can see it' : "you can't see it"];
    if (token.coverFromHero && token.coverFromHero.degree !== 'none') parts.push(`it has ${coverLine(token.coverFromHero.degree, token.coverFromHero.byTerrain)} from you`);
    if (token.heroCoverFromIt && token.heroCoverFromIt.degree !== 'none') parts.push(`you have ${coverLine(token.heroCoverFromIt.degree, token.heroCoverFromIt.byTerrain)} from it`);
    lines.push(parts.join(' · '));
  }
  const extra = [`Reach ${token.reachFt} ft`, token.size !== 'Medium' ? token.size : null, token.elevationFt ? `${token.elevationFt} ft up` : null, token.reactionUsed ? 'Reaction used' : null].filter(
    (x): x is string => x !== null,
  );
  lines.push(extra.join(' · '));
  const canClose = !isHero && token.side === 'enemy' && !token.defeated && model.canMove;
  const cantEnd = !isHero && token.side !== 'enemy' && !token.defeated && model.canMove;
  return (
    <CardFrame
      onClose={onClose}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className={`size-2.5 shrink-0 ${SHAPE_DOT[token.side]}`} aria-hidden />
          <span className="truncate">{name}</span>
          {!isHero && <span className="shrink-0 text-xs font-normal text-faint">({SIDE_WORD[token.side]})</span>}
          <span className="ml-auto shrink-0 text-xs font-normal text-muted tabular-nums">
            {where}
            {places}
          </span>
        </span>
      }
      actions={
        <>
          {canClose && (
            <Button size={touch ? 'lg' : 'sm'} variant="primary" onClick={onMoveNextTo}>
              Move next to {token.name}
            </Button>
          )}
          <Button size={touch ? 'lg' : 'sm'} variant="secondary" icon={<Ruler className="size-4" aria-hidden />} onClick={onMeasure}>
            Measure from {isHero ? 'you' : 'here'}
          </Button>
        </>
      }
    >
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
      {cantEnd && <p>{`Can't end in ${possessive(token.name)} space.`}</p>}
    </CardFrame>
  );
}

export function SquareCard({
  square,
  model,
  onClose,
  onMoveHere,
}: {
  square: GridPoint;
  model: BattleMapModel;
  onClose(): void;
  onMoveHere?(): void;
}) {
  const touch = useIsTouch();
  const places = placesAt(model, square);
  const heroSpace = model.heroToken?.space ?? null;
  const rect: GridRect = { x0: square.x, y0: square.y, x1: square.x, y1: square.y };
  const reach = model.reachable.find((r) => r.at.x === square.x && r.at.y === square.y && r.canEnd);
  const feet = heroSpace ? 5 * Math.max(0, rect.x0 - heroSpace.x1, heroSpace.x0 - rect.x1, rect.y0 - heroSpace.y1, heroSpace.y0 - rect.y1) : null;
  return (
    <CardFrame
      onClose={onClose}
      title={
        <span>
          {squareLabel(square)}
          {places.length > 0 && <span className="font-normal text-muted"> · {places.join(', ')}</span>}
        </span>
      }
      actions={
        reach && onMoveHere ? (
          <Button size={touch ? 'lg' : 'sm'} variant="primary" onClick={onMoveHere}>
            Plan a move here
          </Button>
        ) : undefined
      }
    >
      <p>{capitalize(terrainWords(model, square))}</p>
      {heroSpace && feet !== null && <p>{capitalize(directionWords(heroSpace, rect, feet))}</p>}
      {reach && <p>{reach.band === 'dash' ? `Move with Dash: ${reach.costFt} ft` : `Move: ${reach.costFt} ft`}</p>}
    </CardFrame>
  );
}
