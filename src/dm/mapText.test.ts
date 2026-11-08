import { describe, expect, it } from 'vitest';
import mapTextSource from './mapText.ts?raw';
import mapToolsSource from './tools/map.ts?raw';
import combatToolsSource from './tools/combat.ts?raw';
import rollToolsSource from './tools/rolls.ts?raw';
import definitionsSource from './tools/definitions.ts?raw';
import stateSource from './state.ts?raw';
import promptsSource from './prompts.ts?raw';
import sessionSource from './session.ts?raw';
import agentSource from './agent.ts?raw';
import { applyMove, sortCombatants } from '@/engine';
import { sampleCharacter, sampleMappedCombat, sampleStopCombat } from '@/test/fixtures';
import type { BattleMap, Combatant, CombatState, MapEffect, MapStop, TurnMove } from '@/types';
import {
  describeMapSetup,
  describeShow,
  describeStop,
  describeWillingMove,
  finalPositions,
  layoutForPrompt,
  mapNote,
  mapStateLines,
  moveNotes,
  namesHiddenCreature,
  playerLayout,
  relationClause,
  turnStartLine,
  type MovedOutcome,
  type StoppedOutcome,
} from './mapText';
import { BATTLE_MAPS_MODES } from '@/types';
import { battleMapsNotice, battleMapsSection } from './modes';
import { DM_TOOLS } from './tools/definitions';

const hero = sampleCharacter();
const never = () => false;

/** Every DM-facing text the fixtures produce. */
function dmTexts(state: CombatState): string[] {
  return [
    describeMapSetup(state, hero),
    describeShow(state, hero),
    layoutForPrompt(state, hero) ?? '',
    mapStateLines(state, hero, never).join('\n'),
  ];
}

/** Every player-facing text the fixtures produce. */
function playerTexts(state: CombatState): string[] {
  return [playerLayout(state, hero), finalPositions(state, hero) ?? '', mapNote(state, hero, never) ?? ''];
}

/** The hero's turn with a player move recorded (as commitHeroMove writes it). */
function withPlayerMove(state: CombatState, move: TurnMove): CombatState {
  return {
    ...state,
    combatants: state.combatants.map((c) => (c.isPlayer ? { ...c, position: move.to } : c)),
    map: { ...(state.map as BattleMap), turn: { combatantId: 'c-1', round: state.round, movedFt: move.costFt, dashFt: 0, dashes: 0, disengaged: Boolean(move.disengaged), stoodUp: false, moves: [move] } },
  };
}

const B6 = { x: 1, y: 5 };
const C7 = { x: 2, y: 6 };
const D8 = { x: 3, y: 7 };

describe('deterministic text (prompt caching depends on it)', () => {
  it('renders identical text for identical state, however the state object was made', () => {
    for (const make of [() => sampleMappedCombat(), () => sampleMappedCombat({ heroTurn: true }), () => sampleStopCombat()]) {
      const a = make();
      const b: CombatState = JSON.parse(JSON.stringify(make()));
      // Same initiative order whatever order the list arrived in.
      const c: CombatState = { ...b, combatants: sortCombatants([...b.combatants].reverse()) };
      expect(dmTexts(b)).toEqual(dmTexts(a));
      expect(dmTexts(c)).toEqual(dmTexts(a));
      expect(playerTexts(b)).toEqual(playerTexts(a));
    }
  });
});

describe('no ids in any text', () => {
  it('never prints combatant, map, terrain, place or effect ids', () => {
    for (const state of [sampleMappedCombat(), sampleMappedCombat({ heroTurn: true }), sampleStopCombat()]) {
      for (const text of [...dmTexts(state), ...playerTexts(state)]) {
        expect(text).not.toMatch(/\bc-\d+\b|\bmap-\d+\b|\b[tpe]\d+\b/);
      }
    }
  });
});

describe('player-facing text never names a hidden creature (D41)', () => {
  it('leaves the Cutthroat out of the layout, the final positions and the move note', () => {
    const state = withPlayerMove(sampleMappedCombat({ heroTurn: true }), {
      by: 'player',
      kind: 'move',
      from: B6,
      to: C7,
      path: [C7],
      costFt: 5,
      provoked: [{ reactorId: 'c-5', at: B6, hidden: true }],
      entered: [],
      revealedHidden: true,
      blockedById: 'c-5',
    });
    for (const text of playerTexts(state)) expect(text).not.toContain('Cutthroat');
    // …while the DM hears about it.
    expect(mapStateLines(state, hero, never).join('\n')).toContain('[hidden] Cutthroat');
    expect(playerLayout(state, hero)).toContain('- Positions: You C7 · Bandit 1 F4 · Bandit 2 F3 · Old Tam B5 · Dock Ogre H10:I11');
  });
});

describe("the player bubble's mapNote (D51)", () => {
  const base = () => sampleMappedCombat({ heroTurn: true });

  it('joins the moves of a turn into one route, with what the hero spent', () => {
    const first: TurnMove = { by: 'player', kind: 'move', from: B6, to: C7, path: [C7], costFt: 5, provoked: [], entered: [], disengaged: true };
    const second: TurnMove = { by: 'player', kind: 'move', from: C7, to: D8, path: [D8], costFt: 5, provoked: [], entered: [] };
    const state = withPlayerMove(base(), first);
    const map = state.map as BattleMap;
    const both: CombatState = {
      ...state,
      combatants: state.combatants.map((c) => (c.isPlayer ? { ...c, position: D8 } : c)),
      map: { ...map, turn: { ...(map.turn as NonNullable<BattleMap['turn']>), movedFt: 10, moves: [first, second] } },
    };
    expect(mapNote(both, hero, never)).toBe('Moved B6 → C7 → D8 · 10 ft · Disengaged');
  });

  it('notes a stand-up and a stop at an Opportunity Attack', () => {
    const stand: TurnMove = { by: 'player', kind: 'stand', from: B6, to: B6, path: [], costFt: 15, stoodUp: true, provoked: [], entered: [] };
    expect(mapNote(withPlayerMove(base(), stand), hero, never)).toBe('Stood up (15 ft)');
    expect(mapNote(sampleStopCombat(), hero, never)).toBe('Moved toward A7 · stopped at B6 (Opportunity Attack)');
  });

  it('says nothing once the DM has seen the moves, or without a map', () => {
    const told = withPlayerMove(base(), { by: 'player', kind: 'move', from: B6, to: C7, path: [C7], costFt: 5, provoked: [], entered: [], toldSeq: 3 });
    expect(mapNote(told, hero, (seq) => seq === 3)).toBeUndefined();
    expect(mapNote(told, hero, never)).toBe('Moved B6 → C7 · 5 ft');
    expect(mapNote(sampleMappedCombat(), hero, never)).toBeUndefined();
    expect(mapNote(null, hero, never)).toBeUndefined();
  });
});

describe('no gendered pronouns for anyone (amendment 1)', () => {
  const PRONOUNS = /\b(he|she|him|her|his|hers|himself|herself)\b/i;

  it('has none in the templates', () => {
    for (const [file, source] of [
      ['mapText.ts', mapTextSource],
      ['tools/map.ts', mapToolsSource],
      ['tools/combat.ts', combatToolsSource],
      ['tools/rolls.ts', rollToolsSource],
      ['tools/definitions.ts', definitionsSource],
      ['state.ts', stateSource],
      ['prompts.ts', promptsSource],
      ['session.ts', sessionSource],
      ['agent.ts', agentSource],
    ] as const) {
      const strings = source.match(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g) ?? [];
      for (const s of strings) expect(s, `${file}: ${s}`).not.toMatch(PRONOUNS);
    }
  });

  it('has none in rendered results either', () => {
    const state = sampleMappedCombat({ heroTurn: true });
    const moved = applyMove(sampleMappedCombat(), hero, { moverId: 'c-2', kind: 'move', by: 'dm', to: { kind: 'creature', id: 'c-1' } });
    const atC5 = (c: Combatant) => (c.id === 'c-2' ? { ...c, position: { x: 2, y: 4 } } : c);
    const stopState: CombatState = { ...sampleMappedCombat(), combatants: sampleMappedCombat().combatants.map(atC5) };
    const stopped = applyMove(stopState, hero, { moverId: 'c-2', kind: 'move', by: 'dm', to: { kind: 'square', at: { x: 5, y: 3 } } });
    expect(moved.status).toBe('moved');
    expect(stopped.status).toBe('stopped');
    const texts = [
      ...dmTexts(state),
      ...dmTexts(sampleStopCombat()),
      describeWillingMove(1, moved.status === 'moved' ? moved.state : state, hero, moved as MovedOutcome, []),
      describeStop(1, stopped.status === 'stopped' ? stopped.state : state, hero, stopped as StoppedOutcome, { heroTakes: true }),
      describeStop(1, stopped.status === 'stopped' ? stopped.state : state, hero, stopped as StoppedOutcome, { heroTakes: false }),
    ];
    for (const text of texts) expect(text).not.toMatch(PRONOUNS);
  });
});

describe('the battle-map prompt text and tool definitions have no gendered pronouns either (amendment 1)', () => {
  const PRONOUNS = /\b(he|she|him|her|his|hers|himself|herself)\b/i;
  const MAP_TOOLS = new Set(['move_tokens', 'update_map', 'resolve_area', 'check_map', 'start_combat', 'update_combat', 'roll_dice']);

  it('in the battle-maps section and its mid-session notes, every mode', () => {
    for (const mode of BATTLE_MAPS_MODES) {
      expect(battleMapsSection(mode)).not.toMatch(PRONOUNS);
      expect(battleMapsNotice(mode, { withPrinciples: true })).not.toMatch(PRONOUNS);
    }
  });

  it('in the descriptions and schemas of the map tools and the combat tools they extend', () => {
    for (const tool of DM_TOOLS.filter((t) => MAP_TOOLS.has(t.name))) expect(JSON.stringify(tool), tool.name).not.toMatch(PRONOUNS);
  });
});

describe('the reach clause and the turn-start line', () => {
  it('lists the hero first among the creatures a mover reaches, whatever the initiative order', () => {
    const base = sampleMappedCombat();
    const [mira, bandit1, cutthroat, bandit2, oldTam, ogre] = base.combatants;
    // Old Tam acts before Mira Voss here; Bandit 1 at C5 is next to both.
    const state: CombatState = { ...base, turnIndex: 1, combatants: [{ ...oldTam, initiative: 20 }, { ...bandit1, position: { x: 2, y: 4 } }, mira, cutthroat, bandit2, ogre] };
    expect(relationClause(state, hero, 'c-2')).toBe("5 ft from Mira Voss and 5 ft from Old Tam — each is within the other's reach");
  });

  it("doesn't remind the DM to move the hero when the hero shares an initiative with the next creature", () => {
    const before = sampleMappedCombat();
    const shared: CombatState = {
      ...before,
      turnIndex: 0,
      round: 3,
      combatants: before.combatants.map((c) => (c.name === 'Bandit 1' ? { ...c, initiative: 17 } : c)),
    };
    const line = turnStartLine(before, shared, hero) ?? '';
    expect(line).toMatch(/^Map: Mira Voss's turn — the player moves Mira Voss on the map/);
    expect(line).not.toContain('same initiative');
  });

  it("asks for the hero to be placed when the hero's turn starts off the map", () => {
    const before = sampleMappedCombat();
    const unplaced: CombatState = { ...before, turnIndex: 0, round: 3, combatants: before.combatants.map((c) => (c.isPlayer ? { ...c, position: undefined } : c)) };
    expect(turnStartLine(before, unplaced, hero)).toBe(
      'Map: Mira Voss\'s turn — Mira Voss isn\'t on the map: place Mira Voss with move_tokens kind "place" so the player can move.',
    );
  });
});

describe('free text that names a hidden creature (amendment 8)', () => {
  it('matches whole names in any case, and skips a hidden name a visible creature shares', () => {
    const state = sampleMappedCombat();
    expect(namesHiddenCreature(state, 'Stealth for the cutthroat')).toBe(true);
    expect(namesHiddenCreature(state, 'Cutthroats everywhere')).toBe(false);
    expect(namesHiddenCreature(state, 'Bandit 1 attacks')).toBe(false);
    const renamed: CombatState = { ...state, combatants: state.combatants.map((c) => (c.name === 'Cutthroat' ? { ...c, name: 'Bandit' } : c)) };
    expect(namesHiddenCreature(renamed, 'Bandit attacks')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What the DM hears about the player's own moves beyond the route (review findings D1, D2, D11)
// ---------------------------------------------------------------------------

describe("the player's moves in <game_state>: hazards, lasting effects, emanations and hidden reactors", () => {
  const G10 = { x: 6, y: 9 };
  const G11 = { x: 6, y: 10 };
  const G12 = { x: 6, y: 11 };
  const newSince = (state: CombatState) => mapStateLines(state, hero, never).find((l) => l.startsWith('New since your last reply: ')) ?? '';
  const move = (m: Partial<TurnMove> & Pick<TurnMove, 'from' | 'to' | 'path' | 'costFt'>): TurnMove => ({ by: 'player', kind: 'move', provoked: [], entered: [], ...m });
  const lasting = (effect: Partial<MapEffect> & Pick<MapEffect, 'label' | 'spec'>): MapEffect => ({
    id: 'e20',
    rects: effect.spec.rects ?? [],
    terrain: [],
    duration: 'lasting',
    round: 2,
    turnOfId: 'c-1',
    ...effect,
  });
  const withEffects = (state: CombatState, ...effects: MapEffect[]): CombatState => ({ ...state, map: { ...(state.map as BattleMap), effects } });

  it('D1: reports a hazard the hero walked through, as a DM-made move would', () => {
    const state = withPlayerMove(sampleMappedCombat({ heroTurn: true }), move({ from: G10, to: G12, path: [G11, G12], costFt: 10, entered: ['brazier'] }));
    expect(newSince(state)).toBe('New since your last reply: the player moved Mira Voss G10 → G11 → G12 (10 ft); Mira Voss entered the brazier (hazard) at G11.');
  });

  it('D1: reports a lasting effect the hero walked into (Spike Growth)', () => {
    const spikes = lasting({ label: 'Spike Growth', spec: { shape: 'squares', rects: [{ x0: 2, y0: 5, x1: 3, y1: 6 }] }, terrain: ['difficult', 'hazard'] });
    const moved = withPlayerMove(sampleMappedCombat({ heroTurn: true }), move({ from: B6, to: { x: 3, y: 5 }, path: [{ x: 2, y: 4 }, { x: 3, y: 5 }], costFt: 15, entered: ['Spike Growth'] }));
    expect(newSince(withEffects(moved, spikes))).toBe('New since your last reply: the player moved Mira Voss B6 → C5 → D6 (15 ft); Mira Voss entered Spike Growth at D6.');
  });

  it("D1, D11: says whom the hero's own emanation now covers, and never that the hero entered it", () => {
    const guardians = lasting({ label: 'Spirit Guardians', spec: { shape: 'emanation', sizeFt: 15, fromId: 'c-1' }, terrain: ['difficult'] });
    // The engine (today) records the hero's own aura as entered; the DM must not be told to roll a save for its caster.
    const moved = withPlayerMove(sampleMappedCombat({ heroTurn: true }), move({ from: B6, to: { x: 2, y: 5 }, path: [{ x: 2, y: 5 }], costFt: 5, entered: ['Spirit Guardians'] }));
    const text = newSince(withEffects(moved, guardians));
    expect(text).toBe("New since your last reply: the player moved Mira Voss B6 → C6 (5 ft); Mira Voss's Spirit Guardians now covers Bandit 1 and Bandit 2.");
    expect(text).not.toContain('entered');
  });

  it('D2: a hidden reactor earlier on a stopped move is reported, to resolve first; one at the stop waits for the repeat', () => {
    const B2 = { x: 1, y: 1 };
    const B1 = { x: 1, y: 0 };
    const base = sampleMappedCombat({ heroTurn: true });
    const placed: CombatState = {
      ...base,
      combatants: base.combatants.map((c) => {
        if (c.id === 'c-5') return { ...c, position: { x: 0, y: 6 } }; // the hidden Cutthroat at A7
        if (c.id === 'c-2') return { ...c, position: { x: 2, y: 3 }, reachFt: 10 }; // Bandit 1 at C4, reach 10
        if (c.id === 'c-4') return { ...c, position: { x: 10, y: 0 } }; // Old Tam out of the way
        return c;
      }),
    };
    const stopAtB2 = (provoked: TurnMove['provoked']): CombatState => {
      const moved = withPlayerMove(placed, move({ from: B6, to: B2, path: [{ x: 1, y: 4 }, { x: 1, y: 3 }, { x: 1, y: 2 }, B2], costFt: 20, provoked }));
      const stop: MapStop = { moverId: 'c-1', by: 'player', round: 2, at: B2, destination: B1, route: [B1], reactorIds: ['c-2'], declinedIds: [], opts: { prefer: 'safest' } };
      return { ...moved, map: { ...(moved.map as BattleMap), stop } };
    };
    const text = newSince(stopAtB2([{ reactorId: 'c-5', at: B6, hidden: true }, { reactorId: 'c-2', at: B2, hidden: false }]));
    expect(text).toContain(
      "the player moved Mira Voss B6 → B5 → B4 → B3 → B2 (20 ft) toward B1 and the move stopped at B2 — leaving Bandit 1's reach there provokes its Opportunity Attack (its Reaction is unused). " +
        'On the way, leaving B6 gave the [hidden] Cutthroat an unseen Opportunity Attack — resolve it first if it takes it; if it stops the hero, put Mira Voss back on B6 with move_tokens kind "place" and skip the rest of this move. ' +
        'The player meant to go on to B1',
    );
    expect(text).toContain('Resolve the attack (roll_dice), then finish the move with move_tokens {"moves":[{"who":"hero","to":"B1"}]} unless it stops the hero.');
    // A hidden reactor whose reach the stopped step would leave gets its attack when move_tokens finishes the move.
    const atStop = newSince(stopAtB2([{ reactorId: 'c-2', at: B2, hidden: false }, { reactorId: 'c-5', at: B2, hidden: true }]));
    expect(atStop).not.toContain('Cutthroat');
    expect(atStop).not.toContain('On the way');
    // The player's own words stay free of the hidden creature (D41).
    expect(mapNote(stopAtB2([{ reactorId: 'c-5', at: B6, hidden: true }]), hero, never)).not.toContain('Cutthroat');
  });

  it('D2: a stopped move tells the DM what the hero entered on the way', () => {
    const stop = sampleStopCombat();
    const map = stop.map as BattleMap;
    const turn = map.turn as NonNullable<BattleMap['turn']>;
    const state: CombatState = { ...stop, map: { ...map, turn: { ...turn, moves: [{ ...turn.moves[0], entered: ['brazier'] }] } } };
    expect(newSince(state)).toContain('provokes its Opportunity Attack (its Reaction is unused). On the way, Mira Voss entered the brazier (hazard). The player meant to go on to A7');
  });

  it('names a hidden creature that stopped the move on its first step, also after standing up', () => {
    const blocked = { from: B6, to: B6, path: [], revealedHidden: true, blockedById: 'c-5' };
    const tried = withPlayerMove(sampleMappedCombat({ heroTurn: true }), move({ ...blocked, costFt: 0 }));
    expect(newSince(tried)).toBe(
      "New since your last reply: the player tried to move Mira Voss from B6; Mira Voss's move stopped at B6: the [hidden] Cutthroat (M8) blocks the way — the player saw the hero stop and nothing more.",
    );
    const stood = withPlayerMove(sampleMappedCombat({ heroTurn: true }), move({ ...blocked, costFt: 15, stoodUp: true }));
    expect(newSince(stood)).toBe(
      "New since your last reply: the player stood Mira Voss up (15 ft); Mira Voss's move stopped at B6: the [hidden] Cutthroat (M8) blocks the way — the player saw the hero stop and nothing more.",
    );
  });

  it('keeps Example 2 word for word when there is nothing more to say', () => {
    expect(newSince(sampleStopCombat())).toBe(
      'New since your last reply: the player moved Mira Voss toward A7 and the move stopped at B6 — leaving Dock Ogre\'s reach there provokes its Opportunity Attack (its Reaction is unused). The player meant to go on to A7 (5 ft more). Resolve the attack (roll_dice), then finish the move with move_tokens {"moves":[{"who":"hero","to":"A7"}]} unless it stops the hero.',
    );
  });
});

describe("D11: a creature never 'enters' its own lasting emanation", () => {
  const guardians = (fromId: string, id = 'e20'): MapEffect => ({
    id,
    label: 'Spirit Guardians',
    spec: { shape: 'emanation', sizeFt: 15, fromId },
    rects: [],
    terrain: [],
    duration: 'lasting',
    round: 2,
    turnOfId: fromId,
  });
  const withAuras = (...effects: MapEffect[]): CombatState => {
    const base = sampleMappedCombat();
    return { ...base, map: { ...(base.map as BattleMap), effects } };
  };
  const E4 = { x: 4, y: 3 };
  const G11 = { x: 6, y: 10 };

  it("drops the mover's own aura from a move's notes and keeps the hazards it entered", () => {
    const notes = moveNotes(withAuras(guardians('c-2')), hero, 'c-2', [
      { kind: 'entered', label: 'Spirit Guardians', at: E4 },
      { kind: 'entered', label: 'brazier', at: G11 },
      { kind: 'emanation-reached', label: 'Spirit Guardians', ids: ['c-1'] },
    ]);
    expect(notes).toBe(' It entered the brazier (hazard) at G11. Its Spirit Guardians now covers Mira Voss.');
  });

  it("still reports another creature's aura of the same name", () => {
    const notes = moveNotes(withAuras(guardians('c-2'), guardians('c-6', 'e21')), hero, 'c-2', [{ kind: 'entered', label: 'Spirit Guardians', at: E4 }]);
    expect(notes).toBe(' It entered Spirit Guardians at E4.');
  });

  it("the hero's DM-made move with a lasting Spirit Guardians (the reviewer's case)", () => {
    const base = sampleMappedCombat({ heroTurn: true });
    const state: CombatState = { ...base, map: { ...(base.map as BattleMap), effects: [guardians('c-1')] } };
    const o = applyMove(state, hero, { moverId: 'c-1', kind: 'move', by: 'dm', to: { kind: 'square', at: { x: 2, y: 5 } } });
    expect(o.status).toBe('moved');
    const text = describeWillingMove(1, o.status === 'moved' ? o.state : state, hero, o as MovedOutcome, []);
    expect(text).toContain("Mira Voss's Spirit Guardians now covers Bandit 1 and Bandit 2.");
    expect(text).not.toContain('entered Spirit Guardians');
  });
});
