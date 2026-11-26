import { describe, expect, it } from 'vitest';
import compendiumRaw from '../../public/srd/compendium.json?raw';
import type { BattleMap, Character, Combatant, CombatState, CompendiumEntry, InventoryItem, MapEffect } from '@/types';
import { sampleCharacter, sampleCombat } from '@/test/fixtures';
import { createCombat, currentCombatant, nextTurn, removeCombatant } from './combat';
import {
  concentrationAreas,
  concentrationTurnStart,
  conditionsNaming,
  durationRounds,
  endNpcConcentration,
  handSetAcNaming,
  roundsLeftText,
  setNpcConcentration,
  type HeroConcentration,
} from './spellEffects';

const npc = (id: string, name: string, initiative: number, extra: Partial<Combatant> = {}): Combatant => ({
  id,
  name,
  side: 'enemy',
  isPlayer: false,
  initiative,
  initiativeBonus: 0,
  hp: { max: 33, current: 33, temp: 0 },
  conditions: [],
  defeated: false,
  ...extra,
});
const heroIn = (initiative: number, extra: Partial<Combatant> = {}): Combatant => ({
  id: 'hero',
  name: 'Mira Voss',
  side: 'player',
  isPlayer: true,
  initiative,
  initiativeBonus: 2,
  ac: 12,
  conditions: [],
  defeated: false,
  ...extra,
});
const find = (state: CombatState, id: string) => state.combatants.find((c) => c.id === id) as Combatant;
const NO_HERO: HeroConcentration = { spell: null };
/** next_turn and the countdowns at the turn it starts. */
const advance = (state: CombatState, hero: HeroConcentration = NO_HERO) => concentrationTurnStart(state, nextTurn(state), hero);

describe('durationRounds (srd:rule:casting-spells-duration; srd:rule:combat-the-order-of-combat)', () => {
  // srd:rule:casting-spells-duration: a time span "specifies how long the spell lasts in rounds, minutes, hours, or the
  // like … a Duration entry might say "1 minute," meaning the spell ends after 1 minute has passed".
  // srd:rule:combat-the-order-of-combat: "A round represents about 6 seconds in the game world." 1 minute = 10 rounds is
  // derived from it (the SRD states no conversion); an hour is 600 rounds and a day 14,400.
  const EXPECTED: Record<string, number | undefined> = {
    '1 day': 14_400,
    '1 hour': 600,
    '1 minute': 10,
    '1 round': 1,
    '10 days': 144_000,
    '10 minutes': 100,
    '24 hours': 14_400,
    '30 days': 432_000,
    '7 days': 100_800,
    '8 hours': 4_800,
    'Concentration up to 10 minutes': 100,
    'Concentration, up to 1 day': 14_400,
    'Concentration, up to 1 hour': 600,
    'Concentration, up to 1 minute': 10,
    'Concentration, up to 10 minutes': 100,
    'Concentration, up to 2 hours': 1_200,
    'Concentration, up to 6 rounds': 6,
    'Concentration, up to 8 hours': 4_800,
    Instantaneous: undefined,
    Special: undefined,
    'Until dispelled': undefined,
    'Until dispelled or triggered': undefined,
    'Up to 1 hour': 600,
    'Up to 1 minute': 10,
    'Up to 8 hours': 4_800,
  };

  it('reads every distinct Duration entry of the SRD 5.2.1 spells (all 25), the Concentration ones included', () => {
    const spells = (JSON.parse(compendiumRaw) as CompendiumEntry[]).filter((e) => e.kind === 'spell');
    const durations = [...new Set(spells.map((s) => (s.data as { duration?: string } | undefined)?.duration))];
    expect(durations.every((d) => typeof d === 'string')).toBe(true);
    expect([...durations].sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(durations).toHaveLength(25);
    for (const duration of durations as string[]) expect(durationRounds(duration), duration).toBe(EXPECTED[duration]);
    // Every spell that requires Concentration has a count: Bless (1 minute) is 10 rounds, Shield of Faith 100.
    const concentration = spells.filter((s) => (s.data as { concentration?: boolean } | undefined)?.concentration === true);
    expect(concentration.length).toBeGreaterThan(100);
    expect(concentration.filter((s) => durationRounds((s.data as { duration: string }).duration) === undefined)).toEqual([]);
  });

  it('takes the spacing and case as they come, and nothing else', () => {
    expect(durationRounds('  concentration,   UP TO 1   Minute ')).toBe(10);
    expect(durationRounds('2 rounds')).toBe(2);
    expect(durationRounds('Instantaneous or 1 hour (see below)')).toBeUndefined();
    expect(durationRounds('Concentration (up to 1 minute)')).toBeUndefined();
    expect(durationRounds('one minute')).toBeUndefined();
    expect(durationRounds('0 rounds')).toBeUndefined();
    expect(durationRounds('')).toBeUndefined();
    expect(durationRounds(undefined)).toBeUndefined();
  });
});

describe('roundsLeftText', () => {
  it('counts rounds up to a minute, then minutes, rounded up', () => {
    expect([1, 7, 10].map(roundsLeftText)).toEqual(['1 round left', '7 rounds left', '10 rounds left']);
    expect([11, 85, 90, 100, 600].map(roundsLeftText)).toEqual([
      'about 2 minutes left',
      'about 9 minutes left',
      'about 9 minutes left',
      'about 10 minutes left',
      'about 60 minutes left',
    ]);
  });
});

describe('setNpcConcentration and endNpcConcentration (srd:rule:concentration)', () => {
  const fight = () => createCombat([heroIn(17), npc('cf', 'Cultist Fanatic', 14), npc('b', 'Bandit', 9, { hidden: true })]);

  it('records the spell and its count on the NPC', () => {
    const r = setNpcConcentration(fight(), 'cf', 'Hold Person', 10);
    expect(r).toMatchObject({ recast: false });
    expect(r.refused).toBeUndefined();
    expect(r.previous).toBeUndefined();
    expect(find(r.state, 'cf').concentration).toEqual({ spell: 'Hold Person', roundsLeft: 10 });
    // Without a count the app records it and doesn't count it; a name finds the creature too.
    expect(find(setNpcConcentration(fight(), 'cultist fanatic', '  Shadow   Lash ').state, 'cf').concentration).toEqual({ spell: 'Shadow Lash' });
    // A spell's name is kept to 80 characters.
    expect(find(setNpcConcentration(fight(), 'cf', 'x'.repeat(100)).state, 'cf').concentration?.spell).toHaveLength(80);
  });

  it('another spell ends the one it held (srd:rule:concentration: "You lose Concentration on an effect the moment you start casting a spell that requires Concentration")', () => {
    const held = setNpcConcentration(fight(), 'cf', 'Hold Person', 7).state;
    const r = setNpcConcentration(held, 'cf', 'Command', 1);
    expect(r.recast).toBe(false);
    expect(r.previous).toEqual({ id: 'cf', name: 'Cultist Fanatic', spell: 'Hold Person', roundsLeft: 7, hidden: false });
    expect(find(r.state, 'cf').concentration).toEqual({ spell: 'Command', roundsLeft: 1 });
  });

  it('the same spell again is a recast: its count restarts (srd:rule:casting-spells-effects-combining-spell-effects: "the effect continues until the duration of the second Bless ends")', () => {
    const held = setNpcConcentration(fight(), 'cf', 'Bless', 10).state;
    const later = { ...held, combatants: held.combatants.map((c) => (c.id === 'cf' ? { ...c, concentration: { spell: 'Bless', roundsLeft: 3 } } : c)) };
    const r = setNpcConcentration(later, 'cf', 'bless', 10);
    expect(r.recast).toBe(true);
    expect(r.previous).toBeUndefined();
    expect(find(r.state, 'cf').concentration).toEqual({ spell: 'bless', roundsLeft: 10 });
    // Without a count, the recast leaves it uncounted.
    expect(find(setNpcConcentration(later, 'cf', 'Bless').state, 'cf').concentration).toEqual({ spell: 'Bless' });
    // The very same call again changes nothing (a DM repeating a call after an "Interrupted" note).
    const again = setNpcConcentration(held, 'cf', 'Bless', 10);
    expect(again).toEqual({ state: held, recast: true });
    expect(again.state).toBe(held);
  });

  it('refuses the hero, a defeated creature and an Incapacitated one (srd:rule:concentration: "Your Concentration ends if you have the Incapacitated condition or you die"; srd:condition:incapacitated: "Your Concentration is broken")', () => {
    const state = fight();
    expect(setNpcConcentration(state, 'hero', 'Bless', 10)).toEqual({ state, refused: 'Mira Voss is the hero: their Concentration is on the sheet.', recast: false });
    const down = { ...state, combatants: state.combatants.map((c) => (c.id === 'cf' ? { ...c, defeated: true } : c)) };
    expect(setNpcConcentration(down, 'cf', 'Bless', 10).refused).toBe('Cultist Fanatic is defeated and can\'t start concentrating.');
    for (const id of ['incapacitated', 'paralyzed', 'petrified', 'stunned', 'unconscious']) {
      const held = { ...state, combatants: state.combatants.map((c) => (c.id === 'cf' ? { ...c, conditions: [{ id }] } : c)) };
      const r = setNpcConcentration(held, 'cf', 'Bless', 10);
      expect(r.refused, id).toMatch(/^Cultist Fanatic can't concentrate while (Incapacitated|Paralyzed|Petrified|Stunned|Unconscious)\.$/);
      expect(r.state).toBe(held);
    }
    // A Prone or Frightened creature can.
    const prone = { ...state, combatants: state.combatants.map((c) => (c.id === 'cf' ? { ...c, conditions: [{ id: 'prone' }, { id: 'frightened' }] } : c)) };
    expect(setNpcConcentration(prone, 'cf', 'Bless', 10).refused).toBeUndefined();
    expect(setNpcConcentration(state, 'nobody', 'Bless').refused).toBe('No combatant "nobody".');
    expect(setNpcConcentration(state, 'cf', '   ').refused).toBe('Name the spell Cultist Fanatic concentrates on.');
  });

  it('ends a Concentration, a defeated creature\'s too (srd:rule:damage-and-healing-dropping-to-0-hit-points-instant-death: "A monster dies the instant it drops to 0 Hit Points"), and changes nothing when there is none', () => {
    const held = setNpcConcentration(fight(), 'b', 'Fog Cloud', 30).state;
    const r = endNpcConcentration(held, 'Bandit');
    expect(r.ended).toEqual({ id: 'b', name: 'Bandit', spell: 'Fog Cloud', roundsLeft: 30, hidden: true });
    expect(find(r.state, 'b')).not.toHaveProperty('concentration');
    const down = { ...held, combatants: held.combatants.map((c) => (c.id === 'b' ? { ...c, defeated: true, concentration: { spell: 'Fog Cloud' } } : c)) };
    expect(endNpcConcentration(down, 'b').ended).toEqual({ id: 'b', name: 'Bandit', spell: 'Fog Cloud', hidden: true });
    const none = fight();
    expect(endNpcConcentration(none, 'cf')).toEqual({ state: none });
    expect(endNpcConcentration(none, 'nobody')).toEqual({ state: none });
  });
});

describe('concentrationTurnStart: a spell ends at its caster\'s turn start (srd:rule:casting-spells-duration; srd:rule:combat-the-order-of-combat)', () => {
  /** Mira 17, Cultist Fanatic 14, Bandit 9: round 1, Mira's turn. */
  const fight = (extra: Combatant[] = []) => createCombat([heroIn(17), npc('cf', 'Cultist Fanatic', 14), npc('b', 'Bandit', 9), ...extra]);

  it('Bless (Concentration, up to 1 minute: 10 rounds) cast on its caster\'s turn in round 1 ends as that turn starts in round 11, and not before', () => {
    let state = nextTurn(fight()); // round 1, the Cultist Fanatic's turn: it casts Bless
    expect(currentCombatant(state)?.id).toBe('cf');
    state = setNpcConcentration(state, 'cf', 'Bless', durationRounds('Concentration, up to 1 minute')).state;
    const counts: string[] = [];
    let ended = null;
    while (!ended && state.round < 20) {
      const t = advance(state);
      state = t.state;
      // Only the creature whose turn starts counts down.
      if (currentCombatant(state)?.id !== 'cf') expect(t.ended).toEqual([]);
      else counts.push(`${state.round}:${find(state, 'cf').concentration?.roundsLeft ?? 'ended'}`);
      if (t.ended.length) ended = { round: state.round, ends: t.ended };
    }
    expect(counts).toEqual(['2:9', '3:8', '4:7', '5:6', '6:5', '7:4', '8:3', '9:2', '10:1', '11:ended']);
    expect(ended).toEqual({ round: 11, ends: [{ id: 'cf', name: 'Cultist Fanatic', spell: 'Bless', hidden: false }] });
    expect(find(state, 'cf')).not.toHaveProperty('concentration');
  });

  it('the first creature of round 1 isn\'t counted down: createCombat starts no turn, so a spell it casts then first counts at its round-2 turn start', () => {
    let state = createCombat([npc('cf', 'Cultist Fanatic', 14), npc('b', 'Bandit', 9)]);
    expect(state.round).toBe(1);
    expect(currentCombatant(state)?.id).toBe('cf');
    state = setNpcConcentration(state, 'cf', 'Hold Person', 2).state;
    state = advance(state).state; // the Bandit's turn: nothing counts
    expect(find(state, 'cf').concentration?.roundsLeft).toBe(2);
    const round2 = advance(state);
    expect(round2.state.round).toBe(2);
    expect(find(round2.state, 'cf').concentration?.roundsLeft).toBe(1);
    expect(advance(advance(round2.state).state).ended.map((e) => e.spell)).toEqual(['Hold Person']);
  });

  it('a lone creature\'s next_turn starts its own turn again, in a new round', () => {
    let state = createCombat([npc('cf', 'Cultist Fanatic', 14), npc('b', 'Bandit', 9, { defeated: true })]);
    state = setNpcConcentration(state, 'cf', 'Bless', 2).state;
    const first = advance(state);
    expect(first.state).toMatchObject({ round: 2, turnIndex: 0 });
    expect(find(first.state, 'cf').concentration).toEqual({ spell: 'Bless', roundsLeft: 1 });
    const second = advance(first.state);
    expect(second.state.round).toBe(3);
    expect(second.ended.map((e) => e.id)).toEqual(['cf']);
  });

  it('removing the creature whose turn it is starts the next one\'s turn', () => {
    let state = nextTurn(nextTurn(fight())); // round 1, the Bandit's turn
    state = setNpcConcentration(state, 'cf', 'Bless', 1).state;
    expect(currentCombatant(state)?.id).toBe('b');
    // The Bandit leaves; the order wraps to Mira, whose turn starts in round 2 (her countdown, none here)…
    const toHero = concentrationTurnStart(state, removeCombatant(state, 'b'), NO_HERO);
    expect(toHero.state.round).toBe(2);
    expect(toHero.ended).toEqual([]);
    // …and removing Mira while it is her turn starts the Cultist Fanatic's, which ends its Bless.
    const r = concentrationTurnStart(toHero.state, removeCombatant(toHero.state, 'hero'), NO_HERO);
    expect(currentCombatant(r.state)?.id).toBe('cf');
    expect(r.ended.map((e) => e.spell)).toEqual(['Bless']);
  });

  it('defeated creatures are skipped: their turns never start, so nothing of theirs counts down', () => {
    let state = fight();
    state = setNpcConcentration(state, 'cf', 'Bless', 3).state;
    state = { ...state, combatants: state.combatants.map((c) => (c.id === 'cf' ? { ...c, defeated: true } : c)) };
    for (let i = 0; i < 9; i++) state = advance(state).state;
    expect(state.round).toBe(5);
    expect(find(state, 'cf').concentration).toEqual({ spell: 'Bless', roundsLeft: 3 });
    // Removing the creature whose turn it is when everyone left is defeated starts no one's turn.
    const lastStanding = createCombat([npc('b', 'Bandit', 20), npc('cf', 'Cultist Fanatic', 14, { defeated: true, concentration: { spell: 'Bless', roundsLeft: 1 } })]);
    const removed = removeCombatant(lastStanding, 'b');
    expect(concentrationTurnStart(lastStanding, removed, NO_HERO)).toEqual({ state: removed, ended: [] });
  });

  it('no turn started (the same round and creature): nothing changes; an NPC whose Concentration isn\'t counted keeps it', () => {
    const state = setNpcConcentration(nextTurn(fight()), 'cf', 'Shadow Lash').state;
    expect(concentrationTurnStart(state, state, NO_HERO)).toEqual({ state, ended: [] });
    const later = advance(advance(advance(state).state).state).state; // round 2, the Cultist Fanatic's turn again
    expect(currentCombatant(later)?.id).toBe('cf');
    expect(find(later, 'cf').concentration).toEqual({ spell: 'Shadow Lash' });
  });

  it('a recast restarts the count', () => {
    let state = setNpcConcentration(nextTurn(fight()), 'cf', 'Bless', 10).state;
    for (let i = 0; i < 3 * 3; i++) state = advance(state).state; // three rounds on
    expect(find(state, 'cf').concentration?.roundsLeft).toBe(7);
    state = setNpcConcentration(state, 'cf', 'Bless', 10).state;
    expect(find(state, 'cf').concentration?.roundsLeft).toBe(10);
  });

  it("nothing is counted down at a turn start in round 1: Hold Person given 10 rounds at the fight's start lasts 10 of its caster's turns, ending as that turn starts in round 11, whatever the order (E4; srd:spell:hold-person: \"Concentration, up to 1 minute\"; srd:rule:combat-the-order-of-combat: \"A round represents about 6 seconds\")", () => {
    /** The Cultist Fanatic's turns with the spell, and the round whose turn start ended it. */
    const until = (start: CombatState) => {
      let state = start;
      let turns = currentCombatant(state)?.id === 'cf' ? 1 : 0; // round 1's first turn is never started (createCombat)
      for (let i = 0; i < 60; i++) {
        const t = advance(state);
        state = t.state;
        if (t.ended.length) return { round: state.round, turns, ended: t.ended.map((e) => e.spell) };
        if (currentCombatant(state)?.id === 'cf') turns++;
      }
      return { round: Infinity, turns, ended: [] };
    };
    const fanaticFirst = createCombat([npc('cf', 'Cultist Fanatic', 14), heroIn(10), npc('b', 'Bandit', 9)]);
    const fanaticSecond = createCombat([heroIn(17), npc('cf', 'Cultist Fanatic', 14), npc('b', 'Bandit', 9)]);
    for (const [order, start] of Object.entries({ fanaticFirst, fanaticSecond })) {
      expect(until(setNpcConcentration(start, 'cf', 'Hold Person', 10).state), order).toEqual({ round: 11, turns: 10, ended: ['Hold Person'] });
    }
    // Acting second, its round-1 turn start leaves the count as given.
    const firstTurn = advance(setNpcConcentration(fanaticSecond, 'cf', 'Hold Person', 10).state);
    expect(currentCombatant(firstTurn.state)?.id).toBe('cf');
    expect(find(firstTurn.state, 'cf').concentration).toEqual({ spell: 'Hold Person', roundsLeft: 10 });
    // Cast on its own round-1 turn, once that turn has started: it still ends as its turn starts in round 11.
    expect(until(setNpcConcentration(nextTurn(fanaticSecond), 'cf', 'Hold Person', 10).state)).toEqual({ round: 11, turns: 10, ended: ['Hold Person'] });
    // Later rounds count as before: given 2 in round 2 before its turn, that turn start counts one, and the next ends it.
    const later = setNpcConcentration(advance(advance(advance(fanaticSecond).state).state).state, 'cf', 'Hold Person', 2).state;
    expect(later.round).toBe(2);
    expect(until(later)).toEqual({ round: 3, turns: 1, ended: ['Hold Person'] });
  });

  describe("the hero's countdown (Combatant.concentrationCountdown; the sheet's Spellcasting.concentratingOn)", () => {
    const bless: HeroConcentration = { spell: 'Bless', rounds: 10 };
    /** Runs turn starts until the hero's Bless ends; her countdown at each of her turn starts. */
    const run = (start: CombatState) => {
      let state = start;
      const counts: string[] = [];
      for (let i = 0; i < 60; i++) {
        const t = advance(state, bless);
        state = t.state;
        if (currentCombatant(state)?.id === 'hero') counts.push(`${state.round}:${find(state, 'hero').concentrationCountdown?.roundsLeft ?? 'ended'}`);
        if (t.heroEnded) return { counts, state, heroEnded: t.heroEnded };
      }
      return { counts, state, heroEnded: undefined };
    };

    it('Bless cast on her turn in round 1 is counted from her round-2 turn start, at rounds − 1 (lazily), and ends as her turn starts in round 11', () => {
      const r = run(fight());
      expect(r.counts).toEqual(['2:9', '3:8', '4:7', '5:6', '6:5', '7:4', '8:3', '9:2', '10:1', '11:ended']);
      expect(r.heroEnded).toBe('Bless');
      expect(r.state.round).toBe(11);
      expect(find(r.state, 'hero')).not.toHaveProperty('concentrationCountdown');
    });

    it('a countdown set at the cast (10) ends on the very same turn', () => {
      const start = fight();
      const eager = { ...start, combatants: start.combatants.map((c) => (c.id === 'hero' ? { ...c, concentrationCountdown: { spell: 'Bless', roundsLeft: 10 } } : c)) };
      const r = run(eager);
      expect(r.state.round).toBe(11);
      expect(r.counts.at(-1)).toBe('11:ended');
    });

    it('a stale countdown (another spell) is dropped, or replaced when the spell\'s duration is known; no Concentration drops it', () => {
      const start = nextTurn(nextTurn(fight())); // the Bandit's turn; Mira's is next
      const stale = { ...start, combatants: start.combatants.map((c) => (c.id === 'hero' ? { ...c, concentrationCountdown: { spell: 'Fly', roundsLeft: 40 } } : c)) };
      expect(find(advance(stale, { spell: 'Bless' }).state, 'hero')).not.toHaveProperty('concentrationCountdown');
      expect(find(advance(stale, bless).state, 'hero').concentrationCountdown).toEqual({ spell: 'Bless', roundsLeft: 9 });
      expect(find(advance(stale, NO_HERO).state, 'hero')).not.toHaveProperty('concentrationCountdown');
      // The sheet's name decides, case aside: "bless" counts the Bless countdown down.
      const counted = { ...start, combatants: start.combatants.map((c) => (c.id === 'hero' ? { ...c, concentrationCountdown: { spell: 'Bless', roundsLeft: 4 } } : c)) };
      expect(find(advance(counted, { spell: 'bless' }).state, 'hero').concentrationCountdown).toEqual({ spell: 'Bless', roundsLeft: 3 });
      // Without a duration, the app doesn't count it; a spell lasting 1 round ends at once.
      expect(find(advance(start, { spell: 'Shadow Lash' }).state, 'hero')).not.toHaveProperty('concentrationCountdown');
      expect(advance(start, { spell: 'Readied Fire', rounds: 1 }).heroEnded).toBe('Readied Fire');
    });

    it("only the hero's own turn start counts it", () => {
      const start = fight();
      const held = { ...start, combatants: start.combatants.map((c) => (c.id === 'hero' ? { ...c, concentrationCountdown: { spell: 'Bless', roundsLeft: 5 } } : c)) };
      const t = advance(held, bless); // the Cultist Fanatic's turn
      expect(t.heroEnded).toBeUndefined();
      expect(find(t.state, 'hero').concentrationCountdown).toEqual({ spell: 'Bless', roundsLeft: 5 });
    });

    it("Bless already running when the fight starts lasts the hero's first 10 turns whatever the initiative order, ending as the hero's turn starts in round 11 (H6/C2/P2; srd:spell:bless: \"Concentration, up to 1 minute\"; srd:rule:combat-the-order-of-combat: \"A round represents about 6 seconds\")", () => {
      // start_combat: "the app counts its 1 minute from <hero>'s first turn". The hero's turns with Bless, counted.
      const until = (start: CombatState) => {
        let state = start;
        let heroTurns = currentCombatant(state)?.id === 'hero' ? 1 : 0; // round 1's first turn is never started (createCombat)
        for (let i = 0; i < 60; i++) {
          const t = advance(state, bless);
          state = t.state;
          if (t.heroEnded) return { round: state.round, heroTurns };
          if (currentCombatant(state)?.id === 'hero') heroTurns++;
        }
        return { round: Infinity, heroTurns };
      };
      const heroFirst = createCombat([heroIn(17), npc('cf', 'Cultist Fanatic', 14), npc('b', 'Bandit', 9)]);
      const heroSecond = createCombat([npc('cf', 'Cultist Fanatic', 14), heroIn(10), npc('b', 'Bandit', 9)]);
      const heroLast = createCombat([npc('cf', 'Cultist Fanatic', 14), npc('b', 'Bandit', 9), heroIn(2)]);
      for (const [order, start] of Object.entries({ heroFirst, heroSecond, heroLast })) {
        expect(until(start), order).toEqual({ round: 11, heroTurns: 10 });
      }
      // The hero second: the round-1 turn start starts the count at the full 10 (later rounds start it at rounds − 1).
      const firstTurn = advance(heroSecond, bless);
      expect(firstTurn.state.round).toBe(1);
      expect(find(firstTurn.state, 'hero').concentrationCountdown).toEqual({ spell: 'Bless', roundsLeft: 10 });
      // A lone hero: round 1's turn isn't started, round 2's is (at rounds − 1), and it still ends in round 11.
      expect(until(createCombat([heroIn(17)]))).toEqual({ round: 11, heroTurns: 10 });
      // A spell lasting 1 round, running at a round-1 turn start, lasts that turn.
      const short = advance(heroSecond, { spell: 'Readied Fire', rounds: 1 });
      expect(short.heroEnded).toBeUndefined();
      expect(find(short.state, 'hero').concentrationCountdown).toEqual({ spell: 'Readied Fire', roundsLeft: 1 });
    });

    it("rounds given before the hero's first turn aren't counted down in round 1: they last that many of the hero's turns whatever the order, and 10 given is none given (E4; srd:rule:casting-spells-duration: a time span \"specifies how long the spell lasts in rounds\"; srd:rule:combat-the-order-of-combat: \"A round represents about 6 seconds\")", () => {
      /** The hero's turns with Bless, and the round whose turn start ended it. */
      const until = (start: CombatState) => {
        let state = start;
        let heroTurns = currentCombatant(state)?.id === 'hero' ? 1 : 0; // round 1's first turn is never started (createCombat)
        for (let i = 0; i < 60; i++) {
          const t = advance(state, bless);
          state = t.state;
          if (t.heroEnded) return { round: state.round, heroTurns };
          if (currentCombatant(state)?.id === 'hero') heroTurns++;
        }
        return { round: Infinity, heroTurns };
      };
      /** update_combat concentrate on the hero with `rounds`: the countdown it stores. */
      const given = (start: CombatState, roundsLeft: number): CombatState => ({
        ...start,
        combatants: start.combatants.map((c) => (c.id === 'hero' ? { ...c, concentrationCountdown: { spell: 'Bless', roundsLeft } } : c)),
      });
      const heroFirst = createCombat([heroIn(17), npc('cf', 'Cultist Fanatic', 14), npc('b', 'Bandit', 9)]);
      const heroSecond = createCombat([npc('cf', 'Cultist Fanatic', 14), heroIn(10), npc('b', 'Bandit', 9)]);
      for (const [order, start] of Object.entries({ heroFirst, heroSecond })) {
        // Bless running at start_combat with 6 rounds of its minute left (srd:spell:bless: "Concentration, up to 1 minute").
        expect(until(given(start, 6)), order).toEqual({ round: 7, heroTurns: 6 });
        // Its full 10 given lasts as long as none given: it ends as the hero's turn starts in round 11.
        expect(until(given(start, 10)), order).toEqual({ round: 11, heroTurns: 10 });
        expect(until(start), order).toEqual({ round: 11, heroTurns: 10 });
      }
      // The hero second: the round-1 turn start leaves the count as given.
      expect(find(advance(given(heroSecond, 6), bless).state, 'hero').concentrationCountdown).toEqual({ spell: 'Bless', roundsLeft: 6 });
      // Given on the hero's own round-1 turn, once it has started: 10 of the hero's turns, ending in round 11.
      const onTurn = advance(heroSecond, NO_HERO).state;
      expect(currentCombatant(onTurn)?.id).toBe('hero');
      expect(until(given(onTurn, 10))).toEqual({ round: 11, heroTurns: 10 });
    });
  });
});

describe('concentrationAreas: the lasting areas the DM is told to end with a spell (srd:rule:concentration: "If the effect\'s creator loses Concentration, the effect ends")', () => {
  const effect = (id: string, label: string, patch: Partial<MapEffect> = {}, fromId?: string): MapEffect => ({
    id,
    label,
    spec: { shape: 'cube', sizeFt: 20, ...(fromId ? { fromId } : {}) },
    rects: [{ x0: 0, y0: 0, x1: 3, y1: 3 }],
    terrain: ['difficult'],
    duration: 'lasting',
    round: 1,
    turnOfId: 'cf',
    ...patch,
  });
  const map = (effects: MapEffect[]): BattleMap => ({ id: 'm', width: 16, height: 12, terrain: [], places: [], effects, nextId: 20, rev: 0 });

  it('names areas whose label names the spell as whole words (a plural counts) and that come from no other creature', () => {
    const m = map([
      effect('e1', 'Web', {}, 'cf'),
      effect('e2', 'Webs over the door'),
      effect('e3', 'Cobweb Trap'),
      effect('e4', 'Web', {}, 'b'),
      effect('e5', 'Web', { duration: 'turn', terrain: [] }, 'cf'),
      effect('e6', 'Butterfly Swarm'),
      effect('e7', "Cultist's web"),
    ]);
    expect(concentrationAreas(m, 'cf', 'Web').map((e) => e.id)).toEqual(['e1', 'e2', 'e7']);
    // "Fly" isn't in "Butterfly"; "Bless" isn't "Blessed".
    expect(concentrationAreas(m, 'cf', 'Fly')).toEqual([]);
    expect(concentrationAreas(map([effect('e1', 'Blessed Ground')]), 'cf', 'Bless')).toEqual([]);
    expect(concentrationAreas(map([effect('e1', 'Spirit Guardians', {}, 'hero')]), 'hero', 'Spirit Guardians').map((e) => e.id)).toEqual(['e1']);
    expect(concentrationAreas(undefined, 'cf', 'Web')).toEqual([]);
  });

  it('reads a Concentration recorded under a noted name as its spell: "Spirit Guardians" for a sheet copy\'s "Spirit Guardians (scroll)" (H1; srd:spell:spirit-guardians: "Concentration, up to 10 minutes", "Protective spirits flit around you in a 15-foot Emanation for the duration")', () => {
    const guardians = map([effect('e1', 'Spirit Guardians', {}, 'hero'), effect('e2', 'Spirit Guardians (scroll)', {}, 'hero'), effect('e3', 'Guardians of the Gate')]);
    expect(concentrationAreas(guardians, 'hero', 'Spirit Guardians (scroll)').map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(concentrationAreas(guardians, 'hero', 'Spirit Guardians').map((e) => e.id)).toEqual(['e1', 'e2']);
    // Whole words still, and another creature's area still isn't the hero's.
    const m = map([effect('e1', 'Web', {}, 'cf'), effect('e4', 'Web', {}, 'b'), effect('e6', 'Butterfly Swarm')]);
    expect(concentrationAreas(m, 'cf', 'Web (scroll)').map((e) => e.id)).toEqual(['e1']);
    expect(concentrationAreas(m, 'cf', 'Fly (scroll)')).toEqual([]);
    expect(concentrationAreas(m, 'cf', '(scroll)')).toEqual([]);
  });
});

describe('conditionsNaming: conditions the DM is told to end with a spell', () => {
  const hero = (patch: Partial<Character> = {}) => sampleCharacter(patch);
  const state = (): CombatState => {
    const s = sampleCombat();
    s.combatants[1] = { ...s.combatants[1], conditions: [{ id: 'paralyzed', source: 'Hold Person (Cultist Fanatic)' }, { id: 'prone' }] };
    s.combatants[2] = { ...s.combatants[2], conditions: [{ id: 'frightened', duration: 'until Hold Person ends' }, { id: 'charmed', source: 'Holding Persons' }] };
    // The hero's combatant keeps no conditions of its own (they are the sheet's): a stale one isn't read.
    s.combatants[0] = { ...s.combatants[0], conditions: [{ id: 'paralyzed', source: 'Hold Person' }] };
    return s;
  };

  it("names each condition whose source or duration names the spell as whole words, the hero's sheet first", () => {
    const mira = hero({ conditions: [{ id: 'paralyzed', source: 'hold person' }, { id: 'poisoned', source: 'Giant spider venom' }] });
    expect(conditionsNaming('Hold Person', mira, state())).toEqual([
      { who: 'Mira Voss', isHero: true, condition: { id: 'paralyzed', source: 'hold person' } },
      { who: 'Bandit 1', isHero: false, condition: { id: 'paralyzed', source: 'Hold Person (Cultist Fanatic)' }, combatantId: 'c-2' },
      { who: 'Bandit 2', isHero: false, condition: { id: 'frightened', duration: 'until Hold Person ends' }, combatantId: 'c-3' },
    ]);
    expect(conditionsNaming('Web', mira, state())).toEqual([]);
    expect(conditionsNaming('Hold Person', null, null)).toEqual([]);
  });

  it('skips the conditions the triggering call itself just added', () => {
    // An ally's Hold Person paralyzed Bandit 1, which broke Bandit 1's own Hold Person: that Paralyzed isn't named back.
    const named = conditionsNaming('Hold Person', null, state(), [{ combatantId: 'c-2', condition: 'Paralyzed' }]);
    expect(named.map((n) => n.who)).toEqual(['Bandit 2']);
    // On the hero's sheet: no combatant id.
    const mira = hero({ conditions: [{ id: 'paralyzed', source: 'Hold Person' }] });
    expect(conditionsNaming('Hold Person', mira, null, [{ condition: 'paralyzed' }])).toEqual([]);
    expect(conditionsNaming('Hold Person', mira, null, [{ combatantId: 'c-2', condition: 'paralyzed' }])).toHaveLength(1);
  });

  it('reads a Concentration recorded under a noted name as its spell: a Paralyzed sourced "Hold Person" for a sheet copy\'s "Hold Person (scroll)" (H1; srd:spell:hold-person: "The target must succeed on a Wisdom saving throw or have the Paralyzed condition for the duration")', () => {
    const mira = hero({ conditions: [{ id: 'paralyzed', source: 'hold person' }, { id: 'poisoned', source: 'Giant spider venom' }] });
    const asHoldPerson = conditionsNaming('Hold Person', mira, state());
    expect(asHoldPerson.map((n) => n.who)).toEqual(['Mira Voss', 'Bandit 1', 'Bandit 2']);
    for (const noted of ['Hold Person (scroll)', 'Hold Person (3rd level)']) expect(conditionsNaming(noted, mira, state()), noted).toEqual(asHoldPerson);
    // The skip list works the same, and a note alone, or another spell's name with one, names nothing.
    expect(conditionsNaming('Hold Person (scroll)', null, state(), [{ combatantId: 'c-2', condition: 'Paralyzed' }]).map((n) => n.who)).toEqual(['Bandit 2']);
    expect(conditionsNaming('(scroll)', mira, state())).toEqual([]);
    expect(conditionsNaming('Web (scroll)', mira, state())).toEqual([]);
  });
});

describe('handSetAcNaming: an AC set by hand for a spell (srd:spell:haste: "+2 bonus to Armor Class")', () => {
  const mail: InventoryItem = { id: 'cm', name: 'Chain Mail', quantity: 1, category: 'armor', equipped: true };
  const fighter = (patch: Partial<Character>) => sampleCharacter({ armorTraining: ['Heavy armor'], inventory: [mail], ...patch });

  it('gives the stored AC and what armor and abilities give when the hand-set formula names the spell', () => {
    const hasted = fighter({ armorClass: 18, acFormula: 'set by the DM: Haste' });
    expect(handSetAcNaming(hasted, 'Haste')).toEqual({ stored: 18, computed: 16 });
    expect(handSetAcNaming(fighter({ armorClass: 18, acFormula: 'set by the DM: Shield of Faith from the priest' }), 'Shield of Faith')).toEqual({ stored: 18, computed: 16 });
    expect(handSetAcNaming(hasted, 'Slow')).toBeUndefined();
    expect(handSetAcNaming(fighter({ armorClass: 18, acFormula: 'set by the DM: Hasted' }), 'Haste')).toBeUndefined();
    // A formula the gear worked out, or one that names the spell without being set by hand, says nothing.
    expect(handSetAcNaming(fighter({ armorClass: 16, acFormula: 'Chain Mail 16' }), 'Haste')).toBeUndefined();
    expect(handSetAcNaming(fighter({ armorClass: 18, acFormula: 'Haste' }), 'Haste')).toBeUndefined();
    // Nothing to set back: armor the app can't identify keeps the stored AC.
    const unknown = fighter({ armorClass: 18, acFormula: 'set by the DM: Haste', inventory: [{ ...mail, name: 'Elven Chain' }] });
    expect(handSetAcNaming(unknown, 'Haste')).toBeUndefined();
  });

  it("never reads the app's own parts as the DM's words: an ally's Shield of Faith the app counts isn't \"set by hand\" for it (E2; srd:rule:concentration: \"If the effect's creator loses Concentration, the effect ends\")", () => {
    // Chain Mail 16, an ally's Shield of Faith recorded (+2), then the DM sets the AC by hand for something else.
    const shrine = fighter({ acSpells: ['Shield of Faith'], armorClass: 19, acFormula: 'set by the DM: shrine blessing +1 + Shield of Faith 2' });
    expect(handSetAcNaming(shrine, 'Shield of Faith')).toBeUndefined();
    // srd:spell:slow: "it takes a -2 penalty to AC": Slow is the DM's word, Shield of Faith the app's part.
    const slowed = fighter({ acSpells: ['Shield of Faith'], armorClass: 16, acFormula: 'set by the DM: Slow from the Stone Golem + Shield of Faith 2' });
    expect(handSetAcNaming(slowed, 'Shield of Faith')).toBeUndefined();
    expect(handSetAcNaming(slowed, 'Slow')).toEqual({ stored: 16, computed: 18 });
    // An old save's words beside the app's part still name the spell.
    const old = fighter({ acSpells: ['Shield of Faith'], armorClass: 20, acFormula: 'set by the DM: Shield of Faith and Haste + Shield of Faith 2' });
    expect(handSetAcNaming(old, 'Shield of Faith')).toEqual({ stored: 20, computed: 18 });
  });
});
