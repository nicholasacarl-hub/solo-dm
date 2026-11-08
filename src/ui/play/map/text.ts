/**
 * Every player-facing word of the battle map (spec §7.8, D46): gate messages, move refusals, warning chips,
 * readouts, the waiting banner, the first-fight tip and the [Area: …] line. Pure; every name comes from the
 * player view (hidden creatures never reach these functions). Player text says "you" — never a pronoun for the
 * hero (amendment 1).
 */
import { squareLabel, type MoveRefusal, type TurnBudget } from '@/engine';
// By path: the real condition names (the Play tests' '@/engine' stand-in carries only Prone).
import { CONDITIONS } from '@/engine/conditions';
import type { HeroMoveBlock } from '@/state/gameStore';
import type { AreaShape, BattleMap, Combatant, ConditionId, GridPoint, TerrainFeature } from '@/types';

/**
 * What the map shows when the hero can't move. 'waiting' stands in for 'not-your-turn' whenever the player's view
 * still shows the hero acting (a hidden creature's turn, D42): "It isn't your turn" would give the hidden turn away.
 */
export type MapBlock = HeroMoveBlock | 'waiting';

/** Names as the player knows them, by combatant id (player view only). */
export type NameOf = (id: string) => string;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function possessive(name: string): string {
  return `${name}'s`;
}

/**
 * How a creature is named in a sentence: "Bandit 1", "Old Tam", but "the Dock Ogre" — a name that describes its
 * stat block ("Dock Ogre" for an Ogre) reads with "the", unless it is numbered like a group member.
 */
export function referName(c: Pick<Combatant, 'name' | 'statBlockName' | 'isPlayer'>): string {
  const name = c.name.trim();
  const block = c.statBlockName?.trim().toLowerCase();
  if (!c.isPlayer && block && name.toLowerCase().includes(block) && !/\d$/.test(name)) return `the ${name}`;
  return name;
}

/** A NameOf for a combatant list (the player view's). */
export function namesFor(combatants: readonly Combatant[]): NameOf {
  const byId = new Map(combatants.map((c) => [c.id, c]));
  return (id) => {
    const c = byId.get(id);
    return c ? referName(c) : 'someone';
  };
}

export function feet(n: number): string {
  return `${n} ft`;
}

/** "Prone", "Exhaustion 2", or a homebrew condition's own name. */
export function conditionLabel(id: string, level?: number): string {
  const info = (CONDITIONS as Partial<Record<string, { name: string }>>)[id as ConditionId];
  const name = info?.name ?? capitalize(id);
  return level ? `${name} ${level}` : name;
}

// ---------------------------------------------------------------------------
// Gates and refusals
// ---------------------------------------------------------------------------

export interface BlockContext {
  /** The visible creatures that get an Opportunity Attack at the player's pending stop. */
  stopReactors: readonly string[];
}

/** Why the hero can't move right now (spec §7.8). */
export function blockText(block: MapBlock, ctx: BlockContext): string {
  switch (block) {
    case 'no-map':
      return 'There is no battle map right now.';
    case 'not-your-turn':
      return "It isn't your turn.";
    case 'waiting':
      return 'Waiting for the DM.';
    case 'dm-busy':
      return 'The DM is still working.';
    case 'interaction':
      return 'Answer the DM first.';
    case 'no-session':
      return 'Start the session first.';
    case 'unplaced':
      return "You're not on the map yet.";
    case 'stop-pending':
      return ctx.stopReactors.length
        ? `Tell the DM what you do first — ${joinNames(ctx.stopReactors)} ${ctx.stopReactors.length === 1 ? 'gets an Opportunity Attack' : 'get Opportunity Attacks'}.`
        : 'Tell the DM what you do first.';
    case 'refused':
      return "You can't move there.";
  }
}

export interface RefusalContext {
  name: NameOf;
  budget: TurnBudget | null;
  map: BattleMap;
}

function featuresAt(map: BattleMap, p: GridPoint): TerrainFeature[] {
  return map.terrain.filter((f) => f.rects.some((r) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1));
}

/** "The pillar is in the way.", "The office door is closed: ask the DM." (moves never open doors, C28). */
export function obstacleText(map: BattleMap, at: GridPoint): string {
  const here = featuresAt(map, at);
  const door = [...here].reverse().find((f) => f.kind === 'door');
  if (door && door.door !== 'open') {
    const what = door.label ? `The ${door.label}` : 'The door';
    return `${what} is ${door.door === 'locked' ? 'locked' : 'closed'}: ask the DM.`;
  }
  const solid = here.find((f) => f.kind === 'three-quarters-cover' || (f.kind === 'wall' && !door));
  if (solid?.label) return `The ${solid.label} is in the way.`;
  if (solid?.kind === 'three-quarters-cover') return 'Three-quarters cover is in the way.';
  if (solid) return 'A wall is in the way.';
  const pit = here.find((f) => f.kind === 'pit');
  if (pit) return pit.label ? `The ${pit.label} is in the way.` : 'A pit is in the way.';
  return 'Something is in the way.';
}

/** A refused plan or commit, in the player's words (spec §7.8). */
export function refusalText(refusal: MoveRefusal, ctx: RefusalContext): string {
  switch (refusal.code) {
    case 'too-far': {
      const b = ctx.budget;
      const dash = b && b.dashes === 0 && b.dashAddsFt > 0 ? `, or ${refusal.leftFt + b.dashAddsFt} with Dash` : '';
      return `Too far: ${refusal.needFt} ft (you have ${refusal.leftFt}${dash}).`;
    }
    case 'occupied':
      return `${capitalize(ctx.name(refusal.byId))} is in that square.`;
    case 'blocked':
      return obstacleText(ctx.map, refusal.at);
    case 'speed-zero':
      return `${refusal.because}: Speed 0.`;
    case 'cant-stand':
      return `Not enough movement left to stand up (${refusal.costFt} ft).`;
    case 'frightened':
      return `You're Frightened of ${ctx.name(refusal.sourceId)}: you can't move closer.`;
    case 'no-route':
      return "There's no way through from here.";
    case 'off-map':
      return "That's off the map.";
    case 'unplaced':
      return "You're not on the map yet.";
    case 'not-their-turn':
      return "It isn't your turn.";
    case 'stop-pending': {
      const names = refusal.reactorIds.map(ctx.name);
      return blockText('stop-pending', { stopReactors: names });
    }
    case 'out-of-range':
      return `Too far: ${refusal.distanceFt} ft (the most is ${refusal.maxFt}).`;
    case 'bad-request':
      return refusal.problem;
  }
}

// ---------------------------------------------------------------------------
// Planning readouts and chips
// ---------------------------------------------------------------------------

/** "To D8 · 10 ft · 20 ft left". */
export function moveReadout(to: GridPoint, costFt: number, leftFt: number): string {
  return `To ${squareLabel(to)} · ${feet(costFt)} · ${feet(leftFt)} left`;
}

/** "⚠ Leaves Bandit 1's reach: Opportunity Attack". */
export function opportunityChip(reactors: readonly string[]): string {
  if (reactors.length === 1) return `⚠ Leaves ${possessive(reactors[0])} reach: Opportunity Attack`;
  return `⚠ Leaves the reach of ${joinNames(reactors)}: Opportunity Attacks`;
}

export function difficultChip(squares: number): string {
  return `Difficult +${squares * 5} ft`;
}

/** "Enters the brazier (hazard)", "Enters the Web". */
export function enteredChip(label: string, hazard: boolean): string {
  return hazard ? `Enters the ${label} (hazard)` : `Enters the ${label}`;
}

export const CRAWLING_CHIP = 'Crawling (Prone)';
export const NEEDS_DASH_CHIP = 'Needs Dash — uses your action';

export function standsUpChip(costFt: number): string {
  return `Stands up first (${costFt} ft)`;
}

export function frightenedChip(source: string): string {
  return `Frightened: can't move closer to ${source}`;
}

/** The Safe / Short route chip, shown only when the shortest route differs. */
export function shortRouteChip(provokes: number): string {
  return provokes > 0 ? `Short route: provokes ${provokes}` : 'Short route';
}

// ---------------------------------------------------------------------------
// After a move
// ---------------------------------------------------------------------------

/** "Moved to D8 · 20 ft left". */
export function movedText(to: GridPoint, leftFt: number | null): string {
  return leftFt === null ? `Moved to ${squareLabel(to)}` : `Moved to ${squareLabel(to)} · ${feet(leftFt)} left`;
}

/** "Stood up · 15 ft left". */
export function stoodText(leftFt: number | null): string {
  return leftFt === null ? 'Stood up' : `Stood up · ${feet(leftFt)} left`;
}

/** "You stop at B6: leaving the Dock Ogre's reach gives it an Opportunity Attack." */
export function stopText(at: GridPoint, reactors: readonly string[]): string {
  if (reactors.length === 0) return `You stop at ${squareLabel(at)}: leaving here provokes an Opportunity Attack.`;
  if (reactors.length === 1) return `You stop at ${squareLabel(at)}: leaving ${possessive(reactors[0])} reach gives it an Opportunity Attack.`;
  return `You stop at ${squareLabel(at)}: leaving the reach of ${joinNames(reactors)} gives them Opportunity Attacks.`;
}

/** A move cut short by something the hero couldn't see (C24): nothing more than that. */
export function unseenStopText(at: GridPoint): string {
  return `You stop at ${squareLabel(at)}: something blocks the way.`;
}

/** What Tell the DM appends after a stop (D34). */
export function keepMovingWords(destination: GridPoint): string {
  return `I keep moving to ${squareLabel(destination)}.`;
}

export const MOVE_FAILED_TOAST = "Couldn't save your move. Try again.";
export const UNDO_FAILED_TOAST = "Couldn't undo that move. Try again.";

// ---------------------------------------------------------------------------
// Turn pill, waiting banner, battle chip, tip
// ---------------------------------------------------------------------------

/**
 * "Your turn · 30 ft", "Your turn · Grappled: Speed 0", "Bandit 2's turn" — whose turn the player's view shows
 * (D42: during a hidden creature's turn, the last visible creature before it).
 */
export function turnPillText(opts: { yourTurn: boolean; currentName: string | null; budget: TurnBudget | null }): string {
  if (!opts.yourTurn) return opts.currentName ? `${capitalize(possessive(opts.currentName))} turn` : 'Battle map';
  const b = opts.budget;
  if (!b) return 'Your turn';
  if (b.speedZero) return `Your turn · ${b.speedZero}: Speed 0`;
  return `Your turn · ${feet(b.leftFt)}`;
}

/** "Waiting for the DM to finish Bandit 2's turn" (D54). */
export function waitingText(name: string): string {
  return `Waiting for the DM to finish ${possessive(name)} turn`;
}

/** What Remind the DM adds to the draft (out of character). */
export function remindWords(name: string): string {
  return `It's still ${possessive(name)} turn on the tracker — please finish it.`;
}

/** The phone Story tab's chip: "Battle map · your turn · 25 ft". */
export function battleChipText(opts: { yourTurn: boolean; currentName: string | null; leftFt: number | null }): string {
  if (opts.yourTurn) return opts.leftFt === null ? 'Battle map · your turn' : `Battle map · your turn · ${feet(opts.leftFt)}`;
  return opts.currentName ? `Battle map · ${possessive(opts.currentName)} turn` : 'Battle map';
}

/** D65, worded for the input in use (a mouse click moves at once; a touch plans first). */
export function firstFightTip(touch: boolean): string {
  return touch
    ? 'Tap a square to plan · tap again to move · your moves reach the DM with your next message · Undo until you send'
    : 'Hover to preview · click a square to move · your moves reach the DM with your next message · Undo until you send';
}

/** The application's accessible name: "Battle map: Dockside warehouse, 16 by 12 squares". */
export function mapAccessibleName(map: Pick<BattleMap, 'name' | 'width' | 'height'>): string {
  return `Battle map: ${map.name ? `${map.name}, ` : ''}${map.width} by ${map.height} squares`;
}

// ---------------------------------------------------------------------------
// Measuring and cover
// ---------------------------------------------------------------------------

export type CoverWord = 'none' | 'half' | 'three-quarters' | 'total';

export function coverName(degree: CoverWord): string {
  switch (degree) {
    case 'half':
      return 'Half Cover';
    case 'three-quarters':
      return 'Three-Quarters Cover';
    case 'total':
      return 'Total Cover';
    case 'none':
      return 'no cover';
  }
}

/** "Mira Voss → Bandit 1: 20 ft (4 squares) · clear line of sight · Bandit 1 has Half Cover (crates)". */
export function measureText(opts: {
  from: string;
  to: string;
  feet: number;
  lineOfSight: boolean;
  cover?: { degree: CoverWord; by: readonly string[] } | null;
}): string {
  const squares = opts.feet / 5;
  const parts = [
    `${opts.from} → ${opts.to}: ${feet(opts.feet)} (${squares} ${squares === 1 ? 'square' : 'squares'})`,
    opts.lineOfSight ? 'clear line of sight' : 'no line of sight',
  ];
  if (opts.cover && opts.cover.degree !== 'none') {
    const by = opts.cover.by.length ? ` (${opts.cover.by.join(', ')})` : '';
    parts.push(`${opts.to} has ${coverName(opts.cover.degree)}${by}`);
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Area templates (D50)
// ---------------------------------------------------------------------------

export interface AreaLineInput {
  label: string;
  shape: Exclude<AreaShape, 'squares'>;
  sizeFt: number;
  widthFt?: number;
  /** The hero's name when the area comes from the hero (cones, lines, cubes from the hero, emanations). */
  fromName?: string;
  /** Exactly what resolve_area takes: "C5", "G4/H5", "north-east". */
  toward?: string;
  at?: string;
  /** Who it catches on the player's map (player view), in initiative order. */
  catches: readonly string[];
}

/** "15-ft cone toward C5", "20-ft sphere centred on G4", "15-ft emanation around Mira Voss". */
export function areaPlacement(a: AreaLineInput, opts: { withFrom: boolean }): string {
  const size = `${a.sizeFt}-ft ${a.shape}${a.shape === 'line' ? `, ${a.widthFt ?? 5} ft wide` : ''}`;
  if (a.shape === 'emanation') return `${size} around ${a.fromName ?? 'you'}`;
  if (a.toward && a.fromName) return opts.withFrom ? `${size} from ${a.fromName} toward ${a.toward}` : `${size} toward ${a.toward}`;
  if (a.at) return `${size} centred on ${a.at}`;
  return size;
}

/**
 * The one line Add to message appends (D50, §7.4):
 * "[Area: Burning Hands — 15-ft cone from Mira Voss toward C5; on my map it catches Bandit 1]".
 */
export function areaMessageLine(a: AreaLineInput): string {
  const catches = a.catches.length ? a.catches.join(', ') : 'nobody';
  return `[Area: ${a.label} — ${areaPlacement(a, { withFrom: true })}; on my map it catches ${catches}]`;
}

/** The template bar's readout: "Burning Hands · 15-ft cone toward C5 · catches Bandit 1". */
export function areaReadout(a: AreaLineInput): string {
  const catches = a.catches.length ? `catches ${joinNames(a.catches)}` : 'catches nobody you can see';
  return `${a.label} · ${areaPlacement(a, { withFrom: false })} · ${catches}`;
}

export function insideWarning(name: string): string {
  return `⚠ ${name} is inside`;
}

export const YOU_INSIDE_WARNING = '⚠ You are inside';

export function rangeWarning(label: string, rangeFt: number): string {
  return `⚠ Beyond ${possessive(label)} range (${rangeFt} ft)`;
}
