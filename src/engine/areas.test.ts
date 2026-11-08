import { describe, expect, it } from 'vitest';
import compendiumRaw from '../../public/srd/compendium.json?raw';
import type { AreaSpec, BattleMap, CompendiumEntry, Combatant, CombatSide, CombatState, CreatureSize, GridPoint, MapEffect, MapRef, TerrainFeature, TerrainKind } from '@/types';
import { sampleCharacter, sampleMappedCombat } from '@/test/fixtures';
import { parseCorner, parseSquare, parseSquareList, rectLabel, rectsLabel, squareLabel } from './grid';
import { areaSquares, effectSquares, parseAreaText, resolveArea, type AreaResult } from './areas';

interface Who {
  id: string;
  at: string;
  side?: CombatSide;
  size?: CreatureSize;
  elevationFt?: number;
  hidden?: boolean;
}

function board(width: number, height: number, terrain: [TerrainKind, string, Partial<TerrainFeature>?][] = [], cast: Who[] = []): CombatState {
  const dims = { width, height };
  const map: BattleMap = {
    id: 'map-1',
    width,
    height,
    terrain: terrain.map(([kind, squares, extra], i): TerrainFeature => {
      const r = parseSquareList(squares, dims);
      if (!r.ok) throw new Error(r.problem);
      return { id: `t${i + 1}`, kind, rects: r.value, ...extra };
    }),
    places: [],
    effects: [],
    nextId: terrain.length + 1,
    rev: 0,
  };
  const combatants: Combatant[] = cast.map((w, i) => {
    const p = parseSquare(w.at, dims);
    if (!p.ok) throw new Error(p.problem);
    return {
      id: w.id,
      name: w.id,
      side: w.side ?? 'enemy',
      isPlayer: false,
      initiative: 20 - i,
      initiativeBonus: 0,
      hp: { max: 10, current: 10, temp: 0 },
      conditions: [],
      defeated: false,
      position: p.value,
      ...(w.size ? { size: w.size } : {}),
      ...(w.elevationFt ? { elevationFt: w.elevationFt } : {}),
      ...(w.hidden ? { hidden: true } : {}),
    };
  });
  return { active: true, round: 1, turnIndex: 0, combatants, startedAt: 0, map };
}

const BIG = { width: 40, height: 40 };
const square = (label: string, dims = BIG): MapRef => {
  const p = parseSquare(label, dims);
  if (!p.ok) throw new Error(p.problem);
  return { kind: 'square', at: p.value };
};
const corner = (label: string, dims = BIG): MapRef => {
  const c = parseCorner(label, dims);
  if (!c.ok) throw new Error(c.problem);
  return { kind: 'corner', ...c.value };
};
const dir = (d: Extract<MapRef, { kind: 'direction' }>['dir']): MapRef => ({ kind: 'direction', dir: d });
const creature = (id: string): MapRef => ({ kind: 'creature', id });
/** Labels of squares in reading order. */
const labels = (points: readonly GridPoint[]) => [...points].sort((a, b) => a.y - b.y || a.x - b.x).map(squareLabel);
const resolved = (r: AreaResult | { problem: string }): AreaResult => {
  if ('problem' in r) throw new Error(r.problem);
  return r;
};
const ids = (r: AreaResult) => r.inside.map((h) => h.id);
const count = (state: CombatState, spec: AreaSpec) => {
  const r = resolved(resolveArea(state, null, spec));
  return r.squares.reduce((n, q) => n + (q.x1 - q.x0 + 1) * (q.y1 - q.y0 + 1), 0) + r.offMap;
};

describe('spheres and cylinders are round (SRD 5.2.1 Sphere: srd:rule:sphere; app convention C19, D8)', () => {
  it('A1: 5/10/15/20-ft spheres on a square centre, on a corner and on a Large creature', () => {
    const state = board(40, 40, [], [{ id: 'ogre', at: 'J10', size: 'Large' }]);
    expect([5, 10, 15, 20].map((r) => areaSquares(state, null, { shape: 'sphere', sizeFt: r, at: square('T20') }).length)).toEqual([5, 13, 29, 49]);
    expect([5, 10, 15, 20].map((r) => areaSquares(state, null, { shape: 'sphere', sizeFt: r, at: corner('S19/T20') }).length)).toEqual([4, 12, 32, 52]);
    expect(areaSquares(state, null, { shape: 'sphere', sizeFt: 20, at: creature('ogre') })).toHaveLength(52);
  });

  it('A2: a 20-ft sphere at G4 leaves out J7 (15 ft away by the grid) and takes I6, K4 and G8', () => {
    const got = labels(areaSquares(board(40, 40), null, { shape: 'sphere', sizeFt: 20, at: square('G4') }));
    expect(got).not.toContain('J7');
    for (const l of ['I6', 'K4', 'G8', 'G4', 'C4']) expect(got).toContain(l);
  });

  it('cylinders use the round footprint with their radius (srd:rule:cylinder)', () => {
    const state = board(40, 40);
    expect(areaSquares(state, null, { shape: 'cylinder', sizeFt: 5, heightFt: 40, at: square('T20') })).toHaveLength(5);
    expect(areaSquares(state, null, { shape: 'cylinder', sizeFt: 20, at: corner('S19/T20') })).toHaveLength(52);
  });
});

describe('cones (srd:rule:cone; app convention C19, D9)', () => {
  it('A3: 15 ft east and toward I11 from C5; 30 and 60 ft; from Large and Huge casters', () => {
    const state = board(40, 40, [], [
      { id: 'c', at: 'C5' },
      { id: 'far', at: 'C20' },
      { id: 'large', at: 'C25', size: 'Large' },
      { id: 'huge', at: 'K11', size: 'Huge' },
    ]);
    expect(labels(areaSquares(state, null, { shape: 'cone', sizeFt: 15, fromId: 'c', toward: dir('east') }))).toEqual(['E4', 'F4', 'D5', 'E5', 'F5', 'E6', 'F6']);
    expect(labels(areaSquares(state, null, { shape: 'cone', sizeFt: 15, fromId: 'c', toward: square('I11') }))).toEqual([
      'D6', 'E6', 'F6', 'D7', 'E7', 'F7', 'D8', 'E8', 'F8',
    ]);
    expect(count(state, { shape: 'cone', sizeFt: 30, fromId: 'c', toward: dir('east') })).toBe(24);
    expect(count(state, { shape: 'cone', sizeFt: 60, fromId: 'far', toward: dir('east') })).toBe(84);
    // A Large caster at C25:D26 (the C5:D6 case moved down 20 rows): 8 squares.
    expect(labels(areaSquares(state, null, { shape: 'cone', sizeFt: 15, fromId: 'large', toward: dir('east') }))).toEqual([
      'G24', 'E25', 'F25', 'G25', 'E26', 'F26', 'G26', 'G27',
    ]);
    expect(count(state, { shape: 'cone', sizeFt: 60, fromId: 'huge', toward: dir('east') })).toBe(96);
    // The caster's own squares are never in its cone.
    for (const id of ['c', 'large', 'huge']) {
      const r = resolved(resolveArea(state, null, { shape: 'cone', sizeFt: 30, fromId: id, toward: dir('south-east') }));
      expect(ids(r)).not.toContain(id);
    }
  });

  it('A4: from C8, exactly 7 aims catch both C7 and D7; aimed at D6 it covers 9 squares (D9)', () => {
    const dims = { width: 16, height: 16 };
    const state = board(16, 16, [], [{ id: 'mira', at: 'C8', side: 'player' }]);
    const aims: string[] = [];
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        if (x === 2 && y === 7) continue;
        const got = labels(areaSquares(state, null, { shape: 'cone', sizeFt: 15, fromId: 'mira', toward: { kind: 'square', at: { x, y } } }));
        if (got.includes('C7') && got.includes('D7')) aims.push(squareLabel({ x, y }));
      }
    }
    expect(aims.sort()).toEqual(['D5', 'D6', 'E2', 'E3', 'E4', 'F1', 'F2']);
    expect(labels(areaSquares(state, null, { shape: 'cone', sizeFt: 15, fromId: 'mira', toward: square('D6', dims) }))).toEqual([
      'C5', 'D5', 'E5', 'F5', 'C6', 'D6', 'E6', 'C7', 'D7',
    ]);
  });

  it('a cone from a square with no creature starts there and leaves that square out unless includeOrigin', () => {
    const state = board(40, 40);
    const spec: AreaSpec = { shape: 'cone', sizeFt: 15, at: square('C5'), toward: dir('east') };
    expect(labels(areaSquares(state, null, spec))).toEqual(['E4', 'F4', 'D5', 'E5', 'F5', 'E6', 'F6']);
    expect(labels(areaSquares(state, null, { ...spec, includeOrigin: true }))).toContain('C5');
  });
});

describe('lines are stepped (srd:rule:line; app convention D10)', () => {
  it('A5: 30×5 east, south-east and toward G6 from C4; 60×10; 100×5; from Large and Huge casters', () => {
    const state = board(40, 40, [], [
      { id: 'c', at: 'C4' },
      { id: 'large', at: 'C5', size: 'Large' },
      { id: 'huge', at: 'K11', size: 'Huge' },
    ]);
    const line = (from: string, toward: MapRef, sizeFt: number, widthFt?: number) =>
      areaSquares(state, null, { shape: 'line', sizeFt, widthFt, fromId: from, toward });
    expect(rectsLabel(resolved(resolveArea(state, null, { shape: 'line', sizeFt: 30, fromId: 'c', toward: dir('east') })).squares)).toBe('D4:I4');
    expect(labels(line('c', dir('south-east'), 30))).toEqual(['D5', 'E6', 'F7', 'G8', 'H9', 'I10']);
    expect(labels(line('c', square('G6'), 30))).toEqual(['D5', 'E5', 'F6', 'G6', 'H7', 'I7']);
    const wide = line('c', dir('east'), 60, 10);
    expect(wide).toHaveLength(24);
    expect([...new Set(wide.map((p) => p.y + 1))].sort((a, b) => a - b)).toEqual([4, 5]);
    expect(line('c', dir('east'), 100)).toHaveLength(20);
    expect(line('c', dir('south-east'), 100)).toHaveLength(20);
    expect(rectsLabel(resolved(resolveArea(state, null, { shape: 'line', sizeFt: 30, fromId: 'large', toward: dir('east') })).squares)).toBe('E6:J6');
    expect(rectsLabel(resolved(resolveArea(state, null, { shape: 'line', sizeFt: 30, fromId: 'huge', toward: dir('east') })).squares)).toBe('N12:S12');
  });

  it('R2: from a Large or Gargantuan caster, a line aimed exactly north-east or south-west passes through its target (srd:rule:line; app convention D10)', () => {
    const state = board(40, 40, [], [
      { id: 'dragon', at: 'G9', size: 'Large' }, // G9:H10
      { id: 'hero', at: 'J7', side: 'player' }, // on the dragon's exact north-east diagonal
      { id: 'ancient', at: 'G25', size: 'Gargantuan' }, // G25:J28
      { id: 'scout', at: 'K24', side: 'player' }, // on its exact north-east diagonal
    ]);
    const line = (from: string, toward: MapRef) => resolved(resolveArea(state, null, { shape: 'line', sizeFt: 30, widthFt: 5, fromId: from, toward }));
    const ne = line('dragon', creature('hero'));
    expect(labels(areaSquares(state, null, { shape: 'line', sizeFt: 30, fromId: 'dragon', toward: creature('hero') }))).toEqual(['N3', 'M4', 'L5', 'K6', 'J7', 'I8']);
    expect(ids(ne)).toEqual(['hero']);
    expect(labels(areaSquares(state, null, { shape: 'line', sizeFt: 30, fromId: 'dragon', toward: dir('north-east') }))).toEqual(['N3', 'M4', 'L5', 'K6', 'J7', 'I8']);
    expect(labels(areaSquares(state, null, { shape: 'line', sizeFt: 30, fromId: 'dragon', toward: dir('south-west') }))).toEqual(['F11', 'E12', 'D13', 'C14', 'B15', 'A16']);
    // The other two diagonals were already right and stay so.
    expect(labels(areaSquares(state, null, { shape: 'line', sizeFt: 30, fromId: 'dragon', toward: dir('north-west') }))).toEqual(['A3', 'B4', 'C5', 'D6', 'E7', 'F8']);
    expect(labels(areaSquares(state, null, { shape: 'line', sizeFt: 30, fromId: 'dragon', toward: dir('south-east') }))).toEqual(['I11', 'J12', 'K13', 'L14', 'M15', 'N16']);
    expect(ids(line('ancient', creature('scout')))).toEqual(['scout']);
  });

  it('R2: every square a line is aimed at is inside it, from every size of caster, and the line keeps its length (app convention D10; spec §3.6)', () => {
    const misses: string[] = [];
    for (const size of ['Medium', 'Large', 'Huge', 'Gargantuan'] as const) {
      const n = { Medium: 1, Large: 2, Huge: 3, Gargantuan: 4 }[size];
      const state = board(40, 40, [], [{ id: 'c', at: 'S19', size }]); // S19 = (18, 18): every line stays on the map
      for (let y = 18 - 11; y <= 18 + n - 1 + 11; y++) {
        for (let x = 18 - 11; x <= 18 + n - 1 + 11; x++) {
          if (x >= 18 && x < 18 + n && y >= 18 && y < 18 + n) continue;
          const got = areaSquares(state, null, { shape: 'line', sizeFt: 60, fromId: 'c', toward: { kind: 'square', at: { x, y } } });
          const gap = (p: GridPoint) => Math.max(0, p.x - (18 + n - 1), 18 - p.x, p.y - (18 + n - 1), 18 - p.y);
          if (!got.some((p) => p.x === x && p.y === y)) misses.push(`${size} → ${squareLabel({ x, y })}`);
          expect(got).toHaveLength(12);
          expect(Math.max(...got.map(gap))).toBe(12);
        }
      }
    }
    expect(misses).toEqual([]);
  });

  it("a 30×5 line is 6 squares at every aim, and its last square is 30 ft away by the grid count", () => {
    const state = board(40, 40, [], [{ id: 'c', at: 'T20' }]);
    for (let y = 10; y <= 30; y++) {
      for (let x = 10; x <= 30; x++) {
        if (x === 19 && y === 19) continue;
        const got = areaSquares(state, null, { shape: 'line', sizeFt: 30, fromId: 'c', toward: { kind: 'square', at: { x, y } } });
        expect(got).toHaveLength(6);
        const farthest = Math.max(...got.map((p) => Math.max(Math.abs(p.x - 19), Math.abs(p.y - 19))));
        expect(farthest).toBe(6);
      }
    }
  });
});

describe('cubes (srd:rule:cube; app convention D11)', () => {
  it('A6: from C6 east, north-east and 10 ft east; placed 15, 20 and 10 ft at H8', () => {
    const state = board(40, 40, [], [{ id: 'c', at: 'C6' }]);
    const cube = (spec: Partial<AreaSpec>) => rectsLabel(resolved(resolveArea(state, null, { shape: 'cube', ...spec })).squares);
    expect(cube({ sizeFt: 15, fromId: 'c', toward: dir('east') })).toBe('D5:F7');
    expect(cube({ sizeFt: 15, fromId: 'c', toward: dir('north-east') })).toBe('D3:F5');
    expect(cube({ sizeFt: 10, fromId: 'c', toward: dir('east') })).toBe('D5:E6');
    expect(cube({ sizeFt: 15, at: square('H8') })).toBe('G7:I9');
    expect(cube({ sizeFt: 20, at: square('H8') })).toBe('G7:J10');
    expect(cube({ sizeFt: 10, at: square('H8') })).toBe('H8:I9');
    // A corner centres an even cube exactly; an aim at a square snaps to the nearest of 8 directions.
    expect(cube({ sizeFt: 20, at: corner('H8/I9') })).toBe('G7:J10');
    expect(cube({ sizeFt: 15, fromId: 'c', toward: square('J7') })).toBe('D5:F7');
  });
});

describe('emanations (srd:rule:emanation; app convention D12)', () => {
  it('A7: 5/10/15 ft around a Medium creature at E5; 15 ft around a Large one; the 10-ft extent', () => {
    const state = board(40, 40, [], [
      { id: 'm', at: 'E5' },
      { id: 'l', at: 'T20', size: 'Large' },
    ]);
    expect([5, 10, 15].map((s) => areaSquares(state, null, { shape: 'emanation', sizeFt: s, fromId: 'm' }).length)).toEqual([8, 24, 48]);
    expect(areaSquares(state, null, { shape: 'emanation', sizeFt: 15, fromId: 'l' })).toHaveLength(60);
    const ten = labels(areaSquares(state, null, { shape: 'emanation', sizeFt: 10, fromId: 'm' }));
    expect(ten[0]).toBe('C3');
    expect(ten[ten.length - 1]).toBe('G7');
    expect(ten).not.toContain('E5');
    expect(labels(areaSquares(state, null, { shape: 'emanation', sizeFt: 10, fromId: 'm', includeOrigin: true }))).toContain('E5');
  });

  it('an emanation reaches up and down by the 3D grid count (D14)', () => {
    const state = board(40, 40, [], [
      { id: 'cleric', at: 'E5', side: 'player' },
      { id: 'low', at: 'F5', elevationFt: 15 },
      { id: 'high', at: 'F6', elevationFt: 20 },
    ]);
    const r = resolved(resolveArea(state, null, { shape: 'emanation', sizeFt: 15, fromId: 'cleric' }));
    expect(ids(r)).toEqual(['low']);
    expect(r.outside).toEqual(['cleric', 'high']);
  });
});

describe('Total Cover and filling squares (srd:rule:area-of-effect; app convention C19, D13)', () => {
  it('A8: a 20-ft sphere at D4/E5 beside a wall column F1:F12; then with an open door at F4', () => {
    const dims = { width: 16, height: 12 };
    const cast: Who[] = [{ id: 'behind', at: 'H4' }];
    const walled = board(16, 12, [['wall', 'F1:F12']], cast);
    const spec: AreaSpec = { shape: 'sphere', sizeFt: 20, at: corner('D4/E5', dims) };
    const r = resolved(resolveArea(walled, null, spec));
    const kept = areaSquares(walled, null, spec);
    expect(r.offMap).toBe(0);
    expect(kept).toHaveLength(34);
    // 52 squares in bounds: 8 are wall (never in an area), 34 kept, so 10 are shielded.
    expect(kept.some((p) => p.x === 5)).toBe(false);
    expect(r.shielded).toEqual([{ id: 'behind', by: ['wall'] }]);
    expect(ids(r)).toEqual([]);

    const door = board(16, 12, [['wall', 'F1:F12'], ['door', 'F4', { door: 'open' }]], cast);
    const opened = areaSquares(door, null, spec);
    expect(opened).toHaveLength(41);
    expect(labels(opened.filter((p) => p.x > 5))).toEqual(['G3', 'H3', 'G4', 'H4', 'G5', 'H5']);
    expect(ids(resolved(resolveArea(door, null, spec)))).toEqual(['behind']);
  });

  it('three-quarters cover squares are never in an area; half cover squares are', () => {
    const state = board(16, 12, [
      ['three-quarters-cover', 'G4'],
      ['half-cover', 'H4'],
    ]);
    const got = labels(areaSquares(state, null, { shape: 'sphere', sizeFt: 10, at: square('G5', { width: 16, height: 12 }) }));
    expect(got).not.toContain('G4');
    expect(got).toContain('H4');
  });
});

describe('the warehouse fixture (spells as named)', () => {
  const hero = sampleCharacter();
  const fixtureDims = { width: 16, height: 12 };
  const at = (label: string) => square(label, fixtureDims);
  const withBandit1At = (label: string): CombatState => {
    const state = sampleMappedCombat();
    const p = parseSquare(label, fixtureDims);
    if (!p.ok) throw new Error(p.problem);
    return { ...state, combatants: state.combatants.map((c) => (c.id === 'c-2' ? { ...c, position: p.value } : c)) };
  };

  it('A9: Fireball at G4 (srd:spell:fireball): Bandit 1 and Bandit 2; the centre is 25 ft from Mira', () => {
    const r = resolved(resolveArea(sampleMappedCombat(), hero, { shape: 'sphere', sizeFt: 20, at: at('G4'), fromId: 'c-1' }, { rangeFt: 150 }));
    expect(ids(r)).toEqual(['c-2', 'c-3']);
    expect(r.outside).toEqual(['c-1', 'c-5', 'c-4', 'c-6']);
    expect(r.origin).toEqual({ fromId: 'c-1', distanceFt: 25, lineOfSight: true, withinRange: true });
    // Its top square (G0) is past the north edge.
    expect(r.offMap).toBe(1);
  });

  it('A9: Burning Hands toward C5 (srd:spell:burning-hands) and Thunderwave north-east (srd:spell:thunderwave) catch Bandit 1 at C5', () => {
    const state = withBandit1At('C5');
    const bh = resolved(resolveArea(state, hero, { shape: 'cone', sizeFt: 15, fromId: 'c-1', toward: at('C5') }));
    expect(rectsLabel(bh.squares)).toBe('C3:E5');
    expect(ids(bh)).toEqual(['c-2']);
    expect(bh.origin).toEqual({ fromId: 'c-1', distanceFt: 0, lineOfSight: true });
    const tw = resolved(resolveArea(state, hero, { shape: 'cube', sizeFt: 15, fromId: 'c-1', toward: dir('north-east') }));
    expect(rectsLabel(tw.squares)).toBe('C3:E5');
    expect(ids(tw)).toEqual(['c-2']);
  });

  it('A9: Web, a 20-ft cube at H8 (srd:spell:web), catches the Dock Ogre; Spirit Guardians (srd:spell:spirit-guardians) catches Old Tam', () => {
    const state = sampleMappedCombat();
    const web = resolved(resolveArea(state, hero, { shape: 'cube', sizeFt: 20, at: at('H8') }));
    expect(rectsLabel(web.squares)).toBe('G7:J10');
    expect(ids(web)).toEqual(['c-6']);
    const sg = resolved(resolveArea(state, hero, { shape: 'emanation', sizeFt: 15, fromId: 'c-1' }));
    expect(ids(sg)).toEqual(['c-4']);
  });

  it('A9: Lightning Bolt toward F4 (srd:spell:lightning-bolt): 11 squares on the map, 9 off it; Bandit 1', () => {
    const r = resolved(resolveArea(sampleMappedCombat(), hero, { shape: 'line', sizeFt: 100, widthFt: 5, fromId: 'c-1', toward: at('F4') }));
    const squares = r.squares.flatMap((q) => {
      const out: GridPoint[] = [];
      for (let y = q.y0; y <= q.y1; y++) for (let x = q.x0; x <= q.x1; x++) out.push({ x, y });
      return out;
    });
    expect(labels(squares)).toEqual(['L1', 'M1', 'J2', 'K2', 'H3', 'I3', 'F4', 'G4', 'D5', 'E5', 'C6']);
    expect(r.offMap).toBe(9);
    expect(ids(r)).toEqual(['c-2']);
  });

  it('cover against the blast: a creature behind another creature has Half Cover from the origin', () => {
    // Fireball centred on D4: Bandit 2 (F3) is behind nobody; with Bandit 1 at E3 between them, Bandit 2 has Half Cover.
    const state = withBandit1At('E3');
    const r = resolved(resolveArea(state, hero, { shape: 'sphere', sizeFt: 20, at: at('D3') }));
    const b2 = r.inside.find((h) => h.id === 'c-3');
    expect(b2?.cover).toEqual({ degree: 'half', byTerrain: [], byCreatureIds: ['c-2'] });
    expect(r.inside.find((h) => h.id === 'c-2')?.cover.degree).toBe('none');
  });

  it('R3: Burning Hands cast from the crates, and a Fireball centred on them, give no cover from those crates (srd:rule:combat-cover)', () => {
    const state = board(12, 12, [['half-cover', 'E5', { label: 'crates' }], ['half-cover', 'G7', { label: 'crates' }]], [
      { id: 'mira', at: 'E5', side: 'player' },
      { id: 'b1', at: 'D5' },
      { id: 'b2', at: 'H7' },
    ]);
    const cone = resolved(resolveArea(state, null, { shape: 'cone', sizeFt: 15, fromId: 'mira', toward: dir('west') }));
    expect(cone.inside).toEqual([{ id: 'b1', squaresInside: 1, cover: { degree: 'none', byTerrain: [], byCreatureIds: [] } }]);
    const fireball = resolved(resolveArea(state, null, { shape: 'sphere', sizeFt: 5, at: square('G7', { width: 12, height: 12 }) }));
    expect(fireball.inside.find((h) => h.id === 'b2')?.cover.degree).toBe('none');
    // One square further off, the same crates stand between the blast and H7.
    const beside = resolved(resolveArea(state, null, { shape: 'sphere', sizeFt: 10, at: square('F7', { width: 12, height: 12 }) }));
    expect(beside.inside.find((h) => h.id === 'b2')?.cover).toEqual({ degree: 'half', byTerrain: ['crates'], byCreatureIds: [] });
  });

  it('reports a corner centre, and whether the caster can see the centre (the "near side" rule is the DM\'s call)', () => {
    const corner = resolved(resolveArea(sampleMappedCombat(), hero, { shape: 'sphere', sizeFt: 10, at: { kind: 'corner', x: 8, y: 7 }, fromId: 'c-1' }));
    expect(corner.origin).toMatchObject({ fromId: 'c-1', corner: { x: 8, y: 7 }, lineOfSight: true });
    const onOgre = resolved(resolveArea(sampleMappedCombat(), hero, { shape: 'sphere', sizeFt: 10, at: { kind: 'creature', id: 'c-6' } }));
    expect(onOgre.origin).toEqual({ corner: { x: 8, y: 10 } });
    expect(ids(onOgre)).toEqual(['c-6']);
    // Inside the office, behind its wall: Mira can't see the centre.
    const office = resolved(resolveArea(sampleMappedCombat(), hero, { shape: 'sphere', sizeFt: 5, at: at('N2'), fromId: 'c-1' }));
    expect(office.origin.lineOfSight).toBe(false);
  });

  it('A12: a range of 20 ft with the centre 25 ft away is out of range (srd:rule:casting-spells-range)', () => {
    const r = resolved(resolveArea(sampleMappedCombat(), hero, { shape: 'sphere', sizeFt: 20, at: at('G4'), fromId: 'c-1' }, { rangeFt: 20 }));
    expect(r.origin.distanceFt).toBe(25);
    expect(r.origin.withinRange).toBe(false);
  });

  it('the player perspective leaves the hidden Cutthroat out of every list', () => {
    const state = sampleMappedCombat();
    const spec: AreaSpec = { shape: 'sphere', sizeFt: 20, at: at('M8') };
    const dm = resolved(resolveArea(state, hero, spec));
    expect(ids(dm)).toEqual(['c-5']);
    const player = resolved(resolveArea(state, hero, spec, { perspective: 'player' }));
    expect(ids(player)).toEqual([]);
    expect(player.outside).not.toContain('c-5');
    expect(player.squares).toEqual(dm.squares);
    expect(resolveArea(state, hero, { shape: 'sphere', sizeFt: 10, at: creature('c-5') }, { perspective: 'player' })).toHaveProperty('problem');
  });
});

describe('creatures inside (app convention C19, D14)', () => {
  it('A10: a Large creature with one square inside is hit; a flier 30 ft up is outside a 20-ft sphere on the ground, 15 ft up inside', () => {
    const dims = { width: 16, height: 12 };
    const state = board(16, 12, [], [
      { id: 'ogre', at: 'J3', size: 'Large' },
      { id: 'high', at: 'E3', elevationFt: 30 },
      { id: 'low', at: 'F3', elevationFt: 15 },
    ]);
    const r = resolved(resolveArea(state, null, { shape: 'sphere', sizeFt: 20, at: square('F4', dims) }));
    expect(r.inside.find((h) => h.id === 'ogre')?.squaresInside).toBe(1);
    expect(ids(r)).toEqual(['ogre', 'low']);
    expect(r.outside).toEqual(['high']);
  });

  it('cones and lines ignore height and flag fliers; cylinders use their base and height', () => {
    const dims = { width: 16, height: 12 };
    const state = board(16, 12, [], [
      { id: 'caster', at: 'B4', side: 'player' },
      { id: 'harpy', at: 'D4', elevationFt: 20 },
    ]);
    const cone = resolved(resolveArea(state, null, { shape: 'cone', sizeFt: 15, fromId: 'caster', toward: dir('east') }));
    expect(cone.inside).toEqual([{ id: 'harpy', squaresInside: 1, cover: { degree: 'none', byTerrain: [], byCreatureIds: [] }, airborneFt: 20 }]);
    const low = resolved(resolveArea(state, null, { shape: 'cylinder', sizeFt: 5, heightFt: 15, at: square('D4', dims) }));
    expect(ids(low)).toEqual([]);
    const tall = resolved(resolveArea(state, null, { shape: 'cylinder', sizeFt: 5, heightFt: 40, at: square('D4', dims) }));
    expect(ids(tall)).toEqual(['harpy']);
  });

  it('an area partly off the map counts the squares it lost and catches nothing there', () => {
    const state = board(16, 12, [], [{ id: 'a', at: 'A1' }]);
    const r = resolved(resolveArea(state, null, { shape: 'sphere', sizeFt: 10, at: square('A1', { width: 16, height: 12 }) }));
    expect(r.offMap).toBe(13 - 6);
    expect(ids(r)).toEqual(['a']);
  });

  it('squares-shaped areas take exactly the given squares (minus walls) and flag fliers', () => {
    const dims = { width: 16, height: 12 };
    const rects = parseSquareList('G7:J10', dims);
    if (!rects.ok) throw new Error(rects.problem);
    const state = board(16, 12, [['wall', 'G7']], [
      { id: 'a', at: 'H8' },
      { id: 'b', at: 'J10', elevationFt: 10 },
      { id: 'c', at: 'K10' },
    ]);
    const r = resolved(resolveArea(state, null, { shape: 'squares', rects: rects.value }));
    expect(areaSquares(state, null, { shape: 'squares', rects: rects.value })).toHaveLength(15);
    expect(ids(r)).toEqual(['a', 'b']);
    expect(r.inside[1].airborneFt).toBe(10);
    expect(r.outside).toEqual(['c']);
  });

  it('absurd sizes from stored data are capped instead of hanging; squares off the map are counted, not enumerated', () => {
    const state = board(16, 12, [], [{ id: 'a', at: 'A1' }]);
    const huge = resolved(resolveArea(state, null, { shape: 'sphere', sizeFt: 1e9, at: square('A1', { width: 16, height: 12 }) }));
    expect(ids(huge)).toEqual(['a']);
    const far = resolved(resolveArea(state, null, { shape: 'squares', rects: [{ x0: 14, y0: 10, x1: 1e6, y1: 11 }] }));
    expect(rectsLabel(far.squares)).toBe('O11:P12');
    expect(far.offMap).toBe((1e6 - 14 + 1) * 2 - 4);
    expect(areaSquares(state, null, { shape: 'line', sizeFt: 30, widthFt: 1e9, fromId: 'a', toward: dir('east') }).length).toBeGreaterThan(0);
  });

  it('results do not depend on the order of the combatant list (determinism)', () => {
    const state = sampleMappedCombat();
    const shuffled: CombatState = { ...state, combatants: [...state.combatants].reverse() };
    const specs: AreaSpec[] = [
      { shape: 'sphere', sizeFt: 20, at: { kind: 'square', at: { x: 6, y: 3 } }, fromId: 'c-1' },
      { shape: 'cone', sizeFt: 30, fromId: 'c-1', toward: { kind: 'creature', id: 'c-2' } },
      { shape: 'line', sizeFt: 60, fromId: 'c-6', toward: { kind: 'creature', id: 'c-1' } },
      { shape: 'emanation', sizeFt: 10, fromId: 'c-6' },
    ];
    for (const spec of specs) {
      const a = resolved(resolveArea(state, sampleCharacter(), spec));
      const b = resolved(resolveArea(shuffled, sampleCharacter(), spec));
      expect(b.squares).toEqual(a.squares);
      expect([...b.inside].sort((x, y) => x.id.localeCompare(y.id))).toEqual([...a.inside].sort((x, y) => x.id.localeCompare(y.id)));
      expect([...b.outside].sort()).toEqual([...a.outside].sort());
      expect(b.origin).toEqual(a.origin);
    }
  });
});

describe('problems', () => {
  it('names what is missing instead of throwing', () => {
    const state = sampleMappedCombat();
    const problem = (spec: AreaSpec) => {
      const r = resolveArea(state, sampleCharacter(), spec);
      return 'problem' in r ? r.problem : null;
    };
    expect(problem({ shape: 'sphere', sizeFt: 20 })).toMatch(/needs "at"/);
    expect(problem({ shape: 'cone', sizeFt: 15, fromId: 'c-1' })).toMatch(/toward/);
    expect(problem({ shape: 'cone', sizeFt: 15, fromId: 'c-1', toward: { kind: 'creature', id: 'c-1' } })).toMatch(/own origin/);
    expect(problem({ shape: 'emanation', sizeFt: 15 })).toMatch(/needs "from"/);
    expect(problem({ shape: 'squares' })).toMatch(/squares/);
    expect(problem({ shape: 'cube', sizeFt: 0, at: { kind: 'square', at: { x: 1, y: 1 } } })).toMatch(/at least 5 ft/);
    expect(problem({ shape: 'sphere', sizeFt: 20, at: { kind: 'square', at: { x: 30, y: 1 } } })).toMatch(/off the map/);
    const unplaced: CombatState = { ...state, combatants: state.combatants.map((c) => (c.id === 'c-4' ? { ...c, position: undefined } : c)) };
    const r = resolveArea(unplaced, sampleCharacter(), { shape: 'emanation', sizeFt: 10, fromId: 'c-4' });
    expect(r).toEqual({ problem: "Old Tam isn't on the map." });
    const { map: _map, ...noMap } = state;
    expect(resolveArea(noMap, null, { shape: 'sphere', sizeFt: 20, at: { kind: 'square', at: { x: 1, y: 1 } } })).toHaveProperty('problem');
    expect(areaSquares(noMap, null, { shape: 'sphere', sizeFt: 20, at: { kind: 'square', at: { x: 1, y: 1 } } })).toEqual([]);
  });
});

describe('effect squares', () => {
  const effect = (spec: AreaSpec, rects: MapEffect['rects']): MapEffect => ({
    id: 'e1',
    label: 'Spirit Guardians',
    spec,
    rects,
    terrain: [],
    duration: 'lasting',
    round: 2,
    turnOfId: 'c-1',
  });

  it('an emanation follows its creature; a removed creature leaves no squares (orphan); others keep their rects', () => {
    const state = sampleMappedCombat();
    const sg = effect({ shape: 'emanation', sizeFt: 5, fromId: 'c-4' }, []);
    expect(effectSquares(state, null, sg).map(rectLabel)).toEqual(['A4:C4', 'A5', 'C5', 'A6:C6']);
    const gone: CombatState = { ...state, combatants: state.combatants.filter((c) => c.id !== 'c-4') };
    expect(effectSquares(gone, null, sg)).toEqual([]);
    const web = effect({ shape: 'cube', sizeFt: 20, at: { kind: 'square', at: { x: 7, y: 7 } } }, [{ x0: 6, y0: 6, x1: 9, y1: 9 }]);
    expect(effectSquares(gone, null, web)).toEqual([{ x0: 6, y0: 6, x1: 9, y1: 9 }]);
  });
});

describe('parseAreaText (srd-rules §6.5)', () => {
  const compendium = JSON.parse(compendiumRaw) as CompendiumEntry[];
  const text = (id: string) => {
    const entry = compendium.find((e) => e.id === id);
    if (!entry) throw new Error(`no ${id}`);
    return entry.text;
  };

  it('A11: the SRD texts of Fireball, Burning Hands, Lightning Bolt, Moonbeam, Spirit Guardians, Thunderwave and Entangle', () => {
    expect(parseAreaText(text('srd:spell:fireball'))).toEqual({ shape: 'sphere', sizeFt: 20 });
    expect(parseAreaText(text('srd:spell:burning-hands'))).toEqual({ shape: 'cone', sizeFt: 15 });
    // Not the stored data.area (its size is the Line's width).
    expect(parseAreaText(text('srd:spell:lightning-bolt'))).toEqual({ shape: 'line', sizeFt: 100, widthFt: 5 });
    expect(parseAreaText(text('srd:spell:moonbeam'))).toEqual({ shape: 'cylinder', sizeFt: 5, heightFt: 40 });
    expect(parseAreaText(text('srd:spell:spirit-guardians'))).toEqual({ shape: 'emanation', sizeFt: 15 });
    expect(parseAreaText(text('srd:spell:thunderwave'))).toEqual({ shape: 'cube', sizeFt: 15 });
    expect(parseAreaText(text('srd:spell:entangle'))).toEqual({ shape: 'cube', sizeFt: 20 });
  });

  it('the first area phrase wins, and SRD spelling variants parse', () => {
    expect(parseAreaText(text('srd:spell:darkness'))).toEqual({ shape: 'sphere', sizeFt: 15 });
    expect(parseAreaText(text('srd:spell:web'))).toEqual({ shape: 'cube', sizeFt: 20 });
    expect(parseAreaText(text('srd:spell:sleet-storm'))).toEqual({ shape: 'cylinder', sizeFt: 20, heightFt: 40 });
    expect(parseAreaText(text('srd:spell:call-lightning'))).toEqual({ shape: 'cylinder', sizeFt: 60, heightFt: 10 });
    expect(parseAreaText(text('srd:spell:gust-of-wind'))).toEqual({ shape: 'line', sizeFt: 60, widthFt: 10 });
    expect(parseAreaText(text('srd:spell:grease'))).toEqual({ shape: 'cube', sizeFt: 10 });
    expect(parseAreaText(text('srd:spell:flame-strike'))).toEqual({ shape: 'cylinder', sizeFt: 10, heightFt: 40 });
    expect(parseAreaText(text('srd:spell:sunbeam'))).toEqual({ shape: 'line', sizeFt: 60, widthFt: 5 });
    expect(parseAreaText(text('srd:monster:adult-blue-dragon'))).toEqual({ shape: 'line', sizeFt: 90, widthFt: 5 });
    expect(parseAreaText('Fire Breath (Recharge 5–6). Dexterity Saving Throw: DC 21, each creature in a 60-foot Cone.')).toEqual({ shape: 'cone', sizeFt: 60 });
    expect(parseAreaText('a 30-foot Line')).toEqual({ shape: 'line', sizeFt: 30 });
  });

  it('is null when the text has no area', () => {
    expect(parseAreaText(text('srd:spell:magic-missile'))).toBeNull();
    expect(parseAreaText('It sheds Bright Light in a 20-foot radius.')).toBeNull();
    expect(parseAreaText(text('srd:spell:flaming-sphere'))).toBeNull();
    expect(parseAreaText('')).toBeNull();
  });
});

describe('performance (battle-map spec §7.12, generous margins)', () => {
  it('resolves a 60-ft sphere on a 40×40 map with 30 creatures and walls in well under 50 ms', () => {
    const cast: Who[] = [];
    for (let i = 0; i < 30; i++) cast.push({ id: `c${i}`, at: squareLabel({ x: (i * 7) % 40, y: Math.floor((i * 7) / 40) * 3 + 10 }) });
    const state = board(40, 40, [['wall', 'A20:AN20'], ['wall', 'T1:T19'], ['half-cover', 'E5:H8']], cast);
    resolveArea(state, null, { shape: 'sphere', sizeFt: 60, at: square('S18') }); // warm up
    const t0 = performance.now();
    const r = resolved(resolveArea(state, null, { shape: 'sphere', sizeFt: 60, at: square('S18') }));
    const ms = performance.now() - t0;
    expect(r.squares.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(50);
  });
});
