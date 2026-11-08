import { describe, expect, it } from 'vitest';
import type { MoveRefusal, TurnBudget } from '@/engine';
import { sampleBattleMap, sampleMappedCombat } from '@/test/fixtures';
import type { BattleMap } from '@/types';
import {
  areaMessageLine,
  areaReadout,
  battleChipText,
  blockText,
  conditionLabel,
  difficultChip,
  enteredChip,
  firstFightTip,
  frightenedChip,
  insideWarning,
  joinNames,
  keepMovingWords,
  mapAccessibleName,
  measureText,
  moveReadout,
  movedText,
  namesFor,
  obstacleText,
  opportunityChip,
  rangeWarning,
  refusalText,
  referName,
  remindWords,
  shortRouteChip,
  stoodText,
  stopText,
  turnPillText,
  unseenStopText,
  waitingText,
  YOU_INSIDE_WARNING,
  type MapBlock,
} from './text';

const at = (x: number, y: number) => ({ x, y });
const nameOf = namesFor(sampleMappedCombat().combatants);
const budget = (over: Partial<TurnBudget> = {}): TurnBudget => ({
  combatantId: 'c-1',
  mode: 'walk',
  speedFt: 30,
  movedFt: 0,
  dashFt: 0,
  dashes: 0,
  leftFt: 30,
  dashAddsFt: 30,
  disengaged: false,
  stoodUp: false,
  prone: false,
  standCostFt: 15,
  speedZero: null,
  ...over,
});
const ctx = (over: { budget?: TurnBudget | null; map?: BattleMap } = {}) => ({
  name: nameOf,
  budget: over.budget === undefined ? budget() : over.budget,
  map: over.map ?? sampleBattleMap(),
});

/** No gendered pronoun for the hero anywhere in player text (amendment 1): player text says "you". */
const PRONOUNS = /\b(he|she|him|her|his|hers)\b/i;

describe('map text: gates (spec §7.8)', () => {
  const cases: [MapBlock, string][] = [
    ['no-map', 'There is no battle map right now.'],
    ['not-your-turn', "It isn't your turn."],
    ['waiting', 'Waiting for the DM.'],
    ['dm-busy', 'The DM is still working.'],
    ['interaction', 'Answer the DM first.'],
    ['no-session', 'Start the session first.'],
    ['unplaced', "You're not on the map yet."],
    ['refused', "You can't move there."],
  ];
  it.each(cases)('words the %s block', (block, text) => {
    expect(blockText(block, { stopReactors: [] })).toBe(text);
  });

  it('words a pending stop with the creatures that get to attack', () => {
    expect(blockText('stop-pending', { stopReactors: ['Bandit 1'] })).toBe(
      'Tell the DM what you do first — Bandit 1 gets an Opportunity Attack.',
    );
    expect(blockText('stop-pending', { stopReactors: ['Bandit 1', 'the Dock Ogre'] })).toBe(
      'Tell the DM what you do first — Bandit 1 and the Dock Ogre get Opportunity Attacks.',
    );
    expect(blockText('stop-pending', { stopReactors: [] })).toBe('Tell the DM what you do first.');
  });
});

describe('map text: refusals (spec §7.8)', () => {
  const words = (refusal: MoveRefusal, over: Parameters<typeof ctx>[0] = {}) => refusalText(refusal, ctx(over));

  it('says how far, and how far a Dash would take you', () => {
    const tooFar: MoveRefusal = { code: 'too-far', needFt: 45, leftFt: 30, route: [], dashWouldReach: true };
    expect(words(tooFar)).toBe('Too far: 45 ft (you have 30, or 60 with Dash).');
    // Already dashed this turn: no second offer.
    expect(words(tooFar, { budget: budget({ dashes: 1 }) })).toBe('Too far: 45 ft (you have 30).');
  });

  it('names who is in the way, from the player view', () => {
    expect(words({ code: 'occupied', at: at(1, 4), byId: 'c-4', open: [] })).toBe('Old Tam is in that square.');
    expect(words({ code: 'occupied', at: at(7, 9), byId: 'c-6', open: [] })).toBe('The Dock Ogre is in that square.');
  });

  it('names the terrain in the way; closed doors are the DM’s to open (app convention C28)', () => {
    expect(words({ code: 'blocked', at: at(8, 3), what: 'wall (pillar)' })).toBe('The pillar is in the way.');
    expect(words({ code: 'blocked', at: at(13, 4), what: 'door' })).toBe('The office door is closed: ask the DM.');
    expect(words({ code: 'blocked', at: at(0, 0), what: '' })).toBe('Something is in the way.');
  });

  it('words every other refusal', () => {
    expect(words({ code: 'speed-zero', because: 'Grappled' })).toBe('Grappled: Speed 0.');
    expect(words({ code: 'cant-stand', costFt: 15, leftFt: 10 })).toBe('Not enough movement left to stand up (15 ft).');
    expect(words({ code: 'frightened', sourceId: 'c-6' })).toBe("You're Frightened of the Dock Ogre: you can't move closer.");
    expect(words({ code: 'no-route' })).toBe("There's no way through from here.");
    expect(words({ code: 'off-map', to: at(20, 2) })).toBe("That's off the map.");
    expect(words({ code: 'unplaced' })).toBe("You're not on the map yet.");
    expect(words({ code: 'not-their-turn', currentId: 'c-2' })).toBe("It isn't your turn.");
    expect(words({ code: 'stop-pending', reactorIds: ['c-6'] })).toBe(
      'Tell the DM what you do first — the Dock Ogre gets an Opportunity Attack.',
    );
    expect(words({ code: 'out-of-range', distanceFt: 40, maxFt: 30 })).toBe('Too far: 40 ft (the most is 30).');
    expect(words({ code: 'bad-request', problem: 'Something odd.' })).toBe('Something odd.');
  });

  it('describes doors and walls on their own', () => {
    const map: BattleMap = {
      ...sampleBattleMap(),
      terrain: [
        { id: 't1', kind: 'door', rects: [{ x0: 2, y0: 2, x1: 2, y1: 2 }], door: 'locked' },
        { id: 't2', kind: 'wall', rects: [{ x0: 3, y0: 3, x1: 3, y1: 3 }] },
        { id: 't3', kind: 'pit', rects: [{ x0: 4, y0: 4, x1: 4, y1: 4 }], label: 'chasm' },
      ],
    };
    expect(obstacleText(map, at(2, 2))).toBe('The door is locked: ask the DM.');
    expect(obstacleText(map, at(3, 3))).toBe('A wall is in the way.');
    expect(obstacleText(map, at(4, 4))).toBe('The chasm is in the way.');
  });
});

describe('map text: plans, chips and moves (spec §7.4)', () => {
  it('reads a plan', () => {
    expect(moveReadout(at(3, 7), 10, 20)).toBe('To D8 · 10 ft · 20 ft left');
  });

  it('words every chip', () => {
    expect(opportunityChip(['Bandit 1'])).toBe("⚠ Leaves Bandit 1's reach: Opportunity Attack");
    expect(opportunityChip(['Bandit 1', 'the Dock Ogre'])).toBe('⚠ Leaves the reach of Bandit 1 and the Dock Ogre: Opportunity Attacks');
    expect(difficultChip(1)).toBe('Difficult +5 ft');
    expect(difficultChip(2)).toBe('Difficult +10 ft');
    expect(enteredChip('brazier', true)).toBe('Enters the brazier (hazard)');
    expect(enteredChip('Web', false)).toBe('Enters the Web');
    expect(frightenedChip('the Dock Ogre')).toBe("Frightened: can't move closer to the Dock Ogre");
    expect(shortRouteChip(1)).toBe('Short route: provokes 1');
    expect(shortRouteChip(0)).toBe('Short route');
  });

  it('reads a finished move, a stand-up and a stop', () => {
    expect(movedText(at(3, 7), 20)).toBe('Moved to D8 · 20 ft left');
    expect(movedText(at(3, 7), null)).toBe('Moved to D8');
    expect(stoodText(15)).toBe('Stood up · 15 ft left');
    expect(stopText(at(1, 5), ['the Dock Ogre'])).toBe("You stop at B6: leaving the Dock Ogre's reach gives it an Opportunity Attack.");
    expect(stopText(at(1, 5), ['Bandit 1', 'Bandit 2'])).toBe(
      'You stop at B6: leaving the reach of Bandit 1 and Bandit 2 gives them Opportunity Attacks.',
    );
    expect(unseenStopText(at(12, 6))).toBe('You stop at M7: something blocks the way.');
    expect(keepMovingWords(at(0, 6))).toBe('I keep moving to A7.');
  });
});

describe('map text: turn, waiting, chip and tip', () => {
  it('says whose turn the player sees', () => {
    expect(turnPillText({ yourTurn: true, currentName: null, budget: budget() })).toBe('Your turn · 30 ft');
    expect(turnPillText({ yourTurn: true, currentName: null, budget: budget({ speedZero: 'Grappled', leftFt: 0 }) })).toBe(
      'Your turn · Grappled: Speed 0',
    );
    expect(turnPillText({ yourTurn: true, currentName: null, budget: null })).toBe('Your turn');
    expect(turnPillText({ yourTurn: false, currentName: 'Bandit 2', budget: null })).toBe("Bandit 2's turn");
  });

  it('words the waiting banner and its reminder (D54)', () => {
    expect(waitingText('Bandit 2')).toBe("Waiting for the DM to finish Bandit 2's turn");
    expect(remindWords('Bandit 2')).toBe("It's still Bandit 2's turn on the tracker — please finish it.");
  });

  it('words the phone chip', () => {
    expect(battleChipText({ yourTurn: true, currentName: null, leftFt: 25 })).toBe('Battle map · your turn · 25 ft');
    expect(battleChipText({ yourTurn: false, currentName: 'Bandit 1', leftFt: null })).toBe("Battle map · Bandit 1's turn");
  });

  it('words the first-fight tip for touch exactly as the spec (D65)', () => {
    expect(firstFightTip(true)).toBe(
      'Tap a square to plan · tap again to move · your moves reach the DM with your next message · Undo until you send',
    );
    expect(firstFightTip(false)).toContain('your moves reach the DM with your next message · Undo until you send');
  });

  it('names the map for assistive tech', () => {
    expect(mapAccessibleName(sampleBattleMap())).toBe('Battle map: Dockside warehouse, 16 by 12 squares');
    expect(mapAccessibleName({ width: 10, height: 8 })).toBe('Battle map: 10 by 8 squares');
  });
});

describe('map text: measuring', () => {
  it('reads distance, sight and cover', () => {
    expect(
      measureText({ from: 'Mira Voss', to: 'Bandit 1', feet: 20, lineOfSight: true, cover: { degree: 'half', by: ['crates'] } }),
    ).toBe('Mira Voss → Bandit 1: 20 ft (4 squares) · clear line of sight · Bandit 1 has Half Cover (crates)');
    expect(measureText({ from: 'Mira Voss', to: 'E6', feet: 5, lineOfSight: false })).toBe('Mira Voss → E6: 5 ft (1 square) · no line of sight');
  });
});

describe('map text: the [Area: …] line (D50, spec §7.4 grammar)', () => {
  it('writes a cone from the hero', () => {
    expect(
      areaMessageLine({ label: 'Burning Hands', shape: 'cone', sizeFt: 15, fromName: 'Mira Voss', toward: 'C5', catches: ['Bandit 1'] }),
    ).toBe('[Area: Burning Hands — 15-ft cone from Mira Voss toward C5; on my map it catches Bandit 1]');
  });

  it('writes a sphere centred on a square, and on a corner', () => {
    expect(areaMessageLine({ label: 'Fireball', shape: 'sphere', sizeFt: 20, at: 'G4', catches: ['Bandit 1', 'Bandit 2'] })).toBe(
      '[Area: Fireball — 20-ft sphere centred on G4; on my map it catches Bandit 1, Bandit 2]',
    );
    expect(areaMessageLine({ label: 'Fireball', shape: 'sphere', sizeFt: 20, at: 'G4/H5', catches: [] })).toBe(
      '[Area: Fireball — 20-ft sphere centred on G4/H5; on my map it catches nobody]',
    );
  });

  it('writes a line with its width, and an emanation around the hero', () => {
    expect(
      areaMessageLine({ label: 'Lightning Bolt', shape: 'line', sizeFt: 100, widthFt: 5, fromName: 'Mira Voss', toward: 'north-east', catches: [] }),
    ).toBe('[Area: Lightning Bolt — 100-ft line, 5 ft wide from Mira Voss toward north-east; on my map it catches nobody]');
    expect(areaMessageLine({ label: 'Spirit Guardians', shape: 'emanation', sizeFt: 15, fromName: 'Mira Voss', catches: ['Bandit 1'] })).toBe(
      '[Area: Spirit Guardians — 15-ft emanation around Mira Voss; on my map it catches Bandit 1]',
    );
  });

  it('reads the template bar without the hero’s name', () => {
    expect(areaReadout({ label: 'Burning Hands', shape: 'cone', sizeFt: 15, fromName: 'Mira Voss', toward: 'C5', catches: ['Bandit 1'] })).toBe(
      'Burning Hands · 15-ft cone toward C5 · catches Bandit 1',
    );
    expect(areaReadout({ label: 'Fireball', shape: 'sphere', sizeFt: 20, at: 'G4', catches: [] })).toBe(
      'Fireball · 20-ft sphere centred on G4 · catches nobody you can see',
    );
  });

  it('words the template warnings', () => {
    expect(YOU_INSIDE_WARNING).toBe('⚠ You are inside');
    expect(insideWarning('Old Tam')).toBe('⚠ Old Tam is inside');
    expect(rangeWarning('Fireball', 150)).toBe("⚠ Beyond Fireball's range (150 ft)");
  });
});

describe('map text: names', () => {
  it('reads a stat-block name with "the", but never a numbered one or the hero', () => {
    expect(referName({ name: 'Dock Ogre', statBlockName: 'Ogre', isPlayer: false })).toBe('the Dock Ogre');
    expect(referName({ name: 'Bandit 1', statBlockName: 'Bandit', isPlayer: false })).toBe('Bandit 1');
    expect(referName({ name: 'Old Tam', isPlayer: false })).toBe('Old Tam');
    expect(nameOf('nobody')).toBe('someone');
  });

  it('joins names and labels conditions', () => {
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
    expect(conditionLabel('prone')).toBe('Prone');
    expect(conditionLabel('exhaustion', 2)).toBe('Exhaustion 2');
    expect(conditionLabel('dazzled')).toBe('Dazzled');
  });

  it('never uses a gendered pronoun for the hero', () => {
    const texts = [
      ...(['no-map', 'not-your-turn', 'waiting', 'dm-busy', 'interaction', 'no-session', 'unplaced', 'refused', 'stop-pending'] as MapBlock[]).map(
        (b) => blockText(b, { stopReactors: ['Bandit 1'] }),
      ),
      stopText(at(1, 5), ['Bandit 1']),
      unseenStopText(at(1, 5)),
      firstFightTip(true),
      firstFightTip(false),
      remindWords('Bandit 2'),
    ];
    for (const t of texts) expect(t).not.toMatch(PRONOUNS);
  });
});
