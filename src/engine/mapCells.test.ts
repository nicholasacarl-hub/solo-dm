import { describe, expect, it } from 'vitest';
import type { BattleMap, CombatState, MapEffect, TerrainFeature } from '@/types';
import { sampleCharacter, sampleMappedCombat } from '@/test/fixtures';
import { parseSquare, parseSquareList } from './grid';
import { CELL, combatantSize, coverFeatureName, mapCells, occupants, terrainCells, type MapCells } from './mapCells';

const sq = (label: string, map: { width: number; height: number } = { width: 16, height: 12 }) => {
  const p = parseSquare(label, map);
  if (!p.ok) throw new Error(p.problem);
  return p.value;
};
const rects = (text: string) => {
  const r = parseSquareList(text, { width: 40, height: 40 });
  if (!r.ok) throw new Error(r.problem);
  return r.value;
};
const at = (cells: MapCells, label: string) => sq(label, cells).y * cells.width + sq(label, cells).x;
const flagsAt = (cells: MapCells, label: string) => cells.flags[at(cells, label)];
const coverAtLabel = (cells: MapCells, label: string) => cells.cover[at(cells, label)];
const has = (cells: MapCells, label: string, flags: number) => (flagsAt(cells, label) & flags) === flags;

function emptyMap(terrain: Omit<TerrainFeature, 'id'>[] = [], width = 16, height = 12): BattleMap {
  return {
    id: 'map-1',
    width,
    height,
    terrain: terrain.map((t, i) => ({ ...t, id: `t${i + 1}` })),
    places: [],
    effects: [],
    nextId: terrain.length + 1,
    rev: 0,
  };
}

const withMap = (map: BattleMap, base: CombatState = sampleMappedCombat()): CombatState => ({ ...base, map });

const lasting = (id: string, label: string, spec: MapEffect['spec'], rectList: MapEffect['rects'], terrain: MapEffect['terrain']): MapEffect => ({
  id,
  label,
  spec,
  rects: rectList,
  terrain,
  duration: 'lasting',
  round: 2,
  turnOfId: 'c-1',
});

describe('mapCells: terrain mechanics (battle-map spec §3.3.1)', () => {
  it('K1: a closed door replaces the wall it sits in; opened it blocks nothing (app convention C28)', () => {
    const state = sampleMappedCombat();
    const cells = mapCells(state, sampleCharacter());
    if (!cells) throw new Error('no cells');
    const solid = CELL.DOOR | CELL.DOOR_CLOSED | CELL.BLOCKS_MOVE | CELL.FILLS | CELL.BLOCKS_SIGHT;
    expect(flagsAt(cells, 'N5')).toBe(solid);
    expect(coverAtLabel(cells, 'N5')).toBe(3);
    expect(cells.doorAt.get(at(cells, 'N5'))).toBe('t2');
    expect(cells.labelsAt.get(at(cells, 'N5'))).toEqual(['office door']);
    expect(flagsAt(cells, 'M5')).toBe(CELL.BLOCKS_MOVE | CELL.FILLS | CELL.BLOCKS_SIGHT);
    expect(cells.labelsAt.get(at(cells, 'M5'))).toEqual(['office wall']);

    const map = state.map as BattleMap;
    const opened = withMap({ ...map, terrain: map.terrain.map((t) => (t.kind === 'door' ? { ...t, door: 'open' as const } : t)) });
    const openCells = mapCells(opened, sampleCharacter());
    if (!openCells) throw new Error('no cells');
    expect(flagsAt(openCells, 'N5')).toBe(CELL.DOOR);
    expect(coverAtLabel(openCells, 'N5')).toBe(0);
    expect(has(openCells, 'M5', CELL.BLOCKS_MOVE)).toBe(true);
  });

  it('a door replaces a wall even when the wall is listed after it; locked doors are closed', () => {
    const cells = terrainCells(
      emptyMap([
        { kind: 'door', rects: rects('C3'), door: 'locked', label: 'iron door' },
        { kind: 'wall', rects: rects('A3:F3'), label: 'cell wall' },
        { kind: 'door', rects: rects('E3'), door: 'open' },
      ]),
    );
    expect(flagsAt(cells, 'C3')).toBe(CELL.DOOR | CELL.DOOR_CLOSED | CELL.BLOCKS_MOVE | CELL.FILLS | CELL.BLOCKS_SIGHT);
    expect(cells.labelsAt.get(at(cells, 'C3'))).toEqual(['iron door']);
    expect(flagsAt(cells, 'E3')).toBe(CELL.DOOR);
    expect(coverAtLabel(cells, 'E3')).toBe(0);
    expect(flagsAt(cells, 'D3')).toBe(CELL.BLOCKS_MOVE | CELL.FILLS | CELL.BLOCKS_SIGHT);
  });

  it('every kind has its fixed flags and cover level (srd:rule:difficult-terrain, srd:rule:swimming, srd:rule:combat-cover, srd:rule:heavily-obscured)', () => {
    const cells = terrainCells(
      emptyMap([
        { kind: 'wall', rects: rects('A1') },
        { kind: 'difficult', rects: rects('B1') },
        { kind: 'shallow-water', rects: rects('C1') },
        { kind: 'deep-water', rects: rects('D1') },
        { kind: 'pit', rects: rects('E1') },
        { kind: 'hazard', rects: rects('F1'), label: 'brazier' },
        { kind: 'half-cover', rects: rects('G1') },
        { kind: 'three-quarters-cover', rects: rects('H1') },
        { kind: 'obscured', rects: rects('I1') },
        { kind: 'hazard', rects: rects('J1') },
      ]),
    );
    expect(['A1', 'B1', 'C1', 'D1', 'E1', 'F1', 'G1', 'H1', 'I1', 'K1'].map((l) => flagsAt(cells, l))).toEqual([
      CELL.BLOCKS_MOVE | CELL.FILLS | CELL.BLOCKS_SIGHT,
      CELL.DIFFICULT,
      CELL.SHALLOW | CELL.DIFFICULT,
      CELL.DEEP,
      CELL.PIT,
      CELL.HAZARD,
      CELL.DIFFICULT,
      CELL.BLOCKS_MOVE | CELL.FILLS,
      CELL.OBSCURED | CELL.BLOCKS_SIGHT,
      0,
    ]);
    expect(['A1', 'B1', 'G1', 'H1', 'I1'].map((l) => coverAtLabel(cells, l))).toEqual([3, 0, 1, 2, 0]);
    expect(cells.hazardsAt.get(at(cells, 'F1'))).toEqual(['brazier']);
    expect(cells.hazardsAt.get(at(cells, 'J1'))).toEqual(['hazard']);
  });

  it('overlapping features combine; the cover level is the maximum; rects off the map are clipped', () => {
    const cells = terrainCells(
      emptyMap([
        { kind: 'half-cover', rects: rects('B2:C2'), label: 'crates' },
        { kind: 'difficult', rects: rects('C2:D2'), label: 'rubble' },
        { kind: 'three-quarters-cover', rects: rects('C2') },
        { kind: 'obscured', rects: [{ x0: 14, y0: 10, x1: 20, y1: 20 }] },
      ]),
    );
    expect(flagsAt(cells, 'C2')).toBe(CELL.DIFFICULT | CELL.BLOCKS_MOVE | CELL.FILLS);
    expect(coverAtLabel(cells, 'C2')).toBe(2);
    expect(cells.labelsAt.get(at(cells, 'C2'))).toEqual(['crates', 'rubble']);
    expect(has(cells, 'P12', CELL.OBSCURED)).toBe(true);
    expect(cells.flags).toHaveLength(16 * 12);
  });

  it('places are listed per square', () => {
    const cells = mapCells(sampleMappedCombat(), sampleCharacter());
    if (!cells) throw new Error('no cells');
    expect(cells.placesAt.get(at(cells, 'B6'))).toEqual(['the loading door']);
    expect(cells.placesAt.get(at(cells, 'M2'))).toEqual(['the office']);
    expect(cells.placesAt.get(at(cells, 'C6'))).toBeUndefined();
  });

  it('is null without a map', () => {
    const { map: _map, ...noMap } = sampleMappedCombat();
    expect(mapCells(noMap, sampleCharacter())).toBeNull();
  });

  it('names the feature that gives cover: label, else kind; a wall under a door does not count', () => {
    const map = sampleMappedCombat().map as BattleMap;
    expect(coverFeatureName(map, sq('E5'), 1)).toBe('crates');
    expect(coverFeatureName(map, sq('I4'), 3)).toBe('pillar');
    expect(coverFeatureName(map, sq('N5'), 3)).toBe('office door');
    expect(coverFeatureName(map, sq('E5'), 2)).toBeNull();
    expect(coverFeatureName(emptyMap([{ kind: 'wall', rects: rects('A1') }]), sq('A1'), 3)).toBe('wall');
  });
});

describe('mapCells: lasting effects', () => {
  it('K2: a lasting Web makes its squares difficult and obscured (srd:spell:web)', () => {
    const base = sampleMappedCombat();
    const web = lasting('e10', 'Web', { shape: 'cube', sizeFt: 20, at: { kind: 'square', at: sq('H8') } }, rects('G7:J10'), ['difficult', 'obscured']);
    const state = withMap({ ...(base.map as BattleMap), effects: [web], nextId: 11 });
    const cells = mapCells(state, sampleCharacter());
    if (!cells) throw new Error('no cells');
    for (const l of ['G7', 'J10', 'H9']) {
      expect(has(cells, l, CELL.DIFFICULT | CELL.OBSCURED | CELL.BLOCKS_SIGHT)).toBe(true);
      expect(cells.hazardsAt.get(at(cells, l))).toContain('Web');
    }
    expect(has(cells, 'F7', CELL.DIFFICULT)).toBe(false);
    // Spilled grain (H8:J9) stays difficult; the terrain-only cells are untouched.
    expect(has(terrainCells(state.map as BattleMap), 'G7', CELL.OBSCURED)).toBe(false);
  });

  it('a turn-scoped effect paints nothing', () => {
    const base = sampleMappedCombat();
    const fireball: MapEffect = { ...lasting('e10', 'Fireball', { shape: 'sphere', sizeFt: 20, at: { kind: 'square', at: sq('G4') } }, rects('G4'), []), duration: 'turn' };
    const state = withMap({ ...(base.map as BattleMap), effects: [fireball] });
    const cells = mapCells(state, sampleCharacter());
    expect(cells).toBe(terrainCells(state.map as BattleMap));
  });

  it('K3: a lasting 15-ft Spirit Guardians follows Mira from B6 to C6 (srd:rule:emanation; srd:spell:spirit-guardians)', () => {
    const base = sampleMappedCombat();
    const guardians = lasting('e10', 'Spirit Guardians', { shape: 'emanation', sizeFt: 15, fromId: 'c-1' }, [], []);
    const state = withMap({ ...(base.map as BattleMap), effects: [guardians] });
    const hero = sampleCharacter();
    const before = mapCells(state, hero);
    if (!before) throw new Error('no cells');
    // B6 ± 3 squares: A3:E9 minus B6 (the map's west edge clips it).
    expect(before.hazardsAt.get(at(before, 'E9'))).toEqual(['Spirit Guardians']);
    expect(before.hazardsAt.get(at(before, 'F9'))).toBeUndefined();
    expect(before.hazardsAt.get(at(before, 'B6'))).toBeUndefined();
    const moved: CombatState = { ...state, combatants: state.combatants.map((c) => (c.id === 'c-1' ? { ...c, position: sq('C6') } : c)) };
    const after = mapCells(moved, hero);
    if (!after) throw new Error('no cells');
    expect(after).not.toBe(before);
    expect(after.hazardsAt.get(at(after, 'F9'))).toEqual(['Spirit Guardians']);
    expect(after.hazardsAt.get(at(after, 'B6'))).toEqual(['Spirit Guardians']);
    expect(after.hazardsAt.get(at(after, 'C6'))).toBeUndefined();
  });

  it('K4: mapCells is memoized: the same state gives the same object, and so does another move', () => {
    const base = sampleMappedCombat();
    const guardians = lasting('e10', 'Spirit Guardians', { shape: 'emanation', sizeFt: 15, fromId: 'c-1' }, [], []);
    const state = withMap({ ...(base.map as BattleMap), effects: [guardians] });
    const hero = sampleCharacter();
    const first = mapCells(state, hero);
    expect(mapCells(state, hero)).toBe(first);
    // Bandit 1 moving doesn't move the emanation.
    const banditMoved: CombatState = { ...state, combatants: state.combatants.map((c) => (c.id === 'c-2' ? { ...c, position: sq('E4') } : c)) };
    expect(mapCells(banditMoved, hero)).toBe(first);
    // Without effects the cells are the terrain cells, memoized on the terrain array.
    expect(mapCells(base, hero)).toBe(terrainCells(base.map as BattleMap));
    expect(mapCells({ ...base, map: { ...(base.map as BattleMap), rev: 5 } }, hero)).toBe(mapCells(base, hero));
  });
});

describe('occupants', () => {
  it('lists placed, non-defeated combatants in initiative order with their spaces', () => {
    const state = sampleMappedCombat();
    const list = occupants(state, sampleCharacter());
    expect(list.map((o) => o.id)).toEqual(['c-1', 'c-2', 'c-5', 'c-3', 'c-4', 'c-6']);
    const ogre = list.find((o) => o.id === 'c-6');
    expect(ogre).toMatchObject({ rect: { x0: 7, y0: 9, x1: 8, y1: 10 }, size: 'Large', team: 'foes', elevationFt: 0 });
    expect(list.find((o) => o.id === 'c-5')).toMatchObject({ hidden: true, team: 'foes' });
    expect(list.find((o) => o.id === 'c-4')).toMatchObject({ team: 'party', hidden: false });
    const defeated: CombatState = { ...state, combatants: state.combatants.map((c) => (c.id === 'c-2' ? { ...c, defeated: true } : c)) };
    expect(occupants(defeated, sampleCharacter()).map((o) => o.id)).not.toContain('c-2');
    const unplaced: CombatState = { ...state, combatants: state.combatants.map((c) => (c.id === 'c-3' ? { ...c, position: undefined } : c)) };
    expect(occupants(unplaced, sampleCharacter()).map((o) => o.id)).not.toContain('c-3');
  });

  it("reads the hero's size and conditions from the sheet (srd:condition:incapacitated)", () => {
    const state = sampleMappedCombat();
    const hero = sampleCharacter({ size: 'Small', conditions: [{ id: 'unconscious' }] });
    const mira = occupants(state, hero).find((o) => o.id === 'c-1');
    expect(mira).toMatchObject({ size: 'Small', incapacitated: true, team: 'party' });
    // An override on the combatant (Enlarge) wins over the sheet.
    const enlarged: CombatState = { ...state, combatants: state.combatants.map((c) => (c.id === 'c-1' ? { ...c, size: 'Large' as const } : c)) };
    expect(occupants(enlarged, hero).find((o) => o.id === 'c-1')?.rect).toEqual({ x0: 1, y0: 5, x1: 2, y1: 6 });
    expect(combatantSize(state.combatants[1], hero)).toBe('Medium');
    // Stunned NPCs are Incapacitated; Prone ones are not.
    const stunned: CombatState = { ...state, combatants: state.combatants.map((c) => (c.id === 'c-2' ? { ...c, conditions: [{ id: 'stunned' }] } : c)) };
    const list = occupants(stunned, hero);
    expect(list.find((o) => o.id === 'c-2')?.incapacitated).toBe(true);
    expect(list.find((o) => o.id === 'c-3')?.incapacitated).toBe(false);
  });
});
