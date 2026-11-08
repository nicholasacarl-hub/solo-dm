import { describe, expect, it, vi } from 'vitest';
import type { BattleMap, Combatant, CombatState, GridPoint, MapEffect, MapTurn, TurnMove } from '@/types';
import { sampleBattleMap, sampleCharacter, sampleMappedCombat, sampleStopCombat } from '@/test/fixtures';
import { nextTurn } from './combat';
import { parseSquare, parseSquareList, rectLabel, squareLabel } from './grid';
import { mapCells } from './mapCells';
import { applyHeroMove } from './movement';
import { coverAgainst } from './sight';

// A pass-through spy, so a test can count how often a snapshot works out cover (K2); results are the real ones.
vi.mock('./sight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sight')>();
  return { ...actual, coverAgainst: vi.fn(actual.coverAgainst) };
});
import {
  addAreaEffect,
  createBattleMap,
  editMap,
  findMapCombatant,
  findPlace,
  isToldAndAnswered,
  mapGlyphGrid,
  mapSnapshot,
  mapWarnings,
  placeCombatants,
  playerEffectLabel,
  playerTurnIndex,
  playerView,
  refitFootprints,
  removeBattleMap,
  stampMapTold,
  turnStartReport,
  type BattleMapInput,
} from './battleMap';

const DIMS = { width: 16, height: 12 };
const sq = (label: string): GridPoint => {
  const p = parseSquare(label, DIMS);
  if (!p.ok) throw new Error(p.problem);
  return p.value;
};
const rects = (text: string) => {
  const r = parseSquareList(text, DIMS);
  if (!r.ok) throw new Error(r.problem);
  return r.value;
};
const hero = sampleCharacter();
const at = (state: CombatState, id: string) => {
  const p = state.combatants.find((c) => c.id === id)?.position;
  return p ? squareLabel(p) : null;
};
const move = (state: CombatState, id: string, label: string | null): CombatState => ({
  ...state,
  combatants: state.combatants.map((c) => (c.id === id ? { ...c, position: label ? sq(label) : undefined } : c)),
});
const patch = (state: CombatState, id: string, p: Partial<Combatant>): CombatState => ({
  ...state,
  combatants: state.combatants.map((c) => (c.id === id ? { ...c, ...p } : c)),
});
const withMap = (state: CombatState, p: Partial<BattleMap>): CombatState => ({ ...state, map: { ...(state.map as BattleMap), ...p } });

/** The §4.5 setup call's map input (the warehouse fixture without ids). */
const warehouseInput = (): BattleMapInput => ({
  name: 'Dockside warehouse',
  width: 16,
  height: 12,
  terrain: [
    { kind: 'wall', rects: rects('L5:P5'), label: 'office wall' },
    { kind: 'door', rects: rects('N5'), label: 'office door' },
    { kind: 'wall', rects: rects('I4'), label: 'pillar' },
    { kind: 'half-cover', rects: rects('E5:F6'), label: 'crates' },
    { kind: 'difficult', rects: rects('H8:J9'), label: 'spilled grain' },
    { kind: 'deep-water', rects: rects('N10:P12'), label: 'flooded dock' },
    { kind: 'hazard', rects: rects('G11'), label: 'brazier' },
  ],
  places: [
    { name: 'the loading door', rects: rects('A5:B7') },
    { name: 'the office', rects: rects('L1:P4') },
  ],
});

const playerMove = (from: string, to: string, extra: Partial<TurnMove> = {}): TurnMove => ({
  by: 'player',
  kind: 'move',
  from: sq(from),
  to: sq(to),
  path: [sq(to)],
  costFt: 5,
  provoked: [],
  entered: [],
  ...extra,
});

describe('createBattleMap and removeBattleMap', () => {
  it('B1: ids t1…/p1… and map-1 from the counter; the §4.5 input gives exactly the fixture', () => {
    expect(createBattleMap(warehouseInput())).toEqual(sampleBattleMap());
  });

  it('B1: rects are clipped, empty ones dropped (without using an id); a replacement carries the turn and continues the ids', () => {
    const map = createBattleMap({
      width: 10,
      height: 8,
      terrain: [
        { kind: 'wall', rects: [{ x0: 20, y0: 0, x1: 25, y1: 3 }] },
        { kind: 'wall', rects: [{ x0: 8, y0: 6, x1: 12, y1: 9 }, { x0: 30, y0: 30, x1: 31, y1: 31 }], label: '  the   old wall ' },
        { kind: 'door', rects: [{ x0: 1, y0: 1, x1: 1, y1: 1 }] },
      ],
      places: [{ name: 'nowhere', rects: [{ x0: 50, y0: 50, x1: 51, y1: 51 }] }, { name: 'the bar', rects: rects('B2:E3') }],
    });
    expect(map.id).toBe('map-1');
    expect(map.terrain).toEqual([
      { id: 't1', kind: 'wall', rects: [{ x0: 8, y0: 6, x1: 9, y1: 7 }], label: 'the old wall' },
      { id: 't2', kind: 'door', rects: [{ x0: 1, y0: 1, x1: 1, y1: 1 }], door: 'closed' },
    ]);
    expect(map.places).toEqual([{ id: 'p3', name: 'the bar', rects: rects('B2:E3') }]);
    expect(map.nextId).toBe(4);
    const turn: MapTurn = { combatantId: 'c-2', round: 2, movedFt: 10, dashFt: 0, dashes: 0, disengaged: false, stoodUp: false, moves: [] };
    const previous: BattleMap = { ...sampleBattleMap(), turn, stop: sampleStopCombat().map?.stop, effects: [] };
    const replaced = createBattleMap({ width: 99, height: 2, terrain: [{ kind: 'pit', rects: rects('B2') }] }, previous);
    expect(replaced).toMatchObject({ id: 'map-10', width: 40, height: 4, nextId: 11, rev: 1, turn, effects: [] });
    expect(replaced.terrain[0].id).toBe('t10');
    expect(replaced.stop).toBeUndefined();
    // An empty replacement still moves the counter on, so the next map gets a new id.
    const empty = createBattleMap({ width: 10, height: 10 }, replaced);
    expect(empty.id).toBe('map-11');
    expect(createBattleMap({ width: 10, height: 10 }, empty).id).toBe('map-12');
  });

  it('removeBattleMap drops the map and every position and elevation; sizes, speeds, reach, hidden and reactions stay', () => {
    const state = patch(sampleMappedCombat(), 'c-2', { elevationFt: 10, reactionUsed: true, reachFt: 10 });
    const removed = removeBattleMap(state);
    expect(removed.map).toBeUndefined();
    expect('map' in removed).toBe(false);
    for (const c of removed.combatants) {
      expect(c.position).toBeUndefined();
      expect(c.elevationFt).toBeUndefined();
    }
    expect(removed.combatants.find((c) => c.id === 'c-2')).toMatchObject({ reactionUsed: true, reachFt: 10 });
    expect(removed.combatants.find((c) => c.id === 'c-5')?.hidden).toBe(true);
    expect(removed.combatants.find((c) => c.id === 'c-6')).toMatchObject({ size: 'Large', speeds: { walk: 40 } });
  });
});

describe('placeCombatants (app convention C27)', () => {
  const unplaced = (): CombatState => ({ ...sampleMappedCombat(), combatants: sampleMappedCombat().combatants.map(({ position: _p, ...c }) => c) });

  it('B2: Bandit ×2 at F4; Old Tam auto; an auto enemy; a requested wall square', () => {
    const { state, placed } = placeCombatants(unplaced(), hero, [
      { ids: ['c-1'], anchor: { kind: 'square', at: sq('B6') } },
      { ids: ['c-2', 'c-3'], anchor: { kind: 'square', at: sq('F4') } },
      { ids: ['c-4'], anchor: { kind: 'auto' } },
      { ids: ['c-6'], anchor: { kind: 'auto' } },
      { ids: ['c-5'], anchor: { kind: 'square', at: sq('I4') } },
    ]);
    expect(placed).toEqual([
      { id: 'c-1', at: sq('B6'), auto: false },
      { id: 'c-2', at: sq('F4'), auto: false },
      { id: 'c-3', at: sq('F3'), auto: true, why: 'next to Bandit 1' },
      { id: 'c-4', at: sq('B5'), auto: true, why: 'next to Mira Voss' },
      { id: 'c-6', at: sq('O7'), auto: true, why: 'across the map from Mira Voss' },
      { id: 'c-5', at: sq('I3'), auto: false, shiftedFrom: sq('I4'), why: 'I4 is a wall' },
    ]);
    expect(at(state, 'c-3')).toBe('F3');
    // Never within 5 ft of the hero: the Large ogre's space O7:P8 is far away.
    const snap = mapSnapshot(state, hero, { perspective: 'dm' });
    expect(snap?.tokens.find((t) => t.id === 'c-6')?.distanceFromHeroFt).toBeGreaterThan(5);
  });

  it('an enemy may start next to the hero only on a square that was asked for (the demo cutpurse at E4)', () => {
    const base = unplaced();
    const first = placeCombatants(base, hero, [
      { ids: ['c-1'], anchor: { kind: 'square', at: sq('D3') } },
      { ids: ['c-2', 'c-3'], anchor: { kind: 'square', at: sq('E4') } },
    ]);
    expect(first.placed[1]).toEqual({ id: 'c-2', at: sq('E4'), auto: false });
    // The second bandit spreads from E4 but not next to the hero (D3).
    const second = first.placed[2].at as GridPoint;
    expect(Math.max(Math.abs(second.x - 3), Math.abs(second.y - 2))).toBeGreaterThan(1);
    // Spreading members also avoid hazards, pits and deep water.
    const wet = placeCombatants(withMap(base, {}), hero, [{ ids: ['c-2', 'c-3', 'c-4'], anchor: { kind: 'square', at: sq('O11') } }]);
    expect(wet.placed[0]).toMatchObject({ shiftedFrom: sq('O11'), why: 'O11 is deep water' });
    for (const p of wet.placed) expect((p.at as GridPoint).x < 13 || (p.at as GridPoint).y < 9).toBe(true);
  });

  it("an occupied requested square shifts with why; 'squares' gives one square each; a place fills from its middle", () => {
    const base = unplaced();
    const { placed, state } = placeCombatants(base, hero, [
      { ids: ['c-1'], anchor: { kind: 'square', at: sq('B6') } },
      { ids: ['c-2'], anchor: { kind: 'square', at: sq('B6') } },
      { ids: ['c-3', 'c-4', 'c-5'], anchor: { kind: 'squares', at: [sq('J2'), sq('K2')] } },
      { ids: ['c-6'], anchor: { kind: 'place', placeId: 'p9' } },
    ]);
    expect(placed[1]).toMatchObject({ id: 'c-2', shiftedFrom: sq('B6'), why: "B6 is Mira Voss's space" });
    expect(placed[1].at).not.toEqual(sq('B6'));
    expect(placed.slice(2, 4).map((p) => p.at)).toEqual([sq('J2'), sq('K2')]);
    expect(placed[4]).toMatchObject({ id: 'c-5', auto: true, why: 'next to Old Tam' });
    // The Large ogre in the office (L1:P4): wholly inside it, near its middle.
    const ogre = state.combatants.find((c) => c.id === 'c-6')?.position as GridPoint;
    expect(ogre.x).toBeGreaterThanOrEqual(11);
    expect(ogre.y + 1).toBeLessThanOrEqual(3);
    expect(placed[5]).toEqual({ id: 'c-6', at: ogre, auto: false });
  });

  it('reinforcements arrive at the middle of the edge farthest from the hero; elevation is set when given', () => {
    const base = move(sampleMappedCombat(), 'c-5', null);
    const { placed, state } = placeCombatants(base, hero, [{ ids: ['c-5'], anchor: { kind: 'auto', arriving: true }, elevationFt: 12 }]);
    // Mira at B6: the east edge is farthest (14 squares).
    expect(placed[0]).toEqual({ id: 'c-5', at: sq('P7'), auto: true, why: 'arriving from the east edge' });
    expect(state.combatants.find((c) => c.id === 'c-5')?.elevationFt).toBe(10);
  });

  it('is deterministic and leaves creatures outside the requests where they are', () => {
    const base = unplaced();
    const reqs = [
      { ids: ['c-1'], anchor: { kind: 'auto' as const } },
      { ids: ['c-2', 'c-3', 'c-5'], anchor: { kind: 'auto' as const } },
      { ids: ['c-4'], anchor: { kind: 'auto' as const } },
    ];
    const a = placeCombatants(base, hero, reqs);
    const b = placeCombatants({ ...base, combatants: [...base.combatants].reverse() }, hero, reqs);
    expect(b.placed).toEqual(a.placed);
    expect(a.placed[0]).toEqual({ id: 'c-1', at: sq('I11'), auto: true });
    expect(at(a.state, 'c-6')).toBeNull();
    const kept = placeCombatants(sampleMappedCombat(), hero, [{ ids: ['c-4'], anchor: { kind: 'auto' } }]);
    expect(at(kept.state, 'c-2')).toBe('F4');
  });

  it('reports unknown ids and a missing map instead of throwing', () => {
    expect(placeCombatants(sampleMappedCombat(), hero, [{ ids: ['nobody'], anchor: { kind: 'auto' } }]).placed).toEqual([
      { id: 'nobody', at: null, auto: false, why: 'not in this fight' },
    ]);
    const { map: _m, ...noMap } = sampleMappedCombat();
    expect(placeCombatants(noMap, hero, [{ ids: ['c-2'], anchor: { kind: 'auto' } }]).placed[0].at).toBeNull();
  });
});

describe('editMap', () => {
  it('B3: one unknown door label among valid edits refuses the whole edit; the state is unchanged (atomic)', () => {
    const state = sampleMappedCombat();
    const result = editMap(state, hero, {
      terrainAdd: [{ kind: 'difficult', rects: rects('G7:J10'), label: 'rubble' }],
      doors: [
        { at: sq('N5'), state: 'open' },
        { at: { label: 'cellar hatch' }, state: 'open' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toBe('There is no door labelled "cellar hatch". Doors on this map: office door (N5).');
    expect(state).toEqual(sampleMappedCombat());
  });

  it('B4: closing the door N5 while the Cutthroat stands in it is refused (app convention C28)', () => {
    const opened = editMap(sampleMappedCombat(), hero, { doors: [{ at: { label: 'Office Door' }, state: 'open' }] });
    if (!opened.ok) throw new Error(opened.problem);
    expect(opened.changes).toEqual([{ kind: 'door', at: sq('N5'), state: 'open', label: 'office door' }]);
    const standing = move(opened.state, 'c-5', 'N5');
    expect(editMap(standing, hero, { doors: [{ at: sq('N5'), state: 'closed' }] })).toEqual({ ok: false, problem: 'Cutthroat stands in the door at N5' });
    expect(editMap(standing, hero, { doors: [{ at: sq('N5'), state: 'locked' }] }).ok).toBe(false);
    expect(editMap(standing, hero, { doors: [{ at: sq('M5'), state: 'closed' }] })).toEqual({
      ok: false,
      problem: 'There is no door at M5. Doors on this map: office door (N5).',
    });
  });

  it('B5: Bandit 1 grows to Large at F4 beside the crates (F4:G5 is legal); at H4 the pillar moves it (D39)', () => {
    const grown = editMap(sampleMappedCombat(), hero, { creatures: [{ id: 'c-2', size: 'Large' }] });
    if (!grown.ok) throw new Error(grown.problem);
    expect(grown.changes).toEqual([{ kind: 'creature', id: 'c-2', patch: { size: 'Large' } }]);
    expect(at(grown.state, 'c-2')).toBe('F4');
    const byPillar = editMap(move(sampleMappedCombat(), 'c-2', 'H4'), hero, { creatures: [{ id: 'c-2', size: 'Large' }] });
    if (!byPillar.ok) throw new Error(byPillar.problem);
    expect(byPillar.changes).toEqual([{ kind: 'creature', id: 'c-2', patch: { size: 'Large' }, moved: { from: sq('H4'), to: sq('G4') } }]);
    expect(at(byPillar.state, 'c-2')).toBe('G4');
  });

  it('adds and clears terrain, renames places, changes speeds and ends effects; rev bumps for layout changes only', () => {
    const state = withMap(sampleMappedCombat(), {
      effects: [
        {
          id: 'e10',
          label: 'Web',
          spec: { shape: 'cube', sizeFt: 20, at: { kind: 'square', at: sq('H8') } },
          rects: rects('G7:J10'),
          terrain: ['difficult', 'obscured'],
          duration: 'lasting',
          round: 2,
          turnOfId: 'c-1',
        },
      ],
      nextId: 11,
    });
    const result = editMap(state, hero, {
      terrainAdd: [{ kind: 'difficult', rects: rects('C1:C3'), label: 'rubble' }],
      terrainClear: [{ label: 'crates' }, { rects: rects('H8:H9') }],
      placesAdd: [{ name: 'the stairs', rects: rects('C1:C3') }],
      placesRemove: ['office'],
      creatures: [
        { id: 'c-3', speedChangeFt: -10 },
        { id: 'c-1', speeds: { fly: 60, hover: true } },
      ],
      effectsEnd: ['web'],
    });
    if (!result.ok) throw new Error(result.problem);
    expect(result.changes).toEqual([
      { kind: 'terrain-added', feature: { id: 't11', kind: 'difficult', rects: rects('C1:C3'), label: 'rubble' } },
      { kind: 'terrain-cleared', squares: 4, labels: ['crates'] },
      { kind: 'terrain-cleared', squares: 2, labels: ['spilled grain'] },
      { kind: 'place-added', name: 'the stairs' },
      { kind: 'place-removed', name: 'the office' },
      { kind: 'effect-ended', label: 'Web' },
      { kind: 'creature', id: 'c-3', patch: { speedChangeFt: -10 } },
      { kind: 'creature', id: 'c-1', patch: { speeds: { fly: 60, hover: true } } },
    ]);
    const map = result.state.map as BattleMap;
    expect(map.terrain.find((t) => t.label === 'spilled grain')?.rects.map(rectLabel)).toEqual(['I8:J9']);
    expect(map.terrain.some((t) => t.label === 'crates')).toBe(false);
    expect(map.places.map((p) => p.name)).toEqual(['the loading door', 'the stairs']);
    expect(map.effects).toEqual([]);
    expect(map.rev).toBe(1);
    expect(map.nextId).toBe(13);
    expect(result.state.combatants.find((c) => c.id === 'c-3')?.speedChangeFt).toBe(-10);
    // speedChangeFt 0 clears it; creature-only edits don't bump rev.
    const cleared = editMap(result.state, hero, { creatures: [{ id: 'c-3', speedChangeFt: 0 }] });
    if (!cleared.ok) throw new Error(cleared.problem);
    expect(cleared.state.combatants.find((c) => c.id === 'c-3')).not.toHaveProperty('speedChangeFt');
    expect(cleared.state.map?.rev).toBe(1);
  });

  it('refuses walls on a creature, unknown labels, places and effects with a sentence that lists what exists', () => {
    const state = sampleMappedCombat();
    const problem = (edit: Parameters<typeof editMap>[2]) => {
      const r = editMap(state, hero, edit);
      return r.ok ? null : r.problem;
    };
    // Creatures are checked in initiative order: Bandit 1 (F4) before Bandit 2 (F3).
    expect(problem({ terrainAdd: [{ kind: 'wall', rects: rects('F3:F4') }] })).toBe('Bandit 1 stands at F4: clear that square before putting a wall there');
    expect(problem({ terrainAdd: [{ kind: 'three-quarters-cover', rects: rects('F3') }] })).toBe('Bandit 2 stands at F3: clear that square before putting three-quarters cover there');
    expect(problem({ terrainAdd: [{ kind: 'pit', rects: rects('F3') }] })).toBeNull();
    expect(problem({ terrainClear: [{ label: 'barrels' }] })).toMatch(/No terrain is labelled "barrels"\. Labels on this map: office wall, office door, pillar, crates/);
    expect(problem({ placesRemove: ['balcony'] })).toBe('There is no place called "balcony". Places on this map: the loading door, the office.');
    expect(problem({ placesAdd: [{ name: 'The Office', rects: rects('A1') }] })).toBe('There is already a place called "The Office".');
    expect(problem({ effectsEnd: ['Web'] })).toBe('No effect called "Web" is on the map. Effects: none.');
    expect(problem({ creatures: [{ id: 'c-99', size: 'Huge' }] })).toMatch(/no creature/);
    const { map: _m, ...noMap } = state;
    expect(editMap(noMap, hero, {}).ok).toBe(false);
    // Nothing asked: the same state back.
    const nothing = editMap(state, hero, {});
    expect(nothing.ok && nothing.state).toBe(state);
  });
});

describe('addAreaEffect', () => {
  it('draws a turn-scoped Fireball and a lasting Web with terrain; refuses out of range (srd:rule:casting-spells-range)', () => {
    const state = sampleMappedCombat();
    const fireball = addAreaEffect(state, hero, { shape: 'sphere', sizeFt: 20, at: { kind: 'square', at: sq('G4') }, fromId: 'c-1' }, { label: 'Fireball', lasting: false, rangeFt: 150 });
    if (!fireball.ok) throw new Error(fireball.problem);
    expect(fireball.effect).toMatchObject({ id: 'e10', label: 'Fireball', duration: 'turn', round: 2, turnOfId: 'c-2', terrain: [] });
    expect(fireball.result.inside.map((h) => h.id)).toEqual(['c-2', 'c-3']);
    expect(fireball.state.map).toMatchObject({ nextId: 11, rev: 1 });
    const web = addAreaEffect(fireball.state, hero, { shape: 'cube', sizeFt: 20, at: { kind: 'square', at: sq('H8') } }, { label: 'Web', lasting: true, terrain: ['obscured', 'difficult', 'obscured'] });
    if (!web.ok) throw new Error(web.problem);
    expect(web.effect).toMatchObject({ id: 'e11', duration: 'lasting', terrain: ['difficult', 'obscured'] });
    expect(web.effect.rects.map(rectLabel)).toEqual(['G7:J10']);
    expect(web.state.map?.effects.map((e) => e.label)).toEqual(['Fireball', 'Web']);
    expect(addAreaEffect(state, hero, { shape: 'sphere', sizeFt: 20, at: { kind: 'square', at: sq('G4') }, fromId: 'c-1' }, { label: 'Fireball', lasting: false, rangeFt: 20 })).toEqual({
      ok: false,
      problem: 'Fireball: G4 is 25 ft from Mira Voss, beyond its 20-ft range.',
    });
    // The next visible turn's write prunes the expired Fireball (through the hidden Cutthroat's turn the player
    // still sees Bandit 1's: U9).
    const later = addAreaEffect(nextTurn(nextTurn(web.state)), hero, { shape: 'emanation', sizeFt: 10, fromId: 'c-4' }, { label: 'Aura', lasting: false });
    if (!later.ok) throw new Error(later.problem);
    expect(later.state.map?.effects.map((e) => e.label)).toEqual(['Web', 'Aura']);
  });

  it('refuses a thirteenth lasting effect', () => {
    const lasting = (i: number): MapEffect => ({
      id: `e${i}`,
      label: `Fog ${i}`,
      spec: { shape: 'squares', rects: rects('A1') },
      rects: rects('A1'),
      terrain: ['obscured'],
      duration: 'lasting',
      round: 1,
      turnOfId: 'c-1',
    });
    const full = withMap(sampleMappedCombat(), { effects: Array.from({ length: 12 }, (_, i) => lasting(i + 20)), nextId: 40 });
    const r = addAreaEffect(full, hero, { shape: 'squares', rects: rects('B1') }, { label: 'Fog', lasting: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/effects_end/);
  });
});

describe('turnStartReport', () => {
  it('B6: Bandit 1 → Cutthroat: position and budget; inside Web as it starts; the brazier its predecessor ended in', () => {
    const before = sampleMappedCombat();
    const after = nextTurn(before);
    const report = turnStartReport(before, after, hero);
    expect(report).toMatchObject({ currentId: 'c-5', position: sq('M8'), elevationFt: 0, startsInside: [], previous: { id: 'c-2', endedInside: [] }, expired: [] });
    expect(report?.budget).toMatchObject({ combatantId: 'c-5', leftFt: 30, movedFt: 0 });
    const web: MapEffect = {
      id: 'e10',
      label: 'Web',
      spec: { shape: 'cube', sizeFt: 20, at: { kind: 'square', at: sq('M8') } },
      rects: rects('L7:O10'),
      terrain: ['difficult', 'obscured'],
      duration: 'lasting',
      round: 2,
      turnOfId: 'c-2',
    };
    const fireball: MapEffect = { ...web, id: 'e11', label: 'Fireball', rects: rects('A1'), terrain: [], duration: 'turn' };
    const busy = move(withMap(before, { effects: [web, fireball], nextId: 12 }), 'c-2', 'G11');
    const r = turnStartReport(busy, nextTurn(busy), hero);
    expect(r?.startsInside).toEqual(['Web']);
    expect(r?.previous).toEqual({ id: 'c-2', endedInside: ['brazier'] });
    expect(r?.expired).toEqual(['Fireball']);
  });

  it('is null when the turn did not change', () => {
    const state = sampleMappedCombat();
    expect(turnStartReport(state, move(state, 'c-2', 'E4'), hero)).toBeNull();
  });
});

describe('refitFootprints (D39)', () => {
  it('B12: the hero grows to Large against a wall and shifts to the nearest legal anchor', () => {
    const state = patch(
      withMap(sampleMappedCombat(), { terrain: [...sampleBattleMap().terrain, { id: 't10', kind: 'wall', rects: rects('C7') }], nextId: 11 }),
      'c-1',
      { size: 'Large' },
    );
    const { state: refit, moved, unplaced } = refitFootprints(state, hero);
    expect(moved).toEqual([{ id: 'c-1', from: sq('B6'), to: sq('A6') }]);
    expect(unplaced).toEqual([]);
    expect(at(refit, 'c-1')).toBe('A6');
    // Nothing to do: the same positions.
    expect(refitFootprints(sampleMappedCombat(), hero).moved).toEqual([]);
  });

  it('R6: the hero grown to Large beside a Large ogre moves out of the space they would share (D39; SRD Moving around Other Creatures)', () => {
    // Enlarged on the sheet (update_character): B6:C7 would take C7 from the Dock Ogre at C7:D8.
    const enlarged = { ...hero, size: 'Large' as const };
    const state = move(sampleMappedCombat(), 'c-6', 'C7');
    const { state: refit, moved, unplaced } = refitFootprints(state, enlarged);
    expect(moved).toEqual([{ id: 'c-1', from: sq('B6'), to: sq('A6') }]);
    expect(unplaced).toEqual([]);
    expect(at(refit, 'c-6')).toBe('C7');
    expect(mapWarnings(refit, enlarged).filter((w) => w.kind === 'shared-space')).toEqual([]);
    // A flier 15 ft above the ogre's head shares no space with it and stays put (C3).
    const aloft = patch(state, 'c-1', { elevationFt: 15 });
    expect(refitFootprints(aloft, enlarged).moved).toEqual([]);
  });

  it('R6: update_map creatures making Bandit 1 Large beside a Large creature moves Bandit 1 (D39)', () => {
    const state = move(sampleMappedCombat(), 'c-6', 'G5'); // the Dock Ogre at G5:H6; Bandit 1 at F4 would grow to F4:G5
    const edited = editMap(state, hero, { creatures: [{ id: 'c-2', size: 'Large' }] });
    if (!edited.ok) throw new Error(edited.problem);
    expect(edited.changes).toEqual([{ kind: 'creature', id: 'c-2', patch: { size: 'Large' }, moved: { from: sq('F4'), to: sq('E4') } }]);
    expect(at(edited.state, 'c-6')).toBe('G5');
    expect(mapWarnings(edited.state, hero).filter((w) => w.kind === 'shared-space')).toEqual([]);
  });

  it('a creature that no longer fits anywhere is unplaced', () => {
    const tiny = createBattleMap({ width: 4, height: 4, terrain: [{ kind: 'wall', rects: [{ x0: 0, y0: 2, x1: 3, y1: 3 }] }] });
    const state: CombatState = { ...sampleMappedCombat(), map: tiny, combatants: [{ ...sampleMappedCombat().combatants[5], position: { x: 0, y: 0 }, size: 'Huge' }] };
    expect(refitFootprints(state, hero)).toMatchObject({ moved: [], unplaced: ['c-6'] });
  });
});

describe('what the DM was told (D48)', () => {
  const twoMoves = (first: Partial<TurnMove> = {}): CombatState => {
    const state = sampleMappedCombat({ heroTurn: true });
    const turn: MapTurn = {
      combatantId: 'c-1',
      round: 2,
      movedFt: 10,
      dashFt: 0,
      dashes: 0,
      disengaged: false,
      stoodUp: false,
      moves: [playerMove('B6', 'C7', first), playerMove('C7', 'D8'), { ...playerMove('D8', 'D8'), by: 'dm' }],
    };
    return withMap(state, { turn });
  };

  it('B8: stamps unseen player moves; a second stamp changes nothing; an answered move keeps its stamp', () => {
    const state = twoMoves();
    const stamped = stampMapTold(state, 41, () => false);
    expect(stamped.map?.turn?.moves.map((m) => m.toldSeq)).toEqual([41, 41, undefined]);
    expect(stampMapTold(stamped, 41, () => false)).toBe(stamped);
    const answered = twoMoves({ toldSeq: 41 });
    const restamped = stampMapTold(answered, 45, (seq) => seq === 41);
    expect(restamped.map?.turn?.moves.map((m) => m.toldSeq)).toEqual([41, 45, undefined]);
    // Nothing unseen: the same object.
    const seen = stampMapTold(restamped, 50, () => true);
    expect(seen).toBe(restamped);
  });

  it("stamps the player's stop; ignores a stale turn record", () => {
    const stamped = stampMapTold(sampleStopCombat(), 7, () => false);
    expect(stamped.map?.stop?.toldSeq).toBe(7);
    expect(stamped.map?.turn?.moves[0].toldSeq).toBe(7);
    const stale = { ...twoMoves(), round: 3 };
    expect(stampMapTold(stale, 9, () => false)).toBe(stale);
  });

  it('isToldAndAnswered needs a stamp and an answer', () => {
    expect(isToldAndAnswered({}, () => true)).toBe(false);
    expect(isToldAndAnswered({ toldSeq: 3 }, (s) => s === 3)).toBe(true);
    expect(isToldAndAnswered({ toldSeq: 3 }, () => false)).toBe(false);
  });
});

describe('the player view (D42, D63)', () => {
  const cutthroatsTurn = (): CombatState => ({ ...sampleMappedCombat(), turnIndex: 2 });

  it('B9: during the Cutthroat\'s turn the view has no Cutthroat and shows Bandit 1 as current', () => {
    const state = cutthroatsTurn();
    expect(playerTurnIndex(state)).toBe(1);
    const view = playerView(state);
    expect(view.combatants.map((c) => c.id)).toEqual(['c-1', 'c-2', 'c-3', 'c-4', 'c-6']);
    expect(view.turnIndex).toBe(1);
    expect(view.combatants[view.turnIndex].name).toBe('Bandit 1');
    expect(playerView(state)).toBe(view);
  });

  it('B9: hidden reactors leave the stop and the turn moves; a stop with only hidden reactors disappears; a hidden turn record is dropped', () => {
    const stop = sampleStopCombat();
    const map = stop.map as BattleMap;
    const turn = map.turn as MapTurn;
    const mixed = withMap(stop, {
      stop: { ...(map.stop as NonNullable<BattleMap['stop']>), reactorIds: ['c-5', 'c-6'], declinedIds: ['c-5'] },
      turn: {
        ...turn,
        moves: [{ ...turn.moves[0], provoked: [{ reactorId: 'c-5', at: sq('B6'), hidden: true }, { reactorId: 'c-6', at: sq('B6'), hidden: false }] }],
      },
    });
    const view = playerView(mixed);
    expect(view.map?.stop?.reactorIds).toEqual(['c-6']);
    expect(view.map?.stop?.declinedIds).toEqual([]);
    expect(view.map?.turn?.moves[0].provoked).toEqual([{ reactorId: 'c-6', at: sq('B6'), hidden: false }]);
    // The true state is untouched.
    expect(mixed.map?.stop?.reactorIds).toEqual(['c-5', 'c-6']);
    const onlyHidden = withMap(stop, { stop: { ...(map.stop as NonNullable<BattleMap['stop']>), reactorIds: ['c-5'] } });
    expect(playerView(onlyHidden).map?.stop).toBeUndefined();
    const hiddenTurn = withMap(cutthroatsTurn(), {
      turn: { combatantId: 'c-5', round: 2, movedFt: 15, dashFt: 0, dashes: 0, disengaged: false, stoodUp: false, moves: [{ ...playerMove('M8', 'M7'), by: 'dm' }] },
    });
    expect(playerView(hiddenTurn).map?.turn).toBeUndefined();
    expect(JSON.stringify(playerView(hiddenTurn))).not.toContain('c-5');
    // A hero move stopped by the hidden Cutthroat keeps its blocker for the DM only.
    const blocked = withMap(stop, { turn: { ...turn, moves: [{ ...turn.moves[0], revealedHidden: true, blockedById: 'c-5' }] } });
    expect(blocked.map?.turn?.moves[0].blockedById).toBe('c-5');
    expect(playerView(blocked).map?.turn?.moves[0]).not.toHaveProperty('blockedById');
    expect(playerView(blocked).map?.turn?.moves[0].revealedHidden).toBe(true);
  });

  it('is the state itself when nothing is hidden; wraps back to the end when the first creature is hidden', () => {
    const open = patch(sampleMappedCombat(), 'c-5', { hidden: false });
    expect(playerView(open)).toBe(open);
    const first = { ...patch(sampleMappedCombat(), 'c-1', {}), combatants: [{ ...sampleMappedCombat().combatants[2] }, ...sampleMappedCombat().combatants.filter((c) => c.id !== 'c-5')], turnIndex: 0 };
    expect(playerTurnIndex(first)).toBe(5);
    expect(playerView(first).turnIndex).toBe(4);
  });

  const okState = (r: { ok: true; state: CombatState } | { ok: false; problem: string }): CombatState => {
    if (!r.ok) throw new Error(r.problem);
    return r.state;
  };
  const playerEffects = (s: CombatState) => (mapSnapshot(s, hero, { perspective: 'player' })?.effects ?? []).map((e) => e.label);
  const dmEffects = (s: CombatState) => (mapSnapshot(s, hero, { perspective: 'dm' })?.effects ?? []).map((e) => e.label);

  it('K1: when a hidden creature opens a new round, the view stays in the round of the creature it shows (D42)', () => {
    // The Cutthroat first in the order: round 3 opens with its hidden turn, after the Dock Ogre's turn of round 2.
    const base = sampleMappedCombat();
    const [mira, bandit1, cutthroat, ...rest] = base.combatants;
    const ogresTurn: CombatState = { ...base, combatants: [{ ...cutthroat, initiative: 20 }, mira, bandit1, ...rest], turnIndex: 5 };
    const barrel = okState(addAreaEffect(ogresTurn, hero, { shape: 'sphere', sizeFt: 5, at: { kind: 'square', at: sq('H9') } }, { label: 'Thrown barrel', lasting: false }));
    const hiddenTurn = nextTurn(barrel);
    expect([hiddenTurn.round, hiddenTurn.turnIndex]).toEqual([3, 0]);
    const view = playerView(hiddenTurn);
    expect(view.round).toBe(2);
    expect(view.combatants[view.turnIndex].name).toBe('Dock Ogre');
    // What belongs to the Ogre's turn stays in view; the DM's view is the true turn.
    expect(playerEffects(hiddenTurn)).toEqual(['Thrown barrel']);
    expect(dmEffects(hiddenTurn)).toEqual([]);
    // The first visible turn of round 3 brings the round in, and the barrel goes.
    const mirasTurn = nextTurn(hiddenTurn);
    expect(playerView(mirasTurn).round).toBe(3);
    expect(playerEffects(mirasTurn)).toEqual([]);
    // Without a wrap the round is the true one; a hidden creature first in round 1 never shows round 0.
    expect(playerView(cutthroatsTurn()).round).toBe(2);
    expect(playerView({ ...ogresTurn, round: 1, turnIndex: 0 }).round).toBe(1);
  });

  it("U9: a visible creature's turn-scoped area stays in the player's view through the next (hidden) creature's turn, map writes included", () => {
    const flask = okState(addAreaEffect(sampleMappedCombat(), hero, { shape: 'sphere', sizeFt: 5, at: { kind: 'square', at: sq('J6') } }, { label: 'Oil flask', lasting: false }));
    const hiddenTurn = nextTurn(flask); // Bandit 1 → the hidden Cutthroat
    expect(playerEffects(hiddenTurn)).toEqual(['Oil flask']);
    // The DM writes the map during the hidden turn: a door, a quiet stat change, an area that catches nobody visible.
    const writes = [
      okState(editMap(hiddenTurn, hero, { doors: [{ at: { label: 'office door' }, state: 'open' }] })),
      okState(editMap(hiddenTurn, hero, { creatures: [{ id: 'c-5', reachFt: 10 }] })),
      okState(addAreaEffect(hiddenTurn, hero, { shape: 'sphere', sizeFt: 5, at: { kind: 'square', at: sq('N9') } }, { label: 'Smoke dart', lasting: false })),
    ];
    for (const s of writes) {
      expect(playerEffects(s)).toEqual(['Oil flask']);
      expect(dmEffects(s)).not.toContain('Oil flask');
    }
    expect(dmEffects(writes[2])).toEqual(['Smoke dart']);
    // It ends when the next visible creature's turn begins, and the next map write prunes it.
    const bandit2 = nextTurn(writes[0]);
    expect(playerEffects(bandit2)).toEqual([]);
    expect(okState(editMap(bandit2, hero, { doors: [{ at: { label: 'office door' }, state: 'closed' }] })).map?.effects).toEqual([]);
  });

  it("K5: an effect label that names a hidden creature reads 'Area' on every player surface; the DM keeps it (D41, D63)", () => {
    let state = okState(addAreaEffect(sampleMappedCombat({ heroTurn: true }), hero, { shape: 'squares', rects: rects('C7') }, { label: "Cutthroat's caltrops", lasting: true, terrain: ['hazard'] }));
    state = okState(addAreaEffect(state, hero, { shape: 'squares', rects: rects('D7') }, { label: 'Bandit net', lasting: true, terrain: ['difficult'] }));
    // Mira steps into the caltrops on her turn: the move records the label on the true map.
    const moved = applyHeroMove(state, hero, { to: sq('C7'), prefer: 'safest', dash: false, disengage: false, standUp: false }, { stopResolved: true });
    if (moved.status === 'refused') throw new Error(JSON.stringify(moved.refusal));
    expect(moved.state.map?.turn?.moves[0].entered).toEqual(["Cutthroat's caltrops"]);
    const view = playerView(moved.state);
    expect(view.map?.effects.map((e) => e.label)).toEqual(['Area', 'Bandit net']);
    expect(view.map?.turn?.moves[0].entered).toEqual(['Area']);
    expect(playerEffects(moved.state)).toEqual(['Area', 'Bandit net']);
    expect(mapCells(view, hero)?.hazardsAt.get(6 * 16 + 2)).toEqual(['Area']); // C7, what previews and the announcer read
    expect(JSON.stringify(view)).not.toMatch(/cutthroat/i);
    // The DM keeps the label, and so does the player once the Cutthroat is revealed.
    expect(dmEffects(moved.state)).toEqual(["Cutthroat's caltrops", 'Bandit net']);
    expect(playerEffects(patch(moved.state, 'c-5', { hidden: false }))).toEqual(["Cutthroat's caltrops", 'Bandit net']);
    // Plurals count; names a visible creature also answers to say nothing new (Bandit 2 hidden, Bandit 1 in sight).
    expect(playerEffectLabel(moved.state, "the cutthroats' den")).toBe('Area');
    const bandit2Hidden = patch(moved.state, 'c-3', { hidden: true });
    expect(playerEffectLabel(bandit2Hidden, 'Bandit net')).toBe('Bandit net');
    expect(playerEffectLabel(bandit2Hidden, 'Bandit 2’s net')).toBe('Area');
    expect(playerEffectLabel(patch(bandit2Hidden, 'c-2', { hidden: true }), 'Bandit net')).toBe('Area');
    expect(playerEffectLabel(bandit2Hidden, 'Ogre smash')).toBe('Ogre smash');
    // Nothing hidden: the same objects come back.
    const open = patch(moved.state, 'c-5', { hidden: false });
    expect(playerView(open)).toBe(open);
  });
});

describe('lookups', () => {
  it('B14: findMapCombatant takes hero words and names; findPlace ignores case and a leading "the"', () => {
    const state = sampleMappedCombat();
    for (const who of ['hero', 'the hero', 'You', ' The  Hero ']) expect(findMapCombatant(state, who)?.id).toBe('c-1');
    expect(findMapCombatant(state, 'bandit 1')?.id).toBe('c-2');
    expect(findMapCombatant(state, 'c-6')?.name).toBe('Dock Ogre');
    expect(findMapCombatant(state, 'nobody')).toBeUndefined();
    const map: BattleMap = { ...sampleBattleMap(), places: [{ id: 'p1', name: 'the balcony', rects: rects('A1') }] };
    expect(findPlace(map, 'balcony')?.id).toBe('p1');
    expect(findPlace(map, 'The Balcony')?.id).toBe('p1');
    expect(findPlace(sampleBattleMap(), 'Loading Door')?.id).toBe('p8');
    expect(findPlace(sampleBattleMap(), 'p9')?.name).toBe('the office');
    expect(findPlace(sampleBattleMap(), 'cellar')).toBeUndefined();
  });
});

describe('mapSnapshot (D7, D47)', () => {
  it('B10: distances from the hero at round start; nobody in reach', () => {
    const snap = mapSnapshot(sampleMappedCombat(), hero, { perspective: 'dm' });
    if (!snap) throw new Error('no snapshot');
    expect(snap).toMatchObject({ mapId: 'map-1', name: 'Dockside warehouse', width: 16, height: 12, unplacedIds: [], reach: [], stop: null, warnings: [] });
    expect(snap.tokens.map((t) => [t.name, t.distanceFromHeroFt])).toEqual([
      ['Mira Voss', null],
      ['Bandit 1', 20],
      ['Cutthroat', 55],
      ['Bandit 2', 20],
      ['Old Tam', 5],
      ['Dock Ogre', 30],
    ]);
    const mira = snap.tokens[0];
    expect(mira).toMatchObject({ isHero: true, places: ['the loading door'], heroCanSee: true, reachFt: 5, enemiesWithin5: [], space: { x0: 1, y0: 5, x1: 1, y1: 5 } });
    const b1 = snap.tokens[1];
    expect(b1.coverFromHero).toEqual({ degree: 'half', byTerrain: ['crates'], byCreatureIds: [] });
    expect(b1.heroCoverFromIt?.degree).toBe('half');
    expect(b1.heroCanSee).toBe(true);
    expect(snap.tokens.find((t) => t.id === 'c-3')).toMatchObject({ prone: true, reactionUsed: false });
    expect(snap.tokens.find((t) => t.id === 'c-6')).toMatchObject({ size: 'Large', space: { x0: 7, y0: 9, x1: 8, y1: 10 } });
    expect(snap.current?.id).toBe('c-2');
    expect(snap.current?.budget).toMatchObject({ leftFt: 30 });
  });

  it('B10: after Bandit 1 moves to C5, Bandit 1 ↔ Mira and Bandit 1 ↔ Old Tam (pairs are foe first)', () => {
    const snap = mapSnapshot(move(sampleMappedCombat(), 'c-2', 'C5'), hero, { perspective: 'dm' });
    expect(snap?.reach).toEqual([
      { aId: 'c-2', bId: 'c-1', aReachesB: true, bReachesA: true, distanceFt: 5 },
      { aId: 'c-2', bId: 'c-4', aReachesB: true, bReachesA: true, distanceFt: 5 },
    ]);
    expect(snap?.tokens[0].enemiesWithin5).toEqual(['c-2']);
  });

  it('§5.4 Example 2: Bandit 1 ↔ Mira · Bandit 1 ↔ Old Tam · Dock Ogre ↔ Mira; the stop is current', () => {
    const snap = mapSnapshot(sampleStopCombat(), hero, { perspective: 'dm' });
    expect(snap?.reach.map((p) => [p.aId, p.bId])).toEqual([
      ['c-2', 'c-1'],
      ['c-2', 'c-4'],
      ['c-6', 'c-1'],
    ]);
    expect(snap?.tokens[0].enemiesWithin5).toEqual(['c-2', 'c-6']);
    expect(snap?.tokens.find((t) => t.id === 'c-2')?.reactionUsed).toBe(true);
    expect(snap?.stop?.reactorIds).toEqual(['c-6']);
    expect(snap?.current).toMatchObject({ id: 'c-1', moves: [{ by: 'player', costFt: 0 }] });
  });

  it('§5.4 facts by C21: who has cover against the hero, and what gives it (checked with spec-proto/engine.py)', () => {
    const cover = (state: CombatState) =>
      Object.fromEntries(
        (mapSnapshot(state, hero, { perspective: 'dm' })?.tokens ?? [])
          .filter((t) => !t.isHero)
          .map((t) => [t.name, t.coverFromHero && [t.coverFromHero.degree, ...t.coverFromHero.byTerrain, ...t.coverFromHero.byCreatureIds]]),
      );
    // Example 1. Bandit 2 (F3) is Half behind Bandit 1 (F4): from Mira's best corner only Bandit 1's square cuts a line.
    expect(cover(sampleMappedCombat({ heroTurn: true }))).toEqual({
      'Bandit 1': ['half', 'crates'],
      Cutthroat: ['none'],
      'Bandit 2': ['half', 'c-2'],
      'Old Tam': ['none'],
      'Dock Ogre': ['none'],
    });
    // Example 2. With the Ogre at C7:D8 and Bandit 1 at C5, the Cutthroat (M8) has Half Cover too (the Ogre and the crates).
    expect(cover(sampleStopCombat())).toEqual({
      'Bandit 1': ['none'],
      Cutthroat: ['half', 'crates'],
      'Bandit 2': ['half', 'crates', 'c-2'],
      'Old Tam': ['none'],
      'Dock Ogre': ['none'],
    });
  });

  it('the player perspective has no hidden token, and during a hidden turn shows the last visible creature', () => {
    const snap = mapSnapshot({ ...sampleMappedCombat(), turnIndex: 2 }, hero, { perspective: 'player' });
    expect(snap?.tokens.map((t) => t.id)).toEqual(['c-1', 'c-2', 'c-3', 'c-4', 'c-6']);
    expect(snap?.current?.id).toBe('c-2');
    expect(JSON.stringify(snap)).not.toContain('Cutthroat');
    expect(JSON.stringify(snap)).not.toContain('c-5');
    const dm = mapSnapshot({ ...sampleMappedCombat(), turnIndex: 2 }, hero, { perspective: 'dm' });
    expect(dm?.current?.id).toBe('c-5');
  });

  it('lists visible effects: lasting ones, and turn ones on their own turn; an emanation follows its creature', () => {
    const effect = (p: Partial<MapEffect>): MapEffect => ({
      id: 'e1',
      label: 'x',
      spec: { shape: 'squares', rects: rects('A1') },
      rects: rects('A1'),
      terrain: [],
      duration: 'lasting',
      round: 2,
      turnOfId: 'c-2',
      ...p,
    });
    const state = withMap(sampleMappedCombat(), {
      effects: [
        effect({ id: 'e1', label: 'Spirit Guardians', spec: { shape: 'emanation', sizeFt: 5, fromId: 'c-4' }, rects: [] }),
        effect({ id: 'e2', label: 'Fireball', duration: 'turn' }),
        effect({ id: 'e3', label: 'Old blast', duration: 'turn', round: 1 }),
      ],
    });
    const snap = mapSnapshot(state, hero, { perspective: 'dm' });
    expect(snap?.effects.map((e) => e.label)).toEqual(['Spirit Guardians', 'Fireball']);
    expect(snap?.effects[0]).toMatchObject({ emanationOfId: 'c-4', sizeFt: 5 });
    expect(snap?.effects[0].rects.map(rectLabel)).toEqual(['A4:C4', 'A5', 'C5', 'A6:C6']);
  });

  it('is null without a map', () => {
    const { map: _m, ...noMap } = sampleMappedCombat();
    expect(mapSnapshot(noMap, hero, { perspective: 'dm' })).toBeNull();
  });

  it('is deterministic: a reshuffled combatant list gives the same facts per creature and the same reach pairs', () => {
    const state = move(sampleMappedCombat(), 'c-2', 'C5');
    const a = mapSnapshot(state, hero, { perspective: 'dm' });
    const shuffled = { ...state, combatants: [state.combatants[3], state.combatants[0], state.combatants[5], state.combatants[1], state.combatants[4], state.combatants[2]] };
    const b = mapSnapshot({ ...shuffled, turnIndex: shuffled.combatants.findIndex((c) => c.id === 'c-2') }, hero, { perspective: 'dm' });
    const byId = (s: typeof a) => Object.fromEntries((s?.tokens ?? []).map((t) => [t.id, t]));
    expect(byId(b)).toEqual(byId(a));
    const pairs = (s: typeof a) => (s?.reach ?? []).map((p) => `${p.aId}>${p.bId}:${p.aReachesB}${p.bReachesA}${p.distanceFt}`).sort();
    expect(pairs(b)).toEqual(pairs(a));
    expect(mapSnapshot(state, hero, { perspective: 'dm' })).toEqual(a);
  });
});

describe('mapWarnings', () => {
  it('B11: a shared space, a Prone flier 20 ft up, a walker 10 ft up and an unplaced creature (srd:rule:flying; C25)', () => {
    let state = move(sampleMappedCombat(), 'c-4', 'B6');
    state = patch(state, 'c-3', { speeds: { walk: 30, fly: 40 }, elevationFt: 20 });
    state = patch(state, 'c-2', { elevationFt: 10 });
    state = move(state, 'c-6', null);
    expect(mapWarnings(state, hero)).toEqual([
      { kind: 'unplaced', id: 'c-6' },
      { kind: 'shared-space', ids: ['c-1', 'c-4'] },
      { kind: 'airborne-walker', id: 'c-2', elevationFt: 10 },
      { kind: 'must-fall', id: 'c-3', elevationFt: 20, dice: '2d6' },
    ]);
  });

  it('a hovering flier stays up; Tiny creatures may share; a lasting emanation without its creature is an orphan', () => {
    let state = patch(sampleMappedCombat(), 'c-3', { speeds: { walk: 30, fly: 40, hover: true }, elevationFt: 20 });
    state = patch(move(state, 'c-4', 'F4'), 'c-4', { size: 'Tiny' });
    state = patch(state, 'c-2', { size: 'Tiny' });
    state = withMap(
      { ...state, combatants: state.combatants.filter((c) => c.id !== 'c-6') },
      {
        effects: [
          {
            id: 'e1',
            label: 'Aura of Dread',
            spec: { shape: 'emanation', sizeFt: 10, fromId: 'c-6' },
            rects: [],
            terrain: [],
            duration: 'lasting',
            round: 1,
            turnOfId: 'c-6',
          },
        ],
      },
    );
    expect(mapWarnings(state, hero)).toEqual([{ kind: 'orphan-effect', label: 'Aura of Dread' }]);
  });

  it('a falling distance under 10 ft has no dice; a footprint in a wall does not fit', () => {
    let state = patch(sampleMappedCombat(), 'c-3', { speeds: { walk: 30, fly: 40 }, elevationFt: 5 });
    state = move(state, 'c-2', 'I4');
    // Per-creature warnings come in initiative order.
    expect(mapWarnings(state, hero)).toEqual([
      { kind: 'does-not-fit', id: 'c-2' },
      { kind: 'must-fall', id: 'c-3', elevationFt: 5, dice: null },
    ]);
  });
});

describe('mapGlyphGrid', () => {
  it('draws the §4.5 warehouse: terrain glyphs, @ for the hero, 1–5 for the others in initiative order', () => {
    const { rows, legend } = mapGlyphGrid(sampleMappedCombat(), hero);
    expect(rows).toEqual([
      '................',
      '................',
      '.....3..........',
      '.....1..#.......',
      '.4..)).....##+##',
      '.@..))..........',
      '................',
      '.......:::..2...',
      '.......:::......',
      '.......55....~~~',
      '......!55....~~~',
      '.............~~~',
    ]);
    expect(legend).toEqual([
      { glyph: '@', id: 'c-1' },
      { glyph: '1', id: 'c-2' },
      { glyph: '2', id: 'c-5' },
      { glyph: '3', id: 'c-3' },
      { glyph: '4', id: 'c-4' },
      { glyph: '5', id: 'c-6' },
    ]);
  });

  it('shows open doors, pits, shallow water, obscured squares and three-quarters cover; leaves defeated creatures out', () => {
    const map = createBattleMap({
      width: 6,
      height: 4,
      terrain: [
        { kind: 'wall', rects: rects('A1:C1') },
        { kind: 'door', rects: rects('B1'), door: 'open' },
        { kind: 'pit', rects: rects('A2') },
        { kind: 'shallow-water', rects: rects('B2') },
        { kind: 'obscured', rects: rects('C2') },
        { kind: 'three-quarters-cover', rects: rects('D2') },
      ],
    });
    const state = patch({ ...sampleMappedCombat(), map, combatants: sampleMappedCombat().combatants.slice(0, 2).map((c, i) => ({ ...c, position: { x: 4 + i, y: 3 } })) }, 'c-2', { defeated: true });
    const { rows, legend } = mapGlyphGrid(state, hero);
    expect(rows).toEqual(['#/#...', '_,%]..', '......', '....@.']);
    expect(legend).toEqual([{ glyph: '@', id: 'c-1' }]);
  });
});

describe('performance (battle-map spec §7.12, generous margins)', () => {
  it('rasterises a full 40×40 map (60 features × 40 rects) in under 50 ms, then serves it from the memo', () => {
    const terrain: BattleMapInput['terrain'] = Array.from({ length: 60 }, (_, f) => ({
      kind: (['wall', 'difficult', 'half-cover', 'obscured', 'deep-water', 'hazard'] as const)[f % 6],
      rects: Array.from({ length: 40 }, (_, r) => ({ x0: (f + r) % 30, y0: (f * 3 + r) % 30, x1: ((f + r) % 30) + 9, y1: ((f * 3 + r) % 30) + 9 })),
      label: `feature ${f}`,
    }));
    const map = createBattleMap({ width: 40, height: 40, terrain });
    expect(map.terrain).toHaveLength(60);
    const state: CombatState = { ...sampleMappedCombat(), map };
    const t0 = performance.now();
    const first = mapGlyphGrid(state, hero);
    const ms = performance.now() - t0;
    expect(first.rows).toHaveLength(40);
    expect(ms).toBeLessThan(50);
    const t1 = performance.now();
    mapGlyphGrid(state, hero);
    expect(performance.now() - t1).toBeLessThan(ms + 5);
  });

  /** A 40×40 map with walls, crates and 30 creatures, the hero first. */
  const bigFight = (): CombatState => {
    const terrain: BattleMapInput['terrain'] = [
      { kind: 'wall', rects: [{ x0: 0, y0: 20, x1: 30, y1: 20 }] },
      { kind: 'wall', rects: [{ x0: 20, y0: 0, x1: 20, y1: 15 }] },
      { kind: 'half-cover', rects: [{ x0: 5, y0: 5, x1: 9, y1: 7 }] },
      { kind: 'difficult', rects: [{ x0: 25, y0: 25, x1: 35, y1: 35 }] },
    ];
    const map = createBattleMap({ width: 40, height: 40, terrain });
    const base = sampleMappedCombat().combatants;
    const combatants: Combatant[] = Array.from({ length: 30 }, (_, i) => ({
      ...(i === 0 ? base[0] : { ...base[1], id: `n-${i}`, name: `Foe ${i}`, side: i % 3 === 0 ? ('ally' as const) : ('enemy' as const) }),
      initiative: 30 - i,
      position: { x: (i * 7) % 38, y: 2 + ((i * 5) % 36) },
    }));
    const state: CombatState = { ...sampleMappedCombat(), combatants, turnIndex: 0, map };
    return placeCombatants(state, hero, [{ ids: combatants.map((c) => c.id), anchor: { kind: 'auto' } }]).state;
  };

  it('builds the player snapshot of a 40×40 map with 30 creatures and walls in under 50 ms', () => {
    const placed = bigFight();
    mapSnapshot(placed, hero, { perspective: 'player' }); // warm up
    const t0 = performance.now();
    const snap = mapSnapshot({ ...placed }, hero, { perspective: 'player' });
    const ms = performance.now() - t0;
    expect(snap?.tokens).toHaveLength(30);
    expect(ms).toBeLessThan(50);
  });

  it('K2: a snapshot works out cover only for the tokens whose cover is read, once each, with the same values', () => {
    const state = bigFight();
    const spy = vi.mocked(coverAgainst);
    spy.mockClear();
    const snap = mapSnapshot(state, hero, { perspective: 'dm' });
    if (!snap) throw new Error('expected a snapshot');
    expect(spy).not.toHaveBeenCalled();
    const heroId = state.combatants[0].id;
    const foe = snap.tokens[7];
    const first = foe.coverFromHero;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(foe.coverFromHero).toBe(first);
    expect(spy).toHaveBeenCalledTimes(1);
    // Every reader gets exactly what the eager snapshot gave: cover both ways for the living, null for the hero.
    for (const t of snap.tokens) {
      const live = !t.isHero && t.space !== null && !t.defeated;
      expect(t.coverFromHero).toEqual(live ? coverAgainst(state, hero, heroId, t.id) : null);
      expect(t.heroCoverFromIt).toEqual(live ? coverAgainst(state, hero, t.id, heroId) : null);
    }
    expect(snap.tokens.some((t) => t.coverFromHero && t.coverFromHero.degree !== 'none')).toBe(true);
    // Copies and JSON carry the values.
    expect(JSON.parse(JSON.stringify(foe)).coverFromHero).toEqual(first);
    expect({ ...foe }.coverFromHero).toEqual(first);
  });
});
