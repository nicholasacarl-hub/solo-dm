import { describe, expect, it } from 'vitest';
import type { BattleMap, Combatant, CombatSide, CombatState, CreatureSize, TerrainFeature, TerrainKind } from '@/types';
import { sampleCharacter, sampleMappedCombat } from '@/test/fixtures';
import { parseSquare, parseSquareList } from './grid';
import { coverAgainst, coverFromPoint, lineOfSight, totalCoverBetween } from './sight';

const DIMS = { width: 16, height: 12 };
const sq = (label: string) => {
  const p = parseSquare(label, DIMS);
  if (!p.ok) throw new Error(p.problem);
  return p.value;
};
const rects = (text: string) => {
  const r = parseSquareList(text, DIMS);
  if (!r.ok) throw new Error(r.problem);
  return r.value;
};

interface Who {
  id: string;
  at: string;
  side?: CombatSide;
  size?: CreatureSize;
  hidden?: boolean;
}

/** A 16×12 map with the given terrain and creatures (no hero sheet: everyone is an NPC). */
function scene(terrain: [TerrainKind, string][], cast: Who[]): CombatState {
  const map: BattleMap = {
    id: 'map-1',
    width: 16,
    height: 12,
    terrain: terrain.map(([kind, squares], i): TerrainFeature => ({ id: `t${i + 1}`, kind, rects: rects(squares) })),
    places: [],
    effects: [],
    nextId: terrain.length + 1,
    rev: 0,
  };
  const combatants: Combatant[] = cast.map((w, i) => ({
    id: w.id,
    name: w.id,
    side: w.side ?? (i === 0 ? 'ally' : 'enemy'),
    isPlayer: false,
    initiative: 20 - i,
    initiativeBonus: 0,
    hp: { max: 10, current: 10, temp: 0 },
    conditions: [],
    defeated: false,
    position: sq(w.at),
    ...(w.size ? { size: w.size } : {}),
    ...(w.hidden ? { hidden: true } : {}),
  }));
  return { active: true, round: 1, turnIndex: 0, combatants, startedAt: 0, map };
}

const degree = (state: CombatState, a: string, t: string) => coverAgainst(state, null, a, t).degree;

describe('cover (SRD 5.2.1 Cover: srd:rule:combat-cover; app convention C21)', () => {
  it('S1: crates (half-cover) at C3 between A3 and E3; a creature there instead', () => {
    const crates = scene([['half-cover', 'C3']], [
      { id: 'a', at: 'A3' },
      { id: 't', at: 'E3' },
    ]);
    expect(coverAgainst(crates, null, 'a', 't')).toEqual({ degree: 'half', byTerrain: ['half cover'], byCreatureIds: [] });
    const body = scene([], [
      { id: 'a', at: 'A3' },
      { id: 't', at: 'E3' },
      { id: 'c', at: 'C3', side: 'neutral' },
    ]);
    expect(coverAgainst(body, null, 'a', 't')).toEqual({ degree: 'half', byTerrain: [], byCreatureIds: ['c'] });
  });

  it('S2: a wall at B2, A3 → C1: line of sight, Three-Quarters Cover', () => {
    const state = scene([['wall', 'B2']], [
      { id: 'a', at: 'A3' },
      { id: 't', at: 'C1' },
    ]);
    expect(lineOfSight(state, null, 'a', 't')).toBe(true);
    expect(coverAgainst(state, null, 'a', 't')).toEqual({ degree: 'three-quarters', byTerrain: ['wall'], byCreatureIds: [] });
  });

  it('S3: a wall B1:B4, A3 → C3: no line of sight, Total Cover (C20)', () => {
    const state = scene([['wall', 'B1:B4']], [
      { id: 'a', at: 'A3' },
      { id: 't', at: 'C3' },
    ]);
    expect(lineOfSight(state, null, 'a', 't')).toBe(false);
    expect(degree(state, 'a', 't')).toBe('total');
  });

  it('S4: an arrow slit (three-quarters cover C3) in a wall C1:C5, A3 → E3: line of sight, Three-Quarters', () => {
    const state = scene(
      [
        ['wall', 'C1:C2'],
        ['wall', 'C4:C5'],
        ['three-quarters-cover', 'C3'],
      ],
      [
        { id: 'a', at: 'A3' },
        { id: 't', at: 'E3' },
      ],
    );
    expect(lineOfSight(state, null, 'a', 't')).toBe(true);
    expect(degree(state, 'a', 't')).toBe('three-quarters');
  });

  it('S5: a crack between walls B1 and A2 seals A1 from B2; one wall B1 alone does not', () => {
    const crack = scene(
      [
        ['wall', 'B1'],
        ['wall', 'A2'],
      ],
      [
        { id: 'a', at: 'A1' },
        { id: 't', at: 'B2' },
      ],
    );
    expect(lineOfSight(crack, null, 'a', 't')).toBe(false);
    expect(degree(crack, 'a', 't')).toBe('total');
    const one = scene([['wall', 'B1']], [
      { id: 'a', at: 'A1' },
      { id: 't', at: 'B2' },
    ]);
    expect(lineOfSight(one, null, 'a', 't')).toBe(true);
    expect(degree(one, 'a', 't')).toBe('none');
  });

  it('S9: crates C3:C4, A3 → a Large target at E3:F4: Half (its least-covered square)', () => {
    const state = scene([['half-cover', 'C3:C4']], [
      { id: 'a', at: 'A3' },
      { id: 't', at: 'E3', size: 'Large' },
    ]);
    expect(degree(state, 'a', 't')).toBe('half');
  });

  it('S10: on the fixture, Bandit 1 (F4) has Half Cover (crates) from Mira (B6) and Mira Half from it; Old Tam none', () => {
    const state = sampleMappedCombat();
    const hero = sampleCharacter();
    expect(coverAgainst(state, hero, 'c-1', 'c-2')).toEqual({ degree: 'half', byTerrain: ['crates'], byCreatureIds: [] });
    // Bandit 1's best corner (F4's north-west corner) has one blocked line to Mira, and Old Tam (B5) blocks it,
    // not the crates (checked with spec-proto/engine.py: levels [1, 0, 0, 0] from that corner).
    expect(coverAgainst(state, hero, 'c-2', 'c-1')).toEqual({ degree: 'half', byTerrain: [], byCreatureIds: ['c-4'] });
    expect(coverAgainst(state, hero, 'c-1', 'c-4').degree).toBe('none');
    expect(coverAgainst(state, hero, 'c-4', 'c-1').degree).toBe('none');
    // Bandit 2 (F3) behind the crates too; the Dock Ogre in the open.
    expect(coverAgainst(state, hero, 'c-1', 'c-3').degree).toBe('half');
    expect(coverAgainst(state, hero, 'c-1', 'c-6').degree).toBe('none');
  });

  it('§4.10: the cover Bandit 1 could reach against Mira: Three-Quarters at I3, J3 and K3 by the pillar, Half at H3', () => {
    const state = sampleMappedCombat();
    const hero = sampleCharacter();
    const at = (label: string) => coverAgainst(state, hero, 'c-1', 'c-2', { targetAt: sq(label) });
    for (const l of ['I3', 'J3', 'K3']) {
      expect(at(l).degree).toBe('three-quarters');
      // The pillar (Total Cover terrain) is named before lesser blockers on the same lines.
      expect(at(l).byTerrain[0]).toBe('pillar');
    }
    expect(at('H3').degree).toBe('half');
  });

  it('creatures give at most Half Cover, Tiny and defeated ones none (C7, C21)', () => {
    const wall = scene([], [
      { id: 'a', at: 'A3' },
      { id: 't', at: 'E3' },
      { id: 'b1', at: 'C2', side: 'neutral' },
      { id: 'b2', at: 'C3', side: 'neutral' },
      { id: 'b3', at: 'C4', side: 'neutral' },
    ]);
    expect(degree(wall, 'a', 't')).toBe('half');
    const tiny = scene([], [
      { id: 'a', at: 'A3' },
      { id: 't', at: 'E3' },
      { id: 'rat', at: 'C3', side: 'neutral', size: 'Tiny' },
    ]);
    expect(degree(tiny, 'a', 't')).toBe('none');
    const fallen = scene([], [
      { id: 'a', at: 'A3' },
      { id: 't', at: 'E3' },
      { id: 'c', at: 'C3', side: 'neutral' },
    ]);
    fallen.combatants[2] = { ...fallen.combatants[2], defeated: true };
    expect(degree(fallen, 'a', 't')).toBe('none');
  });

  it("the player perspective ignores hidden creatures as cover and can't measure to them", () => {
    const state = scene([], [
      { id: 'a', at: 'A3' },
      { id: 't', at: 'E3' },
      { id: 'c', at: 'C3', hidden: true },
    ]);
    expect(coverAgainst(state, null, 'a', 't').degree).toBe('half');
    expect(coverAgainst(state, null, 'a', 't', { perspective: 'player' }).degree).toBe('none');
    expect(coverAgainst(state, null, 'a', 'c', { perspective: 'player' }).degree).toBe('none');
    expect(lineOfSight(state, null, 'a', 'c', { perspective: 'player' })).toBe(false);
    expect(lineOfSight(state, null, 'a', 'c')).toBe(true);
  });

  it('positions can be overridden (attackerAt / targetAt)', () => {
    const state = scene([['wall', 'C1:C12']], [
      { id: 'a', at: 'A3' },
      { id: 't', at: 'E3' },
    ]);
    expect(degree(state, 'a', 't')).toBe('total');
    expect(coverAgainst(state, null, 'a', 't', { attackerAt: sq('D3') }).degree).toBe('none');
    expect(lineOfSight(state, null, 'a', 't', { fromAt: sq('D1') })).toBe(true);
  });

  it('cover from an area origin point ignores the creature the area comes from', () => {
    const state = scene([['half-cover', 'C3']], [
      { id: 'caster', at: 'A3' },
      { id: 't', at: 'E3' },
      { id: 'u', at: 'E5' },
    ]);
    // From the caster's centre: the crates give Half Cover; the caster's own body does not.
    expect(coverFromPoint(state, null, { x2: 1, y2: 5 }, 't')).toEqual({ degree: 'half', byTerrain: ['half cover'], byCreatureIds: [] });
    expect(coverFromPoint(state, null, { x2: 1, y2: 5 }, 'u').degree).toBe('none');
  });
});

describe('line of sight (app convention C20; srd:rule:heavily-obscured)', () => {
  it('S6: a wall D1:D12 seals B6 from F6 along every seam', () => {
    const state = scene([['wall', 'D1:D12']], [
      { id: 'a', at: 'B6' },
      { id: 't', at: 'F6' },
    ]);
    expect(lineOfSight(state, null, 'a', 't')).toBe(false);
  });

  it('S7: a diagonal wall C1 D2 E3 F4 G5 seals B3 from G3 at its cracks', () => {
    const state = scene(
      [
        ['wall', 'C1'],
        ['wall', 'D2'],
        ['wall', 'E3'],
        ['wall', 'F4'],
        ['wall', 'G5'],
      ],
      [
        { id: 'a', at: 'B3' },
        { id: 't', at: 'G3' },
      ],
    );
    expect(lineOfSight(state, null, 'a', 't')).toBe(false);
  });

  it('S8: a target wholly in obscured E3 is unseen; one obscured square between is grazed; an obscured column blocks', () => {
    const cast: Who[] = [
      { id: 'a', at: 'A3' },
      { id: 't', at: 'E3' },
    ];
    expect(lineOfSight(scene([['obscured', 'E3']], cast), null, 'a', 't')).toBe(false);
    expect(lineOfSight(scene([['obscured', 'E3']], cast), null, 't', 'a')).toBe(false);
    expect(lineOfSight(scene([['obscured', 'C3']], cast), null, 'a', 't')).toBe(true);
    expect(lineOfSight(scene([['obscured', 'C1:C12']], cast), null, 'a', 't')).toBe(false);
  });

  it('a lasting obscured effect blocks sight like obscured terrain', () => {
    const state = scene([], [
      { id: 'a', at: 'A3' },
      { id: 't', at: 'E3' },
    ]);
    const map = state.map as BattleMap;
    const fog: CombatState = {
      ...state,
      map: {
        ...map,
        effects: [
          {
            id: 'e1',
            label: 'Fog Cloud',
            spec: { shape: 'squares', rects: rects('C1:C12') },
            rects: rects('C1:C12'),
            terrain: ['obscured'],
            duration: 'lasting',
            round: 1,
            turnOfId: 'a',
          },
        ],
      },
    };
    expect(lineOfSight(state, null, 'a', 't')).toBe(true);
    expect(lineOfSight(fog, null, 'a', 't')).toBe(false);
  });

  it('is false for unknown or unplaced creatures and without a map', () => {
    const state = scene([], [
      { id: 'a', at: 'A3' },
      { id: 't', at: 'E3' },
    ]);
    expect(lineOfSight(state, null, 'a', 'nobody')).toBe(false);
    const unplaced: CombatState = { ...state, combatants: state.combatants.map((c) => (c.id === 't' ? { ...c, position: undefined } : c)) };
    expect(lineOfSight(unplaced, null, 'a', 't')).toBe(false);
    const { map: _map, ...noMap } = state;
    expect(lineOfSight(noMap, null, 'a', 't')).toBe(false);
  });
});

describe('Total Cover between spaces (D7)', () => {
  it('M21 geometry: a wall D3:D5 between C4 and E4 is Total Cover; so is a sealed crack; open floor is not', () => {
    const wall = scene([['wall', 'D3:D5']], [
      { id: 'a', at: 'C4' },
      { id: 't', at: 'E4' },
    ]);
    expect(totalCoverBetween(wall, null, 'a', 't')).toBe(true);
    const crack = scene(
      [
        ['wall', 'B1'],
        ['wall', 'A2'],
      ],
      [
        { id: 'a', at: 'A1' },
        { id: 't', at: 'B2' },
      ],
    );
    expect(totalCoverBetween(crack, null, 'a', 't')).toBe(true);
    const open = scene([], [
      { id: 'a', at: 'C4' },
      { id: 't', at: 'E4' },
    ]);
    expect(totalCoverBetween(open, null, 'a', 't')).toBe(false);
    // Obscured squares and half cover are no Total Cover.
    const fog = scene(
      [
        ['obscured', 'D1:D12'],
        ['half-cover', 'D4'],
      ],
      [
        { id: 'a', at: 'C4' },
        { id: 't', at: 'E4' },
      ],
    );
    expect(totalCoverBetween(fog, null, 'a', 't')).toBe(false);
    // Moving the target round the end of the wall.
    expect(totalCoverBetween(wall, null, 'a', 't', { bAt: sq('E6') })).toBe(false);
  });
});
