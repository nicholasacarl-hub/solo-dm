import { describe, expect, it } from 'vitest';
import { sampleBattleMap, sampleCharacter, sampleCombat, sampleMappedCombat, sampleStopCombat } from '@/test/fixtures';
import { MAP_LIMITS, type AreaSpec, type AreaTerrain, type BattleMap, type CombatState } from '@/types';
import { addAreaEffect, mapSnapshot, mapWarnings } from './battleMap';
import { removeCombatant } from './combat';
import { CELL, mapCells } from './mapCells';
import { normalizeBattleMap, normalizeCombatState } from './mapNormalize';

// Saves are read leniently (app convention, spec §6.4 and D69): nothing here is an SRD rule.

const IDS = ['c-1', 'c-2', 'c-3', 'c-4', 'c-5', 'c-6'];

/** A map as JSON would bring it back, with anything mixed in. */
function raw(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...(JSON.parse(JSON.stringify(sampleBattleMap())) as Record<string, unknown>), ...patch };
}

function normalized(patch: Record<string, unknown>, ids: readonly string[] = IDS): BattleMap {
  const map = normalizeBattleMap(raw(patch), ids);
  if (!map) throw new Error('expected a map');
  return map;
}

describe('normalizeBattleMap (app convention: lenient saves)', () => {
  it('N1: clamps the size to 4–40 squares, clips rects, drops unknown kinds and caps the features at 60', () => {
    expect(normalized({ width: 3, height: 99 })).toMatchObject({ width: 4, height: 40 });
    expect(normalized({ width: 16.7, height: 12 })).toMatchObject({ width: 16, height: 12 });

    const map = normalized({
      width: 10,
      height: 8,
      terrain: [
        { id: 't1', kind: 'wall', rects: [{ x0: 8, y0: 6, x1: 14, y1: 20 }], label: 'outer wall' }, // partly off
        { id: 't2', kind: 'wall', rects: [{ x0: 12, y0: 0, x1: 13, y1: 1 }] }, // wholly off: dropped
        { id: 't3', kind: 'lava', rects: [{ x0: 0, y0: 0, x1: 0, y1: 0 }] }, // unknown kind
        { id: 't4', kind: 'difficult', rects: [{ x0: 3, y0: 4, x1: 1, y1: 2 }, 'B2', { x0: 'a' }] }, // reversed
        'not a feature',
      ],
    });
    expect(map.terrain).toEqual([
      { id: 't1', kind: 'wall', rects: [{ x0: 8, y0: 6, x1: 9, y1: 7 }], label: 'outer wall' },
      { id: 't4', kind: 'difficult', rects: [{ x0: 1, y0: 2, x1: 3, y1: 4 }] },
    ]);

    const many = Array.from({ length: 200 }, (_, i) => ({ id: `t${i + 1}`, kind: 'difficult', rects: [{ x0: 0, y0: 0, x1: 0, y1: 0 }] }));
    const capped = normalized({ terrain: many, places: [] });
    expect(capped.terrain).toHaveLength(MAP_LIMITS.maxFeatures);
    expect(capped.nextId).toBe(61);
  });

  it('N1: caps rects per feature, places, effects and the turn record; trims labels to 40 characters', () => {
    const rects = Array.from({ length: 50 }, (_, i) => ({ x0: i % 16, y0: 0, x1: i % 16, y1: 0 }));
    const places = Array.from({ length: 20 }, (_, i) => ({ id: `p${i + 20}`, name: `place ${i}`, rects: [{ x0: 0, y0: 0, x1: 1, y1: 1 }] }));
    const map = normalized({
      terrain: [{ id: 't1', kind: 'wall', rects, label: `  ${'x'.repeat(60)}  ` }],
      places,
      name: 'n'.repeat(80),
    });
    expect(map.terrain[0].rects).toHaveLength(MAP_LIMITS.maxRectsPerFeature);
    expect(map.terrain[0].label).toBe('x'.repeat(MAP_LIMITS.maxLabel));
    expect(map.places).toHaveLength(MAP_LIMITS.maxPlaces);
    expect(map.name).toHaveLength(MAP_LIMITS.maxMapName);
  });

  it('N2: drops a turn record, a stop and turn-scoped effects that name combatants not in the fight; other effects lose only the dangling reference', () => {
    const stopMap = sampleStopCombat().map as BattleMap;
    const effect = {
      id: 'e10',
      label: 'Spirit Guardians',
      spec: { shape: 'emanation', sizeFt: 15, fromId: 'c-9' },
      rects: [],
      terrain: ['difficult'],
      duration: 'lasting',
      round: 2,
      turnOfId: 'c-1',
    };
    const known = normalized({ turn: stopMap.turn, stop: stopMap.stop, effects: [{ ...effect, spec: { ...effect.spec, fromId: 'c-1' } }] });
    expect(known.turn?.combatantId).toBe('c-1');
    expect(known.stop?.reactorIds).toEqual(['c-6']);
    expect(known.effects.map((e) => e.label)).toEqual(['Spirit Guardians']);

    const burning = { id: 'e12', label: 'Burning Hands', spec: { shape: 'cone', sizeFt: 15, fromId: 'c-1', toward: { kind: 'creature', id: 'c-2' } }, rects: [{ x0: 2, y0: 4, x1: 3, y1: 6 }], terrain: [], duration: 'turn', round: 2 };
    const withoutHero = normalized(
      {
        turn: stopMap.turn,
        stop: stopMap.stop,
        effects: [effect, { ...effect, id: 'e11', turnOfId: 'c-9' }, { ...burning, turnOfId: 'c-1' }, { ...burning, id: 'e13', turnOfId: 'c-2' }],
      },
      ['c-2', 'c-3', 'c-4', 'c-5', 'c-6'],
    );
    expect(withoutHero.turn).toBeUndefined();
    expect(withoutHero.stop).toBeUndefined();
    // Lasting effects stay (spec §2.1: until effects_end); the orphaned emanation has no creature (§3.10's warning).
    expect(withoutHero.effects.map((e) => [e.id, e.label, e.duration, e.turnOfId, e.spec.fromId])).toEqual([
      ['e10', 'Spirit Guardians', 'lasting', '', undefined],
      ['e11', 'Spirit Guardians', 'lasting', '', undefined],
      // The turn of a creature that has left is over; this one's turn creature is still here.
      ['e13', 'Burning Hands', 'turn', 'c-2', undefined],
    ]);
    expect(withoutHero.effects[2]).toMatchObject({ spec: { shape: 'cone', toward: { kind: 'creature', id: 'c-2' } }, rects: [{ x0: 2, y0: 4, x1: 3, y1: 6 }] });
    // An unreadable reference still drops the effect (a damaged save), as before.
    const broken = normalized({ effects: [{ ...effect, spec: { ...effect.spec, fromId: 7 } }, { ...burning, turnOfId: 'c-1', spec: { ...burning.spec, toward: { kind: 'creature', id: 3 } } }] });
    expect(broken.effects).toEqual([]);

    // A stop whose every reactor has gone is dropped; unknown reactors in move records are left out.
    const noOgre = normalized({ turn: stopMap.turn, stop: stopMap.stop }, ['c-1', 'c-2']);
    expect(noOgre.stop).toBeUndefined();
    expect(noOgre.turn?.moves[0].provoked).toEqual([]);
  });

  it.each([
    ['null', null],
    ['a string', 'Dockside warehouse'],
    ['a NaN width', { ...sampleBattleMap(), width: Number.NaN }],
    ['an Infinity height', { ...sampleBattleMap(), height: Number.POSITIVE_INFINITY }],
    ['a width written as text', { ...sampleBattleMap(), width: '16' }],
    ['an array', [sampleBattleMap()]],
    ['a missing height', { width: 10 }],
  ])('N3: is undefined for %s', (_label, input) => {
    expect(normalizeBattleMap(input, IDS)).toBeUndefined();
  });

  it('N5: gives the fixture back unchanged, and normalizing twice changes nothing', () => {
    for (const map of [sampleBattleMap(), sampleStopCombat().map as BattleMap]) {
      const once = normalizeBattleMap(map, IDS);
      expect(once).toEqual(map);
      expect(normalizeBattleMap(once, IDS)).toEqual(once);
    }
  });

  it('repairs ids: missing and duplicate ids get fresh ones, and nextId ends above every id in use', () => {
    const map = normalized({
      id: '',
      nextId: 3,
      terrain: [
        { id: 't7', kind: 'wall', rects: [{ x0: 0, y0: 0, x1: 0, y1: 0 }] },
        { id: 't7', kind: 'pit', rects: [{ x0: 1, y0: 0, x1: 1, y1: 0 }] },
        { kind: 'hazard', rects: [{ x0: 2, y0: 0, x1: 2, y1: 0 }] },
      ],
      places: [{ id: 'p12', name: 'the stairs', rects: [{ x0: 2, y0: 0, x1: 2, y1: 2 }] }],
    });
    expect(map.id).toBe('map-13');
    expect(map.terrain.map((t) => t.id)).toEqual(['t7', 't14', 't15']);
    expect(map.places[0].id).toBe('p12');
    expect(map.nextId).toBe(16);
    const ids = [map.id, ...map.terrain.map((t) => t.id), ...map.places.map((p) => p.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(normalizeBattleMap(map, IDS)).toEqual(map);

    // Absurd numbers in a damaged save keep the counter a safe integer.
    const damaged = normalized({ nextId: 1e30, terrain: [{ id: 't99999999999999999999', kind: 'pit', rects: [{ x0: 0, y0: 0, x1: 0, y1: 0 }] }] });
    expect(Number.isSafeInteger(damaged.nextId)).toBe(true);
  });

  it('keeps door states only on doors, and reads effects, turn records and stops field by field', () => {
    const map = normalized({
      terrain: [
        { id: 't1', kind: 'door', rects: [{ x0: 13, y0: 4, x1: 13, y1: 4 }], door: 'ajar' },
        { id: 't2', kind: 'wall', rects: [{ x0: 11, y0: 4, x1: 12, y1: 4 }], door: 'open' },
        { id: 't3', kind: 'door', rects: [{ x0: 14, y0: 4, x1: 14, y1: 4 }], door: 'locked' },
      ],
      effects: [
        {
          id: 'e10',
          label: 'Web',
          spec: { shape: 'cube', sizeFt: 21, at: { kind: 'square', at: { x: 7, y: 7 } }, includeOrigin: 'yes' },
          rects: [{ x0: 6, y0: 6, x1: 9, y1: 9 }],
          terrain: ['difficult', 'obscured', 'sticky', 'difficult'],
          duration: 'lasting',
          round: 2,
          turnOfId: 'c-1',
        },
        { id: 'e11', label: 'Fireball', spec: { shape: 'sphere', sizeFt: 20, at: { kind: 'corner', x: 99, y: 3 } }, rects: [], terrain: [], duration: 'turn', round: 2, turnOfId: 'c-1' },
        { id: 'e12', label: 'Mystery', spec: { shape: 'hexagon', sizeFt: 10 }, rects: [], terrain: [], duration: 'lasting', round: 1, turnOfId: 'c-1' },
        { id: 'e13', label: 'Burning Hands', spec: { shape: 'cone', sizeFt: 15, fromId: 'c-1', toward: { kind: 'direction', dir: 'east' } }, rects: [], terrain: ['hazard'], duration: 'turn', round: 2, turnOfId: 'c-1' },
      ],
      turn: {
        combatantId: 'c-1',
        round: 2,
        movedFt: -10,
        dashFt: 30,
        dashes: 1,
        disengaged: 'yes',
        stoodUp: true,
        moves: [
          { by: 'player', kind: 'move', from: { x: 1, y: 5 }, to: { x: 2, y: 6 }, path: [{ x: 2, y: 6 }, { x: 50, y: 50 }], costFt: 5, provoked: [], entered: ['brazier', 7], toldSeq: 41, dashed: true },
          { by: 'someone', kind: 'move', from: { x: 1, y: 5 }, to: { x: 2, y: 6 }, path: [], costFt: 5, provoked: [], entered: [] },
          { by: 'dm', kind: 'stand', from: { x: 1, y: 5 }, to: { x: 1, y: 5 }, path: [], costFt: 15, provoked: [], entered: [], toldSeq: 0 },
        ],
      },
    });
    expect(map.terrain.map((t) => [t.id, t.door])).toEqual([
      ['t1', undefined],
      ['t2', undefined],
      ['t3', 'locked'],
    ]);
    expect(map.effects.map((e) => e.label)).toEqual(['Web', 'Burning Hands']);
    expect(map.effects[0]).toMatchObject({ spec: { shape: 'cube', sizeFt: 20 }, terrain: ['difficult', 'obscured'] });
    expect(map.effects[0].spec).not.toHaveProperty('includeOrigin');
    // Turn-scoped effects change no terrain.
    expect(map.effects[1].terrain).toEqual([]);
    expect(map.turn).toMatchObject({ movedFt: 0, dashFt: 30, dashes: 1, disengaged: false, stoodUp: true });
    expect(map.turn?.moves).toEqual([
      { by: 'player', kind: 'move', from: { x: 1, y: 5 }, to: { x: 2, y: 6 }, path: [{ x: 2, y: 6 }], costFt: 5, provoked: [], entered: ['brazier'], toldSeq: 41, dashed: true },
      { by: 'dm', kind: 'stand', from: { x: 1, y: 5 }, to: { x: 1, y: 5 }, path: [], costFt: 15, provoked: [], entered: [] },
    ]);
  });
});

describe('normalizeCombatState (app convention: lenient saves)', () => {
  it('N4: a combatant missing its conditions gets [], and a broken map is dropped while the combat is kept', () => {
    const state = sampleMappedCombat();
    const { conditions: _conditions, ...noConditions } = state.combatants[1];
    const result = normalizeCombatState({ ...state, combatants: [state.combatants[0], noConditions, ...state.combatants.slice(2)], map: { width: 'wide' } });
    expect(result.combatants[1].conditions).toEqual([]);
    expect(result.map).toBeUndefined();
    expect(result.combatants).toHaveLength(6);
    expect(result).toMatchObject({ active: true, round: 2, turnIndex: 1, encounterName: 'Ambush in the warehouse' });
    // Without a map, nobody has a position.
    expect(result.combatants.some((c) => 'position' in c)).toBe(false);
    // Other map fields don't need a map.
    expect(result.combatants.find((c) => c.id === 'c-5')?.hidden).toBe(true);
    expect(result.combatants.find((c) => c.id === 'c-6')).toMatchObject({ size: 'Large', speeds: { walk: 40 } });
  });

  it('N5: gives the fixtures back unchanged, and normalizing twice changes nothing', () => {
    for (const state of [sampleCombat(), sampleMappedCombat(), sampleMappedCombat({ heroTurn: true }), sampleStopCombat()]) {
      const once = normalizeCombatState(state);
      expect(once).toEqual(state);
      expect(normalizeCombatState(once)).toEqual(once);
    }
  });

  it('keeps each map field only when it reads (positions inside the map, feet in range, booleans)', () => {
    const state = sampleMappedCombat();
    const [mira, bandit1, cutthroat, bandit2, oldTam, ogre] = state.combatants;
    const result = normalizeCombatState({
      ...state,
      combatants: [
        { ...mira, position: { x: 1.9, y: 5 }, elevationFt: 12, reachFt: 7, speedChangeFt: -200 },
        { ...bandit1, position: { x: 16, y: 3 }, size: 'Colossal', hidden: 'no', reactionUsed: true },
        { ...cutthroat, position: { x: -1, y: 0 }, elevationFt: 9000, speeds: { walk: -5, fly: 60.5, hover: 'yes', teleport: 30 } },
        { ...bandit2, position: 'F3', speeds: { hover: true } },
        { ...oldTam, reachFt: 100, speedChangeFt: 30.8 },
        { ...ogre, speeds: 'fast' },
      ],
    });
    const [a, b, c, d, e, f] = result.combatants;
    expect(a).toMatchObject({ position: { x: 1, y: 5 }, elevationFt: 10, reachFt: 5, speedChangeFt: -120 });
    expect(b).not.toHaveProperty('position');
    expect(b).not.toHaveProperty('size');
    expect(b).not.toHaveProperty('hidden');
    expect(b.reactionUsed).toBe(true);
    expect(c).not.toHaveProperty('position');
    expect(c).toMatchObject({ elevationFt: 500, speeds: { walk: 0, fly: 60 } });
    expect(c.speeds).not.toHaveProperty('hover');
    expect(c.speeds).not.toHaveProperty('teleport');
    // No speed in feet at all: the defaults apply instead of a creature that can't move.
    expect(d).not.toHaveProperty('position');
    expect(d).not.toHaveProperty('speeds');
    expect(e).toMatchObject({ reachFt: 60, speedChangeFt: 30 });
    expect(f).not.toHaveProperty('speeds');
  });

  it('R1/P1: a reload keeps the lasting effects of a creature that has left the fight, as memory does (app convention; spec §2.1, §3.10)', () => {
    const hero = sampleCharacter();
    let state: CombatState = sampleMappedCombat(); // Bandit 1's turn
    const add = (spec: AreaSpec, label: string, lasting: boolean, terrain: AreaTerrain[] = []) => {
      const added = addAreaEffect(state, hero, spec, { label, lasting, terrain });
      if (!added.ok) throw new Error(added.problem);
      state = added.state;
    };
    add({ shape: 'cube', sizeFt: 20, at: { kind: 'square', at: { x: 8, y: 6 } }, fromId: 'c-2' }, 'Web', true, ['difficult', 'obscured']); // I7 → H6:K9
    add({ shape: 'sphere', sizeFt: 10, at: { kind: 'creature', id: 'c-2' } }, 'Fog Cloud', true, ['obscured']);
    add({ shape: 'emanation', sizeFt: 10, fromId: 'c-2' }, 'Spirit Guardians', true, ['difficult']);
    add({ shape: 'cone', sizeFt: 15, fromId: 'c-2', toward: { kind: 'creature', id: 'c-1' } }, 'Burning Hands', false);
    expect(state.map?.effects.every((e) => e.turnOfId === 'c-2')).toBe(true);

    // Bandit 1 flees (update_combat remove); the turn passes to the Cutthroat. Then the page reloads.
    const live = removeCombatant(state, 'c-2');
    const reloaded = normalizeCombatState(JSON.parse(JSON.stringify(live)));

    expect(reloaded.map?.effects.map((e) => e.label)).toEqual(['Web', 'Fog Cloud', 'Spirit Guardians']);
    // Everything a reader sees is the same: squares and terrain, both snapshots, the orphan warning.
    const cells = (s: CombatState) => mapCells(s, hero);
    expect(cells(reloaded)?.flags).toEqual(cells(live)?.flags);
    expect(cells(reloaded)?.hazardsAt).toEqual(cells(live)?.hazardsAt);
    expect(cells(reloaded)!.flags[6 * 16 + 8] & (CELL.DIFFICULT | CELL.OBSCURED)).toBe(CELL.DIFFICULT | CELL.OBSCURED); // I7
    for (const perspective of ['dm', 'player'] as const) {
      expect(mapSnapshot(reloaded, hero, { perspective })?.effects).toEqual(mapSnapshot(live, hero, { perspective })?.effects);
    }
    expect(mapWarnings(reloaded, hero)).toEqual(mapWarnings(live, hero));
    expect(mapWarnings(live, hero)).toContainEqual({ kind: 'orphan-effect', label: 'Spirit Guardians' });
    // Only the dangling references went; normalizing again changes nothing.
    const [web, fog, guardians] = reloaded.map?.effects ?? [];
    expect([web.spec.fromId, fog.spec.at, guardians.spec.fromId, web.turnOfId]).toEqual([undefined, undefined, undefined, '']);
    expect(web.rects).toEqual([{ x0: 7, y0: 5, x1: 10, y1: 8 }]);
    expect(normalizeCombatState(reloaded)).toEqual(reloaded);
  });

  it('keeps the rest of the combat as it was, unknown fields included', () => {
    const state = { ...sampleCombat(), futureField: { keep: true } };
    state.combatants[0] = { ...state.combatants[0], notes: 'Lucky.', futureNote: 1 } as CombatState['combatants'][number];
    const result = normalizeCombatState(state) as CombatState & { futureField?: unknown };
    expect(result.futureField).toEqual({ keep: true });
    expect(result.combatants[0]).toMatchObject({ notes: 'Lucky.', futureNote: 1, ac: 12, initiative: 17 });
  });

  it('never throws: unreadable combatants are left out and the turn stays in range', () => {
    const result = normalizeCombatState({
      round: 'two',
      turnIndex: 9,
      combatants: [null, { name: 'No id' }, { id: 'c-1', name: 42, conditions: 'prone' }, { id: 'c-2', name: 'Bandit', conditions: [{ id: 'prone' }, { name: 'x' }, 'grappled'] }],
      startedAt: 'yesterday',
      encounterName: 7,
      map: [],
    });
    expect(result).toEqual({
      active: true,
      round: 1,
      turnIndex: 1,
      startedAt: 0,
      combatants: [
        { id: 'c-1', name: 'Unnamed', conditions: [] },
        { id: 'c-2', name: 'Bandit', conditions: [{ id: 'prone' }] },
      ],
    });
    for (const input of [null, undefined, 'combat', 3, []]) {
      expect(normalizeCombatState(input)).toEqual({ active: false, round: 1, turnIndex: 0, combatants: [], startedAt: 0 });
    }
  });
});
