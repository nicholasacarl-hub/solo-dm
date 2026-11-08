import { describe, expect, it } from 'vitest';
import type {
  ActiveCondition,
  BattleMap,
  Character,
  Combatant,
  CombatSide,
  CombatState,
  GridPoint,
  GridRect,
  MapEffect,
  TerrainFeature,
} from '@/types';
import { sampleCharacter, sampleMappedCombat, sampleStopCombat } from '@/test/fixtures';
import { nextTurn, removeCombatant } from './combat';
import { parseSquare, spaceDistanceFt, squareLabel } from './grid';
import {
  applyHeroMove,
  applyMove,
  areAllies,
  areHostile,
  currentTurn,
  heroReachFt,
  inReach,
  moverStats,
  opportunityTriggers,
  planMove,
  reachableSquares,
  statBlockMapStats,
  teamOf,
  turnBudget,
  type MoveOutcome,
  type MovePlan,
  type MoveRequest,
} from './movement';

// ---------------------------------------------------------------------------
// Helpers: squares by label, small maps and combatants
// ---------------------------------------------------------------------------

/** "C4" → { x: 2, y: 3 }. */
function P(label: string): GridPoint {
  const r = parseSquare(label, { width: 40, height: 40 });
  if (!r.ok) throw new Error(r.problem);
  return r.value;
}

function R(a: string, b = a): GridRect {
  const p = P(a);
  const q = P(b);
  return { x0: Math.min(p.x, q.x), y0: Math.min(p.y, q.y), x1: Math.max(p.x, q.x), y1: Math.max(p.y, q.y) };
}

const labels = (points: readonly GridPoint[]) => points.map(squareLabel).join(' ');
/** The route as the DM text prints it: the start, then every square entered. */
const route = (plan: { from: GridPoint; path: GridPoint[] }) => labels([plan.from, ...plan.path]);

type Feature = Omit<TerrainFeature, 'id'>;
const wall = (a: string, b = a, label?: string): Feature => ({ kind: 'wall', rects: [R(a, b)], ...(label ? { label } : {}) });
const terrain = (kind: TerrainFeature['kind'], a: string, b = a, label?: string): Feature => ({
  kind,
  rects: [R(a, b)],
  ...(label ? { label } : {}),
});

function battleMap(width: number, height: number, features: Feature[] = [], effects: MapEffect[] = []): BattleMap {
  return {
    id: 'map-1',
    name: 'Test room',
    width,
    height,
    terrain: features.map((f, i) => ({ ...f, id: `t${i + 1}` })),
    places: [],
    effects,
    nextId: features.length + 1,
    rev: 0,
  };
}

let initiative = 30;
function creature(id: string, side: CombatSide, at: string | null, extra: Partial<Combatant> = {}): Combatant {
  return {
    id,
    name: id,
    side,
    isPlayer: side === 'player',
    initiative: initiative--,
    initiativeBonus: 0,
    conditions: [],
    defeated: false,
    ...(side === 'player' ? {} : { hp: { max: 10, current: 10, temp: 0 } }),
    ...(at ? { position: P(at) } : {}),
    ...extra,
  };
}

/** A fight on `map` whose current creature is `turnId` (the first combatant by default). */
function fight(map: BattleMap, combatants: Combatant[], turnId = combatants[0].id, round = 1): CombatState {
  return { active: true, round, turnIndex: combatants.findIndex((c) => c.id === turnId), combatants, startedAt: 0, map };
}

const mira = sampleCharacter();

function move(state: CombatState, moverId: string, to: string, extra: Partial<MoveRequest> = {}, hero: Character | null = mira) {
  return applyMove(state, hero, { moverId, kind: 'move', by: 'dm', to: { kind: 'square', at: P(to) }, ...extra });
}

function plan(state: CombatState, moverId: string, to: string, extra: Partial<MoveRequest> = {}, hero: Character | null = mira): MovePlan {
  return planMove(state, hero, { moverId, kind: 'move', by: 'dm', to: { kind: 'square', at: P(to) }, ...extra });
}

function moved(o: MoveOutcome | MovePlan): Extract<MovePlan, { status: 'moved' }> {
  if (o.status !== 'moved') throw new Error(`expected moved, got ${JSON.stringify(o.status === 'refused' ? o.refusal : o.status)}`);
  return o;
}

function stopped(o: MoveOutcome | MovePlan): Extract<MovePlan, { status: 'stopped' }> {
  if (o.status !== 'stopped') throw new Error(`expected stopped, got ${o.status === 'refused' ? JSON.stringify(o.refusal) : o.status}`);
  return o;
}

function refusal(o: MoveOutcome | MovePlan) {
  if (o.status !== 'refused') throw new Error(`expected refused, got ${o.status}`);
  return o.refusal;
}

function stateOf(o: MoveOutcome): CombatState {
  if (o.status === 'refused') throw new Error(`refused: ${JSON.stringify(o.refusal)}`);
  return o.state;
}

const find = (state: CombatState, id: string) => state.combatants.find((c) => c.id === id) as Combatant;

/** The fixture with some combatants moved and/or patched. */
function fixture(opts: { heroTurn?: boolean; turnId?: string; at?: Record<string, string>; patch?: Record<string, Partial<Combatant>> } = {}) {
  const base = sampleMappedCombat({ heroTurn: opts.heroTurn });
  const combatants = base.combatants.map((c) => ({
    ...c,
    ...(opts.at?.[c.id] ? { position: P(opts.at[c.id]) } : {}),
    ...(opts.patch?.[c.id] ?? {}),
  }));
  const turnIndex = opts.turnId ? combatants.findIndex((c) => c.id === opts.turnId) : base.turnIndex;
  return { ...base, combatants, turnIndex };
}

/** The same fight with the combatants in another array order (same initiative values) and the same current creature. */
function shuffled(state: CombatState): CombatState {
  const current = state.combatants[state.turnIndex].id;
  const combatants = [...state.combatants].reverse();
  return { ...state, combatants, turnIndex: combatants.findIndex((c) => c.id === current) };
}

const heroMove = (to: string, extra: Partial<{ prefer: 'safest' | 'shortest'; dash: boolean; disengage: boolean; standUp: boolean }> = {}) => ({
  to: P(to),
  prefer: 'safest' as const,
  dash: false,
  disengage: false,
  standUp: false,
  ...extra,
});

// ---------------------------------------------------------------------------
// Teams, mover stats, stat blocks (app convention C6; srd:rule:speed)
// ---------------------------------------------------------------------------

describe('teams (app convention C6)', () => {
  it('puts the player and allies in the party, enemies in the foes, neutrals alone', () => {
    expect([teamOf('player'), teamOf('ally'), teamOf('enemy'), teamOf('neutral')]).toEqual(['party', 'party', 'foes', 'neutral']);
    expect(areAllies('party', 'party')).toBe(true);
    expect(areAllies('foes', 'foes')).toBe(true);
    expect(areAllies('neutral', 'neutral')).toBe(false);
    expect(areHostile('party', 'foes')).toBe(true);
    expect(areHostile('foes', 'party')).toBe(true);
    expect(areHostile('neutral', 'foes')).toBe(false);
    expect(areHostile('party', 'party')).toBe(false);
  });
});

describe('moverStats (SRD 5.2.1 srd:rule:speed, srd:condition:exhaustion; app convention C22)', () => {
  it('reads NPC speeds with defaults, Exhaustion and speed changes', () => {
    const map = battleMap(16, 12);
    const state = fight(map, [
      creature('a', 'enemy', 'A1'),
      creature('b', 'enemy', 'B1', { speeds: { walk: 30, fly: 60, hover: true }, conditions: [{ id: 'exhaustion', level: 2 }] }),
      creature('c', 'enemy', 'C1', { speedChangeFt: -10, reachFt: 10, size: 'Large' }),
    ]);
    expect(moverStats(state, null, 'a')).toMatchObject({ walk: 30, fly: 0, reachFt: 5, size: 'Medium', team: 'foes', speedZero: null, notes: [] });
    expect(moverStats(state, null, 'b')).toMatchObject({ walk: 20, fly: 50, hover: true, notes: ['Exhaustion 2: −10 ft'] });
    expect(moverStats(state, null, 'c')).toMatchObject({ walk: 20, reachFt: 10, size: 'Large', notes: ['Speed change: −10 ft'] });
    expect(moverStats(state, null, 'nobody')).toBeNull();
  });

  it('zeroes every speed under a Speed-0 condition, whatever the bonuses (srd:condition:grappled)', () => {
    const state = fight(battleMap(16, 12), [
      creature('a', 'enemy', 'A1', { speeds: { walk: 30, fly: 40 }, speedChangeFt: 30, conditions: [{ id: 'grappled', source: 'b' }] }),
    ]);
    expect(moverStats(state, null, 'a')).toMatchObject({ walk: 0, fly: 0, speedZero: 'Grappled' });
  });

  it('reads the hero from the sheet: walk, granted speeds max’d, Haste on every speed', () => {
    const sheet = sampleCharacter({ otherSpeeds: { swim: 20 } });
    const state = fight(battleMap(16, 12), [
      creature('h', 'player', 'A1', { speeds: { fly: 60, hover: true }, speedChangeFt: 30, name: 'Mira Voss' }),
    ]);
    expect(moverStats(state, sheet, 'h')).toMatchObject({
      isHero: true,
      walk: 60,
      fly: 90,
      swim: 50,
      hover: true,
      reachFt: 5,
      notes: ['Speed change: +30 ft'],
    });
    const prone = sampleCharacter({ conditions: [{ id: 'prone' }, { id: 'blinded' }] });
    expect(moverStats(state, prone, 'h')).toMatchObject({ prone: true, blinded: true, incapacitated: false });
  });

  it('M11: the hero in heavy armor without the Strength loses 10 ft on every speed (SRD 5.2.1 srd:rule:speed, Changes to Your Speeds)', () => {
    const sheet = sampleCharacter({
      otherSpeeds: { climb: 30 },
      inventory: [{ id: 'plate', name: 'Plate Armor', quantity: 1, weight: 65, category: 'armor', equipped: true }],
    });
    const state = fight(battleMap(16, 12), [creature('h', 'player', 'A1')]);
    const stats = moverStats(state, sheet, 'h');
    expect(stats).toMatchObject({ walk: 20, climb: 20 });
    expect(stats?.notes).toEqual(['Plate Armor needs Strength 15: −10 ft']);
  });

  it('resolves Frightened sources by name, with or without "the" (srd:condition:frightened)', () => {
    const state = fight(battleMap(16, 12), [
      creature('h', 'enemy', 'A1', { conditions: [{ id: 'frightened', source: 'the Ogre' }, { id: 'frightened', source: 'nobody' }] }),
      creature('o', 'enemy', 'D1', { name: 'Dock Ogre' }),
    ]);
    expect(moverStats(state, null, 'h')?.frightenedOfIds).toEqual(['o']);
  });
});

describe('heroReachFt (SRD 5.2.1 srd:rule:reach, srd:rule:weapons-properties-reach; app convention C15)', () => {
  const attack = { id: 'a', name: 'Glaive', ability: 'str' as const, proficient: true, damage: '1d10', damageType: 'slashing' };
  it('is 5 without a Reach weapon and 10 with one', () => {
    expect(heroReachFt(sampleCharacter())).toBe(5);
    expect(heroReachFt(sampleCharacter({ attacks: [{ ...attack, properties: ['Heavy', 'Reach', 'Two-Handed'] }] }))).toBe(10);
    expect(heroReachFt(sampleCharacter({ attacks: [{ ...attack, range: '10 ft.' }] }))).toBe(10);
    expect(heroReachFt(sampleCharacter({ attacks: [{ ...attack, range: '10 ft. or 20/60 ft. thrown' }] }))).toBe(10);
    // A spell's range is not reach.
    expect(heroReachFt(sampleCharacter({ attacks: [{ ...attack, ability: 'spell', range: '10 ft.' }] }))).toBe(5);
  });
});

describe('statBlockMapStats (D44; SRD 5.2.1 stat blocks)', () => {
  it('reads size, structured speeds and the longest melee reach', () => {
    const ogre = statBlockMapStats({
      text: '_**Greatclub.**_ _Melee Attack Roll:_ +6, reach 5 ft. _Hit:_ 13 (2d8 + 4) Bludgeoning damage.\n\n_**Javelin.**_ _Melee or Ranged Attack Roll:_ +6, reach 5 ft. or range 30/120 ft.',
      data: { size: 'Large', speeds: { walk: 40 } },
    });
    expect(ogre).toEqual({ size: 'Large', speeds: { walk: 40 }, reachFt: 5 });
    const dragon = statBlockMapStats({
      text: '_**Rend.**_ _Melee Attack Roll:_ +14, reach 10 ft. _Hit:_ 13 (1d10 + 8) Slashing damage. _**Bite.**_ _Melee Attack Roll:_ +14, reach 5 ft.',
      data: { size: 'Huge', speeds: { walk: 40, climb: 40, fly: 80 } },
    });
    expect(dragon).toEqual({ size: 'Huge', speeds: { walk: 40, climb: 40, fly: 80 }, reachFt: 10 });
    const djinni = statBlockMapStats({
      text: '_**Storm Blade.**_ _Melee Attack Roll:_ +9, reach 5 feet. _Hit:_ 12 (2d6 + 5).',
      data: { size: 'Large', speeds: { walk: 30, fly: 90, hover: true } },
    });
    expect(djinni).toEqual({ size: 'Large', speeds: { walk: 30, fly: 90, hover: true }, reachFt: 5 });
  });

  it('gives nothing for homebrew without data, and ignores ranged lines and odd values', () => {
    expect(statBlockMapStats({ text: 'A shadowy thing.' })).toEqual({});
    expect(statBlockMapStats({ text: '_Ranged Attack Roll:_ +4, reach 30 ft.', data: { size: 'Enormous', speeds: { walk: 'fast' } } })).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Movement on an empty 16×12 map (spec §3.12, M1–M14, M18–M21)
// ---------------------------------------------------------------------------

describe('M1: squares and diagonals (SRD 5.2.1 Playing on a Grid, Speed / Entering a Square)', () => {
  const state = fight(battleMap(16, 12), [creature('m', 'enemy', 'A1')]);
  it('six diagonals cost 30 ft', () => {
    const p = moved(plan(state, 'm', 'G7'));
    expect(p.costFt).toBe(30);
    expect(route(p)).toBe('A1 B2 C3 D4 E5 F6 G7');
    expect(p.budget?.leftFt).toBe(0);
  });
  it('seven squares are too far with 30 ft', () => {
    expect(refusal(plan(state, 'm', 'H7'))).toMatchObject({ code: 'too-far', needFt: 35, leftFt: 30, dashWouldReach: true });
  });
});

describe('M2: Difficult Terrain (SRD 5.2.1 srd:rule:difficult-terrain, "isn\'t cumulative")', () => {
  it('costs double to enter, once however many sources', () => {
    const one = fight(battleMap(16, 12, [terrain('difficult', 'B1')]), [creature('m', 'enemy', 'A1')]);
    expect(moved(plan(one, 'm', 'B1')).costFt).toBe(10);
    const grease: MapEffect = {
      id: 'e9',
      label: 'Grease',
      spec: { shape: 'squares', rects: [R('B1')] },
      rects: [R('B1')],
      terrain: ['difficult'],
      duration: 'lasting',
      round: 1,
      turnOfId: 'm',
    };
    const both = fight(battleMap(16, 12, [terrain('difficult', 'B1')], [grease]), [creature('m', 'enemy', 'A1')]);
    const p = moved(plan(both, 'm', 'B1'));
    expect(p.costFt).toBe(10);
    expect(p.notes).toContainEqual({ kind: 'difficult', squares: 1 });
    expect(p.notes).toContainEqual({ kind: 'entered', label: 'Grease', at: P('B1') });
  });
});

describe('M3: corners (SRD 5.2.1 Playing on a Grid, Corners; app convention C8)', () => {
  it('a diagonal can’t cut a wall corner', () => {
    const state = fight(battleMap(8, 6, [wall('C2')]), [creature('m', 'enemy', 'B2')]);
    const p = moved(plan(state, 'm', 'C3'));
    expect(p.costFt).toBe(10);
    expect(route(p)).toBe('B2 B3 C3');
  });
  it('crates don’t fill their space: the diagonal is allowed', () => {
    const state = fight(battleMap(8, 6, [terrain('half-cover', 'C2', 'C2', 'crates')]), [creature('m', 'enemy', 'B2')]);
    expect(moved(plan(state, 'm', 'C3')).costFt).toBe(5);
  });
  it('a Large creature checks its two leading corner squares', () => {
    const state = fight(battleMap(8, 8, [wall('D2')]), [creature('m', 'enemy', 'B2', { size: 'Large' })]);
    const p = moved(plan(state, 'm', 'C3'));
    expect(p.costFt).toBe(10);
    expect(route(p)).toBe('B2 B3 C3');
  });
});

describe('M4: passing other creatures in a corridor (SRD 5.2.1 Moving Around Other Creatures)', () => {
  // A 3×1 corridor A1:C1 on a 4×4 map.
  const corridor = () => battleMap(4, 4, [wall('A2', 'D2'), wall('D1')]);
  const through = (other: Combatant) => plan(fight(corridor(), [creature('m', 'player', 'A1'), other]), 'm', 'C1', {}, null);
  it('an ally’s space is free to cross', () => expect(moved(through(creature('o', 'ally', 'B1'))).costFt).toBe(10));
  it('a same-size enemy blocks', () => expect(refusal(through(creature('o', 'enemy', 'B1')))).toMatchObject({ code: 'no-route' }));
  it('a Tiny enemy can be crossed at no extra cost', () => expect(moved(through(creature('o', 'enemy', 'B1', { size: 'Tiny' }))).costFt).toBe(10));
  it('an Incapacitated enemy can be crossed; its space is Difficult Terrain', () =>
    expect(moved(through(creature('o', 'enemy', 'B1', { conditions: [{ id: 'unconscious' }] }))).costFt).toBe(15));
  it('a move can’t end in an ally’s space', () => {
    const state = fight(corridor(), [creature('m', 'player', 'A1'), creature('o', 'ally', 'B1')]);
    expect(refusal(plan(state, 'm', 'B1', {}, null))).toEqual({ code: 'occupied', at: P('B1'), byId: 'o', open: [P('C1')] });
  });
});

describe('M5: sizes (SRD 5.2.1 Moving Around Other Creatures; app convention C5)', () => {
  it('a Medium creature can’t pass a Large enemy (one size apart)', () => {
    const map = battleMap(4, 4, [wall('A1'), wall('A3'), wall('D1'), wall('D3'), wall('A4', 'D4')]);
    const state = fight(map, [creature('m', 'player', 'A2'), creature('bear', 'enemy', 'B1', { size: 'Large' })]);
    expect(refusal(plan(state, 'm', 'D2', {}, null))).toMatchObject({ code: 'no-route' });
  });
  it('a Medium creature passes through a Huge enemy; its squares are Difficult Terrain', () => {
    const map = battleMap(5, 4, [wall('A4', 'E4')]);
    const state = fight(map, [creature('m', 'player', 'A2', { speeds: { walk: 40 } }), creature('giant', 'enemy', 'B1', { size: 'Huge' })]);
    const p = moved(plan(state, 'm', 'E2', { prefer: 'shortest' }, null));
    expect(p.costFt).toBe(35);
    expect(route(p)).toBe('A2 B2 C2 D2 E2');
    expect(p.notes).toContainEqual({ kind: 'passed-through', ids: ['giant'] });
  });
});

describe('M6: no squeezing (app convention C10)', () => {
  it('a Large creature can’t enter a 1-wide corridor', () => {
    const map = battleMap(8, 4, [wall('C1', 'F1'), wall('C3', 'F4')]);
    const state = fight(map, [creature('m', 'enemy', 'A1', { size: 'Large' })]);
    expect(refusal(plan(state, 'm', 'G1'))).toMatchObject({ code: 'no-route' });
  });
});

describe('M7: Prone (SRD 5.2.1 srd:rule:crawling, srd:condition:prone, srd:rule:playing-the-game-round-down)', () => {
  const prone: ActiveCondition[] = [{ id: 'prone' }];
  const at = (extra: Partial<Combatant> = {}) => fight(battleMap(16, 12), [creature('m', 'enemy', 'A1', { conditions: prone, ...extra })]);
  it('crawling 3 squares costs 30 ft', () => {
    const p = moved(plan(at(), 'm', 'D1', { stayProne: true }));
    expect(p.costFt).toBe(30);
    expect(p.notes).toContainEqual({ kind: 'crawled', feet: 15 });
  });
  it('standing costs half the Speed, then 3 squares', () => {
    const o = move(at(), 'm', 'D1');
    const p = moved(o);
    expect(p.costFt).toBe(15);
    expect(p.notes).toContainEqual({ kind: 'stood-up', costFt: 15 });
    expect(p.budget).toMatchObject({ movedFt: 30, leftFt: 0, prone: false });
    expect(find(stateOf(o), 'm').conditions).toEqual([]);
    expect(stateOf(o).map?.turn).toMatchObject({ stoodUp: true, movedFt: 30 });
  });
  it('Speed 25: standing costs 12 (round down), leaving 2 squares', () => {
    const state = at({ speeds: { walk: 25 } });
    expect(moved(plan(state, 'm', 'C1'))).toMatchObject({ costFt: 10, budget: { movedFt: 22, leftFt: 3 } });
    expect(refusal(plan(state, 'm', 'D1'))).toMatchObject({ code: 'too-far', needFt: 15, leftFt: 13 });
  });
  it('Grappled and Prone: Speed 0, can’t stand', () => {
    expect(refusal(plan(at({ conditions: [{ id: 'prone' }, { id: 'grappled' }] }), 'm', 'B1'))).toEqual({ code: 'speed-zero', because: 'Grappled' });
  });
  it('can’t stand without enough movement left (knocked down after moving 20 ft)', () => {
    const state = at();
    const map = { ...(state.map as BattleMap), turn: { combatantId: 'm', round: 1, movedFt: 20, dashFt: 0, dashes: 0, disengaged: false, stoodUp: false, moves: [] } };
    expect(refusal(plan({ ...state, map }, 'm', 'B1'))).toEqual({ code: 'cant-stand', costFt: 15, leftFt: 10 });
    expect(moved(plan({ ...state, map }, 'm', 'B1', { stayProne: true }))).toMatchObject({ costFt: 10, budget: { leftFt: 0 } });
  });
});

describe('M8: Grappled (SRD 5.2.1 srd:condition:grappled)', () => {
  const state = fight(battleMap(16, 12), [creature('m', 'enemy', 'C3', { conditions: [{ id: 'grappled' }] })]);
  it('refuses its own movement', () => expect(refusal(plan(state, 'm', 'D3'))).toEqual({ code: 'speed-zero', because: 'Grappled' }));
  it('can still be pushed', () => {
    const o = applyMove(state, null, { moverId: 'm', kind: 'forced', by: 'dm', push: { distanceFt: 10, direction: 'east' } });
    expect(moved(o)).toMatchObject({ to: P('E3'), costFt: 0, provoked: [] });
  });
});

describe('M9: Exhaustion and Dash (SRD 5.2.1 srd:condition:exhaustion, srd:rule:dash)', () => {
  const state = fight(battleMap(16, 12), [creature('m', 'enemy', 'A1', { conditions: [{ id: 'exhaustion', level: 2 }] })]);
  it('Exhaustion 2 leaves 20 ft; a Dash adds the reduced Speed (40 in all)', () => {
    expect(turnBudget(state, null, 'm')).toMatchObject({ speedFt: 20, leftFt: 20, dashAddsFt: 20 });
    expect(refusal(plan(state, 'm', 'I1'))).toMatchObject({ code: 'too-far', needFt: 40, leftFt: 20, dashWouldReach: true });
    expect(moved(plan(state, 'm', 'I1', { dash: true }))).toMatchObject({ costFt: 40, budget: { leftFt: 0, dashFt: 20, dashes: 1 } });
  });
});

describe('M10: switching speeds (SRD 5.2.1 srd:rule:speed: "fly 10 feet, walk 10 feet, and … fly 20 feet more")', () => {
  it('one movedFt counter for every speed', () => {
    const start = fight(battleMap(16, 12), [creature('m', 'enemy', 'A1', { speeds: { walk: 30, fly: 40 } })]);
    const fly10 = move(start, 'm', 'C1', { mode: 'fly' });
    expect(moved(fly10).budget).toMatchObject({ mode: 'fly', leftFt: 30 });
    const walk10 = move(stateOf(fly10), 'm', 'E1', { mode: 'walk' });
    expect(moved(walk10).budget).toMatchObject({ mode: 'walk', leftFt: 10 });
    const fly20 = move(stateOf(walk10), 'm', 'I1', { mode: 'fly' });
    expect(moved(fly20).budget).toMatchObject({ mode: 'fly', leftFt: 0, movedFt: 40 });
    expect(refusal(move(stateOf(fly20), 'm', 'J1', { mode: 'fly' }))).toMatchObject({ code: 'too-far', needFt: 5, leftFt: 0 });
  });
});

describe('M12: Dash is idempotent within a turn (SRD 5.2.1 srd:rule:dash; D26)', () => {
  it('a repeated dash: true adds nothing; dashAgain adds another', () => {
    const start = fight(battleMap(30, 12), [creature('m', 'enemy', 'A1')]);
    const first = stateOf(move(start, 'm', 'B1', { dash: true }));
    expect(first.map?.turn).toMatchObject({ dashes: 1, dashFt: 30, movedFt: 5 });
    const second = stateOf(move(first, 'm', 'C1', { dash: true }));
    expect(second.map?.turn).toMatchObject({ dashes: 1, dashFt: 30, movedFt: 10 });
    const third = stateOf(move(second, 'm', 'D1', { dash: true, dashAgain: true }));
    expect(third.map?.turn).toMatchObject({ dashes: 2, dashFt: 60, movedFt: 15 });
    expect(turnBudget(third, null, 'm')?.leftFt).toBe(75);
    expect(third.map?.turn?.moves.map((m) => m.dashed ?? false)).toEqual([true, false, true]);
  });
});

describe('M13: Frightened (SRD 5.2.1 srd:condition:frightened; app convention C13)', () => {
  const state = fight(battleMap(16, 12), [
    creature('m', 'enemy', 'C4', { conditions: [{ id: 'frightened', source: 'Ogre' }] }),
    creature('o', 'ally', 'F4', { name: 'Ogre' }),
  ]);
  it('refuses a square closer to the source, with an alternative', () => {
    const r = refusal(plan(state, 'm', 'D4'));
    expect(r).toMatchObject({ code: 'frightened', sourceId: 'o' });
    expect(r.code === 'frightened' && r.alternative).toEqual(P('C3'));
  });
  it('allows moving away, or keeping the same distance', () => {
    expect(moved(plan(state, 'm', 'B4')).costFt).toBe(5);
    expect(moved(plan(state, 'm', 'C5')).costFt).toBe(5);
  });
  it('partial: true goes to the alternative instead', () => {
    expect(moved(plan(state, 'm', 'D4', { partial: true })).to).toEqual(P('C3'));
  });
});

describe('M14: the default route avoids Opportunity Attacks (app convention C16; SRD 5.2.1 srd:rule:opportunity-attacks)', () => {
  const state = fight(battleMap(16, 12), [creature('m', 'ally', 'A6'), creature('e', 'enemy', 'C5')]);
  it('safest: around the enemy’s reach, no Opportunity Attack', () => {
    const p = moved(plan(state, 'm', 'E6'));
    expect(route(p)).toBe('A6 B7 C7 D7 E6');
    expect(p.costFt).toBe(20);
    expect(p.provoked).toEqual([]);
  });
  it('shortest: straight past it, provoking at D6', () => {
    const p = stopped(plan(state, 'm', 'E6', { prefer: 'shortest' }));
    expect(route(p)).toBe('A6 B6 C6 D6');
    expect(p.at).toEqual(P('D6'));
    expect(p.reactors).toEqual([{ reactorId: 'e', at: P('D6'), stepIndex: 3, reachFt: 5, isHero: false, hidden: false }]);
    expect(p.remainingPath).toEqual([P('E6')]);
    expect(p.remainingCostFt).toBe(5);
  });
});

describe('M18: swimming (SRD 5.2.1 srd:rule:swimming; switching speeds, srd:rule:speed)', () => {
  // Deep water from B1 along row 1, with a wall along row 2 so the only way east is through it.
  const map = (water: string) => battleMap(16, 12, [terrain('deep-water', 'B1', water), wall('A2', 'P2')]);
  it('walk 30 / swim 20: four deep-water squares then one on land', () => {
    const state = fight(map('E1'), [creature('m', 'enemy', 'A1', { speeds: { walk: 30, swim: 20 } })]);
    const p = moved(plan(state, 'm', 'F1'));
    expect(p.costFt).toBe(25);
    expect(p.path).toHaveLength(5);
    expect(p.notes).toContainEqual({ kind: 'swam', squares: 4 });
    expect(moved(plan(state, 'm', 'G1')).costFt).toBe(30);
    expect(refusal(plan(state, 'm', 'H1'))).toMatchObject({ code: 'too-far', needFt: 35, leftFt: 30 });
  });
  it('a non-swimmer pays double in deep water', () => {
    const state = fight(map('D1'), [creature('m', 'enemy', 'A1')]);
    expect(moved(plan(state, 'm', 'D1')).costFt).toBe(30);
  });
});

describe('M19: leaving reach provokes (SRD 5.2.1 srd:rule:opportunity-attacks, srd:rule:weapons-properties-reach)', () => {
  const at = (reachFt?: number, bandit = 'D4') =>
    fight(battleMap(16, 12), [creature('h', 'player', 'C4', reachFt ? { reachFt } : {}), creature('b', 'enemy', bandit)], 'b');
  const triggers = (state: CombatState, path: string) =>
    opportunityTriggers(state, mira, 'b', path.split(' ').map(P), { disengaged: false, kind: 'move' }).map((t) => `${t.reactorId}@${squareLabel(t.at)}`);
  it('provokes on the step out of reach', () => {
    expect(triggers(at(), 'D4 E4 F4')).toEqual(['h@D4']);
    expect(triggers(at(), 'D4 D5 E6')).toEqual(['h@D5']);
  });
  it('a 10-ft reach provokes one square later; moving closer never provokes', () => {
    expect(triggers(at(10, 'E4'), 'E4 F4')).toEqual(['h@E4']);
    expect(triggers(at(10, 'E4'), 'E4 D4')).toEqual([]);
  });
  it('the hero as a reactor: isHero and the reach in the result', () => {
    const [t] = opportunityTriggers(at(), mira, 'b', [P('D4'), P('E4')], { disengaged: false, kind: 'move' });
    expect(t).toEqual({ reactorId: 'h', at: P('D4'), stepIndex: 0, reachFt: 5, isHero: true, hidden: false });
  });
});

describe('M20: no Opportunity Attack (SRD 5.2.1 srd:rule:disengage, srd:rule:teleportation, Avoiding Opportunity Attacks; app conventions C6, C14)', () => {
  const base = (hero: Partial<Combatant> = {}, bandit: Partial<Combatant> = {}, heroSide: CombatSide = 'player') =>
    fight(battleMap(16, 12), [creature('h', heroSide, 'C4', hero), creature('b', 'enemy', 'D4', bandit)], 'b');
  const leaves = (state: CombatState, extra: Partial<MoveRequest> = {}, sheet: Character | null = mira) =>
    planMove(state, sheet, { moverId: 'b', kind: 'move', by: 'dm', to: { kind: 'square', at: P('F4') }, prefer: 'shortest', ...extra });
  it('the baseline stops at D4', () => expect(stopped(leaves(base())).at).toEqual(P('D4')));
  it('Disengage', () => expect(moved(leaves(base(), { disengage: true })).provoked).toEqual([]));
  it('teleport, forced and place', () => {
    for (const kind of ['teleport', 'place'] as const) expect(moved(leaves(base(), { kind })).provoked).toEqual([]);
    expect(moved(leaves(base(), { kind: 'forced', to: undefined, push: { distanceFt: 10, direction: 'east' } })).provoked).toEqual([]);
  });
  it('an Incapacitated, Blinded or spent reactor', () => {
    const asleep = sampleCharacter({ conditions: [{ id: 'unconscious' }] });
    expect(moved(leaves(base(), {}, asleep)).provoked).toEqual([]);
    expect(moved(leaves(base(), {}, sampleCharacter({ conditions: [{ id: 'blinded' }] }))).provoked).toEqual([]);
    expect(moved(leaves(base({ reactionUsed: true }))).provoked).toEqual([]);
  });
  it('an Invisible mover; a mover hidden from the party; a neutral reactor', () => {
    expect(moved(leaves(base({}, { conditions: [{ id: 'invisible' }] }))).provoked).toEqual([]);
    expect(moved(leaves(base({}, { hidden: true })))).toMatchObject({ provoked: [] });
    expect(moved(leaves(base({}, {}, 'neutral'), {}, null)).provoked).toEqual([]);
  });
});

describe('M21: reach needs no Total Cover between (D7; app convention C20)', () => {
  it('a wall between creatures 10 ft apart: not in reach, no Opportunity Attack', () => {
    const state = fight(battleMap(16, 12, [wall('D3', 'D5')]), [creature('h', 'player', 'C4', { reachFt: 10 }), creature('b', 'enemy', 'E4')], 'b');
    const space = (c: Combatant) => ({ rect: R(squareLabel(c.position as GridPoint)), elevationFt: 0, size: 'Medium' as const });
    expect(spaceDistanceFt(space(find(state, 'h')), space(find(state, 'b')))).toBe(10);
    expect(inReach(state, mira, 'h', 'b')).toBe(false);
    expect(moved(plan(state, 'b', 'F4', { prefer: 'shortest' })).provoked).toEqual([]);
  });
  it('a sealed crack: adjacent, but not in reach', () => {
    const state = fight(battleMap(6, 6, [wall('B1'), wall('A2')]), [creature('h', 'player', 'A1'), creature('b', 'enemy', 'B2')], 'b');
    expect(inReach(state, mira, 'h', 'b')).toBe(false);
    expect(inReach(state, mira, 'b', 'h')).toBe(false);
  });
  it('in reach otherwise, also with the target at another square', () => {
    const state = fight(battleMap(16, 12), [creature('h', 'player', 'C4'), creature('b', 'enemy', 'E4')], 'b');
    expect(inReach(state, mira, 'h', 'b')).toBe(false);
    expect(inReach(state, mira, 'h', 'b', P('D5'))).toBe(true);
    expect(inReach(state, mira, 'h', 'h')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The warehouse fixture (spec §9.6): M15–M17, M22–M31
// ---------------------------------------------------------------------------

describe('M15: Bandit 1 closes on Mira (app convention C16; SRD 5.2.1 Playing on a Grid)', () => {
  it('ends within reach of Mira by the cheapest safe route', () => {
    const state = fixture();
    const o = applyMove(state, mira, { moverId: 'c-2', kind: 'move', by: 'dm', to: { kind: 'creature', id: 'c-1' } });
    const p = moved(o);
    expect(route(p)).toBe('F4 E4 D4 C5');
    expect(p.costFt).toBe(15);
    expect(p.provoked).toEqual([]);
    expect(p.budget).toMatchObject({ leftFt: 15, speedFt: 30 });
    expect(inReach(stateOf(o), mira, 'c-2', 'c-1')).toBe(true);
    expect(inReach(stateOf(o), mira, 'c-2', 'c-4')).toBe(true);
    expect(stateOf(o).map?.turn).toMatchObject({ combatantId: 'c-2', round: 2, movedFt: 15, moves: [{ by: 'dm', kind: 'move', path: [P('E4'), P('D4'), P('C5')] }] });
  });
  it('the same on a shuffled combatant list (determinism)', () => {
    const req: MoveRequest = { moverId: 'c-2', kind: 'move', by: 'dm', to: { kind: 'creature', id: 'c-1' } };
    expect(planMove(shuffled(fixture()), mira, req)).toEqual(planMove(fixture(), mira, req));
  });
  it('to a creature already within reach: moved, 0 ft (§3.10)', () => {
    const state = fixture({ at: { 'c-2': 'C5' } });
    const o = applyMove(state, mira, { moverId: 'c-2', kind: 'move', by: 'dm', to: { kind: 'creature', id: 'c-1' } });
    expect(moved(o)).toMatchObject({ costFt: 0, path: [], to: P('C5') });
    expect(stateOf(o)).toBe(state);
  });
});

describe('M16: Bandit 2 stands, then is too far from A7 (SRD 5.2.1 srd:condition:prone, srd:rule:dash)', () => {
  it('needs 30 ft after standing, has 15; the closest is C6; Dash would reach', () => {
    // As in the spec's worked example, Bandit 1 has already closed to C5.
    const state = fixture({ turnId: 'c-3', at: { 'c-2': 'C5' } });
    const r = refusal(plan(state, 'c-3', 'A7'));
    expect(r).toMatchObject({ code: 'too-far', needFt: 30, leftFt: 15, dashWouldReach: true, closest: { at: P('C6'), costFt: 15 } });
    expect(r.code === 'too-far' && labels(r.route)).toBe('E4 D5 D6 C7 B7 A7');
    const p = moved(plan(state, 'c-3', 'A7', { partial: true }));
    expect(route(p)).toBe('F3 E4 D5 C6');
    expect(p.notes).toContainEqual({ kind: 'stood-up', costFt: 15 });
    expect(moved(plan(state, 'c-3', 'A7', { dash: true }))).toMatchObject({ costFt: 30, budget: { leftFt: 15, dashes: 1 } });
  });
  it('with Bandit 1 still at F4, C5 ties with C6 and wins by row', () => {
    const r = refusal(plan(fixture({ turnId: 'c-3' }), 'c-3', 'A7'));
    expect(r).toMatchObject({ code: 'too-far', needFt: 30, leftFt: 15, closest: { at: P('C5'), costFt: 15 } });
  });
});

describe('M17: the Dock Ogre (Large) closes on Mira (SRD 5.2.1 Creature Size)', () => {
  it('ends with its space C7:D8, 5 ft from Mira', () => {
    const state = fixture({ turnId: 'c-6' });
    const o = applyMove(state, mira, { moverId: 'c-6', kind: 'move', by: 'dm', to: { kind: 'creature', id: 'c-1' } });
    const p = moved(o);
    expect(route(p)).toBe('H10 G10 F10 E9 D8 C7');
    expect(p.costFt).toBe(25);
    expect(p.to).toEqual(P('C7'));
    expect(p.notes).toContainEqual({ kind: 'entered', label: 'brazier', at: P('G10') });
    expect(inReach(stateOf(o), mira, 'c-6', 'c-1')).toBe(true);
  });
  it('a Large mover’s square is its top-left anchor; off the map is refused (§3.10)', () => {
    expect(refusal(plan(fixture({ turnId: 'c-6' }), 'c-6', 'P12'))).toEqual({ code: 'off-map', to: P('P12') });
    expect(moved(plan(fixture({ turnId: 'c-6' }), 'c-6', 'F10'))).toMatchObject({ to: P('F10'), costFt: 10 });
  });
});

describe('M22: the stop rule and repeating a move (SRD 5.2.1 srd:rule:opportunity-attacks; D31, D33)', () => {
  const start = () => fixture({ at: { 'c-2': 'C5' } });
  it('stops on the last square in reach, records the stop, then continues past the reactors', () => {
    const o = move(start(), 'c-2', 'F4');
    const p = stopped(o);
    expect(p).toMatchObject({ at: P('C5'), triggerAt: P('C5'), destination: P('F4'), costFt: 0, path: [] });
    expect(p.reactors.map((r) => [r.reactorId, r.stepIndex, r.isHero])).toEqual([
      ['c-1', 0, true],
      ['c-4', 0, false],
    ]);
    expect(p.remainingPath).toEqual([P('D5'), P('E4'), P('F4')]);
    expect(p.remainingCostFt).toBe(15);
    const after = stateOf(o);
    expect(after.map?.stop).toEqual({
      moverId: 'c-2',
      by: 'dm',
      round: 2,
      at: P('C5'),
      destination: P('F4'),
      route: [P('D5'), P('E4'), P('F4')],
      reactorIds: ['c-1', 'c-4'],
      declinedIds: [],
      opts: { prefer: 'safest' },
    });
    expect(find(after, 'c-2').position).toEqual(P('C5'));

    const again = move(after, 'c-2', 'F4', { declinedIds: ['c-1'] });
    const q = moved(again);
    expect(route(q)).toBe('C5 D5 E4 F4');
    expect(q.costFt).toBe(15);
    expect(q.notes).toContainEqual({ kind: 'stop-continued', reactorIds: ['c-1', 'c-4'], declinedIds: ['c-1'] });
    const done = stateOf(again);
    expect(find(done, 'c-4').reactionUsed).toBe(true);
    expect(find(done, 'c-1').reactionUsed).toBeUndefined();
    expect(done.map?.stop).toBeUndefined();
    expect(done.map?.turn?.movedFt).toBe(15);
  });
  it('a declined reactor at the stop step is recorded in reactorIds and declinedIds', () => {
    const o = move(start(), 'c-2', 'F4', { declinedIds: ['c-1'] });
    expect(stopped(o).reactors.map((r) => r.reactorId)).toEqual(['c-4', 'c-1']);
    expect(stateOf(o).map?.stop).toMatchObject({ reactorIds: ['c-4', 'c-1'], declinedIds: ['c-1'] });
    // The repeat neither stops for nor spends the hero's Reaction.
    const done = stateOf(move(stateOf(o), 'c-2', 'F4'));
    expect(find(done, 'c-4').reactionUsed).toBe(true);
    expect(find(done, 'c-1').reactionUsed).toBeUndefined();
  });
  it('declining every reactor lets the move through, listing what it provoked', () => {
    const p = moved(move(start(), 'c-2', 'F4', { declinedIds: ['c-1', 'c-4'] }));
    expect(p.provoked.map((r) => r.reactorId)).toEqual(['c-1', 'c-4']);
  });
});

describe('M23: a stop while passing through an ally (D31)', () => {
  it('stops on the last square it can end on, before the trigger square', () => {
    const state = fixture({ turnId: 'c-4', at: { 'c-2': 'C5' } });
    const o = move(state, 'c-4', 'A7');
    const p = stopped(o);
    expect(p).toMatchObject({ at: P('B5'), triggerAt: P('B6'), destination: P('A7'), costFt: 0, path: [] });
    expect(p.reactors.map((r) => [r.reactorId, squareLabel(r.at), r.stepIndex])).toEqual([['c-2', 'B6', 1]]);
    expect(p.remainingPath).toEqual([P('B6'), P('A7')]);
    expect(p.remainingCostFt).toBe(10);
    expect(stateOf(o).map?.stop).toMatchObject({ at: P('B5'), triggerAt: P('B6'), route: [P('B6'), P('A7')] });
  });
});

describe('M24: the player’s own move stops on the provoking square (D34; C24)', () => {
  it('stops at B6, blocks a second move until the DM has seen it, then continues', () => {
    const state = fixture({ heroTurn: true, at: { 'c-2': 'C5' } });
    const first = applyHeroMove(state, mira, heroMove('D8'), { stopResolved: true });
    if (first.status === 'refused') throw new Error(JSON.stringify(first.refusal));
    expect(first).toMatchObject({ status: 'stopped', stoppedFor: { kind: 'opportunity-attack', reactorIds: ['c-2'] }, revealedHidden: false });
    expect(first.move).toMatchObject({ by: 'player', kind: 'move', from: P('B6'), to: P('B6'), path: [], costFt: 0 });
    expect(first.move.provoked).toEqual([{ reactorId: 'c-2', at: P('B6'), hidden: false }]);
    expect(first.state.map?.stop).toMatchObject({ moverId: 'c-1', by: 'player', at: P('B6'), destination: P('D8'), reactorIds: ['c-2'] });

    expect(applyHeroMove(first.state, mira, heroMove('D8'), { stopResolved: false })).toEqual({
      status: 'refused',
      refusal: { code: 'stop-pending', reactorIds: ['c-2'] },
    });

    const second = applyHeroMove(first.state, mira, heroMove('D8'), { stopResolved: true });
    if (second.status === 'refused') throw new Error(JSON.stringify(second.refusal));
    expect(second.status).toBe('moved');
    expect(second.move).toMatchObject({ from: P('B6'), to: P('D8'), path: [P('C7'), P('D8')], costFt: 10 });
    expect(find(second.state, 'c-2').reactionUsed).toBe(true);
    expect(second.state.map?.stop).toBeUndefined();
    expect(second.state.map?.turn).toMatchObject({ combatantId: 'c-1', movedFt: 10 });
    expect(second.state.map?.turn?.moves).toHaveLength(2);
  });
});

describe('§5.4 Example 2 and §5.5: the pending player stop and the DM finishing the move', () => {
  it('the player’s move B6 → A7 produces exactly the sampleStopCombat() turn record and stop', () => {
    const fixtureState = sampleStopCombat();
    const before = { ...fixtureState, map: { ...(fixtureState.map as BattleMap), turn: undefined, stop: undefined } };
    const out = applyHeroMove(before, mira, heroMove('A7'), { stopResolved: true });
    if (out.status === 'refused') throw new Error(JSON.stringify(out.refusal));
    expect(out).toMatchObject({ status: 'stopped', stoppedFor: { kind: 'opportunity-attack', reactorIds: ['c-6'] } });
    expect(out.state.map?.turn).toEqual(fixtureState.map?.turn);
    expect(out.state.map?.stop).toEqual(fixtureState.map?.stop);
  });
  it('move_tokens hero → A7 continues past the stop and spends the Dock Ogre’s Reaction', () => {
    const o = applyMove(sampleStopCombat(), mira, { moverId: 'c-1', kind: 'move', by: 'dm', to: { kind: 'square', at: P('A7') } });
    const p = moved(o);
    expect(route(p)).toBe('B6 A7');
    expect(p).toMatchObject({ costFt: 5, budget: { leftFt: 25, speedFt: 30 } });
    expect(p.notes).toContainEqual({ kind: 'stop-continued', reactorIds: ['c-6'], declinedIds: [] });
    expect(find(stateOf(o), 'c-6').reactionUsed).toBe(true);
    expect(stateOf(o).map?.stop).toBeUndefined();
  });
});

describe('M25: a hidden reactor never stops the player’s move (D35)', () => {
  const state = () => fixture({ heroTurn: true, at: { 'c-5': 'C6' } });
  it('records an unseen Opportunity Attack instead', () => {
    const out = applyHeroMove(state(), mira, heroMove('B8'), { stopResolved: true });
    if (out.status === 'refused') throw new Error(JSON.stringify(out.refusal));
    expect(out.status).toBe('moved');
    expect(out.move.provoked).toEqual([{ reactorId: 'c-5', at: P('B7'), hidden: true }]);
    expect(out.state.map?.stop).toBeUndefined();
    expect(out.revealedHidden).toBe(false);
  });
  it('the DM’s view of a player move has an oa-unseen note', () => {
    const p = moved(planMove(state(), mira, { moverId: 'c-1', kind: 'move', by: 'player', to: { kind: 'square', at: P('B8') } }));
    expect(p.notes).toContainEqual({ kind: 'oa-unseen', reactorId: 'c-5', at: P('B7') });
    expect(p.provoked).toEqual([{ reactorId: 'c-5', at: P('B7'), stepIndex: 1, reachFt: 5, isHero: false, hidden: true }]);
  });
  it('a DM-made move of the hero does stop for it', () => {
    expect(stopped(move(state(), 'c-1', 'B8')).reactors.map((r) => r.reactorId)).toEqual(['c-5']);
  });
  it('the player continuing a DM-made stop with only hidden reactors spends their Reactions, unseen', () => {
    const halted = stateOf(move(state(), 'c-1', 'B8'));
    expect(halted.map?.stop).toMatchObject({ by: 'dm', at: P('B7'), reactorIds: ['c-5'] });
    const out = applyHeroMove(halted, mira, heroMove('B8'), { stopResolved: false });
    if (out.status === 'refused') throw new Error(JSON.stringify(out.refusal));
    expect(out.status).toBe('moved');
    expect(out.move.provoked).toEqual([]);
    expect(find(out.state, 'c-5').reactionUsed).toBe(true);
    expect(out.state.map?.stop).toBeUndefined();
  });
});

describe('the hero’s Opportunity Attack on a DM-made move (D32)', () => {
  const start = () => fixture({ at: { 'c-2': 'C5' }, patch: { 'c-4': { position: P('A1') } } });
  it('"Attack": the move stops, the hero’s Reaction is spent, and the repeat continues past the hero', () => {
    const asked = planMove(start(), mira, { moverId: 'c-2', kind: 'move', by: 'dm', to: { kind: 'square', at: P('F4') } });
    expect(stopped(asked).reactors.map((r) => [r.reactorId, r.isHero])).toEqual([['c-1', true]]);
    const halted = stateOf(move(start(), 'c-2', 'F4'));
    const attacked = { ...halted, combatants: halted.combatants.map((c) => (c.id === 'c-1' ? { ...c, reactionUsed: true } : c)) };
    const done = move(attacked, 'c-2', 'F4');
    expect(moved(done)).toMatchObject({ costFt: 15, to: P('F4') });
    expect(find(stateOf(done), 'c-1').reactionUsed).toBe(true);
  });
  it('"Let it go": the same call with the hero declined completes the move', () => {
    const p = moved(move(start(), 'c-2', 'F4', { declinedIds: ['c-1'] }));
    expect(p.provoked).toEqual([{ reactorId: 'c-1', at: P('C5'), stepIndex: 0, reachFt: 5, isHero: true, hidden: false }]);
  });
});

describe('M26: something unseen on the previewed route (app convention C24)', () => {
  it('stops before the hidden creature and says only "unseen"', () => {
    const state = fixture({ heroTurn: true, at: { 'c-5': 'B9' } });
    const out = applyHeroMove(state, mira, heroMove('B11'), { stopResolved: true });
    if (out.status === 'refused') throw new Error(JSON.stringify(out.refusal));
    expect(out).toMatchObject({ status: 'stopped', stoppedFor: { kind: 'unseen' }, revealedHidden: true });
    expect(out.move).toMatchObject({ to: P('B8'), path: [P('B7'), P('B8')], costFt: 10, revealedHidden: true });
    expect(find(out.state, 'c-1').position).toEqual(P('B8'));
  });
  it('records the hidden blocker for the DM only: in the turn record, never in the outcome', () => {
    const state = fixture({ heroTurn: true, at: { 'c-5': 'B9' } });
    const out = applyHeroMove(state, mira, heroMove('B11'), { stopResolved: true });
    if (out.status === 'refused') throw new Error(JSON.stringify(out.refusal));
    expect(out.state.map?.turn?.moves.at(-1)?.blockedById).toBe('c-5');
    expect(out.move).not.toHaveProperty('blockedById');
  });
  it('an unseen creature on the destination square: stops on the last open square', () => {
    const state = fixture({ heroTurn: true, at: { 'c-5': 'B8' }, patch: { 'c-5': { side: 'ally' } } });
    const out = applyHeroMove(state, mira, heroMove('B8'), { stopResolved: true });
    if (out.status === 'refused') throw new Error(JSON.stringify(out.refusal));
    expect(out).toMatchObject({ status: 'stopped', stoppedFor: { kind: 'unseen' }, revealedHidden: true });
    expect(out.move.to).toEqual(P('B7'));
  });
});

describe('M27: forced movement (app convention C17; SRD 5.2.1 srd:rule:falling)', () => {
  const push = (state: CombatState, id: string, p: NonNullable<MoveRequest['push']>) =>
    applyMove(state, mira, { moverId: id, kind: 'forced', by: 'dm', push: p });
  it('straight away from the source, snapped to 8 directions', () => {
    const o = push(fixture({ at: { 'c-2': 'C5' } }), 'c-2', { distanceFt: 10, awayFrom: { kind: 'creature', id: 'c-1' } });
    expect(route(moved(o))).toBe('C5 D4 E3');
    expect(moved(o)).toMatchObject({ costFt: 0, provoked: [] });
  });
  it('stops before a wall, saying what and how far short', () => {
    const p = moved(push(fixture({ at: { 'c-2': 'G4' } }), 'c-2', { distanceFt: 10, direction: 'east' }));
    expect(p.to).toEqual(P('H4'));
    expect(p.notes).toContainEqual({ kind: 'push-stopped', at: P('H4'), by: 'the pillar', shortFt: 5 });
  });
  it('stops before a creature and at the map edge', () => {
    const intoTam = moved(push(fixture({ at: { 'c-2': 'D5' } }), 'c-2', { distanceFt: 15, direction: 'west' }));
    expect(intoTam.notes).toContainEqual({ kind: 'push-stopped', at: P('C5'), by: 'Old Tam', shortFt: 10 });
    const edge = moved(push(fixture({ at: { 'c-2': 'B1' } }), 'c-2', { distanceFt: 10, direction: 'north-west' }));
    expect(edge.notes).toContainEqual({ kind: 'push-stopped', at: P('B1'), by: 'the map edge', shortFt: 10 });
  });
  it('drops into a pit', () => {
    const base = fixture({ at: { 'c-2': 'G4' } });
    const map = { ...(base.map as BattleMap), terrain: [...(base.map as BattleMap).terrain, { id: 't99', kind: 'pit' as const, rects: [R('H4')] }] };
    const p = moved(push({ ...base, map }, 'c-2', { distanceFt: 10, direction: 'east' }));
    expect(p.to).toEqual(P('H4'));
    expect(p.notes).toContainEqual({ kind: 'fell', into: 'the pit', feet: 10, dice: '1d6' });
  });
  it('ends a grapple once the target is beyond the grappler’s reach (srd:rule:grappling)', () => {
    const state = fixture({ at: { 'c-2': 'C6' }, patch: { 'c-2': { conditions: [{ id: 'grappled', source: 'Old Tam' }] } } });
    const p = moved(push(state, 'c-2', { distanceFt: 10, direction: 'east' }));
    expect(p.notes).toContainEqual({ kind: 'grapple-ended', grapplerId: 'c-4' });
  });
});

describe('M28: teleportation (SRD 5.2.1 srd:rule:teleportation; app convention C18)', () => {
  const teleport = (extra: Partial<MoveRequest> = {}) =>
    applyMove(fixture({ heroTurn: true }), mira, { moverId: 'c-1', kind: 'teleport', by: 'dm', to: { kind: 'square', at: P('F3') }, ...extra });
  it('an occupied destination shifts to the nearest open square', () => {
    const p = moved(teleport());
    expect(p.to).toEqual(P('E3'));
    expect(p.path).toEqual([]);
    expect(p.notes).toEqual([
      { kind: 'shifted', requested: P('F3'), reason: 'occupied' },
      { kind: 'teleported', distanceFt: 15, lineOfSight: true },
    ]);
  });
  it('checks its range', () => {
    expect(refusal(teleport({ maxFt: 10 }))).toEqual({ code: 'out-of-range', distanceFt: 20, maxFt: 10 });
  });
  it('place: no rules but a legal footprint; spendFt is charged to the current creature', () => {
    const o = applyMove(fixture({ heroTurn: true }), mira, { moverId: 'c-1', kind: 'place', by: 'dm', to: { kind: 'square', at: P('I4') }, spendFt: 10 });
    const p = moved(o);
    expect(p.notes).toEqual([{ kind: 'shifted', requested: P('I4'), reason: 'blocked' }]);
    expect(p.budget).toMatchObject({ movedFt: 10, leftFt: 20 });
    expect(stateOf(o).map?.turn?.moves[0]).toMatchObject({ kind: 'place', costFt: 10 });
  });
  it('place puts an unplaced creature on the map', () => {
    const base = fixture({ patch: { 'c-4': { position: undefined } } });
    const o = applyMove(base, mira, { moverId: 'c-4', kind: 'place', by: 'dm', to: { kind: 'square', at: P('B6') } });
    expect(moved(o).notes).toEqual([{ kind: 'shifted', requested: P('B6'), reason: 'occupied' }]);
    expect(find(stateOf(o), 'c-4').position).toBeDefined();
  });
});

describe('M29: the turn guard and off-turn moves (D21)', () => {
  it('refuses kind move for anyone but the current creature', () => {
    expect(refusal(plan(fixture(), 'c-3', 'E3'))).toEqual({ code: 'not-their-turn', currentId: 'c-2' });
  });
  it('off-turn: its own allowance, the turn record untouched', () => {
    const state = fixture({ patch: { 'c-3': { conditions: [] } } });
    const o = applyMove(state, mira, { moverId: 'c-3', kind: 'off-turn', by: 'dm', to: { kind: 'square', at: P('C3') }, budgetFt: 15 });
    expect(moved(o)).toMatchObject({ costFt: 15, budget: { speedFt: 15, leftFt: 0 } });
    expect(stateOf(o).map?.turn).toBeUndefined();
    expect(refusal(applyMove(state, mira, { moverId: 'c-3', kind: 'off-turn', by: 'dm', to: { kind: 'square', at: P('B3') }, budgetFt: 15 }))).toMatchObject({
      code: 'too-far',
      needFt: 20,
      leftFt: 15,
      dashWouldReach: false,
    });
  });
  it('every NPC defeated: the guard still applies and nextTurn returns to the hero (§3.10)', () => {
    const base = fixture({ heroTurn: true });
    const down = { ...base, combatants: base.combatants.map((c) => (c.isPlayer ? c : { ...c, defeated: true })) };
    expect(currentTurn(nextTurn(down))?.combatantId).toBe('c-1');
    expect(refusal(plan(down, 'c-2', 'E4'))).toEqual({ code: 'not-their-turn', currentId: 'c-1' });
  });
});

describe('M30: a repeated move can stop again (D31)', () => {
  it('stops at the next reactor on the route', () => {
    const state = fight(battleMap(16, 12), [creature('h', 'player', 'C4'), creature('b', 'enemy', 'D4'), creature('g', 'ally', 'H5')], 'b');
    const first = move(state, 'b', 'J4', { prefer: 'shortest' });
    expect(stopped(first).reactors.map((r) => r.reactorId)).toEqual(['h']);
    const second = move(stateOf(first), 'b', 'J4', { prefer: 'shortest' });
    const p = stopped(second);
    expect(route(p)).toBe('D4 E4 F4 G4 H4 I4');
    expect(p.reactors.map((r) => r.reactorId)).toEqual(['g']);
    expect(find(stateOf(second), 'h').reactionUsed).toBe(true);
    expect(stateOf(second).map?.stop).toMatchObject({ at: P('I4'), reactorIds: ['g'] });
  });
});

describe('M31: the turn record goes stale on its own (D3)', () => {
  it('a fresh turn, after a 10-ft move, and a stale record', () => {
    const state = fixture({ heroTurn: true });
    expect(turnBudget(state, mira, 'c-1')).toMatchObject({ leftFt: 30, movedFt: 0, speedFt: 30, standCostFt: 15 });
    const after = stateOf(move(state, 'c-1', 'C8'));
    expect(turnBudget(after, mira, 'c-1')).toMatchObject({ leftFt: 20, movedFt: 10 });
    const stale = { ...after, round: 3 };
    expect(turnBudget(stale, mira, 'c-1')?.leftFt).toBe(30);
    expect(currentTurn(stale)).toMatchObject({ combatantId: 'c-1', round: 3, movedFt: 0, moves: [] });
    // Someone else's budget is always a fresh turn.
    expect(turnBudget(after, mira, 'c-2')?.leftFt).toBe(30);
  });
  it('removing the current creature leaves its stop and record stale (§3.10)', () => {
    const stoppedState = stateOf(move(fixture({ at: { 'c-2': 'C5' } }), 'c-2', 'F4'));
    const removed = removeCombatant(stoppedState, 'c-2');
    expect(currentTurn(removed)?.combatantId).not.toBe('c-2');
    const next = stateOf(applyMove(removed, mira, { moverId: 'c-3', kind: 'forced', by: 'dm', push: { distanceFt: 5, direction: 'north' } }));
    expect(next.map?.stop).toBeUndefined();
  });
  it('no map: no record', () => {
    expect(currentTurn({ ...fixture(), map: undefined })).toBeNull();
  });
});

describe('edge cases (spec §3.10)', () => {
  it('a move to the square the mover stands on changes nothing', () => {
    const state = fixture();
    const o = move(state, 'c-2', 'F4');
    expect(moved(o)).toMatchObject({ path: [], costFt: 0 });
    expect(stateOf(o)).toBe(state);
  });
  it('refuses moves into walls and pits, naming them', () => {
    expect(refusal(plan(fixture(), 'c-2', 'I4'))).toEqual({ code: 'blocked', at: P('I4'), what: 'wall (pillar)' });
    expect(refusal(plan(fixture(), 'c-2', 'N5'))).toEqual({ code: 'blocked', at: P('N5'), what: 'door (office door, closed)' });
  });
  it('an unplaced mover can’t move; an unknown one is a bad request', () => {
    expect(refusal(plan(fixture({ patch: { 'c-2': { position: undefined } } }), 'c-2', 'E4'))).toEqual({ code: 'unplaced' });
    expect(refusal(plan(fixture({ patch: { 'c-2': { position: { x: 99, y: 3 } } } }), 'c-2', 'E4'))).toEqual({ code: 'unplaced' });
    expect(refusal(plan(fixture(), 'nobody', 'E4'))).toMatchObject({ code: 'bad-request' });
    const odd = planMove(fixture(), mira, { moverId: 'c-2', kind: 'move', by: 'dm', to: { kind: 'square', at: { x: 1.5, y: 2 } } });
    expect(refusal(odd)).toMatchObject({ code: 'bad-request' });
    expect(refusal(planMove({ ...fixture(), map: undefined }, mira, { moverId: 'c-2', kind: 'move', by: 'dm', to: { kind: 'square', at: P('E4') } }))).toMatchObject({
      code: 'bad-request',
    });
    expect(reachableSquares({ ...fixture(), map: undefined }, mira, 'c-2')).toEqual([]);
  });
  it('a hidden current creature: the hero can’t move', () => {
    const out = applyHeroMove(fixture({ turnId: 'c-5' }), mira, heroMove('C7'), { stopResolved: true });
    expect(out).toEqual({ status: 'refused', refusal: { code: 'not-their-turn', currentId: 'c-2' } });
  });
  it('the hero stands up on the player’s own move', () => {
    const prone = sampleCharacter({ conditions: [{ id: 'prone' }] });
    const out = applyHeroMove(fixture({ heroTurn: true }), prone, { prefer: 'safest', dash: false, disengage: false, standUp: true }, { stopResolved: true });
    if (out.status === 'refused') throw new Error(JSON.stringify(out.refusal));
    expect(out).toMatchObject({ status: 'moved', heroStoodUp: true, move: { kind: 'stand', costFt: 15, stoodUp: true, path: [] } });
    expect(out.state.map?.turn).toMatchObject({ movedFt: 15, stoodUp: true });
  });
});

// ---------------------------------------------------------------------------
// Reachable squares and the performance budget (spec §7.12)
// ---------------------------------------------------------------------------

describe('reachableSquares', () => {
  it('lists the walk band and the Dash band with costs and provocations', () => {
    const squares = reachableSquares(fixture({ heroTurn: true, at: { 'c-2': 'C5' } }), mira, 'c-1');
    const at = (label: string) => squares.find((s) => squareLabel(s.at) === label);
    expect(at('B6')).toBeUndefined();
    expect(at('C7')).toMatchObject({ costFt: 5, band: 'move', provokes: 1, canEnd: true });
    expect(at('C6')).toMatchObject({ costFt: 5, band: 'move', provokes: 0, canEnd: true });
    expect(at('B5')).toMatchObject({ costFt: 5, canEnd: false });
    expect(at('H6')).toMatchObject({ costFt: 30, band: 'move', provokes: 1 });
    expect(at('J6')).toMatchObject({ costFt: 40, band: 'dash' });
    expect(squares.every((s) => s.costFt <= 60)).toBe(true);
    expect(squares.filter((s) => s.band === 'move').every((s) => s.costFt <= 30)).toBe(true);
  });

  it('is empty at Speed 0, and crawls when told not to stand', () => {
    const grappled = sampleCharacter({ conditions: [{ id: 'grappled' }] });
    expect(reachableSquares(fixture({ heroTurn: true }), grappled, 'c-1')).toEqual([]);
    const prone = sampleCharacter({ conditions: [{ id: 'prone' }] });
    const crawl = reachableSquares(fixture({ heroTurn: true }), prone, 'c-1', { standUp: false });
    expect(Math.max(...crawl.filter((s) => s.band === 'move').map((s) => s.costFt))).toBeLessThanOrEqual(30);
    expect(crawl.find((s) => squareLabel(s.at) === 'C7')?.costFt).toBe(10);
  });

  it('shortest routes count their provocations too', () => {
    const squares = reachableSquares(fixture({ heroTurn: true, at: { 'c-2': 'C5' } }), mira, 'c-1', { prefer: 'shortest' });
    expect(squares.find((s) => squareLabel(s.at) === 'D8')).toMatchObject({ costFt: 10, provokes: 1 });
  });

  it('meets the 40×40 budget (§7.12: < 6 ms; asserted with a generous margin)', () => {
    const features: Feature[] = [];
    for (let i = 0; i < 12; i++) features.push(wall(squareLabel({ x: 3 + 3 * i, y: 5 }), squareLabel({ x: 3 + 3 * i, y: 12 + (i % 5) })));
    features.push(terrain('difficult', 'E20', 'P28'), terrain('deep-water', 'Z3', 'AH9'), terrain('half-cover', 'B30', 'L31'));
    const others: Combatant[] = [];
    for (let i = 0; i < 29; i++) {
      others.push(creature(`n${i}`, i % 3 === 0 ? 'ally' : 'enemy', squareLabel({ x: (i * 7) % 38, y: 14 + ((i * 5) % 24) })));
    }
    const state = fight(battleMap(40, 40, features), [creature('h', 'player', 'T20', { speeds: { walk: 60 } }), ...others]);
    const sheet = sampleCharacter({ speed: 60 });
    reachableSquares(state, sheet, 'h'); // warm up (JIT, memoized terrain)
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      const squares = reachableSquares(state, sheet, 'h');
      times.push(performance.now() - t0);
      expect(squares.length).toBeGreaterThan(400);
    }
    times.sort((a, b) => a - b);
    expect(times[3]).toBeLessThan(40);
  });
});

// ---------------------------------------------------------------------------
// More rules: flying, waypoints, places, Tiny creatures, notes, the true-map replay
// ---------------------------------------------------------------------------

describe('flying (SRD 5.2.1 srd:rule:flying, srd:rule:hover; app conventions C11, C12)', () => {
  const flier = (extra: Partial<Combatant> = {}) => creature('f', 'enemy', 'A1', { speeds: { walk: 10, fly: 60 }, ...extra });
  it('ignores ground terrain and pits; costs max(path, climb)', () => {
    const map = battleMap(16, 12, [terrain('difficult', 'B1', 'D1'), terrain('pit', 'E1', 'E1', 'chasm'), wall('A2', 'P2')]);
    const state = fight(map, [flier()]);
    expect(refusal(plan(state, 'f', 'F1', { mode: 'walk' }))).toMatchObject({ code: 'no-route' });
    expect(moved(plan(state, 'f', 'F1', { mode: 'fly' }))).toMatchObject({ costFt: 25 });
    const up = moved(plan(state, 'f', 'B1', { mode: 'fly', elevationFt: 30 }));
    expect(up).toMatchObject({ costFt: 30, budget: { leftFt: 30 } });
    expect(refusal(plan(state, 'f', 'B1', { mode: 'fly', elevationFt: 80 }))).toMatchObject({ code: 'too-far', needFt: 80, leftFt: 60 });
  });
  it('sets its height; walking keeps it and an airborne walker is flagged', () => {
    const o = move(fight(battleMap(16, 12), [flier()]), 'f', 'C1', { mode: 'fly', elevationFt: 20 });
    expect(find(stateOf(o), 'f').elevationFt).toBe(20);
    const walker = fight(battleMap(16, 12), [creature('w', 'enemy', 'A1', { elevationFt: 10 })]);
    const p = moved(plan(walker, 'w', 'B1'));
    expect(p.notes).toContainEqual({ kind: 'airborne-walker', elevationFt: 10 });
    expect(find(stateOf(move(walker, 'w', 'B1')), 'w').elevationFt).toBe(10);
  });
  it('defaults to flying when airborne or without a walking Speed', () => {
    const state = fight(battleMap(16, 12), [creature('f', 'enemy', 'A1', { speeds: { fly: 30 } }), creature('g', 'enemy', 'B3', { speeds: { walk: 30, fly: 50 }, elevationFt: 15 })]);
    expect(turnBudget(state, null, 'f')).toMatchObject({ mode: 'fly', speedFt: 30 });
    expect(turnBudget(state, null, 'g')).toMatchObject({ mode: 'fly', speedFt: 50 });
  });
  it('a Prone or Incapacitated flier without hover can’t fly', () => {
    const aloft = fight(battleMap(16, 12), [flier({ elevationFt: 20, conditions: [{ id: 'prone' }] })]);
    expect(refusal(plan(aloft, 'f', 'B1'))).toEqual({ code: 'speed-zero', because: 'Prone: it falls instead' });
    const hovering = fight(battleMap(16, 12), [flier({ elevationFt: 20, conditions: [{ id: 'prone' }], speeds: { walk: 10, fly: 60, hover: true } })]);
    expect(moved(plan(hovering, 'f', 'B1'))).toMatchObject({ costFt: 5 });
    const knockedDown = fight(battleMap(16, 12), [flier({ conditions: [{ id: 'prone' }] })]);
    expect(refusal(plan(knockedDown, 'f', 'B1', { mode: 'fly', stayProne: true }))).toEqual({ code: 'speed-zero', because: "Prone: it can't fly without standing up" });
    expect(moved(plan(knockedDown, 'f', 'B1', { mode: 'fly' }))).toMatchObject({ notes: [{ kind: 'stood-up', costFt: 5 }] });
    const stunned = fight(battleMap(16, 12), [flier({ elevationFt: 20, conditions: [{ id: 'stunned' }] })]);
    expect(refusal(plan(stunned, 'f', 'B1'))).toEqual({ code: 'speed-zero', because: 'Incapacitated: it falls instead' });
    expect(refusal(plan(fight(battleMap(16, 12), [creature('x', 'enemy', 'A1')]), 'x', 'B1', { mode: 'fly' }))).toEqual({
      code: 'bad-request',
      problem: 'x has no Fly Speed.',
    });
  });
  it('flying straight up out of reach provokes', () => {
    const state = fight(battleMap(16, 12), [flier({ position: P('B1') }), creature('h', 'player', 'A1')]);
    const p = stopped(plan(state, 'f', 'B1', { mode: 'fly', elevationFt: 20 }, mira));
    expect(p.reactors.map((r) => r.reactorId)).toEqual(['h']);
    expect(p.at).toEqual(P('B1'));
  });
});

describe('via waypoints and places (spec §3.4.5; D22)', () => {
  it('passes the waypoints in order', () => {
    const state = fight(battleMap(16, 12), [creature('m', 'enemy', 'A1')]);
    const p = moved(plan(state, 'm', 'E1', { via: [P('C3')] }));
    expect(route(p)).toBe('A1 B2 C3 D2 E1');
    expect(p.costFt).toBe(20);
    expect(refusal(plan(state, 'm', 'E1', { via: [P('Q3')] }))).toEqual({ code: 'off-map', to: P('Q3') });
    expect(refusal(plan(state, 'm', 'E1', { via: [P('D5')] }))).toMatchObject({ code: 'too-far', needFt: 40, leftFt: 30, dashWouldReach: true });
  });
  it('a place: the cheapest square inside it', () => {
    const p = moved(applyMove(fixture(), mira, { moverId: 'c-2', kind: 'move', by: 'dm', to: { kind: 'place', placeId: 'p9' } }));
    expect(route(p)).toBe('F4 G4 H3 I3 J3 K3 L3'); // ties on (feet, diagonals) go to the first found (E before NE)
    expect(p.costFt).toBe(30);
  });
  it('a Large creature prefers a space wholly inside the place', () => {
    const map = { ...battleMap(16, 12), places: [{ id: 'p1', name: 'the dais', rects: [R('E1', 'G2')] }] };
    const state = fight(map, [creature('o', 'enemy', 'A1', { size: 'Large' })]);
    expect(moved(plan(state, 'o', 'E1', { to: { kind: 'place', placeId: 'p1' } })).to).toEqual(P('E1'));
    expect(refusal(plan(state, 'o', 'E1', { to: { kind: 'place', placeId: 'nowhere' } }))).toMatchObject({ code: 'bad-request' });
  });
});

describe('Tiny creatures share squares (app convention C4)', () => {
  it('up to 4 Tiny creatures in a square, never with a larger one', () => {
    const tiny = (id: string, at: string) => creature(id, 'enemy', at, { size: 'Tiny' });
    const four = fight(battleMap(16, 12), [tiny('r1', 'A1'), tiny('r2', 'C1'), tiny('r3', 'C1'), tiny('r4', 'C1'), tiny('r5', 'C1')]);
    expect(refusal(plan(four, 'r1', 'C1'))).toMatchObject({ code: 'occupied' });
    const three = fight(battleMap(16, 12), [tiny('r1', 'A1'), tiny('r2', 'C1'), tiny('r3', 'C1'), tiny('r4', 'C1')]);
    expect(moved(plan(three, 'r1', 'C1')).costFt).toBe(10);
    const withMedium = fight(battleMap(16, 12), [tiny('r1', 'A1'), creature('b', 'enemy', 'C1')]);
    expect(refusal(plan(withMedium, 'r1', 'C1'))).toMatchObject({ code: 'occupied', byId: 'b' });
  });
});

describe('refusals and partial moves (D24)', () => {
  it('occupied: the nearest open squares, or a move there with partial', () => {
    const state = fixture({ turnId: 'c-3', patch: { 'c-3': { conditions: [] } } });
    const r = refusal(plan(state, 'c-3', 'B6'));
    expect(r).toMatchObject({ code: 'occupied', at: P('B6'), byId: 'c-1' });
    expect(r.code === 'occupied' && labels(r.open)).toBe('C5 C6 B7');
    expect(moved(plan(state, 'c-3', 'B6', { partial: true })).to).toEqual(P('C5'));
  });
  it('no route: the closest it can get', () => {
    const map = battleMap(8, 6, [wall('D1', 'D6')]);
    const r = refusal(plan(fight(map, [creature('m', 'enemy', 'A1')]), 'm', 'H1'));
    expect(r).toEqual({ code: 'no-route', closest: { at: P('C1'), costFt: 10 } });
    expect(moved(plan(fight(map, [creature('m', 'enemy', 'A1')]), 'm', 'H1', { partial: true })).to).toEqual(P('C1'));
  });
});

describe('notes and records', () => {
  it('passing an ally, hazards and lasting effects entered', () => {
    const p = moved(plan(fixture({ turnId: 'c-4' }), 'c-4', 'B7'));
    expect(route(p)).toBe('B5 B6 B7');
    expect(p.notes).toContainEqual({ kind: 'passed-through', ids: ['c-1'] });
    const hot = moved(plan(fixture({ turnId: 'c-2', at: { 'c-2': 'F10' } }), 'c-2', 'G11'));
    expect(hot.notes).toContainEqual({ kind: 'entered', label: 'brazier', at: P('G11') });
  });
  it('its own lasting emanation now covers someone (srd:spell:spirit-guardians)', () => {
    const base = fixture({ turnId: 'c-2' });
    const guardians: MapEffect = {
      id: 'e10',
      label: 'Spirit Guardians',
      spec: { shape: 'emanation', sizeFt: 15, fromId: 'c-2' },
      rects: [],
      terrain: ['difficult'],
      duration: 'lasting',
      round: 2,
      turnOfId: 'c-2',
    };
    const state = { ...base, map: { ...(base.map as BattleMap), effects: [guardians] } };
    const o = move(state, 'c-2', 'E4');
    expect(moved(o).notes).toContainEqual({ kind: 'emanation-reached', label: 'Spirit Guardians', ids: ['c-1', 'c-4'] });
  });
  it('the hero moved by the DM stands up: the caller writes the Character', () => {
    const prone = sampleCharacter({ conditions: [{ id: 'prone' }] });
    const o = move(fixture({ heroTurn: true }), 'c-1', 'A7', {}, prone);
    expect(moved(o)).toMatchObject({ heroStoodUp: true, costFt: 5, notes: [{ kind: 'stood-up', costFt: 15 }] });
    expect(stateOf(o).map?.turn?.moves[0]).toMatchObject({ by: 'dm', stoodUp: true, costFt: 5 });
  });
  it('a stop keeps the options that make a repeat exact', () => {
    const o = move(fixture({ at: { 'c-2': 'C5' } }), 'c-2', 'F4', { dash: true, disengage: false, prefer: 'shortest', mode: 'walk' });
    expect(stateOf(o).map?.stop?.opts).toEqual({ dash: true, prefer: 'shortest', mode: 'walk' });
  });
  it('another creature’s stop that no longer counts is pruned on the next write; a valid one is kept', () => {
    const stoppedState = stateOf(move(fixture({ at: { 'c-2': 'C5' } }), 'c-2', 'F4'));
    const pushed = stateOf(applyMove(stoppedState, mira, { moverId: 'c-3', kind: 'forced', by: 'dm', push: { distanceFt: 5, direction: 'north' } }));
    expect(pushed.map?.stop?.moverId).toBe('c-2');
    const later = stateOf(applyMove(nextTurn(stoppedState), mira, { moverId: 'c-3', kind: 'forced', by: 'dm', push: { distanceFt: 5, direction: 'north' } }));
    expect(later.map?.stop).toBeUndefined();
  });
  it('itemises at most 40 moves a turn; later ones still count', () => {
    const base = fixture();
    const moves = Array.from({ length: 40 }, () => ({ by: 'dm' as const, kind: 'move' as const, from: P('F4'), to: P('F4'), path: [], costFt: 0, provoked: [], entered: [] }));
    const map = { ...(base.map as BattleMap), turn: { combatantId: 'c-2', round: 2, movedFt: 0, dashFt: 0, dashes: 0, disengaged: false, stoodUp: false, moves } };
    const after = stateOf(move({ ...base, map }, 'c-2', 'E4'));
    expect(after.map?.turn).toMatchObject({ movedFt: 5 });
    expect(after.map?.turn?.moves).toHaveLength(40);
  });
});

describe('the true-map replay of the player’s move (app convention C24)', () => {
  it('an unseen creature’s space costs more than the preview: stops on the last affordable open square', () => {
    const state = fight(battleMap(16, 12), [creature('h', 'player', 'A1'), creature('g', 'enemy', 'C1', { size: 'Huge', hidden: true })]);
    expect(moved(planMove(state, mira, { moverId: 'h', kind: 'move', by: 'player', to: { kind: 'square', at: P('G1') } }, { perspective: 'player' })).costFt).toBe(30);
    const out = applyHeroMove(state, mira, heroMove('G1'), { stopResolved: true });
    if (out.status === 'refused') throw new Error(JSON.stringify(out.refusal));
    expect(out).toMatchObject({ status: 'stopped', stoppedFor: { kind: 'out-of-movement' }, revealedHidden: true });
    expect(out.move).toMatchObject({ to: P('B1'), path: [P('B1')], costFt: 5, revealedHidden: true });
  });
  it('the player view plans as if hidden creatures weren’t there', () => {
    const state = fixture({ heroTurn: true, at: { 'c-5': 'B9' } });
    const view = planMove(state, mira, { moverId: 'c-1', kind: 'move', by: 'player', to: { kind: 'square', at: P('B11') } }, { perspective: 'player' });
    expect(route(moved(view))).toBe('B6 B7 B8 B9 B10 B11');
    const triggers = opportunityTriggers(fixture({ heroTurn: true, at: { 'c-5': 'C6' } }), mira, 'c-1', [P('B6'), P('B7'), P('B8')], {
      disengaged: false,
      kind: 'move',
      perspective: 'player',
    });
    expect(triggers).toEqual([]);
  });
  it('opportunityTriggers: ignoreIds, Disengage and kinds that never provoke', () => {
    const state = fixture({ at: { 'c-2': 'C5' } });
    const path = [P('C5'), P('D5'), P('E4')];
    expect(opportunityTriggers(state, mira, 'c-2', path, { disengaged: false, kind: 'move' }).map((t) => t.reactorId)).toEqual(['c-1', 'c-4']);
    expect(opportunityTriggers(state, mira, 'c-2', path, { disengaged: false, kind: 'move', ignoreIds: ['c-1'] }).map((t) => t.reactorId)).toEqual(['c-4']);
    expect(opportunityTriggers(state, mira, 'c-2', path, { disengaged: true, kind: 'move' })).toEqual([]);
    expect(opportunityTriggers(state, mira, 'c-2', path, { disengaged: false, kind: 'forced' })).toEqual([]);
  });
});

describe('determinism: the same plans on a shuffled combatant list (spec §9.1)', () => {
  const cases: [string, () => CombatState, MoveRequest][] = [
    ['M16', () => fixture({ turnId: 'c-3', at: { 'c-2': 'C5' } }), { moverId: 'c-3', kind: 'move', by: 'dm', to: { kind: 'square', at: P('A7') } }],
    ['M17', () => fixture({ turnId: 'c-6' }), { moverId: 'c-6', kind: 'move', by: 'dm', to: { kind: 'creature', id: 'c-1' } }],
    ['M22', () => fixture({ at: { 'c-2': 'C5' } }), { moverId: 'c-2', kind: 'move', by: 'dm', to: { kind: 'square', at: P('F4') } }],
    ['M23', () => fixture({ turnId: 'c-4', at: { 'c-2': 'C5' } }), { moverId: 'c-4', kind: 'move', by: 'dm', to: { kind: 'square', at: P('A7') } }],
    ['M28', () => fixture({ heroTurn: true }), { moverId: 'c-1', kind: 'teleport', by: 'dm', to: { kind: 'square', at: P('F3') } }],
  ];
  for (const [name, make, req] of cases) {
    it(name, () => {
      expect(planMove(shuffled(make()), mira, req)).toEqual(planMove(make(), mira, req));
      const a = applyMove(shuffled(make()), mira, req);
      const b = applyMove(make(), mira, req);
      if (b.status !== 'refused') expect(stateOf(a).map).toEqual(stateOf(b).map);
    });
  }
  it('reachableSquares', () => {
    const s = fixture({ heroTurn: true, at: { 'c-2': 'C5' } });
    expect(reachableSquares(shuffled(s), mira, 'c-1')).toEqual(reachableSquares(s, mira, 'c-1'));
  });
});
