/**
 * The battle-map tools (spec §4): move_tokens, update_map, resolve_area and check_map, plus the input resolution
 * every map tool shares (squares, corners, places, creature names, map specs, start positions) and the hero re-fit
 * after a size change (D39).
 *
 * Write discipline: every handler resolves and checks all of its input first (an input problem is a ToolInputError
 * and nothing changes), does its awaiting (the player's Opportunity Attack answer), then writes each change once
 * with mutateCombat against the latest state. check_map only reads.
 *
 * Text comes from ../mapText (DM-facing results; player-facing log lines with hidden creatures left out).
 */
import {
  addAreaEffect,
  applyMove,
  combatantSize,
  coverAgainst,
  createBattleMap,
  currentCombatant,
  editMap,
  findMapCombatant,
  findPlace,
  footprint,
  mapCells,
  moverStats,
  opportunityTriggers,
  parseCorner,
  parseDirection,
  parseSquare,
  parseSquareList,
  placeCombatants,
  planMove,
  reachableSquares,
  rectSquares,
  rectsLabel,
  rectsSeeEachOther,
  refitFootprints,
  resolveArea,
  removeBattleMap,
  removeCondition,
  snapDirection,
  spaceDistanceFt,
  squareLabel,
  turnBudget,
  type BattleMapInput,
  type MapChange,
  type MapDims,
  type MapEdit,
  type MoveOutcome,
  type MoveRequest,
  type MoveTarget,
  type PlacementAnchor,
  type PlacementRequest,
  type PlacementResult,
} from '@/engine';
import type {
  AreaSpec,
  BattleMap,
  Character,
  Combatant,
  CombatState,
  CompassDirection,
  GridPoint,
  GridRect,
  MapRef,
  TerrainFeature,
} from '@/types';
import { DmCancelledError } from '../errors';
import {
  coverBy,
  describeArea,
  describeForced,
  describeMapChanges,
  describeMapSetup,
  describeNotRun,
  describePlace,
  describeRefusal,
  describeShow,
  describeStop,
  describeTeleport,
  describeWillingMove,
  dmName,
  listAnd,
  measureLine,
  playerLayout,
  playerName,
  spaceText,
  terrainWords,
  type MapStatsLine,
  type MovedOutcome,
  type PushDescription,
  type StoppedOutcome,
} from '../mapText';
import { battleMapsMode } from '../modes';
import { toolActivity, type ToolInput } from './definitions';
import {
  fail,
  logTool,
  MAPS_OFF,
  mutateCharacter,
  mutateCombat,
  NO_COMBAT,
  NO_MAP,
  ok,
  requireCampaign,
  ToolInputError,
  type ToolContext,
  type ToolOutcome,
} from './context';

// ---------------------------------------------------------------------------
// Resolving map input (shared with the combat tools)
// ---------------------------------------------------------------------------

type MapSpecInput = NonNullable<ToolInput<'start_combat'>['map']>;
type AreaInput = Pick<
  ToolInput<'resolve_area'>,
  'shape' | 'size_ft' | 'width_ft' | 'height_ft' | 'at' | 'from' | 'toward' | 'squares' | 'include_origin'
>;

/** Text that is meant as a square ("E5", " e 5 "), as opposed to a name. */
function looksLikeSquare(text: string): boolean {
  return /^\s*[a-z]{1,3}\s*\d{1,3}\s*$/i.test(text);
}

function dimsOf(map: Pick<BattleMap, 'width' | 'height'>): MapDims {
  return { width: map.width, height: map.height };
}

/** Squares and ranges ("A1:P1, F5") on the map, or a ToolInputError naming the problem. */
export function parseRects(text: string, dims: MapDims, where: string): GridRect[] {
  const parsed = parseSquareList(text, dims);
  if (!parsed.ok) throw new ToolInputError(`${where}: ${parsed.problem}`);
  return parsed.value;
}

function parseOneSquare(text: string, dims: MapDims, where: string): GridPoint {
  const parsed = parseSquare(text, dims);
  if (!parsed.ok) throw new ToolInputError(`${where}: ${parsed.problem}`);
  return parsed.value;
}

/** A map spec (start_combat `map`, update_map `create`) parsed and checked; the map itself comes from createBattleMap. */
export function parseMapSpec(spec: MapSpecInput, tool: string): BattleMapInput {
  const dims = { width: spec.width, height: spec.height };
  const terrain = (spec.terrain ?? []).map((t, i): Omit<TerrainFeature, 'id'> => {
    const where = `${tool}: terrain ${i + 1} (${t.label ?? t.kind})`;
    if (t.door && t.kind !== 'door') throw new ToolInputError(`${where}: \`door\` goes only with kind "door".`);
    const rects = parseRects(t.squares, dims, where);
    return { kind: t.kind, rects, ...(t.label ? { label: t.label } : {}), ...(t.kind === 'door' ? { door: t.door ?? 'closed' } : {}) };
  });
  const seen = new Set<string>();
  const places = (spec.places ?? []).map((p, i) => {
    const key = p.name.trim().toLowerCase().replace(/^the\s+/, '');
    if (seen.has(key)) throw new ToolInputError(`${tool}: the place "${p.name}" is named twice.`);
    seen.add(key);
    return { name: p.name, rects: parseRects(p.squares, dims, `${tool}: place ${i + 1} (${p.name})`) };
  });
  return { ...(spec.name ? { name: spec.name } : {}), width: spec.width, height: spec.height, terrain, places };
}

function placeNames(map: BattleMap): string {
  return map.places.map((p) => p.name).join(', ') || 'none';
}

/**
 * Where a creature or group starts: a place, a square (a group spreads out from it), or one square per creature
 * ("E5, F5" or a range "E5:G5"). A malformed or off-map square, an unknown place or more squares than creatures is
 * a ToolInputError.
 */
export function parsePosition(text: string, map: BattleMap, count: number, where: string): PlacementAnchor {
  const place = findPlace(map, text);
  if (place) return { kind: 'place', placeId: place.id };
  if (looksLikeSquare(text)) return { kind: 'square', at: parseOneSquare(text, dimsOf(map), where) };
  const list = parseSquareList(text, dimsOf(map));
  if (!list.ok) {
    // Meant as squares ("E5, Q13"): say what is wrong with them; otherwise it was meant as a place.
    if (/^\s*[a-z]{1,3}\s*\d/i.test(text)) throw new ToolInputError(`${where}: ${list.problem}`);
    throw new ToolInputError(
      `${where}: "${text}" isn't a square ("E5"), one square per creature ("E5, F5") or a place on the map (places: ${placeNames(map)}).`,
    );
  }
  const squares = list.value.flatMap(rectSquares);
  if (squares.length > count) {
    throw new ToolInputError(
      `${where}: ${squares.length} squares for ${count === 1 ? 'one creature' : `${count} creatures`}. Give one square per creature, or one square for the whole group to spread out from.`,
    );
  }
  return squares.length === 1 ? { kind: 'square', at: squares[0] } : { kind: 'squares', at: squares };
}

/** The creatures and places a "who" or "to" could have meant (hidden creatures included: only the DM reads it). */
function namesOnMap(state: CombatState): string {
  return state.combatants.map((c) => dmName(state, c.id)).join(', ');
}

/** A creature by id, name, unique partial name, or "hero" / "the hero" / "you"; else a ToolInputError listing names. */
export function resolveWho(state: CombatState, who: string, where: string): Combatant {
  const c = findMapCombatant(state, who);
  if (!c) throw new ToolInputError(`${where}: no creature called "${who}" in this fight. Creatures: ${namesOnMap(state)}.`);
  return c;
}

/** A move's `to`: a square, a place or a creature. */
function resolveMoveTarget(state: CombatState, text: string, where: string): MoveTarget {
  const map = state.map as BattleMap;
  if (looksLikeSquare(text)) return { kind: 'square', at: parseOneSquare(text, dimsOf(map), where) };
  const place = findPlace(map, text);
  if (place) return { kind: 'place', placeId: place.id };
  const c = findMapCombatant(state, text);
  if (c) return { kind: 'creature', id: c.id };
  throw new ToolInputError(
    `${where}: "${text}" isn't a square, a creature or a place on this map. Creatures: ${namesOnMap(state)}. Places: ${placeNames(map)}.`,
  );
}

/** A map reference: a square ("G4"), a grid corner ("G4/H5"), a creature, or (when allowed) a compass direction. */
function resolveRef(state: CombatState, text: string, where: string, opts: { direction?: boolean } = {}): MapRef {
  const map = state.map as BattleMap;
  if (text.includes('/') || text.includes('\\')) {
    const corner = parseCorner(text, dimsOf(map));
    if (!corner.ok) throw new ToolInputError(`${where}: ${corner.problem}`);
    return { kind: 'corner', x: corner.value.x, y: corner.value.y };
  }
  if (looksLikeSquare(text)) return { kind: 'square', at: parseOneSquare(text, dimsOf(map), where) };
  if (opts.direction) {
    const dir = parseDirection(text);
    if (dir) return { kind: 'direction', dir };
  }
  const c = findMapCombatant(state, text);
  if (c) return { kind: 'creature', id: c.id };
  const choices = opts.direction ? 'a square, a corner ("G4/H5"), a creature or a direction ("north-east")' : 'a square, a corner ("G4/H5") or a creature';
  throw new ToolInputError(`${where}: "${text}" isn't ${choices} on this map. Creatures: ${namesOnMap(state)}.`);
}

/** The text form of a reference for results: "G4", "G4/H5", a creature's name, "north-east". */
function refName(state: CombatState, ref: MapRef): string {
  if (ref.kind === 'square') return squareLabel(ref.at);
  if (ref.kind === 'corner') return `${squareLabel({ x: ref.x - 1, y: ref.y - 1 })}/${squareLabel({ x: ref.x, y: ref.y })}`;
  if (ref.kind === 'creature') return dmName(state, ref.id);
  return ref.dir;
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

type MapCheck = { ok: true; state: CombatState } | { ok: false; outcome: ToolOutcome };

/** The active combat with a battle map, or the fail() outcome to return. */
function mappedCombat(ctx: ToolContext): MapCheck {
  const state = ctx.deps.store().combat;
  if (!state?.active) return { ok: false, outcome: fail(NO_COMBAT) };
  if (!state.map) return { ok: false, outcome: fail(NO_MAP) };
  return { ok: true, state };
}

// ---------------------------------------------------------------------------
// The player-facing log line of a move (visible movers only)
// ---------------------------------------------------------------------------

/** "Bandit 1 moves to C5", "you stand and move to A7", "Bandit 1 breaks away from you and Old Tam"; null when nothing to show. */
function movePhrase(before: CombatState, after: CombatState, outcome: MoveOutcome, pulled: boolean): string | null {
  if (outcome.status === 'refused') return null;
  const who = playerName(after, outcome.moverId);
  if (!who) return null;
  const you = who === 'you';
  const at = squareLabel(outcome.status === 'stopped' ? outcome.at : outcome.to);
  const moved = outcome.path.length > 0 || (outcome.kind === 'teleport' || outcome.kind === 'place' ? !samePlace(before, after, outcome.moverId) : false);
  const stood = outcome.notes.some((n) => n.kind === 'stood-up');
  if (outcome.status === 'stopped') {
    const declined = new Set(after.map?.stop?.declinedIds ?? []);
    const seen = outcome.reactors
      .filter((r) => !r.hidden && !declined.has(r.reactorId))
      .map((r) => playerName(after, r.reactorId))
      .filter((n): n is string => n !== null);
    if (seen.length) return `${capital(who)} ${you ? 'break' : 'breaks'} away from ${listAnd(youLast(seen))}`;
  }
  switch (outcome.kind) {
    case 'forced':
      return moved ? `${capital(who)} ${you ? 'are' : 'is'} ${pulled ? 'pulled' : 'pushed'} to ${at}` : null;
    case 'teleport':
      return moved ? `${capital(who)} ${you ? 'teleport' : 'teleports'} to ${at}` : null;
    case 'place':
      return moved ? `${capital(who)} ${you ? 'are' : 'is'} now at ${at}` : null;
    default:
      if (moved) return `${capital(who)} ${stood ? (you ? 'stand and move' : 'stands and moves') : you ? 'move' : 'moves'} to ${at}`;
      return stood ? `${capital(who)} ${you ? 'stand' : 'stands'} up` : null;
  }
}

function samePlace(before: CombatState, after: CombatState, id: string): boolean {
  const a = before.combatants.find((c) => c.id === id)?.position;
  const b = after.combatants.find((c) => c.id === id)?.position;
  return !!a && !!b && a.x === b.x && a.y === b.y;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "you" reads best at the end of a list: "Bandit 1 and you". */
function youLast(names: readonly string[]): string[] {
  return [...names.filter((n) => n !== 'you'), ...names.filter((n) => n === 'you')];
}

// ---------------------------------------------------------------------------
// move_tokens (spec §4.7)
// ---------------------------------------------------------------------------

type MoveInput = NonNullable<ToolInput<'move_tokens'>['moves']>[number];

interface PreparedMove {
  req: MoveRequest;
  /** What `to` named, as written ("A7", "Mira Voss", "the balcony"). */
  target: string | null;
  push: PushDescription | null;
}

function pushDirection(state: CombatState, hero: Character | null, mover: Combatant, ref: MapRef, toward: boolean): CompassDirection | null {
  if (!mover.position) return null;
  const r = footprint(mover.position, combatantSize(mover, hero));
  const cx = r.x0 + r.x1 + 1;
  const cy = r.y0 + r.y1 + 1;
  let sx: number;
  let sy: number;
  if (ref.kind === 'square') [sx, sy] = [2 * ref.at.x + 1, 2 * ref.at.y + 1];
  else if (ref.kind === 'corner') [sx, sy] = [2 * ref.x, 2 * ref.y];
  else if (ref.kind === 'creature') {
    const c = state.combatants.find((x) => x.id === ref.id);
    if (!c?.position) return null;
    const s = footprint(c.position, combatantSize(c, hero));
    [sx, sy] = [s.x0 + s.x1 + 1, s.y0 + s.y1 + 1];
  } else return ref.dir;
  const vx = toward ? sx - cx : cx - sx;
  const vy = toward ? sy - cy : cy - sy;
  return vx === 0 && vy === 0 ? null : snapDirection(vx, vy);
}

/** Check one move's fields (spec §4.2 handler checks) and resolve every name and square in it. */
function prepareMove(state: CombatState, hero: Character | null, m: MoveInput, index: number): PreparedMove {
  const where = `move_tokens: moves[${index}] (${m.who})`;
  const mover = resolveWho(state, m.who, where);
  const kind = m.kind ?? 'move';
  if (kind === 'forced') {
    if ((m.to === undefined) === (m.push === undefined)) throw new ToolInputError(`${where}: kind "forced" takes exactly one of \`to\` (a square) or \`push\`.`);
    if (m.push) {
      const given = [m.push.away_from, m.push.toward, m.push.direction].filter((x) => x !== undefined).length;
      if (given !== 1) throw new ToolInputError(`${where}: \`push\` takes exactly one of away_from, toward or direction.`);
    }
  } else if (m.to === undefined) {
    throw new ToolInputError(`${where}: kind "${kind}" needs \`to\` (a square, a creature or a place).`);
  }
  if (m.push && kind !== 'forced') throw new ToolInputError(`${where}: \`push\` goes only with kind "forced".`);
  if (m.budget_ft !== undefined && kind !== 'off-turn') throw new ToolInputError(`${where}: budget_ft goes only with kind "off-turn".`);
  if (m.max_ft !== undefined && kind !== 'teleport') throw new ToolInputError(`${where}: max_ft goes only with kind "teleport".`);
  if (m.spend_ft !== undefined && kind !== 'place') throw new ToolInputError(`${where}: spend_ft goes only with kind "place".`);
  const declinedIds = (m.declined ?? []).map((name) => {
    const c = resolveWho(state, name, `${where} declined`);
    if (c.isPlayer) {
      throw new ToolInputError(`${where}: "declined" can't name the hero — the app asks the player itself when the hero gets an Opportunity Attack.`);
    }
    return c.id;
  });
  const map = state.map as BattleMap;
  const req: MoveRequest = { moverId: mover.id, kind, by: 'dm' };
  let target: string | null = null;
  if (m.to !== undefined) {
    const to = resolveMoveTarget(state, m.to, where);
    if (kind === 'forced' && to.kind !== 'square') throw new ToolInputError(`${where}: a forced move's \`to\` must be a square (or use \`push\`).`);
    req.to = to;
    target = to.kind === 'square' ? squareLabel(to.at) : to.kind === 'creature' ? dmName(state, to.id) : (map.places.find((p) => p.id === to.placeId)?.name ?? m.to);
  }
  if (m.via) req.via = m.via.split(/[,;]/).map((s) => s.trim()).filter(Boolean).map((s) => parseOneSquare(s, dimsOf(map), `${where} via`));
  if (m.partial) req.partial = true;
  if (m.prefer) req.prefer = m.prefer;
  if (m.mode) req.mode = m.mode;
  if (m.elevation_ft !== undefined) req.elevationFt = m.elevation_ft;
  if (m.dash) req.dash = true;
  if (m.dash_again) req.dashAgain = true;
  if (m.disengage) req.disengage = true;
  if (m.stay_prone) req.stayProne = true;
  if (m.budget_ft !== undefined) req.budgetFt = m.budget_ft;
  if (m.max_ft !== undefined) req.maxFt = m.max_ft;
  if (m.spend_ft !== undefined) req.spendFt = m.spend_ft;
  if (declinedIds.length) req.declinedIds = declinedIds;
  let push: PushDescription | null = null;
  if (m.push) {
    const toward = m.push.toward !== undefined;
    const sourceText = m.push.away_from ?? m.push.toward;
    const ref = sourceText !== undefined ? resolveRef(state, sourceText, `${where} push`) : null;
    req.push = {
      distanceFt: m.push.distance_ft,
      ...(m.push.direction ? { direction: m.push.direction } : {}),
      ...(ref && !toward ? { awayFrom: ref } : {}),
      ...(ref && toward ? { toward: ref } : {}),
    };
    push = {
      wantedFt: m.push.distance_ft,
      dir: m.push.direction ?? (ref ? pushDirection(state, hero, mover, ref, toward) : null),
      source: ref ? refName(state, ref) : null,
      toward,
    };
  }
  return { req, target, push };
}

/**
 * The hero gets an Opportunity Attack against a DM-made move (D32): ask the player with the confirm dialog. Closing
 * it counts as "Let it go"; stopping the DM throws DmCancelledError.
 */
async function askOpportunityAttack(ctx: ToolContext, mover: Combatant, at: GridPoint): Promise<boolean> {
  const store = ctx.deps.store();
  ctx.status('Waiting for your answer: Opportunity Attack…', 'waiting-player');
  try {
    const response = await store.requestInteraction({
      kind: 'confirm',
      id: ctx.deps.newId(),
      title: 'Opportunity Attack',
      body: `${mover.name} is leaving your reach (from ${squareLabel(at)}). Use your Reaction to make one melee attack against it?`,
      confirmLabel: 'Attack',
      cancelLabel: 'Let it go',
    });
    if (ctx.signal.aborted) throw new DmCancelledError();
    return response.kind === 'confirm' && response.confirmed;
  } catch (err) {
    if (ctx.signal.aborted || err instanceof DmCancelledError) throw new DmCancelledError();
    return false;
  } finally {
    ctx.status(toolActivity('move_tokens'), 'tool');
  }
}

function markReactions(state: CombatState, ids: readonly string[]): CombatState {
  if (!ids.length) return state;
  return { ...state, combatants: state.combatants.map((c) => (ids.includes(c.id) && !c.reactionUsed ? { ...c, reactionUsed: true } : c)) };
}

interface MoveRun {
  line: string;
  log: string | null;
  /** The mover whose Opportunity Attack stop ends the batch. */
  stoppedBy: string | null;
}

function describeOutcome(n: number, before: CombatState, after: CombatState, hero: Character | null, prepared: PreparedMove, outcome: MoveOutcome, heroTakes: boolean): string {
  if (outcome.status === 'refused') return describeRefusal(n, before, hero, outcome.moverId, outcome.refusal, prepared.target);
  if (outcome.status === 'stopped') return describeStop(n, after, hero, outcome as StoppedOutcome, { heroTakes });
  const moved = outcome as MovedOutcome;
  switch (moved.kind) {
    case 'forced':
      return describeForced(n, after, hero, moved, prepared.push ?? { wantedFt: 5 * moved.path.length, dir: null, source: null, toward: false });
    case 'teleport':
      return describeTeleport(n, before, after, hero, moved);
    case 'place':
      return describePlace(n, before, after, hero, moved);
    default:
      return describeWillingMove(n, after, hero, moved, prepared.req.declinedIds ?? []);
  }
}

/** Plan, ask the player if the hero may react, write, describe. */
async function runMove(ctx: ToolContext, n: number, prepared: PreparedMove): Promise<MoveRun> {
  const store = ctx.deps.store();
  const latest = store.combat as CombatState;
  const hero = store.character;
  const plan = planMove(latest, hero, prepared.req);
  if (plan.status === 'refused') {
    return { line: describeRefusal(n, latest, hero, plan.moverId, plan.refusal, prepared.target), log: null, stoppedBy: null };
  }
  let req = prepared.req;
  let heroTakes = false;
  const heroReactor = plan.status === 'stopped' ? plan.reactors.find((r) => r.isHero && !(req.declinedIds ?? []).includes(r.reactorId)) : undefined;
  if (heroReactor) {
    const mover = latest.combatants.find((c) => c.id === plan.moverId) as Combatant;
    heroTakes = await askOpportunityAttack(ctx, mover, heroReactor.at);
    if (!heroTakes) req = { ...req, declinedIds: [...(req.declinedIds ?? []), heroReactor.reactorId] };
  }
  // The hero stands up: the sheet loses Prone first (D49 ordering); the move is still charged as a stand (old sheet).
  if (plan.heroStoodUp && hero) await mutateCharacter(ctx, (c) => removeCondition(c, 'prone'));
  const before = store.combat as CombatState;
  const { outcome, state: after } = await mutateCombat(ctx, (c) => {
    const out = applyMove(c, hero, req);
    if (out.status === 'refused') return { outcome: out, state: c };
    // "Attack": the hero's Reaction is spent in the same write, after the move (before it, the move wouldn't stop).
    const state = heroTakes && heroReactor ? markReactions(out.state, [heroReactor.reactorId]) : out.state;
    return { outcome: { ...out, state } as MoveOutcome, state };
  });
  const heroNow = ctx.deps.store().character;
  const line = describeOutcome(n, before, after, heroNow, { ...prepared, req }, outcome, heroTakes);
  return { line, log: movePhrase(before, after, outcome, prepared.push?.toward ?? false), stoppedBy: outcome.status === 'stopped' ? outcome.moverId : null };
}

export async function moveTokensTool(input: ToolInput<'move_tokens'>, ctx: ToolContext): Promise<ToolOutcome> {
  const check = mappedCombat(ctx);
  if (!check.ok) return check.outcome;
  const state = check.state;
  const hero = ctx.deps.store().character;
  const moves = input.moves ?? [];
  if (!moves.length && !input.reactions_used?.length) throw new ToolInputError('move_tokens needs `moves`, `reactions_used`, or both.');
  const prepared = moves.map((m, i) => prepareMove(state, hero, m, i));
  const seen = new Set<string>();
  for (const p of prepared) {
    if (seen.has(p.req.moverId)) {
      throw new ToolInputError(`move_tokens: ${dmName(state, p.req.moverId)} appears twice in one batch. Give each creature one move per call (use \`via\` for a winding route).`);
    }
    seen.add(p.req.moverId);
  }
  const reactionIds = (input.reactions_used ?? []).map((who) => resolveWho(state, who, 'move_tokens: reactions_used').id);

  const lines: string[] = [];
  if (reactionIds.length) {
    await mutateCombat(ctx, (c) => ({ state: markReactions(c, reactionIds) }));
    lines.push(`Reactions used: ${listAnd(reactionIds.map((id) => dmName(state, id)))} (until each one's next turn starts).`);
  }
  const logParts: string[] = [];
  let stoppedBy: string | null = null;
  for (const [i, p] of prepared.entries()) {
    if (stoppedBy) {
      lines.push(describeNotRun(i + 1, ctx.deps.store().combat as CombatState, stoppedBy));
      continue;
    }
    const run = await runMove(ctx, i + 1, p);
    lines.push(run.line);
    if (run.log) logParts.push(run.log);
    stoppedBy = run.stoppedBy;
  }
  if (logParts.length) await logTool(ctx, 'move_tokens', 'move', logParts.join(' · '));
  return ok(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// update_map (spec §4.8)
// ---------------------------------------------------------------------------

type UpdateMapInput = ToolInput<'update_map'>;

function anyField(input: UpdateMapInput): boolean {
  return Object.values(input).some((v) => v !== undefined && v !== false);
}

/** Stats lines for every creature on a new map (the hero's are read live from the sheet, so it is left out). */
function storedStats(state: CombatState): MapStatsLine[] {
  return state.combatants
    .filter((c) => !c.isPlayer && !c.defeated)
    .map((c) => ({
      label: dmName(state, c.id),
      size: c.size ?? 'Medium',
      speeds: c.speeds ?? { walk: 30 },
      reachFt: c.reachFt ?? 5,
      ...(c.size || c.speeds || c.reachFt ? {} : { source: 'defaults' }),
    }));
}

async function createMapTool(input: UpdateMapInput, ctx: ToolContext, state: CombatState): Promise<ToolOutcome> {
  const create = input.create as MapSpecInput;
  const hero = ctx.deps.store().character;
  const mapInput = parseMapSpec(create, 'update_map');
  // Positions are parsed against the new map (its places) before anything is written.
  const draft = createBattleMap(mapInput, input.replace && state.map ? state.map : undefined);
  const explicit = (input.positions ?? []).map((p, i) => {
    const c = resolveWho(state, p.who, `update_map: positions[${i}]`);
    const anchor = parsePosition(p.at, draft, 1, `update_map: positions[${i}] (${p.who})`);
    return { id: c.id, anchor, isPlayer: c.isPlayer };
  });
  const replacing = Boolean(input.replace && state.map);
  const { placed, state: after } = await mutateCombat(ctx, (c) => {
    const map = createBattleMap(mapInput, replacing && c.map ? c.map : undefined);
    const fresh: CombatState = { ...removeBattleMap(c), map };
    return placeCombatants(fresh, hero, placementOrder(fresh, explicit));
  });
  const text = describeMapSetup(after, hero, { placed, stats: storedStats(after) });
  const map = after.map as BattleMap;
  await logTool(ctx, 'update_map', 'map', `Battle map${map.name ? `: ${map.name}` : ''} (${map.width}×${map.height})`, { detail: playerLayout(after, hero) });
  return ok(replacing ? `${text}\nThe previous map was removed; movement spent this turn carries over.` : text);
}

/** "Bandit 2" → "Bandit": creatures of one group share it. */
function groupKey(c: Combatant): string {
  return `${c.side}:${c.name.replace(/\s+\d+$/, '').trim().toLowerCase()}`;
}

/**
 * Who is placed in what order on a new map: the hero first (so no enemy is auto-placed next to the hero), then the
 * positions the DM gave, then everyone else automatically, a group at a time (members keep together).
 */
function placementOrder(state: CombatState, explicit: readonly { id: string; anchor: PlacementAnchor; isPlayer: boolean }[]): PlacementRequest[] {
  const heroC = state.combatants.find((c) => c.isPlayer);
  const heroGiven = explicit.find((e) => e.isPlayer);
  const requests: PlacementRequest[] = [];
  if (heroC) requests.push({ ids: [heroC.id], anchor: heroGiven?.anchor ?? { kind: 'auto' } });
  for (const e of explicit) if (!e.isPlayer) requests.push({ ids: [e.id], anchor: e.anchor });
  const named = new Set(explicit.map((e) => e.id));
  const groups = new Map<string, string[]>();
  for (const c of state.combatants) {
    if (c.isPlayer || c.defeated || named.has(c.id)) continue;
    const key = groupKey(c);
    groups.set(key, [...(groups.get(key) ?? []), c.id]);
  }
  for (const ids of groups.values()) requests.push({ ids, anchor: { kind: 'auto' } });
  return requests;
}

async function removeMapTool(ctx: ToolContext): Promise<ToolOutcome> {
  await mutateCombat(ctx, (c) => ({ state: removeBattleMap(c) }));
  await logTool(ctx, 'update_map', 'map', 'The battle map is put away');
  return ok('Battle map removed: the fight continues in the theater of the mind (positions are gone; hidden creatures stay hidden).');
}

/** update_map's edits as an engine MapEdit (every square, door, place and name resolved first). */
function parseEdit(input: UpdateMapInput, state: CombatState): MapEdit {
  const map = state.map as BattleMap;
  const dims = dimsOf(map);
  const edit: MapEdit = {};
  if (input.terrain_add) {
    edit.terrainAdd = input.terrain_add.map((t, i) => {
      const where = `update_map: terrain_add[${i}] (${t.label ?? t.kind})`;
      if (t.door && t.kind !== 'door') throw new ToolInputError(`${where}: \`door\` goes only with kind "door".`);
      return { kind: t.kind, rects: parseRects(t.squares, dims, where), ...(t.label ? { label: t.label } : {}), ...(t.kind === 'door' ? { door: t.door ?? 'closed' } : {}) };
    });
  }
  if (input.terrain_clear) {
    edit.terrainClear = input.terrain_clear.map((text, i) => {
      const parsed = parseSquareList(text, dims);
      if (parsed.ok) return { rects: parsed.value };
      if (map.terrain.some((f) => f.label && f.label.trim().toLowerCase() === text.trim().toLowerCase())) return { label: text };
      const labels = [...new Set(map.terrain.map((f) => f.label).filter((l): l is string => Boolean(l)))];
      throw new ToolInputError(`update_map: terrain_clear[${i}] "${text}" is neither squares (${parsed.problem}) nor a terrain label on this map (labels: ${labels.join(', ') || 'none'}).`);
    });
  }
  if (input.doors) {
    edit.doors = input.doors.map((d, i) => ({
      at: looksLikeSquare(d.at) ? parseOneSquare(d.at, dims, `update_map: doors[${i}]`) : { label: d.at },
      state: d.state,
    }));
  }
  if (input.places_add) {
    edit.placesAdd = input.places_add.map((p, i) => ({ name: p.name, rects: parseRects(p.squares, dims, `update_map: places_add[${i}] (${p.name})`) }));
  }
  if (input.places_remove) edit.placesRemove = input.places_remove;
  if (input.creatures) {
    edit.creatures = input.creatures.map((c, i) => {
      const who = resolveWho(state, c.who, `update_map: creatures[${i}]`);
      return {
        id: who.id,
        ...(c.size ? { size: c.size } : {}),
        ...(c.speeds ? { speeds: c.speeds } : {}),
        ...(c.reach_ft !== undefined ? { reachFt: c.reach_ft } : {}),
        ...(c.speed_change_ft !== undefined ? { speedChangeFt: c.speed_change_ft } : {}),
      };
    });
  }
  if (input.effects_end) edit.effectsEnd = input.effects_end;
  return edit;
}

/** The words of each terrain_clear item, from the map before the edit (the engine's change carries no squares). */
function clearedWords(map: BattleMap, edit: MapEdit): string[] {
  return (edit.terrainClear ?? []).map((clear) => {
    if ('label' in clear) {
      const hit = map.terrain.filter((f) => f.label && f.label.trim().toLowerCase() === clear.label.trim().toLowerCase());
      return `cleared the ${hit[0]?.label ?? clear.label} (${rectsLabel(hit.flatMap((f) => f.rects))})`;
    }
    const labels = [...new Set(map.terrain.filter((f) => f.label && f.rects.some((r) => clear.rects.some((c) => r.x0 <= c.x1 && c.x0 <= r.x1 && r.y0 <= c.y1 && c.y0 <= r.y1))).map((f) => f.label as string))];
    return `cleared ${rectsLabel(clear.rects)}${labels.length ? ` (${labels.join(', ')})` : ''}`;
  });
}

/** The player's log phrases for an edit; hidden creatures' changes are left out. */
function editLogPhrases(after: CombatState, changes: readonly MapChange[]): string[] {
  const out: string[] = [];
  for (const ch of changes) {
    switch (ch.kind) {
      case 'door': {
        const name = ch.label ? `The ${ch.label}` : `The door at ${squareLabel(ch.at)}`;
        out.push(`${name} ${ch.state === 'open' ? 'opens' : ch.state === 'closed' ? 'closes' : 'is locked'}`);
        break;
      }
      case 'terrain-added':
        out.push(`The map changes: ${ch.feature.label ?? terrainWords(ch.feature.kind)} at ${rectsLabel(ch.feature.rects)}`);
        break;
      case 'terrain-cleared':
        out.push(`The map changes: ${ch.labels.length ? listAnd(ch.labels) : `${ch.squares} square${ch.squares === 1 ? '' : 's'}`} cleared`);
        break;
      case 'place-added':
        out.push(`New place on the map: ${ch.name}`);
        break;
      case 'place-removed':
        break;
      case 'creature': {
        const who = playerName(after, ch.id);
        if (!who) break;
        const you = who === 'you';
        if (ch.patch.size) out.push(`${capital(who)} ${you ? 'are' : 'is'} now ${ch.patch.size}`);
        if (ch.patch.speeds || ch.patch.speedChangeFt !== undefined) out.push(`${capital(who)}${you ? 'r' : "'s"} speed changes`);
        if (ch.patch.reachFt !== undefined) out.push(`${capital(who)}${you ? 'r' : "'s"} reach is now ${ch.patch.reachFt} ft`);
        break;
      }
      case 'effect-ended':
        out.push(`${ch.label} ends`);
        break;
    }
  }
  return out;
}

async function editMapTool(input: UpdateMapInput, ctx: ToolContext, state: CombatState): Promise<ToolOutcome> {
  const hero = ctx.deps.store().character;
  const edit = parseEdit(input, state);
  let cleared: string[] = [];
  const { changes, state: after } = await mutateCombat(ctx, (c) => {
    cleared = clearedWords(c.map as BattleMap, edit);
    const r = editMap(c, hero, edit);
    if (!r.ok) throw new ToolInputError(`update_map: ${r.problem.replace(/\.$/, '')}. Nothing was changed.`);
    return { state: r.state, changes: r.changes };
  });
  const phrases = editLogPhrases(after, changes);
  if (phrases.length) await logTool(ctx, 'update_map', 'map', phrases.join(' · '));
  return ok(describeMapChanges(after, hero, changes, cleared));
}

export async function updateMapTool(input: UpdateMapInput, ctx: ToolContext): Promise<ToolOutcome> {
  const store = ctx.deps.store();
  const state = store.combat;
  if (!state?.active) return fail(NO_COMBAT);
  if (!anyField(input)) throw new ToolInputError('update_map needs something to do: create, remove, or an edit (terrain_add, terrain_clear, doors, places_add, places_remove, creatures, effects_end).');
  if ((input.replace || input.positions) && !input.create) throw new ToolInputError('update_map: replace and positions go only with create.');
  if (input.remove) {
    const others = Object.entries(input).filter(([k, v]) => k !== 'remove' && v !== undefined);
    if (others.length) throw new ToolInputError(`update_map: remove goes alone (drop ${others.map(([k]) => k).join(', ')}).`);
  }
  if (input.create) {
    const edits = ['terrain_add', 'terrain_clear', 'doors', 'places_add', 'places_remove', 'creatures', 'effects_end'] as const;
    const mixed = edits.filter((k) => input[k] !== undefined);
    if (mixed.length) throw new ToolInputError(`update_map: create takes the whole new map; put ${mixed.join(', ')} in its terrain and places instead, or edit in a second call.`);
    if (battleMapsMode(requireCampaign(store).settings) === 'off') return fail(MAPS_OFF);
    if (state.map && !input.replace) throw new ToolInputError('update_map: there is already a battle map; give replace: true to swap it for a new one.');
    return createMapTool(input, ctx, state);
  }
  if (!state.map) return fail(NO_MAP);
  if (input.remove) return removeMapTool(ctx);
  return editMapTool(input, ctx, state);
}

// ---------------------------------------------------------------------------
// Areas: resolve_area and check_map's preview (spec §4.9)
// ---------------------------------------------------------------------------

const AREA_NEEDS: Record<AreaInput['shape'], string> = {
  sphere: 'a sphere needs "size_ft" (its radius) and "at" (its centre: a square, a corner "G4/H5" or a creature).',
  cylinder: 'a cylinder needs "size_ft" (its radius) and "at" (the centre of its base: a square, a corner or a creature).',
  cone: 'a cone needs "size_ft", "from" (who breathes or casts it) and "toward" (a square, a creature or a direction).',
  line: 'a line needs "size_ft", "from" (who makes it) — or "at", the square it starts in — and "toward" (a square, a creature or a direction).',
  cube: 'a cube needs "size_ft" and either "from" + "toward" (a cube coming out of a creature) or "at" (its centre).',
  emanation: 'an emanation needs "size_ft" and "from" (the creature it surrounds).',
  squares: 'shape "squares" needs "squares" ("G7:J10").',
};

/** Check an area's fields for its shape (spec §4.2) and resolve every reference: the engine AreaSpec. */
export function parseAreaSpec(state: CombatState, input: AreaInput, tool: string): AreaSpec {
  const shape = input.shape;
  const has = (v: unknown) => v !== undefined;
  const needs = (): never => {
    throw new ToolInputError(`${tool}: ${AREA_NEEDS[shape]}`);
  };
  const sized = has(input.size_ft);
  switch (shape) {
    case 'sphere':
    case 'cylinder':
      if (!sized || !has(input.at)) needs();
      break;
    case 'cone':
    case 'line':
      if (!sized || !has(input.toward) || !(has(input.from) || has(input.at))) needs();
      break;
    case 'cube':
      if (!sized || !((has(input.from) && has(input.toward)) || has(input.at))) needs();
      break;
    case 'emanation':
      if (!sized || !has(input.from)) needs();
      break;
    case 'squares':
      if (!has(input.squares)) needs();
      break;
  }
  const map = state.map as BattleMap;
  const spec: AreaSpec = { shape };
  if (input.size_ft !== undefined && shape !== 'squares') spec.sizeFt = input.size_ft;
  if (input.width_ft !== undefined) spec.widthFt = input.width_ft;
  if (input.height_ft !== undefined) spec.heightFt = input.height_ft;
  if (input.from !== undefined) spec.fromId = resolveWho(state, input.from, `${tool}: from`).id;
  if (input.at !== undefined) spec.at = resolveRef(state, input.at, `${tool}: at`);
  if (input.toward !== undefined) spec.toward = resolveRef(state, input.toward, `${tool}: toward`, { direction: true });
  if (input.squares !== undefined && shape === 'squares') spec.rects = parseRects(input.squares, dimsOf(map), `${tool}: squares`);
  if (input.include_origin) spec.includeOrigin = true;
  return spec;
}

/** "Fireball: Bandit 1 and you are caught" · "Burning Hands: nobody you can see is caught". */
function areaLogLine(state: CombatState, label: string, insideIds: readonly string[]): string {
  const names = youLast(insideIds.map((id) => playerName(state, id)).filter((n): n is string => n !== null));
  if (!names.length) return `${label}: nobody you can see is caught`;
  const verb = names.length === 1 && names[0] !== 'you' ? 'is' : 'are';
  return `${label}: ${listAnd(names)} ${verb} caught`;
}

export async function resolveAreaTool(input: ToolInput<'resolve_area'>, ctx: ToolContext): Promise<ToolOutcome> {
  const check = mappedCombat(ctx);
  if (!check.ok) return check.outcome;
  const state = check.state;
  const hero = ctx.deps.store().character;
  if (input.terrain?.length && !input.lasting) throw new ToolInputError('resolve_area: `terrain` goes only with lasting: true (an area shown for one turn changes no squares).');
  const spec = parseAreaSpec(state, input, 'resolve_area');
  if (input.elevation_ft !== undefined) spec.elevationFt = input.elevation_ft;
  const lasting = input.lasting === true;
  const terrain = input.terrain ?? [];
  const { result, state: after } = await mutateCombat(ctx, (c) => {
    const r = addAreaEffect(c, hero, spec, { label: input.label, lasting, terrain: [...terrain], ...(input.range_ft !== undefined ? { rangeFt: input.range_ft } : {}) });
    if (!r.ok) throw new ToolInputError(r.problem);
    return r;
  });
  await logTool(ctx, 'resolve_area', 'area', areaLogLine(after, input.label, result.inside.map((h) => h.id)));
  return ok(describeArea(after, hero, spec, result, { label: input.label, lasting, terrain }));
}

// ---------------------------------------------------------------------------
// check_map (spec §4.10): read-only, never logged
// ---------------------------------------------------------------------------

type Point = { kind: 'creature'; c: Combatant } | { kind: 'square'; at: GridPoint };

function resolvePoint(state: CombatState, text: string, where: string): Point {
  const map = state.map as BattleMap;
  if (looksLikeSquare(text)) return { kind: 'square', at: parseOneSquare(text, dimsOf(map), where) };
  return { kind: 'creature', c: resolveWho(state, text, where) };
}

function pointRect(p: Point, hero: Character | null): GridRect | null {
  if (p.kind === 'square') return { x0: p.at.x, y0: p.at.y, x1: p.at.x, y1: p.at.y };
  return p.c.position ? footprint(p.c.position, combatantSize(p.c, hero)) : null;
}

function pointName(state: CombatState, p: Point, hero: Character | null): string {
  if (p.kind === 'square') return squareLabel(p.at);
  return `${dmName(state, p.c.id)} (${spaceText(p.c, hero) ?? 'not on the map'})`;
}

/** Distance and sight when a square is involved (no cover or reach for an empty square). */
function squareMeasure(state: CombatState, hero: Character | null, a: Point, b: Point): string {
  const ra = pointRect(a, hero);
  const rb = pointRect(b, hero);
  const target = b.kind === 'square' ? squareLabel(b.at) : `${dmName(state, b.c.id)} (${spaceText(b.c, hero) ?? 'not on the map'})`;
  if (!ra || !rb) return `· ${target}: not on the map.`;
  const elevation = (p: Point) => (p.kind === 'creature' ? (p.c.elevationFt ?? 0) : 0);
  const size = (p: Point) => (p.kind === 'creature' ? combatantSize(p.c, hero) : 'Medium');
  const d = spaceDistanceFt({ rect: ra, elevationFt: elevation(a), size: size(a) }, { rect: rb, elevationFt: elevation(b), size: size(b) });
  const cells = mapCells(state, hero);
  const sees = cells ? rectsSeeEachOther(cells, ra, rb) : false;
  return `· ${target}: ${d} ft — ${sees ? 'line of sight' : 'no line of sight'}.`;
}

function measureSection(state: CombatState, hero: Character | null, from: Point, to: readonly Point[]): string {
  const lines = [`From ${pointName(state, from, hero)}:`];
  for (const p of to) {
    if (from.kind === 'creature' && p.kind === 'creature' && from.c.position && p.c.position && from.c.id !== p.c.id) lines.push(measureLine(state, hero, from.c, p.c));
    else lines.push(squareMeasure(state, hero, from, p));
  }
  return lines.join('\n');
}

function teamOfSide(c: Combatant): string {
  return c.side === 'player' || c.side === 'ally' ? 'party' : c.side === 'enemy' ? 'foes' : 'neutral';
}

/** "Around Bandit 1 (F4): Bandit 2 5 ft (ally) · Mira Voss 20 ft · …" plus the best cover it can reach this turn. */
function aroundSection(state: CombatState, hero: Character | null, from: Point): string {
  const others = state.combatants.filter((c) => !c.defeated && c.position && !(from.kind === 'creature' && c.id === from.c.id));
  const rect = pointRect(from, hero);
  if (!rect) return `${pointName(state, from, hero)} isn't on the map.`;
  const self = from.kind === 'creature' ? from.c : null;
  const fromSpace = { rect, elevationFt: self?.elevationFt ?? 0, size: self ? combatantSize(self, hero) : ('Medium' as const) };
  const near = others
    .map((c) => ({ c, d: spaceDistanceFt(fromSpace, { rect: footprint(c.position as GridPoint, combatantSize(c, hero)), elevationFt: c.elevationFt ?? 0, size: combatantSize(c, hero) }) }))
    .sort((a, b) => a.d - b.d);
  const tag = (c: Combatant) => {
    if (!self) return '';
    if (teamOfSide(c) === 'neutral' || teamOfSide(self) === 'neutral') return ' (neutral)';
    return teamOfSide(c) === teamOfSide(self) ? ' (ally)' : '';
  };
  const lines = [`Around ${pointName(state, from, hero)}: ${near.map(({ c, d }) => `${dmName(state, c.id)} ${d} ft${tag(c)}`).join(' · ') || 'nobody else on the map'}.`];
  if (self) {
    const cover = reachableCover(state, hero, self, near.map((x) => x.c));
    if (cover) lines.push(cover);
  }
  return lines.join(' ');
}

/** The three best squares of cover a creature can reach this turn against its main threat (the hero for foes). */
function reachableCover(state: CombatState, hero: Character | null, self: Combatant, byDistance: readonly Combatant[]): string | null {
  const heroC = state.combatants.find((c) => c.isPlayer);
  const hostile = (c: Combatant) =>
    (teamOfSide(c) === 'party' && teamOfSide(self) === 'foes') || (teamOfSide(c) === 'foes' && teamOfSide(self) === 'party');
  const threat = heroC && heroC.position && hostile(heroC) ? heroC : byDistance.find(hostile);
  if (!threat) return null;
  const rank: Record<string, number> = { none: 0, half: 1, 'three-quarters': 2, total: 3 };
  const options = reachableSquares(state, hero, self.id)
    .filter((sq) => sq.band === 'move' && sq.canEnd)
    .map((sq) => ({ sq, cover: coverAgainst(state, hero, threat.id, self.id, { targetAt: sq.at }) }))
    .filter((o) => o.cover.degree !== 'none' && o.cover.degree !== 'total')
    .sort((a, b) => rank[b.cover.degree] - rank[a.cover.degree] || a.sq.costFt - b.sq.costFt || a.sq.at.y - b.sq.at.y || a.sq.at.x - b.sq.at.x)
    .slice(0, 3);
  if (!options.length) return null;
  const short: Record<string, string> = { half: 'Half', 'three-quarters': 'Three-Quarters' };
  const parts = options.map((o) => {
    const by = coverBy(state, o.cover);
    return `${squareLabel(o.sq.at)} ${short[o.cover.degree]}${by ? ` (${by})` : ''}, ${o.sq.costFt} ft`;
  });
  return `Cover it can reach this turn against ${dmName(state, threat.id)}: ${parts.join(' · ')}.`;
}

/** "Bandit 2 (F3) → A7: 30 ft after standing up (15 ft) by F3 E4 …; it has 15 ft left, so the closest it gets is C6." */
function pathSection(state: CombatState, hero: Character | null, mover: Combatant, toText: string): string {
  const to = resolveMoveTarget(state, toText, 'check_map: path_to');
  const current = currentCombatant(state)?.id === mover.id;
  const stats = moverStats(state, hero, mover.id);
  const allowance = stats?.walk ?? 30;
  const base: MoveRequest = { moverId: mover.id, kind: current ? 'move' : 'off-turn', by: 'dm', to, ...(current ? {} : { budgetFt: allowance }) };
  const plan = planMove(state, hero, base);
  const name = `${dmName(state, mover.id)} (${spaceText(mover, hero) ?? 'not on the map'})`;
  const target = to.kind === 'square' ? squareLabel(to.at) : to.kind === 'creature' ? dmName(state, to.id) : ((state.map as BattleMap).places.find((p) => p.id === to.placeId)?.name ?? toText);
  const when = current ? 'this turn' : 'on its next turn';
  const from = mover.position as GridPoint;
  if (plan.status === 'refused' && plan.refusal.code !== 'too-far') {
    return describeRefusal(0, state, hero, mover.id, plan.refusal, target).replace(/^0\. /, '');
  }
  const left = current ? (turnBudget(state, hero, mover.id)?.leftFt ?? 0) : allowance;
  const stand = stats?.prone ? ` after standing up (${Math.floor((stats?.walk ?? 0) / 2)} ft)` : '';
  let cost: number;
  let route: GridPoint[];
  const tail: string[] = [];
  if (plan.status === 'refused' && plan.refusal.code === 'too-far') {
    const r = plan.refusal;
    cost = r.needFt;
    route = r.route;
    const closest = r.closest ? `, so the closest it gets is ${squareLabel(r.closest.at)}` : '';
    tail.push(`it has ${r.leftFt} ft left${closest}`);
    const dash = current ? r.dashWouldReach : planMove(state, hero, { ...base, budgetFt: 2 * allowance }).status !== 'refused';
    if (dash) tail.push(`With Dash it reaches ${target}`);
  } else if (plan.status === 'stopped') {
    cost = plan.costFt + plan.remainingCostFt;
    route = [...plan.path, ...plan.remainingPath];
    tail.push(`it has ${left} ft ${when}`);
  } else if (plan.status === 'moved') {
    cost = plan.costFt;
    route = plan.path;
    tail.push(`it has ${left} ft ${when}`);
  } else {
    return '';
  }
  const triggers = opportunityTriggers(state, hero, mover.id, [from, ...route], { disengaged: false, kind: 'move' });
  const routeText = [from, ...route].map(squareLabel).join(' ');
  const provokes = triggers.length
    ? `Provokes: ${triggers.map((t) => `${dmName(state, t.reactorId)}'s Opportunity Attack leaving ${squareLabel(t.at)}`).join(' · ')}.`
    : 'No Opportunity Attacks on that route.';
  const [first, ...more] = tail;
  return `${name} → ${target}: ${cost} ft${stand} by ${routeText}; ${first}.${more.map((m) => ` ${m}.`).join('')} ${provokes}`;
}

export async function checkMapTool(input: ToolInput<'check_map'>, ctx: ToolContext): Promise<ToolOutcome> {
  const check = mappedCombat(ctx);
  if (!check.ok) return check.outcome;
  const state = check.state;
  const hero = ctx.deps.store().character;
  if (!input.from && !input.to && !input.path_to && !input.area && !input.show) {
    throw new ToolInputError('check_map needs at least one of from, to, path_to, area or show.');
  }
  if (input.to && !input.from) throw new ToolInputError('check_map: `to` needs `from` (the creature or square to measure from).');
  const from = input.from !== undefined ? resolvePoint(state, input.from, 'check_map: from') : null;
  if (input.path_to && from?.kind !== 'creature') throw new ToolInputError('check_map: `path_to` needs `from` to be a creature.');
  const to = (input.to ?? []).map((t, i) => resolvePoint(state, t, `check_map: to[${i}]`));
  const area = input.area ? parseAreaSpec(state, input.area, 'check_map area') : null;
  const sections: string[] = [];
  if (from && to.length) sections.push(measureSection(state, hero, from, to));
  if (from && !to.length && !input.path_to) sections.push(aroundSection(state, hero, from));
  if (input.path_to && from?.kind === 'creature') sections.push(pathSection(state, hero, from.c, input.path_to));
  if (area) {
    const result = resolveArea(state, hero, area);
    sections.push('problem' in result ? `Preview (not shown to the player): ${result.problem}` : describeArea(state, hero, area, result, { label: '', preview: true }));
  }
  if (input.show) sections.push(describeShow(state, hero));
  return ok(sections.filter(Boolean).join('\n\n'));
}

// ---------------------------------------------------------------------------
// The hero's footprint after a size change on the sheet (D39)
// ---------------------------------------------------------------------------

/**
 * After update_character or transform_character changed the hero's size during a mapped fight: re-fit the hero's
 * space and say what happened ("Map: Mira Voss is now Large (B6:C7)." / "Map: Mira Voss no longer fits at A1: moved
 * to B2."). Null when nothing changed on the map.
 */
export async function refitHeroAfterSheetChange(ctx: ToolContext, before: Character, after: Character): Promise<string | null> {
  const combat = ctx.deps.store().combat;
  const heroC = combat?.combatants.find((c) => c.isPlayer);
  if (!combat?.active || !combat.map || !heroC?.position) return null;
  const sizeBefore = combatantSize(heroC, before);
  const sizeAfter = combatantSize(heroC, after);
  if (sizeBefore === sizeAfter) return null;
  const { state, moved, unplaced } = await mutateCombat(ctx, (c) => refitFootprints(c, after));
  const now = state.combatants.find((c) => c.isPlayer) as Combatant;
  if (unplaced.includes(heroC.id)) {
    return `Map: ${heroC.name} no longer fits anywhere on the map as a ${sizeAfter} creature and was taken off it — place ${heroC.name} with move_tokens kind "place".`;
  }
  const m = moved.find((x) => x.id === heroC.id);
  const space = spaceText(now, after) ?? '';
  if (m) {
    const anchor = squareLabel(m.to);
    return `Map: ${heroC.name} no longer fits at ${squareLabel(m.from)}: moved to ${anchor}${space && space !== anchor ? ` (${space})` : ''}.`;
  }
  return `Map: ${heroC.name} is now ${sizeAfter} (${space}).`;
}

export type { PlacementResult };
