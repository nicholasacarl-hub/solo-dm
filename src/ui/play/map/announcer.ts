/**
 * What the battle map's live region says (spec §7.9): one polite, debounced line per change — the square under the
 * keyboard cursor, the plan, the result of a move, and a summary when the hero's turn starts. Pure templates over
 * the player view; the narration has its own region, so the map never repeats it.
 */
import { healthDescriptor, snapDirection, spaceLabel, squareLabel } from '@/engine';
import type { CombatState, GridPoint, GridRect, TerrainFeature } from '@/types';
import type { BattleMapModel } from './model';
import type { PlanPreview } from './preview';
import { capitalize, conditionLabel, joinNames, type NameOf } from './text';
import { SIDE_WORD } from './tokenStyle';

const inRect = (r: GridRect, p: GridPoint) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;

function featureWords(f: TerrainFeature, doorHere: boolean): string | null {
  const named = (kind: string) => (f.label ? `${f.label}, ${kind}` : kind);
  switch (f.kind) {
    case 'wall':
      return doorHere ? null : named('wall');
    case 'door':
      return named(`${f.door ?? 'closed'} door`);
    case 'difficult':
      return named('difficult terrain');
    case 'shallow-water':
      return named('shallow water');
    case 'deep-water':
      return named('deep water');
    case 'pit':
      return named('pit');
    case 'hazard':
      return named('hazard');
    case 'half-cover':
      return named('half cover');
    case 'three-quarters-cover':
      return named('three-quarters cover');
    case 'obscured':
      return named('heavily obscured');
  }
}

/** "crates, half cover" · "the office door, closed door" · "open ground". */
export function terrainWords(model: Pick<BattleMapModel, 'map' | 'snapshot'>, at: GridPoint): string {
  const here = model.map.terrain.filter((f) => f.rects.some((r) => inRect(r, at)));
  const doorHere = here.some((f) => f.kind === 'door');
  const words = here.map((f) => featureWords(f, doorHere)).filter((w): w is string => w !== null);
  for (const e of model.snapshot.effects) if (e.rects.some((r) => inRect(r, at))) words.push(`inside ${e.label}`);
  return words.length ? words.join('; ') : 'open ground';
}

/** The names of the places a square is in. */
export function placesAt(model: Pick<BattleMapModel, 'map'>, at: GridPoint): string[] {
  return model.map.places.filter((p) => p.rects.some((r) => inRect(r, at))).map((p) => p.name);
}

/** "10 feet north-east of you". */
export function directionWords(from: GridRect, to: GridRect, feet: number): string {
  const dx = (to.x0 + to.x1) / 2 - (from.x0 + from.x1) / 2;
  const dy = (to.y0 + to.y1) / 2 - (from.y0 + from.y1) / 2;
  if (dx === 0 && dy === 0) return 'here';
  return `${feet} feet ${snapDirection(dx, dy)} of you`;
}

/** The visible living creature whose space covers a square (or a fallen one when nobody stands there). */
export function tokenAt(model: Pick<BattleMapModel, 'snapshot'>, at: GridPoint, opts: { includeDefeated?: boolean } = {}) {
  const tokens = model.snapshot.tokens.filter((t) => t.space && inRect(t.space, at));
  return tokens.find((t) => !t.defeated) ?? (opts.includeDefeated ? (tokens[0] ?? null) : null);
}

function gridFeet(a: GridRect, b: GridRect): number {
  const gx = Math.max(0, b.x0 - a.x1, a.x0 - b.x1);
  const gy = Math.max(0, b.y0 - a.y1, a.y0 - b.y1);
  return 5 * Math.max(gx, gy);
}

/** A creature in a few words: "Bandit 1, enemy, bloodied, Prone". */
export function creatureWords(model: BattleMapModel, id: string): string {
  const c = model.combatants.get(id);
  const t = model.tokens.get(id);
  if (!c || !t) return 'someone';
  if (t.isHero) return 'you';
  const parts = [c.name, SIDE_WORD[c.side]];
  if (c.defeated) parts.push('down');
  else if (c.hp) parts.push(healthDescriptor(c.hp));
  for (const k of c.conditions) parts.push(conditionLabel(k.id, k.level));
  return parts.join(', ');
}

/**
 * The keyboard cursor's square: "E6: open ground. 10 feet north-east of you. Move: 10 feet." or
 * "F4: Bandit 1, enemy, bloodied. 20 feet from you."
 */
export function squareAnnouncement(model: BattleMapModel, at: GridPoint): string {
  const label = squareLabel(at);
  const places = placesAt(model, at);
  const where = places.length ? ` (${places.join(', ')})` : '';
  const heroSpace = model.heroToken?.space ?? null;
  const token = tokenAt(model, at, { includeDefeated: true });
  if (token?.isHero) return `${label}${where}: you.`;
  const square: GridRect = { x0: at.x, y0: at.y, x1: at.x, y1: at.y };
  if (token) {
    const distance = token.distanceFromHeroFt;
    return `${label}${where}: ${creatureWords(model, token.id)}.${distance !== null ? ` ${distance} feet from you.` : ''}`;
  }
  const parts = [`${label}${where}: ${terrainWords(model, at)}.`];
  if (heroSpace) parts.push(`${capitalize(directionWords(heroSpace, square, gridFeet(heroSpace, square)))}.`);
  const reach = model.reachable.find((r) => r.at.x === at.x && r.at.y === at.y && r.canEnd);
  if (reach) parts.push(reach.band === 'dash' ? `Move with Dash: ${reach.costFt} feet.` : `Move: ${reach.costFt} feet.`);
  return parts.join(' ');
}

/** "Plan: D8, 10 feet, 20 left. Leaves the reach of the Dock Ogre: Opportunity Attack. Press Enter to move." */
export function planAnnouncement(preview: PlanPreview, nameOf: NameOf, refusal: string | null): string {
  const label = squareLabel(preview.to);
  if (preview.status === 'refused') return `${label}: ${refusal ?? "you can't move there."}`;
  const parts = [`Plan: ${label}, ${preview.costFt} feet, ${preview.leftFt} left.`];
  if (preview.stopReactors.length) {
    const names = joinNames(preview.stopReactors.map(nameOf));
    parts.push(`Leaves the reach of ${names}: ${preview.stopReactors.length === 1 ? 'Opportunity Attack' : 'Opportunity Attacks'}.`);
  }
  if (preview.needsDash) parts.push('Needs Dash, which uses your action.');
  parts.push(preview.dash ? 'Press Enter to Dash and move.' : 'Press Enter to move.');
  return parts.join(' ');
}

/** After a commit. */
export function movedAnnouncement(to: GridPoint): string {
  return `Moved to ${squareLabel(to)}.`;
}

/** What visibly changed on the map since the hero's last turn (positions, newcomers, the fallen). */
export function changesSince(before: CombatState, after: CombatState, nameOf: NameOf): string[] {
  const out: string[] = [];
  const old = new Map(before.combatants.map((c) => [c.id, c]));
  for (const c of after.combatants) {
    if (c.isPlayer) continue;
    const prev = old.get(c.id);
    if (!prev) {
      if (c.position) out.push(`${capitalize(nameOf(c.id))} appeared at ${spaceLabel(c.position, c.size ?? 'Medium')}`);
      continue;
    }
    if (c.defeated && !prev.defeated) out.push(`${capitalize(nameOf(c.id))} is down`);
    else if (c.position && (!prev.position || prev.position.x !== c.position.x || prev.position.y !== c.position.y)) {
      out.push(`${capitalize(nameOf(c.id))} moved to ${squareLabel(c.position)}`);
    }
  }
  return out;
}

/** "Your turn. 30 feet of movement. Since your last turn: Bandit 1 moved to C5." */
export function turnStartAnnouncement(leftFt: number | null, changes: readonly string[]): string {
  const parts = ['Your turn.'];
  if (leftFt !== null) parts.push(`${leftFt} feet of movement.`);
  if (changes.length) parts.push(`Since your last turn: ${changes.join('; ')}.`);
  return parts.join(' ');
}
