/**
 * Battle-map text for the DM and for the player's log. The engine returns structured data only (spec D46); this
 * module renders it: the setup drawing, the frozen prompt's layout, the per-turn <game_state> map block, move,
 * area and edit results, the turn-start line, the roll_dice reach check and the player-safe log lines.
 *
 * Two audiences, two rules:
 * - DM text names hidden creatures, tagged "[hidden]", and names the hero.
 * - Player-facing text (log lines, the player bubble's mapNote, final positions, the layout in a log detail) is
 *   built from playerView(): hidden creatures never appear in it, and the hero is "you" in sentences.
 * No text uses ids, and none refers to the hero (or anyone) with a gendered pronoun (amendment 1).
 * Everything is deterministic: identical state gives identical text.
 */
import {
  combatantSize,
  coverAgainst,
  cornerLabel,
  currentCombatant,
  currentTurn,
  footprint,
  inReach,
  isToldAndAnswered,
  lineOfSight,
  mapCells,
  mapGlyphGrid,
  mapSnapshot,
  moverStats,
  planMove,
  playerView,
  rectLabel,
  rectsLabel,
  spaceDistanceFt,
  spaceLabel,
  squareLabel,
  turnBudget,
  turnStartReport,
  type AreaResult,
  type CoverResult,
  type MapChange,
  type MapSnapshot,
  type MapWarning,
  type MoveNote,
  type MoveOutcome,
  type MoverStats,
  type MoveRefusal,
  type PlacementResult,
  type ProvokedAttack,
  type ReachPair,
  type SnapshotToken,
  type Space,
  type TurnBudget,
} from '@/engine';
import type {
  AreaSpec,
  AreaTerrain,
  BattleMap,
  Character,
  Combatant,
  CombatState,
  CompassDirection,
  CreatureSize,
  CreatureSpeeds,
  GridPoint,
  GridRect,
  MapRef,
  MapStop,
  TerrainFeature,
  TerrainKind,
  TurnMove,
} from '@/types';

// ---------------------------------------------------------------------------
// Names, lists and labels
// ---------------------------------------------------------------------------

const HIDDEN_TAG = '[hidden] ';

/** The DM's name for a combatant: "[hidden] Cutthroat" for one the hero hasn't noticed. */
export function dmName(state: CombatState, id: string): string {
  const c = state.combatants.find((x) => x.id === id);
  if (!c) return 'someone';
  return c.hidden ? `${HIDDEN_TAG}${c.name}` : c.name;
}

/** "A", "A and B", "A, B and C". */
export function listAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function heroOf(state: CombatState): Combatant | undefined {
  return state.combatants.find((c) => c.isPlayer);
}

function combatant(state: CombatState, id: string): Combatant | undefined {
  return state.combatants.find((c) => c.id === id);
}

/** A placed combatant's space in 3D (null when it isn't on the map). */
export function spaceOf(c: Combatant, hero: Character | null, at?: GridPoint): Space | null {
  const anchor = at ?? c.position;
  if (!anchor) return null;
  const size = combatantSize(c, hero);
  return { rect: footprint(anchor, size), elevationFt: c.elevationFt ?? 0, size };
}

/** "B6" or "H10:I11" (its whole space), or null when not placed. */
export function spaceText(c: Combatant, hero: Character | null): string | null {
  return c.position ? spaceLabel(c.position, combatantSize(c, hero)) : null;
}

/** Grid distance between two placed combatants (null when either isn't on the map). */
export function distanceFt(a: Combatant, b: Combatant, hero: Character | null): number | null {
  const sa = spaceOf(a, hero);
  const sb = spaceOf(b, hero);
  return sa && sb ? spaceDistanceFt(sa, sb) : null;
}

/** Place names a space overlaps, in map order. */
function placesAt(state: CombatState, hero: Character | null, rect: GridRect): string[] {
  const cells = mapCells(state, hero);
  if (!cells) return [];
  const out: string[] = [];
  for (let y = rect.y0; y <= rect.y1; y++) {
    for (let x = rect.x0; x <= rect.x1; x++) {
      if (x < 0 || y < 0 || x >= cells.width || y >= cells.height) continue;
      for (const name of cells.placesAt.get(y * cells.width + x) ?? []) if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

function placeSuffix(places: readonly string[]): string {
  return places.length ? ` (${places.join(', ')})` : '';
}

const KIND_WORDS: Readonly<Record<TerrainKind, string>> = {
  wall: 'wall',
  door: 'door',
  difficult: 'difficult',
  'shallow-water': 'shallow water',
  'deep-water': 'deep water',
  pit: 'pit',
  hazard: 'hazard',
  'half-cover': 'half cover',
  'three-quarters-cover': 'three-quarters cover',
  obscured: 'obscured',
};

export function terrainWords(kind: TerrainKind): string {
  return KIND_WORDS[kind] ?? kind;
}

/** "the brazier (hazard)" for a hazard square's label, a lasting effect's name ("Web") as it is. */
export function insideLabel(map: BattleMap, label: string): string {
  if (map.effects.some((e) => e.label === label)) return label;
  const hazard = map.terrain.find((f) => f.kind === 'hazard' && (f.label ?? 'hazard') === label);
  if (!hazard) return label;
  return hazard.label ? `the ${hazard.label} (hazard)` : 'a hazard';
}

const COVER_TITLE: Readonly<Record<CoverResult['degree'], string>> = {
  none: 'no cover',
  half: 'Half Cover',
  'three-quarters': 'Three-Quarters Cover',
  total: 'Total Cover',
};
const COVER_SHORT: Readonly<Record<CoverResult['degree'], string>> = {
  none: 'No',
  half: 'Half',
  'three-quarters': 'Three-Quarters',
  total: 'Total',
};
const COVER_BONUS: Readonly<Record<CoverResult['degree'], number>> = { none: 0, half: 2, 'three-quarters': 5, total: 0 };

/** What gives the cover: terrain names, then creatures (DM names). */
export function coverBy(state: CombatState, cover: CoverResult): string {
  return [...cover.byTerrain, ...cover.byCreatureIds.map((id) => dmName(state, id))].join(', ');
}

/** "Half Cover (crates)" / "no cover". */
function coverTitle(state: CombatState, cover: CoverResult): string {
  if (cover.degree === 'none') return COVER_TITLE.none;
  const by = coverBy(state, cover);
  return `${COVER_TITLE[cover.degree]}${by ? ` (${by})` : ''}`;
}

/** "walk 30, fly 60 (hover), swim 30". */
export function speedsText(s: CreatureSpeeds): string {
  const parts = [`walk ${s.walk ?? 0}`];
  if (s.fly) parts.push(`fly ${s.fly}${s.hover ? ' (hover)' : ''}`);
  if (s.swim) parts.push(`swim ${s.swim}`);
  if (s.climb) parts.push(`climb ${s.climb}`);
  if (s.burrow) parts.push(`burrow ${s.burrow}`);
  return parts.join(', ');
}

function statsSpeeds(stats: MoverStats): string {
  return speedsText({ walk: stats.walk, fly: stats.fly, swim: stats.swim, climb: stats.climb, burrow: stats.burrow, hover: stats.hover });
}

/** A map reference as the DM wrote it: "G4", "G4/H5", a creature's name, "north-east". */
export function refText(state: CombatState, ref: MapRef | undefined): string {
  if (!ref) return 'its centre';
  switch (ref.kind) {
    case 'square':
      return squareLabel(ref.at);
    case 'corner':
      return cornerLabel(ref.x, ref.y);
    case 'creature':
      return dmName(state, ref.id);
    case 'direction':
      return ref.dir;
  }
}

// ---------------------------------------------------------------------------
// Relations between creatures: distance and reach (D7)
// ---------------------------------------------------------------------------

function isHostile(a: Combatant, b: Combatant): boolean {
  const team = (c: Combatant) => (c.side === 'player' || c.side === 'ally' ? 'party' : c.side === 'enemy' ? 'foes' : 'neutral');
  return (team(a) === 'party' && team(b) === 'foes') || (team(a) === 'foes' && team(b) === 'party');
}

/** "{d} ft from X" plus who reaches whom, for one hostile pair. */
function reachFragment(state: CombatState, hero: Character | null, mover: Combatant, other: Combatant, mutualAll: boolean): string {
  const d = distanceFt(mover, other, hero) ?? 0;
  const mine = inReach(state, hero, mover.id, other.id);
  const theirs = inReach(state, hero, other.id, mover.id);
  const name = dmName(state, other.id);
  const base = `${d} ft from ${name}`;
  if (mine && theirs) return mutualAll ? base : `${base} (each within the other's reach)`;
  const self = itOf(mover);
  if (mine) return `${base} (${self} reaches ${name}; ${name} doesn't reach ${self})`;
  return `${base} (${name} reaches ${self}; ${self} doesn't reach ${name})`;
}

/**
 * Where a creature stands relative to the hero and to every hostile creature it reaches or is reached by:
 * "20 ft from Mira Voss, out of reach" · "5 ft from Mira Voss and 5 ft from Old Tam — each is within the other's
 * reach". Null when there is nothing to say (no hero on the map and nobody in reach).
 */
export function relationClause(state: CombatState, hero: Character | null, moverId: string): string | null {
  const mover = combatant(state, moverId);
  if (!mover?.position) return null;
  const heroC = heroOf(state);
  const hostiles = state.combatants.filter(
    (o) => o.id !== mover.id && !o.defeated && o.position && isHostile(mover, o) && (inReach(state, hero, mover.id, o.id) || inReach(state, hero, o.id, mover.id)),
  );
  const mutualAll = hostiles.every((o) => inReach(state, hero, mover.id, o.id) && inReach(state, hero, o.id, mover.id));
  const fragments = hostiles.map((o) => reachFragment(state, hero, mover, o, mutualAll));
  const reachText = fragments.length ? `${fragments.join(' and ')}${mutualAll ? " — each is within the other's reach" : ''}` : '';
  let heroText = '';
  if (heroC && heroC.id !== mover.id && heroC.position && !hostiles.some((o) => o.id === heroC.id)) {
    const d = distanceFt(mover, heroC, hero) ?? 0;
    heroText = isHostile(mover, heroC) ? `${d} ft from ${heroC.name}, out of reach` : `${d} ft from ${heroC.name}`;
  }
  if (mover.isPlayer && !reachText) return "out of every enemy's reach";
  const text = [heroText, reachText].filter(Boolean).join('; ');
  return text || null;
}

// ---------------------------------------------------------------------------
// The drawing (setup results and check_map show)
// ---------------------------------------------------------------------------

export const MAP_KEY =
  'Key: # wall · + closed door · / open door · ) half cover · ] three-quarters cover · : difficult · , shallow water · ~ deep water · _ pit · ! hazard · % obscured';

/** The glyph grid with column letters and row numbers. */
function gridLines(state: CombatState, hero: Character | null): string[] {
  const map = state.map as BattleMap;
  const { rows } = mapGlyphGrid(state, hero);
  const width = map.width > 26 ? 2 : 1;
  const columns = Array.from({ length: map.width }, (_, x) => squareLabel({ x, y: 0 }).replace(/\d+$/, '').padEnd(width));
  const lines = [`    ${columns.join(' ').trimEnd()}`];
  rows.forEach((row, y) => {
    const cells = [...row].map((glyph) => glyph.padEnd(width));
    lines.push(`${String(y + 1).padStart(3)} ${cells.join(' ').trimEnd()}`);
  });
  return lines;
}

function tokensLine(state: CombatState, hero: Character | null): string {
  const { legend } = mapGlyphGrid(state, hero);
  return `Tokens: ${legend.map((l) => `${l.glyph} ${dmName(state, l.id)}`).join(' · ') || 'none on the map'}`;
}

function featureText(f: TerrainFeature): string | null {
  if (!f.label) return null;
  const door = f.kind === 'door' ? ` (${f.door ?? 'closed'})` : '';
  return `${f.label} ${rectsLabel(f.rects)}${door}`;
}

function labelsLine(map: BattleMap): string | null {
  const parts = map.terrain.map(featureText).filter((t): t is string => t !== null);
  return parts.length ? `Labels: ${parts.join(' · ')}` : null;
}

function placesLine(map: BattleMap): string | null {
  return map.places.length ? `Places: ${map.places.map((p) => `${p.name} ${rectsLabel(p.rects)}`).join(' · ')}` : null;
}

/** "Web G7:J10 (difficult, obscured)" · "Spirit Guardians, 15-ft Emanation around Mira Voss". */
function effectText(state: CombatState, e: { label: string; rects: GridRect[]; terrain: AreaTerrain[]; emanationOfId?: string; sizeFt?: number }): string {
  if (e.emanationOfId) return `${e.label}, ${e.sizeFt ?? 0}-ft Emanation around ${dmName(state, e.emanationOfId)}`;
  const terrain = e.terrain.length ? ` (${e.terrain.join(', ')})` : '';
  return `${e.label} ${rectsLabel(e.rects) || '(no squares)'}${terrain}`;
}

function effectsLine(state: CombatState, hero: Character | null, opts: { lastingOnly: boolean }): string | null {
  const snap = mapSnapshot(state, hero, { perspective: 'dm' });
  const effects = (snap?.effects ?? []).filter((e) => !opts.lastingOnly || e.duration === 'lasting');
  if (!effects.length) return null;
  return `Effects: ${effects.map((e) => `${effectText(state, e)}${e.duration === 'turn' ? ' (this turn)' : ''}`).join(' · ')}`;
}

/** The text drawing of the whole map (check_map show, and the heart of the setup result). */
export function drawingLines(state: CombatState, hero: Character | null, opts: { effects?: boolean } = {}): string[] {
  const map = state.map;
  if (!map) return [];
  const lines = [...gridLines(state, hero), tokensLine(state, hero), MAP_KEY];
  const labels = labelsLine(map);
  if (labels) lines.push(labels);
  const places = placesLine(map);
  if (places) lines.push(places);
  if (opts.effects) {
    const effects = effectsLine(state, hero, { lastingOnly: false });
    if (effects) lines.push(effects);
  }
  return lines;
}

function mapTitle(map: BattleMap): string {
  return `Battle map: ${map.name ? `${map.name}, ` : ''}${map.width}×${map.height} squares of 5 ft (A1 is the top-left; letters run left to right, numbers top to bottom).`;
}

/** One group's map stats as the setup result lists them. */
export interface MapStatsLine {
  /** "Bandit 1–2", "Dock Ogre". */
  label: string;
  size: CreatureSize;
  speeds: CreatureSpeeds;
  reachFt: number;
  /** "(stat block)", "(defaults)", "(as given)" or a mix; omitted when empty. */
  source?: string;
}

function placementLines(state: CombatState, placed: readonly PlacementResult[]): string[] {
  const lines: string[] = [];
  const auto = placed.filter((p) => p.auto && p.at);
  if (auto.length) {
    const parts = auto.map((p) => `${dmName(state, p.id)} at ${squareLabel(p.at as GridPoint)}${p.why ? ` (${p.why})` : ''}`);
    lines.push(`Placed automatically: ${parts.join(' · ')}. Use move_tokens kind "place" to change that.`);
  }
  const moved = placed.filter((p) => !p.auto && p.at && p.why);
  if (moved.length) {
    lines.push(`Not where you asked: ${moved.map((p) => `${dmName(state, p.id)} at ${squareLabel(p.at as GridPoint)} (${p.why})`).join(' · ')}.`);
  }
  const missing = placed.filter((p) => !p.at);
  if (missing.length) {
    lines.push(`Not placed: ${missing.map((p) => `${dmName(state, p.id)}${p.why ? ` (${p.why})` : ''}`).join(' · ')}. Place them with move_tokens kind "place" once there is room.`);
  }
  return lines;
}

function statsLine(lines: readonly MapStatsLine[]): string | null {
  if (!lines.length) return null;
  const parts = lines.map((l) => `${l.label} ${l.size}, ${speedsText(l.speeds)}, reach ${l.reachFt}${l.source ? ` (${l.source})` : ''}`);
  return `On the map: ${parts.join(' · ')}`;
}

/** "From Mira Voss: Bandit 1 20 ft, Half Cover (crates) · [hidden] Cutthroat 55 ft · …". */
function fromHeroLine(state: CombatState, hero: Character | null): string | null {
  const heroC = heroOf(state);
  if (!heroC?.position) return null;
  const parts: string[] = [];
  for (const c of state.combatants) {
    if (c.id === heroC.id || c.defeated) continue;
    if (!c.position) {
      parts.push(`${dmName(state, c.id)} (not on the map)`);
      continue;
    }
    const cover = coverAgainst(state, hero, heroC.id, c.id);
    const d = distanceFt(heroC, c, hero) ?? 0;
    parts.push(`${dmName(state, c.id)} ${d} ft${cover.degree === 'none' ? '' : `, ${coverTitle(state, cover)}`}`);
  }
  return parts.length ? `From ${heroC.name}: ${parts.join(' · ')}` : null;
}

/** The map section of a setup result (start_combat with `map`, update_map create / replace). */
export function describeMapSetup(
  state: CombatState,
  hero: Character | null,
  opts: { placed?: readonly PlacementResult[]; stats?: readonly MapStatsLine[] } = {},
): string {
  const map = state.map;
  if (!map) return '';
  const lines = [mapTitle(map), ...drawingLines(state, hero)];
  lines.push(...placementLines(state, opts.placed ?? []));
  const stats = statsLine(opts.stats ?? []);
  if (stats) lines.push(stats);
  const from = fromHeroLine(state, hero);
  if (from) lines.push(from);
  return lines.join('\n');
}

/** check_map show: the drawing with effects and places, [hidden] markers included. */
export function describeShow(state: CombatState, hero: Character | null): string {
  const map = state.map;
  if (!map) return '';
  return [mapTitle(map), ...drawingLines(state, hero, { effects: true })].join('\n');
}

// ---------------------------------------------------------------------------
// The frozen prompt's "## Combat in progress" layout (spec §5.3)
// ---------------------------------------------------------------------------

function promptFeature(f: TerrainFeature): string {
  const details = [f.label, f.kind === 'door' ? (f.door ?? 'closed') : undefined].filter(Boolean).join(', ');
  return `${terrainWords(f.kind)}${details ? ` (${details})` : ''} ${rectsLabel(f.rects)}`;
}

/** The map as it stands when a session starts mid-fight: terrain, places and lasting effects in stored order. No ids. */
export function layoutForPrompt(state: CombatState, hero: Character | null): string | null {
  const map = state.map;
  if (!map) return null;
  const lines = [
    `Battle map at the start of this session (<game_state> has the current positions): ${map.name ? `${map.name}, ` : ''}${map.width}×${map.height} squares (A1 top-left)`,
  ];
  if (map.terrain.length) lines.push(`Terrain: ${map.terrain.map(promptFeature).join(' · ')}`);
  const places = placesLine(map);
  if (places) lines.push(places);
  const effects = effectsLine(state, hero, { lastingOnly: true });
  if (effects) lines.push(effects);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The per-turn <game_state> map block (spec §5.4)
// ---------------------------------------------------------------------------

function heroTokenLine(state: CombatState, t: SnapshotToken): string {
  if (!t.space) return `- ${t.name} (hero) · not on the map`;
  const elevation = t.elevationFt > 0 ? ` · ↑${t.elevationFt} ft` : '';
  const near = t.enemiesWithin5?.length
    ? ` · within 5 ft of ${listAnd(t.enemiesWithin5.map((id) => dmName(state, id)))} (${t.name}'s ranged attacks have Disadvantage)`
    : '';
  return `- ${t.name} (hero) ${rectLabel(t.space)}${placeSuffix(t.places)}${elevation} · reach ${t.reachFt} ft${near}`;
}

function tokenLine(state: CombatState, hero: Character | null, t: SnapshotToken): string {
  const name = dmName(state, t.id);
  if (!t.space) return `- ${name} · not on the map`;
  const parts = [`- ${name} ${rectLabel(t.space)}${placeSuffix(t.places)}`];
  if (t.elevationFt > 0) {
    const flies = (moverStats(state, hero, t.id)?.fly ?? 0) > 0;
    parts[0] += ` · ↑${t.elevationFt} ft${flies ? '' : ', not flying'}`;
  }
  if (t.distanceFromHeroFt !== null) parts.push(`${t.distanceFromHeroFt} ft`);
  const cover = t.coverFromHero;
  if (cover && cover.degree !== 'none') {
    const by = coverBy(state, cover);
    parts.push(`${COVER_SHORT[cover.degree]} cover${by ? ` (${by})` : ''}`);
  }
  if (!t.heroCanSee) parts.push('unseen');
  if (t.reactionUsed) parts.push('Reaction used');
  return parts.join(' · ');
}

function reachPairText(state: CombatState, p: ReachPair): string {
  const a = dmName(state, p.aId);
  const b = dmName(state, p.bId);
  if (p.aReachesB && p.bReachesA) return `${a} ↔ ${b}`;
  return p.aReachesB ? `${a} → ${b}` : `${b} → ${a}`;
}

/** The sum of a turn's moves as a route of squares: "B6 C7 D8". */
function routeOfMoves(moves: readonly TurnMove[]): string {
  const squares: GridPoint[] = [];
  for (const m of moves) {
    const last = squares[squares.length - 1];
    if (!last || last.x !== m.from.x || last.y !== m.from.y) squares.push(m.from);
    if (m.path.length) squares.push(...m.path);
    else if (m.to.x !== m.from.x || m.to.y !== m.from.y) squares.push(m.to);
  }
  return squares.length > 1 ? squares.map(squareLabel).join(' ') : '';
}

/** "30 ft of movement." · "moved 10 of 30 ft (B6 C7 D8), 20 ft left; took the Disengage action." */
function movementPhrase(current: Combatant, budget: TurnBudget | null, moves: readonly TurnMove[]): string {
  if (!budget) return 'not on the map.';
  const total = budget.speedFt + budget.dashFt;
  let base: string;
  if (budget.movedFt > 0) {
    const route = routeOfMoves(moves);
    base = `moved ${budget.movedFt} of ${total} ft${route ? ` (${route})` : ''}, ${budget.leftFt} ft left`;
  } else if (moves.length > 0) {
    base = `hasn't moved (${total} ft of movement)`;
  } else {
    base = `${total} ft of movement`;
  }
  const extras: string[] = [];
  if (budget.dashes > 0) extras.push(`took the Dash action${current.isPlayer ? " (the hero's action, unless a feature makes it a Bonus Action)" : ''}`);
  if (budget.disengaged) extras.push('took the Disengage action');
  if (budget.stoodUp) extras.push(`stood up (${budget.standCostFt} ft)`);
  else if (budget.prone) extras.push(`Prone — standing costs ${budget.standCostFt} ft`);
  if (budget.speedZero) extras.push(`Speed 0 (${budget.speedZero})`);
  return `${[base, ...extras].join('; ')}.`;
}

/** Is this stop the player's, still current and not yet seen by the DM? */
function unseenPlayerStop(state: CombatState, answered: (seq: number) => boolean): MapStop | null {
  const stop = state.map?.stop;
  if (!stop || stop.by !== 'player' || stop.round !== state.round) return null;
  const current = currentCombatant(state);
  if (current?.id !== stop.moverId) return null;
  return isToldAndAnswered(stop, answered) ? null : stop;
}

/** The feet left of a stopped move from where it stopped (its repeat ignores the reactors already recorded). */
export function remainingStopFt(state: CombatState, hero: Character | null, stop: MapStop): number {
  const plan = planMove(state, hero, {
    moverId: stop.moverId,
    kind: 'move',
    by: 'dm',
    to: { kind: 'square', at: stop.destination },
    prefer: stop.opts.prefer ?? 'safest',
    ...(stop.opts.mode ? { mode: stop.opts.mode } : {}),
  });
  if (plan.status === 'moved') return plan.costFt;
  if (plan.status === 'stopped') return plan.costFt + plan.remainingCostFt;
  if (plan.refusal.code === 'too-far') return plan.refusal.needFt;
  return 5 * stop.route.length;
}

function occupantAt(state: CombatState, hero: Character | null, at: GridPoint, exceptId: string): Combatant | undefined {
  return state.combatants.find((c) => {
    if (c.id === exceptId || c.defeated || !c.position) return false;
    const r = footprint(c.position, combatantSize(c, hero));
    return at.x >= r.x0 && at.x <= r.x1 && at.y >= r.y0 && at.y <= r.y1;
  });
}

/** "Dock Ogre's reach … its Opportunity Attack (its Reaction is unused)", or the plural. */
function reactorsReach(state: CombatState, ids: readonly string[]): { reach: string; attack: string } {
  const names = ids.map((id) => dmName(state, id));
  if (names.length === 1) return { reach: `${names[0]}'s reach`, attack: 'its Opportunity Attack (its Reaction is unused)' };
  return { reach: `the reach of ${listAnd(names)}`, attack: 'their Opportunity Attacks (their Reactions are unused)' };
}

function playerStopText(state: CombatState, hero: Character | null, stop: MapStop, move: TurnMove | null): string {
  const heroName = combatant(state, stop.moverId)?.name ?? 'the hero';
  const dest = squareLabel(stop.destination);
  const at = squareLabel(stop.at);
  const walked = move && move.path.length ? ` ${[move.from, ...move.path].map(squareLabel).join(' → ')} (${move.costFt} ft)` : '';
  const { reach, attack } = reactorsReach(state, stop.reactorIds);
  const passer = stop.triggerAt ? occupantAt(state, hero, stop.triggerAt, stop.moverId) : undefined;
  const where = stop.triggerAt
    ? ` while passing through ${passer ? `${dmName(state, passer.id)}'s space` : 'a space'} at ${squareLabel(stop.triggerAt)}`
    : ' there';
  const remaining = remainingStopFt(state, hero, stop);
  return (
    `the player moved ${heroName}${walked} toward ${dest} and the move stopped at ${at} — leaving ${reach}${where} provokes ${attack}. ` +
    `The player meant to go on to ${dest} (${remaining} ft more). Resolve the attack (roll_dice), then finish the move with ` +
    `move_tokens {"moves":[{"who":"hero","to":"${dest}"}]} unless it stops the hero.`
  );
}

function playerMoveText(state: CombatState, hero: Character | null, m: TurnMove, budget: TurnBudget | null): string {
  const heroC = heroOf(state);
  const heroName = heroC?.name ?? 'the hero';
  const standFt = budget?.standCostFt ?? 0;
  if (m.kind === 'stand' || (m.path.length === 0 && m.stoodUp && m.from.x === m.to.x && m.from.y === m.to.y)) {
    return `the player stood ${heroName} up (${standFt} ft).`;
  }
  const route = [m.from, ...m.path].map(squareLabel).join(' → ');
  const actions = [m.disengaged ? 'the Disengage action' : '', m.dashed ? 'the Dash action' : ''].filter(Boolean);
  const flags = actions.length ? ` after taking ${actions.join(' and ')}` : '';
  const stood = m.stoodUp ? `the player stood ${heroName} up (${standFt} ft), then moved` : 'the player moved';
  const parts = [`${stood} ${heroName} ${route} (${m.costFt} ft)${flags}`];
  for (const p of m.provoked.filter((x) => x.hidden)) {
    const at = squareLabel(p.at);
    parts.push(
      `leaving ${at} gave the ${dmName(state, p.reactorId)} an unseen Opportunity Attack — resolve it if it takes it; if it stops the hero, put ${heroName} back on ${at} with move_tokens kind "place"`,
    );
  }
  if (m.revealedHidden) {
    const blocker = m.blockedById ? combatant(state, m.blockedById) : undefined;
    const who = blocker ? `the ${dmName(state, blocker.id)} (${spaceText(blocker, hero) ?? 'not on the map'})` : 'something hidden';
    const what = blocker ? `${who} blocks the way` : `${who} cost more movement than the player could see`;
    parts.push(`${heroName}'s move stopped at ${squareLabel(m.to)}: ${what} — the player saw the hero stop and nothing more`);
  }
  return `${parts.join('; ')}.`;
}

/** The player's moves and stop the DM hasn't seen (D48), as one paragraph; null when there are none. */
export function newSinceText(state: CombatState, hero: Character | null, answered: (seq: number) => boolean): string | null {
  if (!state.map) return null;
  const turn = currentTurn(state);
  const current = currentCombatant(state);
  const budget = current ? turnBudget(state, hero, current.id) : null;
  const stop = unseenPlayerStop(state, answered);
  const moves = (turn?.moves ?? []).filter((m) => m.by === 'player' && !isToldAndAnswered(m, answered));
  const stopIndex = stop ? findLastIndex(moves, (m) => m.to.x === stop.at.x && m.to.y === stop.at.y) : -1;
  const items: string[] = [];
  moves.forEach((m, i) => {
    if (stop && i === stopIndex) items.push(playerStopText(state, hero, stop, m));
    else items.push(playerMoveText(state, hero, m, budget));
  });
  if (stop && stopIndex < 0) items.push(playerStopText(state, hero, stop, null));
  return items.length ? items.join(' ') : null;
}

function findLastIndex<T>(list: readonly T[], test: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i])) return i;
  return -1;
}

const FALL_REASON = (stats: MoverStats | null): string => {
  if (stats?.prone) return 'Prone';
  if (stats?.incapacitated) return 'Incapacitated';
  return 'without a working Fly Speed';
};

/** One "Check:" line per map warning. */
export function warningText(state: CombatState, hero: Character | null, w: MapWarning): string {
  switch (w.kind) {
    case 'unplaced':
      return `${dmName(state, w.id)} isn't on the map — place it with move_tokens kind "place".`;
    case 'shared-space':
      return `${dmName(state, w.ids[0])} and ${dmName(state, w.ids[1])} share a space: one that ends its turn there has the Prone condition unless it is Tiny or larger than the other — apply it with update_combat conditions, or move one of them.`;
    case 'airborne-walker':
      return `${dmName(state, w.id)} is ${w.elevationFt} ft up without a Fly Speed — correct its height with move_tokens kind "place" if it isn't on a ledge.`;
    case 'must-fall': {
      const stats = moverStats(state, hero, w.id);
      const dice = w.dice ? `${w.dice} bludgeoning` : 'no damage under 10 ft';
      return `${dmName(state, w.id)} is ${FALL_REASON(stats)} ${w.elevationFt} ft up and can't hover — it falls (${dice}).`;
    }
    case 'does-not-fit':
      return `${dmName(state, w.id)} doesn't fit where it stands — move it with move_tokens kind "place".`;
    case 'orphan-effect':
      return `${w.label} has no creature to surround any more — end it with update_map effects_end.`;
  }
}

/** The `<game_state>` map block (spec §5.4): positions, reach, lasting effects, the current turn, unseen player moves. */
export function mapStateLines(state: CombatState, hero: Character | null, answered: (seq: number) => boolean): string[] {
  const snap: MapSnapshot | null = mapSnapshot(state, hero, { perspective: 'dm' });
  if (!snap || !state.map) return [];
  const lines = [`Map: ${snap.name ? `${snap.name} ` : ''}${snap.width}×${snap.height} (A1 top-left; full layout: check_map show)`];
  for (const t of snap.tokens) {
    if (t.defeated) continue;
    lines.push(t.isHero ? heroTokenLine(state, t) : tokenLine(state, hero, t));
  }
  lines.push(`In reach: ${snap.reach.length ? snap.reach.map((p) => reachPairText(state, p)).join(' · ') : 'none'}`);
  const lasting = snap.effects.filter((e) => e.duration === 'lasting');
  if (lasting.length) lines.push(`Effects: ${lasting.map((e) => effectText(state, e)).join(' · ')}`);
  const current = currentCombatant(state);
  if (current) lines.push(`Turn: ${dmName(state, current.id)} — ${movementPhrase(current, snap.current?.budget ?? null, snap.current?.moves ?? [])}`);
  const unseen = newSinceText(state, hero, answered);
  if (unseen) lines.push(`New since your last reply: ${unseen}`);
  if (current && !current.isPlayer) {
    lines.push(`Turn check: the tracker is on ${dmName(state, current.id)}'s turn. If that turn is over, call update_combat next_turn first.`);
  }
  for (const w of snap.warnings) lines.push(`Check: ${warningText(state, hero, w)}`);
  return lines;
}

// ---------------------------------------------------------------------------
// The turn-start line after update_combat (spec §4.6)
// ---------------------------------------------------------------------------

/** "Map: Bandit 2 is at F3 (Prone — standing costs 15 ft) with 30 ft of movement (walk 30); 20 ft from Mira Voss, out of reach." */
export function turnStartLine(before: CombatState, after: CombatState, hero: Character | null): string | null {
  if (!after.map) return null;
  const report = turnStartReport(before, after, hero);
  if (!report?.currentId) return null;
  const c = combatant(after, report.currentId);
  if (!c) return null;
  const map = after.map;
  const parts: string[] = [];
  const budget = report.budget;
  const stats = moverStats(after, hero, c.id);
  if (c.isPlayer) {
    parts.push(`Map: ${c.name}'s turn — the player moves ${c.name} on the map (${budget?.leftFt ?? 0} ft). Don't move ${c.name} unless the player asks.`);
  } else if (!report.position) {
    parts.push(`Map: ${dmName(after, c.id)} isn't on the map — place it with move_tokens kind "place".`);
  } else {
    const space = spaceText(c, hero) ?? squareLabel(report.position);
    const up = report.elevationFt > 0 ? `, ${report.elevationFt} ft up` : '';
    const prone = budget?.prone ? ` (Prone — standing costs ${budget.standCostFt} ft)` : '';
    const movement = budget?.speedZero
      ? `no movement (${budget.speedZero}: Speed 0)`
      : `${budget?.leftFt ?? 0} ft of movement (${stats ? statsSpeeds(stats) : 'walk 30'})`;
    const relation = relationClause(after, hero, c.id);
    parts.push(`Map: ${dmName(after, c.id)} is at ${space}${up}${prone} with ${movement}${relation ? `; ${relation}` : ''}.`);
  }
  if (report.startsInside.length) {
    const subject = c.isPlayer ? c.name : 'It';
    parts.push(`${subject} starts ${c.isPlayer ? 'the' : 'its'} turn inside ${listAnd(report.startsInside.map((l) => insideLabel(map, l)))}.`);
  }
  if (report.previous?.endedInside.length) {
    const prev = combatant(after, report.previous.id) ?? combatant(before, report.previous.id);
    if (prev) {
      parts.push(`${dmName(after, prev.id)} ended ${prev.isPlayer ? 'the' : 'its'} turn inside ${listAnd(report.previous.endedInside.map((l) => insideLabel(map, l)))}.`);
    }
  }
  if (report.expired.length) parts.push(`${listAnd(report.expired)} ${report.expired.length > 1 ? 'are' : 'is'} no longer shown.`);
  const next = nextInOrder(after, c.id);
  if (next && next.initiative === c.initiative) {
    parts.push(`${dmName(after, next.id)} acts next on the same initiative: move ${dmName(after, c.id)}, act, then call update_combat next_turn again.`);
  }
  return parts.join(' ');
}

/** The next non-defeated combatant after `id` in initiative order (wrapping), or null. */
function nextInOrder(state: CombatState, id: string): Combatant | null {
  const i = state.combatants.findIndex((c) => c.id === id);
  if (i < 0) return null;
  for (let step = 1; step < state.combatants.length; step++) {
    const c = state.combatants[(i + step) % state.combatants.length];
    if (!c.defeated) return i + step >= state.combatants.length ? null : c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// roll_dice: the reach and cover check (spec §4.11)
// ---------------------------------------------------------------------------

/** One "Map:" line for an attack roll on a battle map; null when either creature isn't on it. */
export function attackCheck(state: CombatState, hero: Character | null, attackerId: string, targetId: string): string | null {
  const a = combatant(state, attackerId);
  const t = combatant(state, targetId);
  if (!state.map || !a?.position || !t?.position || a.id === t.id) return null;
  const aName = dmName(state, a.id);
  const tName = dmName(state, t.id);
  const aSq = spaceText(a, hero) ?? '';
  const d = distanceFt(a, t, hero) ?? 0;
  const reach = moverStats(state, hero, a.id)?.reachFt ?? 5;
  const cover = coverAgainst(state, hero, a.id, t.id);
  const sentences: string[] = [];
  if (inReach(state, hero, a.id, t.id)) {
    sentences.push(`Map: in reach (${d} ft); ${coverSentence(state, tName, cover, true)}`);
  } else {
    sentences.push(
      `Map: ${aName} (${aSq}) is ${d} ft from ${tName} (${spaceText(t, hero) ?? ''}), beyond its ${reach}-ft reach — if this is a melee attack, move it first (the roll stands only if it is a ranged attack).`,
    );
    if (cover.degree !== 'none') sentences.push(capitalize(coverSentence(state, tName, cover, false)));
  }
  if (cover.degree !== 'total' && !lineOfSight(state, hero, a.id, t.id)) {
    sentences.push(`${aName} can't see ${tName} from ${aSq} — Disadvantage, unless something lets it see ${tName}.`);
  }
  return sentences.join(' ');
}

function coverSentence(state: CombatState, targetName: string, cover: CoverResult, inReachNow: boolean): string {
  if (cover.degree === 'none') return inReachNow ? 'no cover.' : '';
  const by = coverBy(state, cover);
  const what = `${targetName} has ${COVER_TITLE[cover.degree]} from it${by ? ` (${by})` : ''}`;
  if (cover.degree === 'total') return `${what} — it can't be targeted directly.`;
  return `${what} — that is +${COVER_BONUS[cover.degree]} AC.`;
}

// ---------------------------------------------------------------------------
// Areas of effect (spec §4.9)
// ---------------------------------------------------------------------------

function shapePhrase(state: CombatState, spec: AreaSpec): string {
  const size = spec.sizeFt ?? 0;
  const from = spec.fromId ? dmName(state, spec.fromId) : undefined;
  const origin = from ?? refText(state, spec.at);
  const toward = refText(state, spec.toward);
  switch (spec.shape) {
    case 'sphere':
      return `${size}-ft-radius Sphere centred on ${refText(state, spec.at)}`;
    case 'cylinder':
      return `${size}-ft-radius, ${spec.heightFt ?? 40}-ft-high Cylinder centred on ${refText(state, spec.at)}`;
    case 'cone':
      return `${size}-ft Cone from ${origin} toward ${toward}`;
    case 'line':
      return `${size}-ft-long, ${spec.widthFt ?? 5}-ft-wide Line from ${origin} toward ${toward}`;
    case 'cube':
      return spec.fromId && spec.toward ? `${size}-ft Cube from ${origin} toward ${toward}` : `${size}-ft Cube centred on ${refText(state, spec.at)}`;
    case 'emanation':
      return `${size}-ft Emanation around ${origin}`;
    case 'squares':
      return `the squares ${rectsLabel(spec.rects ?? [])}`;
  }
}

/** Shapes measured from a centre (the distance and sight from `from` matter); the others come out of `from`. */
function isPlacedShape(spec: AreaSpec): boolean {
  return spec.shape === 'sphere' || spec.shape === 'cylinder' || spec.shape === 'squares' || (spec.shape === 'cube' && !(spec.fromId && spec.toward));
}

function listsSquares(spec: AreaSpec): boolean {
  return spec.shape === 'cone' || spec.shape === 'line' || (spec.shape === 'cube' && Boolean(spec.fromId && spec.toward));
}

const AREA_TERRAIN_WORDS: Readonly<Record<AreaTerrain, string>> = {
  difficult: 'difficult terrain',
  obscured: 'heavily obscured (they block sight)',
  hazard: 'a hazard (the app reports who enters them)',
};

function hitName(state: CombatState, hero: Character | null, id: string): string {
  const c = combatant(state, id);
  return c ? `${dmName(state, id)} ${spaceText(c, hero) ?? ''}`.trim() : 'someone';
}

/** The resolve_area result (or check_map's preview of it). */
export function describeArea(
  state: CombatState,
  hero: Character | null,
  spec: AreaSpec,
  result: AreaResult,
  opts: { label: string; lasting?: boolean; terrain?: readonly AreaTerrain[]; preview?: boolean },
): string {
  const lines: string[] = [];
  let first = `${opts.label ? `${opts.label}: ` : ''}${shapePhrase(state, spec)}`;
  if (listsSquares(spec)) first += ` (${rectsLabel(result.squares) || 'no squares'})`;
  const from = spec.fromId ? dmName(state, spec.fromId) : undefined;
  if (from && isPlacedShape(spec) && result.origin.distanceFt !== undefined) {
    const sees = result.origin.lineOfSight !== false;
    first += `, ${result.origin.distanceFt} ft from ${from} (${from} ${sees ? 'can see it' : "can't see it: if it needs a point the caster can see, rule where it goes off"})`;
  }
  if (opts.preview) first = `Preview (not shown to the player): ${first}.`;
  else if (opts.lasting) {
    first += `. It stays on the map until update_map effects_end ["${opts.label}"].`;
    const words = (opts.terrain ?? []).map((t) => AREA_TERRAIN_WORDS[t]);
    if (words.length) first += ` Its squares are now ${listAnd(words)}.`;
  } else first += '. Shown on the map until this turn ends.';
  lines.push(first);
  if (result.offMap > 0) lines.push(`${result.offMap} of its squares ${result.offMap === 1 ? 'is' : 'are'} off the map.`);
  lines.push(result.inside.length ? `Inside (${result.inside.length}): ${result.inside.map((h) => hitName(state, hero, h.id)).join(' · ')}.` : 'Inside: nobody.');
  const covered = result.inside.filter((h) => h.cover.degree !== 'none' && h.cover.degree !== 'total');
  if (covered.length) {
    const parts = covered.map((h) => {
      const c = combatant(state, h.id);
      const whose = c?.isPlayer ? `${c.name}'s` : 'its';
      return `${dmName(state, h.id)} — ${coverTitle(state, h.cover)}: +${COVER_BONUS[h.cover.degree]} to ${whose} Dexterity save`;
    });
    lines.push(`Cover against it: ${parts.join(' · ')}.`);
  }
  if (result.shielded.length) {
    const parts = result.shielded.map((s) => `${hitName(state, hero, s.id)}${s.by.length ? ` — behind ${listAnd(s.by.map((b) => `the ${b}`))}` : ''}`);
    lines.push(`Shielded by Total Cover (not affected): ${parts.join(' · ')}.`);
  }
  if (result.outside.length) lines.push(`Not inside: ${result.outside.map((id) => hitName(state, hero, id)).join(' · ')}.`);
  for (const h of result.inside) {
    const c = combatant(state, h.id);
    if (c?.isPlayer) lines.push(`⚠ ${c.name} (the hero) is inside.`);
    else if (c?.side === 'ally') lines.push(`⚠ ${dmName(state, c.id)} (an ally) is inside.`);
  }
  for (const h of result.inside) {
    if (h.airborneFt) lines.push(`Airborne: ${dmName(state, h.id)} is ${h.airborneFt} ft up — the ${spec.shape} ignores height on this map; you decide.`);
  }
  if (!opts.preview && result.inside.length) {
    lines.push("Next: roll each creature's save (roll_dice; the hero's with request_player_roll), then apply the damage.");
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Moves (spec §4.7)
// ---------------------------------------------------------------------------

export type MovedOutcome = Extract<MoveOutcome, { status: 'moved' }>;
export type StoppedOutcome = Extract<MoveOutcome, { status: 'stopped' }>;

/** How a result refers to a creature as the subject of a later clause: "it", or the hero's name (never a pronoun). */
function itOf(c: Combatant | undefined): string {
  return c?.isPlayer ? c.name : 'it';
}

/** The same at the start of a sentence: "It", or the hero's name. */
function ItOf(c: Combatant | undefined): string {
  return c?.isPlayer ? c.name : 'It';
}

/** "Its", or the hero's name with an apostrophe. */
function ItsOf(c: Combatant | undefined): string {
  return c?.isPlayer ? `${c.name}'s` : 'Its';
}

/** "its", or the hero's name with an apostrophe. */
function itsOf(c: Combatant | undefined): string {
  return c?.isPlayer ? `${c.name}'s` : 'its';
}

/** "F4 E4 D4 C5": the start, then every square entered. */
function routeText(from: GridPoint, path: readonly GridPoint[]): string {
  return [from, ...path].map(squareLabel).join(' ');
}

/** " It stood up first (15 ft)." and the other notes of a move (DM-facing). */
export function moveNotes(state: CombatState, moverId: string, notes: readonly MoveNote[]): string {
  const mover = combatant(state, moverId);
  const It = ItOf(mover);
  const it = itOf(mover);
  const map = state.map;
  const out: string[] = [];
  for (const n of notes) {
    switch (n.kind) {
      case 'stood-up':
        out.push(`${It} stood up first (${n.costFt} ft).`);
        break;
      case 'crawled':
        out.push(`${It} crawled (Prone).`);
        break;
      case 'entered':
        out.push(`${It} entered ${map ? insideLabel(map, n.label) : n.label} at ${squareLabel(n.at)}.`);
        break;
      case 'emanation-reached':
        out.push(`${ItsOf(mover)} ${n.label} now covers ${listAnd(n.ids.map((id) => dmName(state, id)))}.`);
        break;
      case 'airborne-walker':
        out.push(`${It} is ${n.elevationFt} ft up without a Fly Speed: correct ${itsOf(mover)} height with kind "place" if ${it} isn't on a ledge.`);
        break;
      case 'oa-unseen':
        out.push(`The ${dmName(state, n.reactorId)} gets an unseen Opportunity Attack at ${squareLabel(n.at)}.`);
        break;
      case 'grapple-ended':
        out.push(
          `The grapple ends: ${it} is out of ${dmName(state, n.grapplerId)}'s reach (remove Grappled with ${mover?.isPlayer ? 'update_character' : 'update_combat conditions'}).`,
        );
        break;
      case 'fell':
        out.push(
          n.dice
            ? `${It} fell ${n.feet} ft into ${n.into}: roll ${n.dice} bludgeoning (falling); ${it} lands Prone if ${it} takes any damage.`
            : `${It} dropped ${n.feet} ft into ${n.into} (too short a fall to hurt).`,
        );
        break;
      case 'stop-continued': {
        const used = n.reactorIds.filter((id) => !n.declinedIds.includes(id));
        const letGo = n.reactorIds.filter((id) => n.declinedIds.includes(id));
        if (used.length) out.push(`${listAnd(used.map((id) => `${dmName(state, id)}'s`))} Reaction${used.length > 1 ? 's are' : ' is'} now used.`);
        if (letGo.length) out.push(`${listAnd(letGo.map((id) => dmName(state, id)))} let it go.`);
        break;
      }
      default:
        // difficult, swam, passed-through: the cost already shows them; shifted, teleported, push-stopped,
        // blocked-by-unseen: rendered by their own templates.
        break;
    }
  }
  return out.length ? ` ${out.join(' ')}` : '';
}

/** "Now 5 ft from Mira Voss and 5 ft from Old Tam — each is within the other's reach. Mira Voss has no cover from it." */
function afterMoveClauses(state: CombatState, hero: Character | null, moverId: string): string {
  const out: string[] = [];
  const relation = relationClause(state, hero, moverId);
  if (relation) out.push(`Now ${relation}.`);
  const mover = combatant(state, moverId);
  const heroC = heroOf(state);
  if (mover && heroC && heroC.id !== mover.id && heroC.position && mover.position && isHostile(mover, heroC)) {
    const cover = coverAgainst(state, hero, mover.id, heroC.id);
    const close = inReach(state, hero, mover.id, heroC.id) || inReach(state, hero, heroC.id, mover.id);
    if (cover.degree !== 'none' || close) out.push(`${hasCover(state, heroC.name, cover, 'it')}.`);
  }
  return out.length ? ` ${out.join(' ')}` : '';
}

/** The Opportunity Attacks a move provoked that were let go ("the player let it go" for the hero). */
function letGoText(state: CombatState, provoked: readonly ProvokedAttack[], declined: readonly string[]): string {
  const out: string[] = [];
  for (const p of provoked) {
    if (!declined.includes(p.reactorId)) continue;
    const who = p.isHero ? 'the player let it go' : `${dmName(state, p.reactorId)} let it go`;
    out.push(`Leaving ${squareLabel(p.at)} provoked ${dmName(state, p.reactorId)}'s Opportunity Attack: ${who}.`);
  }
  return out.length ? ` ${out.join(' ')}` : '';
}

/** A willing move that went all the way (kind move or off-turn). `declined`: reactors that let it go. */
export function describeWillingMove(n: number, state: CombatState, hero: Character | null, o: MovedOutcome, declined: readonly string[]): string {
  const name = dmName(state, o.moverId);
  const head =
    o.path.length === 0
      ? `${n}. ${name} is already there (${squareLabel(o.to)}): no movement spent`
      : `${n}. ${name} moved ${squareLabel(o.from)} → ${squareLabel(o.to)}${o.kind === 'off-turn' ? ' off its turn' : ''}: ${o.costFt} ft (${routeText(o.from, o.path)})`;
  const b = o.budget;
  let left = '';
  if (b && o.kind === 'move') left = `; ${b.leftFt} of ${b.speedFt + b.dashFt} ft left this turn`;
  else if (b && o.kind === 'off-turn') left = `; ${b.leftFt} of its ${b.speedFt}-ft allowance left`;
  return `${head}${left}.${letGoText(state, o.provoked, declined)}${moveNotes(state, o.moverId, o.notes)}${afterMoveClauses(state, hero, o.moverId)}`;
}

/** "here", or "Old Tam's space at B6" when the mover was passing through an ally's space (D31). */
function leavingWhere(state: CombatState, hero: Character | null, o: StoppedOutcome): string {
  if (o.triggerAt.x === o.at.x && o.triggerAt.y === o.at.y) return 'here';
  const passer = occupantAt(state, hero, o.triggerAt, o.moverId);
  return `${passer ? `${dmName(state, passer.id)}'s space` : 'the square'} at ${squareLabel(o.triggerAt)}`;
}

/** ', adding "declined": ["Old Tam"] if Old Tam lets Bandit 1 go'. */
function declinedHint(state: CombatState, moverName: string, ids: readonly string[]): string {
  if (!ids.length) return '';
  const names = ids.map((id) => combatant(state, id)?.name ?? 'someone');
  if (names.length === 1) return `, adding "declined": ["${names[0]}"] if ${names[0]} lets ${moverName} go`;
  return `, adding "declined" with the names of any of ${JSON.stringify(names)} that let ${moverName} go`;
}

/** A stop at an Opportunity Attack (D31–D33). `heroTakes`: the player answered Attack in the dialog (D32). */
export function describeStop(n: number, state: CombatState, hero: Character | null, o: StoppedOutcome, opts: { heroTakes: boolean }): string {
  const mover = combatant(state, o.moverId);
  const name = dmName(state, o.moverId);
  const moverName = mover?.name ?? name;
  const stop = state.map?.stop;
  const declined = new Set(stop && stop.moverId === o.moverId ? stop.declinedIds : []);
  const heroIds = o.reactors.filter((r) => r.isHero && !declined.has(r.reactorId)).map((r) => r.reactorId);
  const heroLetGo = o.reactors.filter((r) => r.isHero && declined.has(r.reactorId)).map((r) => r.reactorId);
  const npcs = o.reactors.filter((r) => !r.isHero && !declined.has(r.reactorId)).map((r) => r.reactorId);
  const dest = squareLabel(o.destination);
  const notes = moveNotes(state, o.moverId, o.notes.filter((x) => x.kind !== 'stop-continued'));
  if (opts.heroTakes && heroIds.length) {
    const heroName = combatant(state, heroIds[0])?.name ?? 'the hero';
    const ac = mover?.ac !== undefined ? `, AC ${mover.ac}` : '';
    const parts = [
      `${n}. ${name} stopped at ${squareLabel(o.at)} (${o.costFt} ft moved; ${o.budget?.leftFt ?? 0} ft left): leaving ${leavingWhere(state, hero, o)} provokes Opportunity Attacks.`,
      `${heroName}: the player takes it — resolve it now with request_player_roll (an attack against ${moverName}${ac}), then damage.`,
      ...npcs.map((id) => `${dmName(state, id)}: yours to decide — if ${dmName(state, id)} takes it, roll the attack with roll_dice.`),
      `Then repeat this move to finish it (${o.remainingCostFt} ft more to ${dest})${declinedHint(state, moverName, npcs)}.`,
    ];
    return `${parts.join(' ')}${notes}`;
  }
  const stoppers = npcs.length ? npcs : heroIds;
  const { reach, attack } = reactorsReach(state, stoppers);
  const parts = [
    `${n}. ${name} stopped at ${squareLabel(o.at)} on the way to ${dest} (${o.costFt} ft so far): leaving ${leavingWhere(state, hero, o)} takes ${moverName} out of ${reach}, which provokes ${attack}.`,
  ];
  if (heroLetGo.length) parts.push(`${listAnd(heroLetGo.map((id) => `${dmName(state, id)}'s`))} Opportunity Attack: the player let it go.`);
  const many = stoppers.length > 1;
  parts.push(`Roll ${many ? 'them' : 'it'} now if ${many ? 'they attack' : 'it attacks'}, then repeat this move (${o.remainingCostFt} ft more)${declinedHint(state, moverName, npcs)}.`);
  return `${parts.join(' ')}${notes}`;
}

export function describeNotRun(n: number, state: CombatState, stopperId: string): string {
  return `${n}. Not run: the batch stopped at ${dmName(state, stopperId)}'s Opportunity Attack.`;
}

const DIR_STEP: Readonly<Record<CompassDirection, GridPoint>> = {
  north: { x: 0, y: -1 },
  'north-east': { x: 1, y: -1 },
  east: { x: 1, y: 0 },
  'south-east': { x: 1, y: 1 },
  south: { x: 0, y: 1 },
  'south-west': { x: -1, y: 1 },
  west: { x: -1, y: 0 },
  'north-west': { x: -1, y: -1 },
};

/** How a push was asked for, for its result line. */
export interface PushDescription {
  wantedFt: number;
  dir: CompassDirection | null;
  /** What it was pushed away from or pulled toward, as the DM wrote it. */
  source: string | null;
  toward: boolean;
}

/** "Bandit 1 was pushed 10 ft north-east, C5 → E3, straight away from Mira Voss (no movement used, no Opportunity Attacks)." */
export function describeForced(n: number, state: CombatState, hero: Character | null, o: MovedOutcome, push: PushDescription): string {
  const name = dmName(state, o.moverId);
  const moved = 5 * o.path.length;
  const stopped = o.notes.find((x): x is Extract<MoveNote, { kind: 'push-stopped' }> => x.kind === 'push-stopped');
  const verb = push.toward ? 'pulled' : 'pushed';
  const dir = push.dir ? ` ${push.dir}` : '';
  const why = push.source ? `, straight ${push.toward ? 'toward' : 'away from'} ${push.source}` : '';
  let head: string;
  if (moved === 0) head = `${n}. ${name} wasn't moved`;
  else if (stopped) head = `${n}. ${name} was ${verb}${dir}, ${squareLabel(o.from)} → ${squareLabel(o.to)} (${moved} of ${push.wantedFt} ft)${why}`;
  else head = `${n}. ${name} was ${verb} ${moved} ft${dir}, ${squareLabel(o.from)} → ${squareLabel(o.to)}${why} (no movement used, no Opportunity Attacks)`;
  if (stopped) {
    const step = push.dir ? DIR_STEP[push.dir] : null;
    const beyond = step && stopped.by !== 'the map edge' ? ` at ${squareLabel({ x: stopped.at.x + step.x, y: stopped.at.y + step.y })}` : '';
    head += `: ${stopped.by}${beyond} stopped it ${stopped.shortFt} ft short`;
  }
  const notes = moveNotes(state, o.moverId, o.notes.filter((x) => x.kind !== 'push-stopped'));
  return `${head}.${notes}${afterMoveClauses(state, hero, o.moverId)}`;
}

/** "F3 was Bandit 2's space, so Mira Voss appeared at E3, the nearest open square." */
function shiftedText(before: CombatState, hero: Character | null, o: MovedOutcome, name: string, verb: string): string | null {
  const s = o.notes.find((x): x is Extract<MoveNote, { kind: 'shifted' }> => x.kind === 'shifted');
  if (!s) return null;
  const sq = squareLabel(s.requested);
  const occupant = s.reason === 'occupied' ? occupantAt(before, hero, s.requested, o.moverId) : undefined;
  const why = occupant ? `${sq} was ${dmName(before, occupant.id)}'s space` : s.reason === 'occupied' ? `${sq} was taken` : `${sq} is blocked`;
  return `${why}, so ${name} ${verb} at ${squareLabel(o.to)}, the nearest open square.`;
}

/** "Mira Voss teleported B6 → E3 (15 ft; Mira Voss can see it)." */
export function describeTeleport(n: number, before: CombatState, state: CombatState, hero: Character | null, o: MovedOutcome): string {
  const name = dmName(state, o.moverId);
  const plain = combatant(state, o.moverId)?.name ?? name;
  const tp = o.notes.find((x): x is Extract<MoveNote, { kind: 'teleported' }> => x.kind === 'teleported');
  const sight = tp ? `${tp.distanceFt} ft; ${plain} ${tp.lineOfSight ? 'can see it' : "can't see it — check that against the spell"}` : '';
  const parts = [`${n}. ${name} teleported ${squareLabel(o.from)} → ${squareLabel(o.to)}${sight ? ` (${sight})` : ''}.`];
  const shifted = shiftedText(before, hero, o, plain, 'appeared');
  if (shifted) parts.push(shifted);
  const notes = moveNotes(state, o.moverId, o.notes.filter((x) => x.kind !== 'teleported' && x.kind !== 'shifted'));
  return `${parts.join(' ')}${notes}${afterMoveClauses(state, hero, o.moverId)}`;
}

/** "Placed Bandit 3 at A1." */
export function describePlace(n: number, before: CombatState, state: CombatState, hero: Character | null, o: MovedOutcome): string {
  const c = combatant(state, o.moverId);
  const name = dmName(state, o.moverId);
  const where = (c && spaceText(c, hero)) ?? squareLabel(o.to);
  const up = c?.elevationFt ? `, ${c.elevationFt} ft up` : '';
  const spent = o.costFt > 0 ? `; ${o.costFt} ft of ${itsOf(c)} movement spent` : '';
  const shifted = shiftedText(before, hero, o, c?.name ?? name, 'went');
  const notes = moveNotes(state, o.moverId, o.notes.filter((x) => x.kind !== 'shifted'));
  return `${n}. Placed ${name} at ${where}${up}${spent}.${shifted ? ` ${shifted}` : ''}${notes}${afterMoveClauses(state, hero, o.moverId)}`;
}

function columnsText(map: BattleMap): string {
  return `columns A–${squareLabel({ x: map.width - 1, y: 0 }).replace(/\d+$/, '')}, rows 1–${map.height}`;
}

/** The "Not moved" line of a refused move. `target`: what `to` named, as the DM wrote it. */
export function describeRefusal(n: number, state: CombatState, hero: Character | null, moverId: string, refusal: MoveRefusal, target: string | null): string {
  const mover = combatant(state, moverId);
  const name = dmName(state, moverId);
  const it = itOf(mover);
  const head = `${n}. Not moved — ${name}${target ? ` to ${target}` : ''}`;
  const map = state.map;
  switch (refusal.code) {
    case 'unplaced':
      return `${n}. Not moved — ${name} isn't on the map: place ${it} first with kind "place".`;
    case 'off-map': {
      const size = mover ? combatantSize(mover, hero) : 'Medium';
      const big = size === 'Large' || size === 'Huge' || size === 'Gargantuan' ? ` for a ${size} creature (\`to\` is the top-left square of its space)` : '';
      return `${head}: ${squareLabel(refusal.to)} is off the map${map ? ` (${columnsText(map)})` : ''}${big}. To have ${it} leave the fight, use update_combat remove.`;
    }
    case 'not-their-turn': {
      if (!refusal.currentId) return `${n}. Not moved — ${name}: there is no current turn. Use kind "off-turn" for a readied move, or "place".`;
      const current = dmName(state, refusal.currentId);
      return `${n}. Not moved — ${name}: it's ${current}'s turn. Move each creature on its own turn: finish ${current}'s turn, call update_combat next_turn, then move ${mover?.name ?? name}. A readied move or a legendary action is kind "off-turn"; a shove is "forced".`;
    }
    case 'speed-zero':
      if (refusal.because.includes(':')) return `${n}. Not moved — ${name}: ${refusal.because}. Forced movement and teleportation still work.`;
      return `${n}. Not moved — ${name}: ${it} is ${refusal.because} (Speed 0). Forced movement and teleportation still work.`;
    case 'cant-stand':
      return `${n}. Not moved — ${name}: standing up costs ${refusal.costFt} ft and ${it} has ${refusal.leftFt} ft left. Give stay_prone: true to crawl instead.`;
    case 'blocked':
      return `${head}: ${squareLabel(refusal.at)} is ${withArticle(refusal.what)}.`;
    case 'occupied': {
      const other = combatant(state, refusal.byId);
      const otherName = other ? dmName(state, other.id) : 'another creature';
      const open = refusal.open.length
        ? ` Open squares ${it} can reach nearby: ${refusal.open.map(squareLabel).join(', ')}.`
        : ` No open square ${it} can reach is nearby.`;
      const near = other ? ` Or give "to": "${other.name}" to end next to ${other.name}.` : '';
      return `${head}: ${squareLabel(refusal.at)} is ${otherName}'s space, and a move can't end there.${open}${near}`;
    }
    case 'no-route': {
      const closest = refusal.closest ? ` The closest ${it} can get is ${squareLabel(refusal.closest.at)} (${refusal.closest.costFt} ft).` : '';
      return `${head}: no open route — walls or creatures cut ${it} off.${closest}`;
    }
    case 'too-far': {
      const how = mover && moverStats(state, hero, mover.id)?.prone ? 'after standing up' : 'by the cheapest open route';
      const route = refusal.route.length && mover?.position ? ` (${routeText(mover.position, refusal.route)})` : '';
      const lead = target && /^[A-Z]+\d+$/.test(target) ? `${target} is ${refusal.needFt} ft away ${how}` : `getting there takes ${refusal.needFt} ft ${how}`;
      const closest = refusal.closest ? `The closest ${it} can get is ${squareLabel(refusal.closest.at)} (${refusal.closest.costFt} ft)` : '';
      const dash = refusal.dashWouldReach ? `with dash: true ${it} reaches ${target ?? 'it'}` : '';
      const tail = closest && dash ? ` ${closest}; ${dash}.` : closest ? ` ${closest}.` : dash ? ` ${capitalize(dash)}.` : '';
      return `${head}: ${lead}${route} and ${it} has ${refusal.leftFt} ft left.${tail}`;
    }
    case 'frightened': {
      const alt = refusal.alternative ? ` ${capitalize(it)} could go to ${squareLabel(refusal.alternative)} instead.` : '';
      return `${head}: ${it} is Frightened of ${dmName(state, refusal.sourceId)} and can't willingly move closer.${alt}`;
    }
    case 'out-of-range':
      return `${head}: that is ${refusal.distanceFt} ft away, beyond ${itsOf(mover)} ${refusal.maxFt}-ft range.`;
    case 'stop-pending':
      return `${head}: the player's stop hasn't been answered yet.`;
    case 'bad-request':
      return `${head}: ${refusal.problem}`;
  }
}

/** "a wall (pillar)", "three-quarters cover (arrow slit)". */
function withArticle(what: string): string {
  return /^three-quarters/.test(what) ? what : `a ${what}`;
}

// ---------------------------------------------------------------------------
// Map edits (spec §4.8)
// ---------------------------------------------------------------------------

/**
 * "Map updated: added difficult G7:J10 (rubble) · cleared the crates (E5:F6) · the office door (N5) is now open · …".
 * `clearedText` gives each terrain-cleared change its words (the change carries no rects).
 */
export function describeMapChanges(after: CombatState, hero: Character | null, changes: readonly MapChange[], clearedText: readonly string[] = []): string {
  const parts: string[] = [];
  let cleared = 0;
  for (const ch of changes) {
    switch (ch.kind) {
      case 'terrain-added': {
        const f = ch.feature;
        const door = f.kind === 'door' ? ` (${f.door ?? 'closed'})` : '';
        parts.push(`added ${terrainWords(f.kind)}${door} ${rectsLabel(f.rects)}${f.label ? ` (${f.label})` : ''}`);
        break;
      }
      case 'terrain-cleared':
        parts.push(clearedText[cleared] ?? `cleared ${ch.squares} square${ch.squares === 1 ? '' : 's'}${ch.labels.length ? ` (${ch.labels.join(', ')})` : ''}`);
        cleared++;
        break;
      case 'door':
        parts.push(`${ch.label ? `the ${ch.label} (${squareLabel(ch.at)})` : `the door at ${squareLabel(ch.at)}`} is now ${ch.state}`);
        break;
      case 'place-added': {
        const place = after.map?.places.find((p) => p.name === ch.name);
        parts.push(`added the place "${ch.name}"${place ? ` (${rectsLabel(place.rects)})` : ''}`);
        break;
      }
      case 'place-removed':
        parts.push(`removed the place "${ch.name}"`);
        break;
      case 'creature':
        parts.push(creatureChangeText(after, hero, ch));
        break;
      case 'effect-ended':
        parts.push(`${ch.label} has ended`);
        break;
    }
  }
  return parts.length ? `Map updated: ${parts.join(' · ')}.` : 'Map updated: nothing changed.';
}

function creatureChangeText(state: CombatState, hero: Character | null, ch: Extract<MapChange, { kind: 'creature' }>): string {
  const c = combatant(state, ch.id);
  const name = dmName(state, ch.id);
  const stats = c ? moverStats(state, hero, c.id) : null;
  const now = stats ? statsSpeeds(stats) : '';
  const bits: string[] = [];
  if (ch.patch.size) {
    const space = c ? spaceText(c, hero) : null;
    bits.push(
      ch.moved
        ? `${name} is now ${ch.patch.size}: it no longer fit at ${squareLabel(ch.moved.from)}, so it moved to ${space ?? squareLabel(ch.moved.to)}`
        : `${name} is now ${ch.patch.size}${space ? ` (${space})` : ''}`,
    );
  }
  if (ch.patch.speeds) {
    const granted = speedsText(ch.patch.speeds).replace(/^walk 0, /, '');
    bits.push(c?.isPlayer ? `${name}: ${granted} for now; ${now} in all` : `${name}: ${now || granted}`);
  }
  if (ch.patch.reachFt !== undefined) bits.push(`${name}: reach ${ch.patch.reachFt} ft`);
  if (ch.patch.speedChangeFt !== undefined) {
    const v = ch.patch.speedChangeFt;
    bits.push(v === 0 ? `${name}: no speed change any more (${now})` : `${name}: speed change ${v > 0 ? '+' : '−'}${Math.abs(v)} ft (${now})`);
  }
  return bits.join(' · ') || `${name}: unchanged`;
}

// ---------------------------------------------------------------------------
// check_map (spec §4.10)
// ---------------------------------------------------------------------------

/** "· Mira Voss (B6): 20 ft — line of sight; Mira Voss has Half Cover from it (crates); it has … ; neither is within the other's reach." */
export function measureLine(state: CombatState, hero: Character | null, a: Combatant, b: Combatant): string {
  const bName = dmName(state, b.id);
  const d = distanceFt(a, b, hero) ?? 0;
  const sees = lineOfSight(state, hero, a.id, b.id);
  const bCover = coverAgainst(state, hero, a.id, b.id);
  const aCover = coverAgainst(state, hero, b.id, a.id);
  const ab = inReach(state, hero, a.id, b.id);
  const ba = inReach(state, hero, b.id, a.id);
  const reach = ab && ba
    ? "each is within the other's reach"
    : ab
      ? `it reaches ${bName}; ${bName} doesn't reach it`
      : ba
        ? `${bName} reaches it; it doesn't reach ${bName}`
        : "neither is within the other's reach";
  return `· ${bName} (${spaceText(b, hero)}): ${d} ft — ${sees ? 'line of sight' : 'no line of sight'}; ${hasCover(state, bName, bCover, 'it')}; ${hasCover(state, 'it', aCover, bName)}; ${reach}.`;
}

/** "Mira Voss has Half Cover from it (crates)" / "it has no cover from Mira Voss". */
function hasCover(state: CombatState, who: string, cover: CoverResult, from: string): string {
  if (cover.degree === 'none') return `${who} has no cover from ${from}`;
  const by = coverBy(state, cover);
  return `${who} has ${COVER_TITLE[cover.degree]} from ${from}${by ? ` (${by})` : ''}`;
}

// ---------------------------------------------------------------------------
// Player-facing text: log lines, the bubble's mapNote, final positions, the layout in a log detail
// ---------------------------------------------------------------------------

/** The player's name for a combatant in a log line: "you" for the hero; null when the player can't see it. */
export function playerName(state: CombatState, id: string): string | null {
  const c = combatant(state, id);
  if (!c || c.hidden) return null;
  return c.isPlayer ? 'you' : c.name;
}

/** The player-safe layout for the setup line's detail (markdown). */
export function playerLayout(state: CombatState, hero: Character | null): string {
  const view = playerView(state);
  const map = view.map;
  if (!map) return '';
  const lines = [`**${map.name ?? 'Battle map'}** — ${map.width}×${map.height} squares of 5 ft (A1 is the top-left).`];
  const terrain = map.terrain.map((f) => `${f.label ?? terrainWords(f.kind)} ${rectsLabel(f.rects)}${f.kind === 'door' ? ` (${f.door ?? 'closed'})` : ''}`);
  if (terrain.length) lines.push(`- Terrain: ${terrain.join(' · ')}`);
  if (map.places.length) lines.push(`- Places: ${map.places.map((p) => `${p.name} ${rectsLabel(p.rects)}`).join(' · ')}`);
  const positions = view.combatants
    .filter((c) => c.position && !c.defeated)
    .map((c) => `${c.isPlayer ? 'You' : c.name} ${spaceText(c, hero)}`);
  if (positions.length) lines.push(`- Positions: ${positions.join(' · ')}`);
  return lines.join('\n');
}

/** "Final positions: Mira Voss A7 (the loading door) · Bandit 1 C6 (fallen) · Old Tam B5" (hidden creatures left out). */
export function finalPositions(state: CombatState, hero: Character | null): string | null {
  const view = playerView(state);
  if (!view.map) return null;
  const parts = view.combatants
    .filter((c) => c.position)
    .map((c) => {
      const space = spaceOf(c, hero);
      const places = space ? placesAt(view, hero, space.rect) : [];
      return `${c.name} ${spaceText(c, hero)}${placeSuffix(places)}${c.defeated ? ' (fallen)' : ''}`;
    });
  return parts.length ? `Final positions: ${parts.join(' · ')}` : null;
}

/**
 * The hero's map moves the DM hasn't seen, for the player's bubble (D51), from the player view:
 * "Moved B6 → C7 → D8 · 10 ft · Disengaged" · "Stood up (15 ft)" · "Moved toward A7 · stopped at B6 (Opportunity Attack)".
 */
export function mapNote(state: CombatState | null, hero: Character | null, answered: (seq: number) => boolean): string | undefined {
  if (!state?.active || !state.map) return undefined;
  const view = playerView(state);
  const turn = currentTurn(view);
  const heroC = heroOf(view);
  if (!turn || !heroC || turn.combatantId !== heroC.id) return undefined;
  const stop = unseenPlayerStop(state, answered);
  const moves = turn.moves.filter((m) => m.by === 'player' && !isToldAndAnswered(m, answered));
  if (!moves.length && !stop) return undefined;
  const standFt = turnBudget(view, hero, heroC.id)?.standCostFt ?? 0;
  const parts: string[] = [];
  let run: { squares: GridPoint[]; feet: number } | null = null;
  const flush = () => {
    if (run && run.squares.length > 1) parts.push(`Moved ${run.squares.map(squareLabel).join(' → ')}`, `${run.feet} ft`);
    run = null;
  };
  const flags = new Set<string>();
  moves.forEach((m, i) => {
    if (m.stoodUp || m.kind === 'stand') {
      flush();
      parts.push(`Stood up (${standFt} ft)`);
    }
    if (m.dashed) flags.add('Dashed');
    if (m.disengaged) flags.add('Disengaged');
    const isStop = stop && i === findLastIndex(moves, (x) => x.to.x === stop.at.x && x.to.y === stop.at.y);
    if (isStop && stop) {
      const before: GridPoint[] = run ? (run as { squares: GridPoint[] }).squares : [];
      const squares = [...(before.length ? before : [m.from]), ...m.path];
      run = null;
      const walked = squares.length > 1 ? ` ${squares.map(squareLabel).join(' → ')}` : '';
      parts.push(`Moved${walked} toward ${squareLabel(stop.destination)}`, `stopped at ${squareLabel(stop.at)} (Opportunity Attack)`);
      return;
    }
    if (m.kind === 'stand' || m.path.length === 0) return;
    const current = run as { squares: GridPoint[]; feet: number } | null;
    const last = current?.squares[current.squares.length - 1];
    if (current && last && last.x === m.from.x && last.y === m.from.y) {
      current.squares.push(...m.path);
      current.feet += m.costFt;
    } else {
      flush();
      run = { squares: [m.from, ...m.path], feet: m.costFt };
    }
  });
  flush();
  parts.push(...flags);
  return parts.length ? parts.join(' · ') : undefined;
}
