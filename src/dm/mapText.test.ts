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
import type { BattleMap, Combatant, CombatState, TurnMove } from '@/types';
import {
  describeMapSetup,
  describeShow,
  describeStop,
  describeWillingMove,
  finalPositions,
  layoutForPrompt,
  mapNote,
  mapStateLines,
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
