import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/engine', () => import('../testing/fakeEngine'));
vi.mock('@/data', () => import('../testing/fakeData'));
vi.mock('@/state/gameStore', () => import('../testing/fakeGameStoreModule'));

import { sampleCombat, sampleMappedCombat, sampleStopCombat } from '@/test/fixtures';
import type { BattleMap, Combatant, CombatState, InteractionRequest, LogEntry, MapEffect, TerrainFeature, ToolLogEntry } from '@/types';
import { mapCells, planMove } from '@/engine';
import { DmCancelledError } from '../errors';
import { deps, resetDmDeps } from '../deps';
import { fakeDice } from '../testing/fakeEngine';
import { autoRespond } from '../testing/fakeStore';
import { setupHarness, type Harness, type HarnessOptions } from '../testing/harness';
import type { ToolContext } from './context';
import { runTool } from './handlers';
import { refitHeroAfterSheetChange } from './map';

beforeEach(() => fakeDice.reset());
afterEach(() => resetDmDeps());

type Run = (name: string, input: unknown) => ReturnType<typeof runTool>;

function setup(combat: CombatState | null, opts: HarnessOptions = {}): Harness & { run: Run; ctx: ToolContext } {
  const h = setupHarness({ withSession: true, ...opts, campaignSettings: { playerRollMode: 'auto', ...opts.campaignSettings }, state: { combat, ...opts.state } });
  const ctx: ToolContext = { deps: deps(), signal: new AbortController().signal, status: vi.fn() };
  return { ...h, ctx, run: (name, input) => runTool(name, input, ctx) };
}

const toolLines = (log: LogEntry[]) => log.filter((e): e is ToolLogEntry => e.kind === 'tool');
const lastLine = (h: Harness) => toolLines(h.s().log).at(-1);
const byName = (state: CombatState | null | undefined, name: string) => state?.combatants.find((c) => c.name === name) as Combatant;
const sq = (label: string) => ({ x: label.charCodeAt(0) - 65, y: Number(label.slice(1)) - 1 });

/** The fixture with creatures moved, patched, and whose turn it is. */
function fixture(opts: { turn?: string; at?: Record<string, string>; patch?: Record<string, Partial<Combatant>>; map?: Partial<BattleMap>; heroTurn?: boolean } = {}): CombatState {
  const base = sampleMappedCombat({ heroTurn: opts.heroTurn });
  const combatants = base.combatants.map((c) => ({
    ...c,
    ...(opts.at?.[c.name] ? { position: sq(opts.at[c.name]) } : {}),
    ...(opts.patch?.[c.name] ?? {}),
  }));
  const turnIndex = opts.turn ? combatants.findIndex((c) => c.name === opts.turn) : base.turnIndex;
  return { ...base, combatants, turnIndex, map: { ...(base.map as BattleMap), ...opts.map } };
}

/** Answer the Opportunity Attack dialog, recording what it asked. */
function answerConfirm(h: Harness, confirmed: boolean): InteractionRequest[] {
  const asked: InteractionRequest[] = [];
  autoRespond(h.store, (req) => {
    if (req.kind !== 'confirm') return null;
    asked.push(req);
    return { kind: 'confirm', confirmed };
  });
  return asked;
}

describe('move_tokens: moves and refusals (spec §4.7)', () => {
  it('moves a creature to a creature by the safest, cheapest route and says who is in reach now', async () => {
    const h = setup(fixture());
    const out = await h.run('move_tokens', { moves: [{ who: 'Bandit 1', to: 'hero' }] });
    expect(out.content).toBe(
      '1. Bandit 1 moved F4 → C5: 15 ft (F4 E4 D4 C5); 15 of 30 ft left this turn. Now 5 ft from Mira Voss and 5 ft from Old Tam — each is within the other\'s reach. Mira Voss has no cover from it.',
    );
    expect(byName(h.s().combat, 'Bandit 1').position).toEqual(sq('C5'));
    expect(h.s().combat?.map?.turn).toMatchObject({ combatantId: 'c-2', round: 2, movedFt: 15 });
    expect(lastLine(h)).toMatchObject({ tool: 'move_tokens', icon: 'move', summary: 'Bandit 1 moves to C5' });
  });

  it('refuses a move for anyone but the current creature (the turn guard, D21)', async () => {
    const h = setup(fixture());
    const out = await h.run('move_tokens', { moves: [{ who: 'Bandit 2', to: 'A7' }] });
    expect(out.isError).toBeUndefined();
    expect(out.content).toBe(
      '1. Not moved — Bandit 2: it\'s Bandit 1\'s turn. Move each creature on its own turn: finish Bandit 1\'s turn, call update_combat next_turn, then move Bandit 2. A readied move or a legendary action is kind "off-turn"; a shove is "forced".',
    );
    expect(h.s().combat).toEqual(fixture());
    expect(h.s().log).toHaveLength(0);
  });

  it('refuses a move it can\'t finish this turn with the closest square and whether Dash would reach', async () => {
    const h = setup(fixture({ turn: 'Bandit 2' }));
    const out = await h.run('move_tokens', { moves: [{ who: 'Bandit 2', to: 'A7' }] });
    expect(out.content).toContain('1. Not moved — Bandit 2 to A7: A7 is 30 ft away after standing up (F3 E4 D5 D6 C7 B7 A7) and it has 15 ft left.');
    expect(out.content).toMatch(/The closest it can get is [A-P]\d+ \(15 ft\); with dash: true it reaches A7\.$/);
    const dashed = await h.run('move_tokens', { moves: [{ who: 'Bandit 2', to: 'A7', dash: true }] });
    expect(dashed.content).toContain('1. Bandit 2 moved F3 → A7: 30 ft (F3 E4 D5 D6 C7 B7 A7); 15 of 60 ft left this turn.');
    expect(dashed.content).toContain('It stood up first (15 ft).');
    expect(byName(h.s().combat, 'Bandit 2').conditions).toEqual([]);
    expect(lastLine(h)?.summary).toBe('Bandit 2 stands and moves to A7');
  });

  it('moves as far as it can with partial: true', async () => {
    const h = setup(fixture({ turn: 'Bandit 2' }));
    const out = await h.run('move_tokens', { moves: [{ who: 'Bandit 2', to: 'A7', partial: true }] });
    expect(out.content).toMatch(/^1\. Bandit 2 moved F3 → [A-P]\d+: 15 ft/);
  });

  it("refuses to end in someone's space and offers the open squares nearby", async () => {
    const h = setup(fixture({ turn: 'Bandit 2' }));
    const out = await h.run('move_tokens', { moves: [{ who: 'Bandit 2', to: 'B6' }] });
    expect(out.content).toMatch(/^1\. Not moved — Bandit 2 to B6: B6 is Mira Voss's space, and a move can't end there\. Open squares it can reach nearby: [A-P]\d+(, [A-P]\d+)*\. Or give "to": "Mira Voss" to end next to Mira Voss\.$/);
  });

  it('names Speed 0, walls and fear', async () => {
    const grappled = setup(fixture({ patch: { 'Bandit 1': { conditions: [{ id: 'grappled', source: 'Old Tam' }] } } }));
    expect((await grappled.run('move_tokens', { moves: [{ who: 'Bandit 1', to: 'E4' }] })).content).toBe(
      '1. Not moved — Bandit 1: it is Grappled (Speed 0). Forced movement and teleportation still work.',
    );
    const wall = setup(fixture());
    expect((await wall.run('move_tokens', { moves: [{ who: 'Bandit 1', to: 'I4' }] })).content).toBe('1. Not moved — Bandit 1 to I4: I4 is a wall (pillar).');
    const afraid = setup(fixture({ patch: { 'Bandit 1': { conditions: [{ id: 'frightened', source: 'Mira Voss' }] } } }));
    const out = await afraid.run('move_tokens', { moves: [{ who: 'Bandit 1', to: 'C5' }] });
    // F4 → B6 is 20 ft; C5 → B6 is 5 ft (SRD 5.2.1 Frightened: it can't willingly move closer to the source).
    expect(out.content).toMatch(/^1\. Not moved — Bandit 1 to C5: it is Frightened of Mira Voss and can't willingly move closer \(C5 is 15 ft closer\)\. It could go to [A-P]\d+ instead\.$/);
  });

  it("refuses a Large creature's square whose space leaves the map, and a square off the map before moving anything", async () => {
    const h = setup(fixture({ turn: 'Dock Ogre' }));
    const out = await h.run('move_tokens', { moves: [{ who: 'Dock Ogre', to: 'P12' }] });
    expect(out.content).toBe(
      '1. Not moved — Dock Ogre to P12: P12 is off the map (columns A–P, rows 1–12) for a Large creature (`to` is the top-left square of its space). To have it leave the fight, use update_combat remove.',
    );
    const bad = await h.run('move_tokens', { moves: [{ who: 'Dock Ogre', to: 'Q13' }] });
    expect(bad).toMatchObject({ isError: true });
    expect(bad.content).toContain('"Q13" is off the map: columns run A–P and rows 1–12.');
  });

  it('checks the whole batch before anything moves (all-or-nothing input)', async () => {
    const h = setup(fixture());
    const checks: [unknown, RegExp][] = [
      [{ moves: [{ who: 'Bandit 1', to: 'C5' }, { who: 'Nobody', to: 'A1' }] }, /no creature called "Nobody".*Creatures: .*\[hidden\] Cutthroat/],
      [{ moves: [{ who: 'Bandit 1', to: 'C5' }, { who: 'Bandit 1', to: 'D5' }] }, /appears twice in one batch/],
      [{ moves: [{ who: 'Bandit 1', to: 'C5', declined: ['hero'] }] }, /can't name the hero — the app asks the player/],
      [{ moves: [{ who: 'Bandit 1', kind: 'forced' }] }, /exactly one of `to` \(a square\) or `push`/],
      [{ moves: [{ who: 'Bandit 1', kind: 'forced', push: { distance_ft: 10, direction: 'east', away_from: 'hero' } }] }, /exactly one of away_from, toward or direction/],
      [{ moves: [{ who: 'Bandit 1' }] }, /needs `to`/],
      [{ moves: [{ who: 'Bandit 1', to: 'C5', max_ft: 30 }] }, /max_ft goes only with kind "teleport"/],
      [{ moves: [{ who: 'Bandit 1', to: 'C5', budget_ft: 30 }] }, /budget_ft goes only with kind "off-turn"/],
      [{ moves: [{ who: 'Bandit 1', to: 'C5', spend_ft: 5 }] }, /spend_ft goes only with kind "place"/],
      [{ moves: [{ who: 'Bandit 1', to: 'the cellar' }] }, /isn't a square, a creature or a place.*Places: the loading door, the office/],
      [{}, /needs `moves`, `reactions_used`, or both/],
    ];
    for (const [input, problem] of checks) {
      const out = await h.run('move_tokens', input);
      expect(out.isError, JSON.stringify(input)).toBe(true);
      expect(out.content).toMatch(problem);
    }
    expect(h.s().combat).toEqual(fixture());
  });

  it('pushes in a straight line, stops at walls, and drops into pits (C17)', async () => {
    const away = setup(fixture({ at: { 'Bandit 1': 'C5' } }));
    const pushed = await away.run('move_tokens', { moves: [{ who: 'Bandit 1', kind: 'forced', push: { distance_ft: 10, away_from: 'hero' } }] });
    expect(pushed.content).toMatch(/^1\. Bandit 1 was pushed 10 ft north-east, C5 → E3, straight away from Mira Voss \(no movement used, no Opportunity Attacks\)\. Now 15 ft from Mira Voss, out of reach\./);
    expect(lastLine(away)?.summary).toBe('Bandit 1 is pushed to E3');

    const pillar = setup(fixture({ at: { 'Bandit 2': 'G4' } }));
    const short = await pillar.run('move_tokens', { moves: [{ who: 'Bandit 2', kind: 'forced', push: { distance_ft: 10, direction: 'east' } }] });
    expect(short.content).toMatch(/^1\. Bandit 2 was pushed east, G4 → H4 \(5 of 10 ft\): the pillar at I4 stopped it 5 ft short\./);

    const pit: TerrainFeature = { id: 't20', kind: 'pit', rects: [{ x0: 6, y0: 8, x1: 6, y1: 8 }], label: 'grain chute' }; // G9
    const fall = setup(fixture({ at: { 'Bandit 2': 'G7' }, map: { terrain: [...(sampleMappedCombat().map as BattleMap).terrain, pit], nextId: 21 } }));
    const fell = await fall.run('move_tokens', { moves: [{ who: 'Bandit 2', kind: 'forced', push: { distance_ft: 15, direction: 'south' } }] });
    expect(fell.content).toContain('It fell 10 ft into the grain chute: roll 1d6 bludgeoning (falling); it lands Prone if it takes any damage.');
    expect(byName(fall.s().combat, 'Bandit 2').position).toEqual(sq('G9'));
  });

  it('teleports to the nearest open square when the one asked for is taken (C18)', async () => {
    const h = setup(fixture({ heroTurn: true }));
    const out = await h.run('move_tokens', { moves: [{ who: 'hero', kind: 'teleport', to: 'F3', max_ft: 30 }] });
    expect(out.content).toMatch(/^1\. Mira Voss teleported B6 → E3 \(15 ft; Mira Voss can see it\)\. F3 was Bandit 2's space, so Mira Voss appeared at E3, the nearest open square\./);
    expect(lastLine(h)?.summary).toBe('You teleport to E3');
    const far = await h.run('move_tokens', { moves: [{ who: 'hero', kind: 'teleport', to: 'P1', max_ft: 10 }] });
    expect(far.content).toMatch(/^1\. Not moved — Mira Voss to P1: that is \d+ ft away, beyond Mira Voss's 10-ft range\.$/);
  });

  it('places a creature without the rules, and records reactions spent on something else', async () => {
    const h = setup(fixture());
    const out = await h.run('move_tokens', { moves: [{ who: 'Bandit 2', kind: 'place', to: 'G3' }], reactions_used: ['Old Tam'] });
    expect(out.content.split('\n')).toEqual([
      "Reactions used: Old Tam (until each one's next turn starts).",
      expect.stringMatching(/^1\. Placed Bandit 2 at G3\./),
    ]);
    expect(byName(h.s().combat, 'Old Tam').reactionUsed).toBe(true);
    expect(lastLine(h)?.summary).toBe('Bandit 2 is now at G3');
  });

  it('writes no log line for a hidden mover', async () => {
    const h = setup(fixture({ turn: 'Cutthroat' }));
    const out = await h.run('move_tokens', { moves: [{ who: 'Cutthroat', to: 'L8' }] });
    expect(out.content).toMatch(/^1\. \[hidden\] Cutthroat moved M8 → L8: 5 ft/);
    expect(h.s().log).toHaveLength(0);
  });

  it("stands the hero up on the sheet before the move is written (D49 ordering)", async () => {
    const h = setup(fixture({ heroTurn: true }));
    await h.s().updateCharacter((c) => ({ ...c, conditions: [{ id: 'prone' }] }));
    const order: string[] = [];
    h.store.subscribe((s, prev) => {
      if (s.character !== prev.character) order.push('character');
      if (s.combat !== prev.combat) order.push('combat');
    });
    const out = await h.run('move_tokens', { moves: [{ who: 'hero', to: 'B7' }] });
    expect(out.content).toContain('Mira Voss stood up first (15 ft).');
    expect(order).toEqual(['character', 'combat']);
    expect(h.s().character?.conditions).toEqual([]);
    expect(h.s().combat?.map?.turn).toMatchObject({ movedFt: 20, stoodUp: true });
  });
});

describe("move_tokens: Opportunity Attacks (D31–D33)", () => {
  const bandit1AtC5 = () => fixture({ at: { 'Bandit 1': 'C5' } });

  it("asks the player about the hero's Opportunity Attack; Attack stops the move, spends the Reaction and says what to do", async () => {
    const h = setup(bandit1AtC5());
    const asked = answerConfirm(h, true);
    const out = await h.run('move_tokens', { moves: [{ who: 'Bandit 1', to: 'F4' }, { who: 'Old Tam', kind: 'place', to: 'A1' }] });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      kind: 'confirm',
      title: 'Opportunity Attack',
      body: 'Bandit 1 is leaving your reach (from C5). Use your Reaction to make one melee attack against it?',
      confirmLabel: 'Attack',
      cancelLabel: 'Let it go',
    });
    expect(out.content.split('\n')).toEqual([
      '1. Bandit 1 stopped at C5 (0 ft moved; 30 ft left): leaving here provokes Opportunity Attacks. Mira Voss: the player takes it — resolve it now with request_player_roll (an attack against Bandit 1, AC 12), then damage. Old Tam: yours to decide — if Old Tam takes it, roll the attack with roll_dice. Then repeat this move to finish it (15 ft more to F4), adding "declined": ["Old Tam"] if Old Tam lets Bandit 1 go.',
      "2. Not run: the batch stopped at Bandit 1's Opportunity Attack.",
    ]);
    const s = h.s().combat as CombatState;
    expect(byName(s, 'Mira Voss').reactionUsed).toBe(true);
    expect(byName(s, 'Old Tam').position).toEqual(sq('B5'));
    expect(s.map?.stop).toMatchObject({ moverId: 'c-2', by: 'dm', at: sq('C5'), destination: sq('F4'), reactorIds: ['c-1', 'c-4'], declinedIds: [] });
    expect(lastLine(h)?.summary).toBe('Bandit 1 breaks away from Old Tam and you');

    // The repeat continues past the recorded reactors; Old Tam let it go, so only the hero's Reaction is spent.
    const again = await h.run('move_tokens', { moves: [{ who: 'Bandit 1', to: 'F4', declined: ['Old Tam'] }] });
    expect(asked).toHaveLength(1);
    expect(again.content).toMatch(/^1\. Bandit 1 moved C5 → F4: 15 ft \(C5 [A-P]\d+ [A-P]\d+ F4\); 15 of 30 ft left this turn\. Mira Voss's Reaction is now used\. Old Tam let it go\./);
    expect(h.s().combat?.map?.stop).toBeUndefined();
    expect(byName(h.s().combat, 'Old Tam').reactionUsed).toBeUndefined();
  });

  it('"Let it go" (or closing the dialog) continues the move in the same call when nobody else reacts', async () => {
    const h = setup(fixture({ at: { 'Bandit 1': 'C5' }, patch: { 'Old Tam': { reactionUsed: true } } }));
    answerConfirm(h, false);
    const out = await h.run('move_tokens', { moves: [{ who: 'Bandit 1', to: 'F4' }] });
    expect(out.content).toMatch(
      /^1\. Bandit 1 moved C5 → F4: 15 ft \(C5 [A-P]\d+ [A-P]\d+ F4\); 15 of 30 ft left this turn\. Leaving C5 provoked Mira Voss's Opportunity Attack: the player let it go\. Now 20 ft from Mira Voss, out of reach\./,
    );
    expect(byName(h.s().combat, 'Bandit 1').position).toEqual(sq('F4'));
    expect(byName(h.s().combat, 'Mira Voss').reactionUsed).toBeUndefined();
  });

  it('"Let it go" with an NPC reactor at the same step stops there, and the repeat neither asks again nor spends the hero\'s Reaction', async () => {
    const h = setup(bandit1AtC5());
    const asked = answerConfirm(h, false);
    const out = await h.run('move_tokens', { moves: [{ who: 'Bandit 1', to: 'F4' }] });
    expect(out.content).toBe(
      '1. Bandit 1 stopped at C5 on the way to F4 (0 ft so far): leaving here takes Bandit 1 out of Old Tam\'s reach, which provokes its Opportunity Attack (its Reaction is unused). Mira Voss\'s Opportunity Attack: the player let it go. Roll it now if it attacks, then repeat this move (15 ft more), adding "declined": ["Old Tam"] if Old Tam lets Bandit 1 go.',
    );
    expect(h.s().combat?.map?.stop).toMatchObject({ reactorIds: ['c-4', 'c-1'], declinedIds: ['c-1'] });
    expect(lastLine(h)?.summary).toBe('Bandit 1 breaks away from Old Tam');
    await h.run('move_tokens', { moves: [{ who: 'Bandit 1', to: 'F4' }] });
    expect(asked).toHaveLength(1);
    expect(byName(h.s().combat, 'Old Tam').reactionUsed).toBe(true);
    expect(byName(h.s().combat, 'Mira Voss').reactionUsed).toBeUndefined();
  });

  it('stops an NPC passing through an ally on the last square it can end on, naming the space it leaves (D31)', async () => {
    const h = setup(fixture({ turn: 'Old Tam', at: { 'Bandit 1': 'C5' } }));
    const out = await h.run('move_tokens', { moves: [{ who: 'Old Tam', to: 'A7', via: 'B6' }] });
    expect(out.content).toBe(
      '1. Old Tam stopped at B5 on the way to A7 (0 ft so far): leaving Mira Voss\'s space at B6 takes Old Tam out of Bandit 1\'s reach, which provokes its Opportunity Attack (its Reaction is unused). Roll it now if it attacks, then repeat this move (10 ft more), adding "declined": ["Bandit 1"] if Bandit 1 lets Old Tam go.',
    );
  });

  it('stopping the DM while the dialog is open cancels the tool', async () => {
    const h = setupHarness({ withSession: true, campaignSettings: { playerRollMode: 'auto' }, state: { combat: bandit1AtC5() } });
    const controller = new AbortController();
    const ctx: ToolContext = { deps: deps(), signal: controller.signal, status: vi.fn() };
    h.store.subscribe((s) => {
      const pending = s.interaction;
      if (!pending) return;
      queueMicrotask(() => {
        controller.abort();
        h.s().cancelInteraction(pending.id, 'cancelled');
      });
    });
    await expect(runTool('move_tokens', { moves: [{ who: 'Bandit 1', to: 'F4' }] }, ctx)).rejects.toBeInstanceOf(DmCancelledError);
    expect(byName(h.s().combat, 'Bandit 1').position).toEqual(sq('C5'));
  });
});

describe('update_map (spec §4.8)', () => {
  const ROOM = { name: 'Cellar', width: 10, height: 8, terrain: [{ kind: 'wall', squares: 'A1:J1', label: 'north wall' }], places: [{ name: 'the stairs', squares: 'J7:J8' }] };

  it('puts a running fight on a map: positions where asked, everyone else placed, and logs it for the player', async () => {
    const h = setup(sampleCombat());
    const out = await h.run('update_map', { create: ROOM, positions: [{ who: 'hero', at: 'B7' }, { who: 'Bandit 1', at: 'the stairs' }] });
    expect(out.isError).toBeUndefined();
    const s = h.s().combat as CombatState;
    expect(s.map).toMatchObject({ name: 'Cellar', width: 10, height: 8 });
    expect(byName(s, 'Mira Voss').position).toEqual(sq('B7'));
    expect(['J7', 'J8'].map(sq)).toContainEqual(byName(s, 'Bandit 1').position);
    expect(s.combatants.every((c) => c.position)).toBe(true);
    expect(out.content).toContain('Battle map: Cellar, 10×8 squares of 5 ft');
    expect(out.content).toMatch(/Placed automatically: .*Bandit 2 at [A-J]\d+/);
    expect(out.content).toContain('On the map: Bandit 1 Medium, walk 30, reach 5 (defaults)');
    expect(lastLine(h)).toMatchObject({ icon: 'map', summary: 'Battle map: Cellar (10×8)' });
    expect(lastLine(h)?.detail).toContain('- Places: the stairs J7:J8');
  });

  it('replaces the map with a new room, carrying the turn over', async () => {
    const base = fixture();
    const turn = { combatantId: 'c-2', round: 2, movedFt: 10, dashFt: 0, dashes: 0, disengaged: false, stoodUp: false, moves: [] };
    const h = setup({ ...base, map: { ...(base.map as BattleMap), turn } });
    const refused = await h.run('update_map', { create: ROOM });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content).toContain('there is already a battle map; give replace: true');
    const out = await h.run('update_map', { create: ROOM, replace: true });
    expect(out.content).toContain('The previous map was removed; movement spent this turn carries over.');
    const s = h.s().combat as CombatState;
    expect(s.map?.name).toBe('Cellar');
    expect(s.map?.id).not.toBe('map-1');
    expect(s.map?.turn).toMatchObject({ combatantId: 'c-2', movedFt: 10 });
    expect(s.combatants.filter((c) => !c.defeated).every((c) => c.position && c.position.x < 10 && c.position.y < 8)).toBe(true);
  });

  it('takes the map away', async () => {
    const h = setup(fixture());
    const out = await h.run('update_map', { remove: true });
    expect(out.content).toBe('Battle map removed: the fight continues in the theater of the mind (positions are gone; hidden creatures stay hidden).');
    expect(h.s().combat?.map).toBeUndefined();
    expect(h.s().combat?.combatants.some((c) => c.position)).toBe(false);
    expect(byName(h.s().combat, 'Cutthroat').hidden).toBe(true);
    expect(lastLine(h)?.summary).toBe('The battle map is put away');
  });

  it('edits doors, terrain, places and lasting effects, and logs what the player can see', async () => {
    const web: MapEffect = { id: 'e20', label: 'Web', spec: { shape: 'squares', rects: [{ x0: 6, y0: 6, x1: 9, y1: 9 }] }, rects: [{ x0: 6, y0: 6, x1: 9, y1: 9 }], terrain: ['difficult', 'obscured'], duration: 'lasting', round: 2, turnOfId: 'c-1' };
    const h = setup(fixture({ map: { effects: [web], nextId: 21 } }));
    const out = await h.run('update_map', {
      terrain_add: [{ kind: 'difficult', squares: 'B2:C3', label: 'rubble' }],
      terrain_clear: ['crates'],
      doors: [{ at: 'office door', state: 'open' }],
      places_add: [{ name: 'the stairs', squares: 'C1:C3' }],
      effects_end: ['web'],
    });
    expect(out.content).toBe(
      'Map updated: added difficult B2:C3 (rubble) · cleared the crates (E5:F6) · the office door (N5) is now open · added the place "the stairs" (C1:C3) · Web has ended.',
    );
    const map = h.s().combat?.map as BattleMap;
    expect(map.terrain.find((f) => f.label === 'office door')?.door).toBe('open');
    expect(map.terrain.some((f) => f.label === 'crates')).toBe(false);
    expect(map.effects).toEqual([]);
    expect(lastLine(h)?.summary).toBe('The map changes: rubble at B2:C3 · The map changes: crates cleared · The office door opens · New place on the map: the stairs · Web ends');
  });

  it('is all-or-nothing: a door that can\'t close leaves the state exactly as it was', async () => {
    const h = setup(fixture({ at: { Cutthroat: 'N5' }, map: { terrain: (sampleMappedCombat().map as BattleMap).terrain.map((f) => (f.kind === 'door' ? { ...f, door: 'open' as const } : f)) } }));
    const before = JSON.stringify(h.s().combat);
    const out = await h.run('update_map', { terrain_add: [{ kind: 'difficult', squares: 'B2' }], doors: [{ at: 'N5', state: 'closed' }] });
    expect(out).toMatchObject({ isError: true });
    expect(out.content).toBe('update_map: Cutthroat stands in the door at N5. Nothing was changed.');
    expect(JSON.stringify(h.s().combat)).toBe(before);
    expect(h.s().log).toHaveLength(0);
  });

  it('changes a creature\'s size and re-fits it, and speeds and reach', async () => {
    const h = setup(fixture());
    const out = await h.run('update_map', { creatures: [{ who: 'Bandit 1', size: 'Large' }, { who: 'Bandit 2', speed_change_ft: -10 }, { who: 'hero', speeds: { fly: 60, hover: true } }] });
    expect(out.content).toMatch(/Bandit 1 is now Large/);
    expect(out.content).toContain('Bandit 2: speed change −10 ft (walk 20)');
    expect(out.content).toContain('Mira Voss: fly 60 (hover) for now; walk 30, fly 60 (hover) in all');
    expect(byName(h.s().combat, 'Bandit 1').size).toBe('Large');
    expect(lastLine(h)?.summary).toBe('Bandit 1 is now Large · Bandit 2\'s speed changes · Your speed changes');
  });

  it('writes no log line for changes only to hidden creatures', async () => {
    const h = setup(fixture());
    await h.run('update_map', { creatures: [{ who: 'Cutthroat', reach_ft: 10 }] });
    expect(byName(h.s().combat, 'Cutthroat').reachFt).toBe(10);
    expect(h.s().log).toHaveLength(0);
  });

  it('refuses to create a map when battle maps are Off, but still edits or removes one already there (D57)', async () => {
    const none = setup(sampleCombat(), { campaignSettings: { battleMaps: 'off' } });
    const refused = await none.run('update_map', { create: ROOM });
    expect(refused).toMatchObject({ isError: true, content: "Battle maps are Off in this campaign's table rules: keep this fight in the theater of the mind." });
    const mapped = setup(fixture(), { campaignSettings: { battleMaps: 'off' } });
    expect((await mapped.run('update_map', { doors: [{ at: 'N5', state: 'open' }] })).isError).toBeUndefined();
    expect((await mapped.run('update_map', { remove: true })).isError).toBeUndefined();
  });

  it('needs a fight with a map for edits, and checks its fields', async () => {
    const h = setup(sampleCombat());
    expect((await h.run('update_map', { doors: [{ at: 'N5', state: 'open' }] })).content).toBe(
      'This fight has no battle map: describe positions in words, or add one with update_map create.',
    );
    expect((await h.run('update_map', {})).content).toMatch(/needs something to do/);
    expect((await h.run('update_map', { replace: true })).content).toMatch(/replace and positions go only with create/);
    const mapped = setup(fixture());
    expect((await mapped.run('update_map', { remove: true, doors: [{ at: 'N5', state: 'open' }] })).content).toMatch(/remove goes alone/);
    const none = setup(null);
    expect((await none.run('update_map', { remove: true })).content).toBe('No combat is active. Use start_combat first.');
  });
});

describe('resolve_area (spec §4.9)', () => {
  it('resolves a sphere at a square: who is inside, who is not, the distance and what to roll', async () => {
    const h = setup(fixture({ heroTurn: true }));
    const out = await h.run('resolve_area', { label: 'Fireball', shape: 'sphere', size_ft: 20, at: 'G4', from: 'hero', range_ft: 150 });
    const lines = out.content.split('\n');
    expect(lines[0]).toBe('Fireball: 20-ft-radius Sphere centred on G4, 25 ft from Mira Voss (Mira Voss can see it). Shown on the map until this turn ends.');
    expect(out.content).toContain('Inside (2): Bandit 1 F4 · Bandit 2 F3.');
    expect(out.content).toContain('Not inside: Mira Voss B6 · [hidden] Cutthroat M8 · Old Tam B5 · Dock Ogre H10:I11.');
    expect(out.content).toContain("Next: roll each creature's save (roll_dice; the hero's with request_player_roll), then apply the damage.");
    expect(h.s().combat?.map?.effects).toMatchObject([{ label: 'Fireball', duration: 'turn', round: 2, turnOfId: 'c-1' }]);
    expect(lastLine(h)).toMatchObject({ icon: 'area', summary: 'Fireball: Bandit 1 and Bandit 2 are caught' });
  });

  it('refuses an area beyond its range', async () => {
    const h = setup(fixture({ heroTurn: true }));
    const out = await h.run('resolve_area', { label: 'Fireball', shape: 'sphere', size_ft: 20, at: 'G4', from: 'hero', range_ft: 20 });
    expect(out).toMatchObject({ isError: true, content: 'Fireball: G4 is 25 ft from Mira Voss, beyond its 20-ft range.' });
    expect(h.s().combat?.map?.effects).toEqual([]);
  });

  it('centres a sphere on a grid corner or a creature', async () => {
    const h = setup(fixture({ heroTurn: true }));
    const corner = await h.run('resolve_area', { label: 'Blast', shape: 'sphere', size_ft: 10, at: 'F4/G5' });
    expect(corner.content.split('\n')[0]).toBe('Blast: 10-ft-radius Sphere centred on F4/G5. Shown on the map until this turn ends.');
    expect(corner.content).toMatch(/Inside \(\d\): .*Bandit 1 F4/);
    const creature = await h.run('resolve_area', { label: 'Burst', shape: 'sphere', size_ft: 5, at: 'Bandit 1' });
    expect(creature.content).toMatch(/^Burst: 5-ft-radius Sphere centred on Bandit 1\./);
  });

  it('lists the squares of a cone, warns about the hero and allies, and gives cover against it', async () => {
    const h = setup(fixture({ heroTurn: true, at: { 'Bandit 1': 'C5' } }));
    const out = await h.run('resolve_area', { label: 'Burning Hands', shape: 'cone', size_ft: 15, from: 'hero', toward: 'C5' });
    expect(out.content).toMatch(/^Burning Hands: 15-ft Cone from Mira Voss toward C5 \([A-P]\d+.*\)\. Shown on the map until this turn ends\./);
    expect(out.content).toMatch(/Inside \(\d\): .*Bandit 1 C5/);
    const north = await h.run('resolve_area', { label: 'Gust', shape: 'cone', size_ft: 15, from: 'hero', toward: 'north' });
    expect(north.content).toContain('⚠ Old Tam (an ally) is inside.');
    const fire = await h.run('resolve_area', { label: 'Fire Breath', shape: 'cone', size_ft: 30, from: 'Bandit 1', toward: 'hero' });
    expect(fire.content).toContain('⚠ Mira Voss (the hero) is inside.');
    expect(lastLine(h)?.summary).toMatch(/^Fire Breath: .*you are caught$/);
  });

  it('resolves lines, cubes, emanations and listed squares', async () => {
    const h = setup(fixture({ heroTurn: true }));
    const line = await h.run('resolve_area', { label: 'Lightning Bolt', shape: 'line', size_ft: 100, from: 'hero', toward: 'F4' });
    expect(line.content).toMatch(/^Lightning Bolt: 100-ft-long, 5-ft-wide Line from Mira Voss toward F4 \(/);
    expect(line.content).toContain('of its squares are off the map.');
    const cube = await h.run('resolve_area', { label: 'Thunderwave', shape: 'cube', size_ft: 15, from: 'hero', toward: 'north-east' });
    expect(cube.content).toMatch(/^Thunderwave: 15-ft Cube from Mira Voss toward north-east \(/);
    const aura = await h.run('resolve_area', { label: 'Spirit Guardians', shape: 'emanation', size_ft: 15, from: 'hero', lasting: true });
    expect(aura.content).toContain('Spirit Guardians: 15-ft Emanation around Mira Voss. It stays on the map until update_map effects_end ["Spirit Guardians"].');
    expect(aura.content).toContain('Inside (1): Old Tam B5.');
    const web = await h.run('resolve_area', { label: 'Web', shape: 'squares', squares: 'G7:J10', lasting: true, terrain: ['difficult', 'obscured'] });
    expect(web.content).toContain('Web: the squares G7:J10. It stays on the map until update_map effects_end ["Web"]. Its squares are now difficult terrain and heavily obscured (they block sight).');
    expect(web.content).toContain('Inside (1): Dock Ogre H10:I11.');
    // The lasting area changes the squares' terrain.
    const cells = mapCells(h.s().combat as CombatState, h.s().character);
    expect(cells?.hazardsAt.get(7 * 16 + 7)).toContain('Web');
    expect(lastLine(h)?.summary).toBe('Web: Dock Ogre is caught');
  });

  it('names Total Cover shields and visible creatures only in the log', async () => {
    const h = setup(fixture({ heroTurn: true, at: { Cutthroat: 'J4' } }));
    const out = await h.run('resolve_area', { label: 'Fireball', shape: 'sphere', size_ft: 20, at: 'G4' });
    expect(out.content).toMatch(/Shielded by Total Cover \(not affected\): \[hidden\] Cutthroat J4 — behind the pillar\./);
    const blind = await h.run('resolve_area', { label: 'Sleet', shape: 'sphere', size_ft: 5, at: 'M8' });
    expect(blind.content).toContain('Inside: nobody.');
    const hidden = setup(fixture({ heroTurn: true }));
    await hidden.run('resolve_area', { label: 'Sleet', shape: 'sphere', size_ft: 5, at: 'Cutthroat' });
    expect(lastLine(hidden)?.summary).toBe('Sleet: nobody you can see is caught');
    expect(JSON.stringify(hidden.s().log)).not.toContain('Cutthroat');
  });

  it("checks each shape's fields", async () => {
    const h = setup(fixture({ heroTurn: true }));
    const cone = await h.run('resolve_area', { label: 'Breath', shape: 'cone', size_ft: 15, from: 'hero' });
    expect(cone.content).toBe('resolve_area: a cone needs "size_ft", "from" (who breathes or casts it) and "toward" (a square, a creature or a direction).');
    expect((await h.run('resolve_area', { label: 'Ball', shape: 'sphere', size_ft: 20 })).content).toMatch(/a sphere needs "size_ft" \(its radius\) and "at"/);
    expect((await h.run('resolve_area', { label: 'Ball', shape: 'sphere', size_ft: 20, at: 'G4', terrain: ['hazard'] })).content).toMatch(/`terrain` goes only with lasting: true/);
    expect((await h.run('resolve_area', { label: 'Ball', shape: 'sphere', size_ft: 20, at: 'D4/D6' })).content).toMatch(/isn't a grid corner/);
  });
});

describe('check_map (spec §4.10): read-only', () => {
  it('measures between creatures both ways and draws the map, without changing anything or logging', async () => {
    const h = setup(fixture());
    const before = JSON.stringify(h.s());
    const out = await h.run('check_map', { from: 'Bandit 1', to: ['hero', 'E4'], show: true });
    expect(out.content).toContain('From Bandit 1 (F4):');
    expect(out.content).toMatch(/· Mira Voss \(B6\): 20 ft — line of sight; Mira Voss has Half Cover from it \([^)]+\); it has Half Cover from Mira Voss \(crates\); neither is within the other's reach\./);
    expect(out.content).toContain('· E4: 5 ft — line of sight.');
    expect(out.content).toContain('Tokens: @ Mira Voss · 1 Bandit 1 · 2 [hidden] Cutthroat · 3 Bandit 2 · 4 Old Tam · 5 Dock Ogre');
    expect(JSON.stringify(h.s())).toBe(before);
  });

  it('lists who is around a creature and the cover it can reach this turn against the hero', async () => {
    const h = setup(fixture());
    const out = await h.run('check_map', { from: 'Bandit 1' });
    expect(out.content).toMatch(/^Around Bandit 1 \(F4\): Bandit 2 5 ft \(ally\) · Mira Voss 20 ft · Old Tam 20 ft · Dock Ogre 30 ft \(ally\) · \[hidden\] Cutthroat 35 ft \(ally\)\. Cover it can reach this turn against Mira Voss: I3 Three-Quarters \([^)]*pillar[^)]*\), 15 ft/);
  });

  it('plans a route without moving: cost, the closest square, Dash and Opportunity Attacks', async () => {
    const h = setup(fixture());
    const path = await h.run('check_map', { from: 'Bandit 2', path_to: 'A7' });
    expect(path.content).toMatch(/^Bandit 2 \(F3\) → A7: 30 ft after standing up \(15 ft\) by F3 E4 D5 D6 C7 B7 A7; it has 15 ft left, so the closest it gets is [A-P]\d+\. With Dash it reaches A7\. No Opportunity Attacks on that route\.$/);
    const provoking = setup(fixture({ at: { 'Bandit 1': 'C5' } }));
    const out = await provoking.run('check_map', { from: 'Bandit 1', path_to: 'F4' });
    expect(out.content).toMatch(/Provokes: Mira Voss's Opportunity Attack leaving C5 · Old Tam's Opportunity Attack leaving C5\./);
    expect(provoking.s().combat?.map?.stop).toBeUndefined();
  });

  it('previews an area without showing it to the player', async () => {
    const h = setup(fixture({ heroTurn: true }));
    const out = await h.run('check_map', { area: { shape: 'sphere', size_ft: 20, at: 'G4' } });
    expect(out.content).toMatch(/^Preview \(not shown to the player\): 20-ft-radius Sphere centred on G4\./);
    expect(out.content).toContain('Inside (2): Bandit 1 F4 · Bandit 2 F3.');
    expect(out.content).not.toContain('Next:');
    expect(h.s().combat?.map?.effects).toEqual([]);
    expect(h.s().log).toHaveLength(0);
  });

  it('checks its fields', async () => {
    const h = setup(fixture());
    expect((await h.run('check_map', {})).content).toMatch(/needs at least one of/);
    expect((await h.run('check_map', { from: 'E5', path_to: 'A1' })).content).toBe('check_map: `path_to` needs `from` to be a creature.');
    expect((await h.run('check_map', { to: ['hero'] })).content).toMatch(/`to` needs `from`/);
    expect((await setup(sampleCombat()).run('check_map', { show: true })).content).toMatch(/no battle map/);
  });
});

describe('roll_dice with attacker and target (spec §4.11)', () => {
  it('warns when a melee attacker is out of reach, and gives the cover', async () => {
    const h = setup(fixture({ turn: 'Bandit 2' }));
    const out = await h.run('roll_dice', { expression: '1d20+3', purpose: 'Bandit 2 attacks Mira', dc: 12, is_attack: true, attacker: 'Bandit 2', target: 'hero' });
    expect(out.content).toMatch(
      /\nMap: Bandit 2 \(F3\) is 20 ft from Mira Voss \(B6\), beyond its 5-ft reach — if this is a melee attack, move it first \(the roll stands only if it is a ranged attack\)\. Mira Voss has Half Cover from it \([^)]+\) — that is \+2 AC\.$/,
    );
  });

  it('confirms reach and says when there is no cover', async () => {
    const h = setup(fixture({ at: { 'Bandit 1': 'C5' } }));
    const out = await h.run('roll_dice', { expression: '1d20+3', purpose: 'Bandit 1 attacks', dc: 12, is_attack: true, attacker: 'Bandit 1', target: 'Mira Voss' });
    expect(out.content.split('\n').at(-1)).toBe('Map: in reach (5 ft); no cover.');
  });

  it("says when the attacker can't see the target", async () => {
    const fog: TerrainFeature = { id: 't20', kind: 'obscured', rects: [{ x0: 2, y0: 2, x1: 2, y1: 9 }], label: 'smoke' }; // C3:C10
    const h = setup(fixture({ at: { 'Bandit 1': 'D6' }, map: { terrain: [...(sampleMappedCombat().map as BattleMap).terrain, fog], nextId: 21 } }));
    const out = await h.run('roll_dice', { expression: '1d20+3', purpose: 'Bandit 1 shoots', dc: 12, is_attack: true, attacker: 'Bandit 1', target: 'hero' });
    expect(out.content).toContain("Bandit 1 can't see Mira Voss from D6 (the smoke) — Disadvantage, unless something lets it see Mira Voss.");
  });

  it('adds nothing without a map, without is_attack or for an unknown name', async () => {
    const plain = setup(sampleCombat());
    const out = await plain.run('roll_dice', { expression: '1d20+3', purpose: 'Bandit 1 attacks', dc: 12, is_attack: true, attacker: 'Bandit 1', target: 'hero' });
    expect(out.content).not.toContain('Map:');
    const mapped = setup(fixture());
    expect((await mapped.run('roll_dice', { expression: '1d20+3', purpose: 'x', is_attack: true, attacker: 'Nobody', target: 'hero' })).content).not.toContain('Map:');
    expect((await mapped.run('roll_dice', { expression: '1d20+3', purpose: 'x', attacker: 'Bandit 1', target: 'hero' })).content).not.toContain('Map:');
  });

  it('rolls behind the screen for a hidden attacker (D41), with or without a map', async () => {
    const h = setup(fixture({ turn: 'Cutthroat' }));
    const out = await h.run('roll_dice', { expression: '1d20+5', purpose: 'Cutthroat stabs Mira', dc: 12, is_attack: true, attacker: 'Cutthroat', target: 'hero' });
    expect(out.content.split('\n')[0]).toMatch(/\(secret: the attacker is hidden from the player\)$/);
    expect(h.s().log.at(-1)).toMatchObject({ kind: 'roll', secret: true });
    const combat = sampleCombat();
    combat.combatants[1] = { ...combat.combatants[1], hidden: true };
    const plain = setup(combat);
    await plain.run('roll_dice', { expression: '1d20+3', purpose: 'Bandit 1 attacks', attacker: 'Bandit 1' });
    expect(plain.s().log.at(-1)).toMatchObject({ kind: 'roll', secret: true });
  });
});

describe("the hero's footprint after a size change on the sheet (D39)", () => {
  it('re-fits the hero and says where the hero stands now', async () => {
    const h = setup(fixture({ heroTurn: true }));
    const before = h.s().character as NonNullable<ReturnType<Harness['s']>['character']>;
    await h.s().updateCharacter((c) => ({ ...c, size: 'Large' }));
    const line = await refitHeroAfterSheetChange(h.ctx, before, h.s().character as typeof before);
    expect(line).toMatch(/^Map: Mira Voss (is now Large \([A-P]\d+:[A-P]\d+\)|no longer fits at B6: moved to [A-P]\d+ \([A-P]\d+:[A-P]\d+\))\.$/);
    const now = byName(h.s().combat, 'Mira Voss');
    expect(planMove(h.s().combat as CombatState, h.s().character, { moverId: now.id, kind: 'move', by: 'dm', to: { kind: 'square', at: now.position as { x: number; y: number } } }).status).toBe('moved');
  });

  it('says nothing when the size is unchanged or there is no map', async () => {
    const h = setup(sampleCombat());
    const hero = h.s().character as NonNullable<ReturnType<Harness['s']>['character']>;
    expect(await refitHeroAfterSheetChange(h.ctx, hero, { ...hero, size: 'Large' })).toBeNull();
    const mapped = setup(fixture());
    expect(await refitHeroAfterSheetChange(mapped.ctx, hero, hero)).toBeNull();
  });
});

describe('hidden creatures write no player log line, whatever they do (D41, amendment 8)', () => {
  it("runs the Cutthroat's whole turn behind the screen, then reveals it", async () => {
    fakeDice.queue(15);
    const h = setup(fixture());
    const playerSees = () =>
      JSON.stringify(h.s().log.filter((e) => !('secret' in e && e.secret)));
    // Bandit 1's turn ends; the hidden Cutthroat's begins.
    expect((await h.run('update_combat', { action: 'next_turn' })).content).toContain('Map: [hidden] Cutthroat is at M8');
    await h.run('move_tokens', { moves: [{ who: 'Cutthroat', to: 'G6' }] });
    expect(byName(h.s().combat, 'Cutthroat').position).toEqual(sq('G6'));
    // The DM forgot secret: true — the app keeps the rolls behind the screen anyway.
    await h.run('roll_dice', { expression: '1d20+5', purpose: 'Cutthroat throws a dagger at Mira', dc: 12, is_attack: true, attacker: 'Cutthroat', target: 'hero' });
    await h.run('roll_dice', { expression: '1d20+7', purpose: 'Stealth for the cutthroat' });
    await h.run('roll_dice', { expression: '1d20+3', purpose: 'Old Tam swings blindly', is_attack: true, attacker: 'Old Tam', target: 'Cutthroat' });
    await h.run('resolve_area', { label: 'Fireball', shape: 'sphere', size_ft: 20, at: 'G6' });
    await h.run('update_combat', { action: 'damage', target: 'Cutthroat', amount: 6 });
    await h.run('update_combat', { action: 'conditions', target: 'Cutthroat', conditions_add: [{ condition: 'prone' }] });
    await h.run('update_map', { creatures: [{ who: 'Cutthroat', speed_change_ft: -10 }] });
    await h.run('check_map', { from: 'Cutthroat', to: ['hero'] });
    expect(h.s().log.filter((e) => e.kind === 'roll').every((e) => e.kind === 'roll' && e.secret)).toBe(true);
    expect(playerSees()).not.toMatch(/cutthroat/i);
    // Its turn passes to Bandit 2 without a word about it.
    await h.run('update_combat', { action: 'next_turn' });
    expect(playerSees()).not.toMatch(/cutthroat/i);

    await h.run('update_combat', { action: 'reveal', target: 'Cutthroat' });
    expect(lastLine(h)?.summary).toBe('Cutthroat appears (G6)');
  });

  it('keeps a roll public when the purpose only shares a word with a hidden name a visible creature also has', async () => {
    const combat = fixture();
    const h = setup({ ...combat, combatants: combat.combatants.map((c) => (c.name === 'Cutthroat' ? { ...c, name: 'Bandit' } : c)) });
    await h.run('roll_dice', { expression: '1d20+3', purpose: 'Bandit 1 attacks Mira', is_attack: true, attacker: 'Bandit 1', target: 'hero' });
    expect(h.s().log.at(-1)).toMatchObject({ kind: 'roll', secret: false });
  });
});

describe('the hero is named, never "it", in check_map and move results (amendment 1)', () => {
  it('measures from the hero and plans the hero\'s route in the hero\'s name', async () => {
    const h = setup(fixture({ heroTurn: true }));
    const out = await h.run('check_map', { from: 'hero', to: ['Bandit 1'], path_to: 'C7' });
    expect(out.content).toContain('· Bandit 1 (F4): 20 ft — line of sight; Bandit 1 has Half Cover from Mira Voss (crates); Mira Voss has');
    expect(out.content).not.toMatch(/\bit (has|reaches|doesn't)\b/);
    const path = await h.run('check_map', { from: 'hero', path_to: 'C7' });
    expect(path.content).toMatch(/^Mira Voss \(B6\) → C7: 5 ft by B6 C7; Mira Voss has 30 ft this turn\./);
    const around = await h.run('check_map', { from: 'hero' });
    expect(around.content).not.toMatch(/Cover it can reach/);
  });

  it("lists the Opportunity Attacks a cover square would cost to reach", async () => {
    const h = setup(fixture({ at: { 'Bandit 1': 'C5' } }));
    const out = await h.run('check_map', { from: 'Bandit 1' });
    expect(out.content).toMatch(/Cover it can reach this turn against Mira Voss: [A-P]\d+ (Half|Three-Quarters)/);
    // Leaving the hero's and Old Tam's reach from C5 provokes; the cover list says so where it does.
    expect(out.content).toMatch(/provokes (an Opportunity Attack|\d Opportunity Attacks)/);
  });
});

describe('move_tokens: details the review added', () => {
  it('reports a "Let it go" earlier on the route when the move then stops for an NPC', async () => {
    const h = setup(fixture({ at: { 'Bandit 1': 'C6', 'Old Tam': 'D8' } }));
    const asked = answerConfirm(h, false);
    const out = await h.run('move_tokens', { moves: [{ who: 'Bandit 1', to: 'E10', prefer: 'shortest' }] });
    expect(asked).toHaveLength(1);
    expect(out.content).toMatch(
      /^1\. Bandit 1 stopped at [A-P]\d+ on the way to E10 \(\d+ ft so far\): leaving here takes Bandit 1 out of Old Tam's reach, which provokes its Opportunity Attack \(its Reaction is unused\)\. Leaving [A-P]\d+ provoked Mira Voss's Opportunity Attack: the player let it go\. Roll it now/,
    );
    expect(byName(h.s().combat, 'Mira Voss').reactionUsed).toBeUndefined();
  });

  it('says a Prone creature that stays Prone crawls, rather than standing up', async () => {
    const h = setup(fixture({ turn: 'Bandit 2' }));
    const out = await h.run('move_tokens', { moves: [{ who: 'Bandit 2', to: 'A7', stay_prone: true }] });
    expect(out.content).toMatch(/^1\. Not moved — Bandit 2 to A7: A7 is \d+ ft away by crawling \(F3 /);
  });

  it("names a Large creature's whole space when it walks into a hazard", async () => {
    const h = setup(fixture({ turn: 'Dock Ogre' }));
    const out = await h.run('move_tokens', { moves: [{ who: 'Dock Ogre', to: 'hero' }] });
    // H10 G10 …: at G10 its space G10:H11 covers the brazier on G11.
    expect(out.content).toContain('It entered the brazier (hazard) at G10:H11.');
  });
});

describe('names that look like squares (start_combat numbers groups: "Rat 1", "Rat 2")', () => {
  /** The fixture with the bandits renamed Rat 1 and Rat 2, and the office door labelled "Hut 2". */
  function rats(): CombatState {
    const base = fixture({ at: { 'Bandit 1': 'D4' } });
    const map = base.map as BattleMap;
    return {
      ...base,
      combatants: base.combatants.map((c) => (c.name === 'Bandit 1' ? { ...c, name: 'Rat 1' } : c.name === 'Bandit 2' ? { ...c, name: 'Rat 2' } : c)),
      map: { ...map, terrain: map.terrain.map((f) => (f.kind === 'door' ? { ...f, label: 'Hut 2' } : f)) },
    };
  }

  it('moves to, measures to and aims at a creature called exactly that', async () => {
    const h = setup(rats());
    const moved = await h.run('move_tokens', { moves: [{ who: 'Rat 1', to: 'Rat 2' }] });
    expect(moved.isError).toBeUndefined();
    expect(moved.content).toMatch(/^1\. Rat 1 (moved|is already there)/);
    const measured = await h.run('check_map', { from: 'rat 1', to: ['Rat 2', 'F3'] });
    expect(measured.content).toMatch(/^From Rat 1 \([A-P]\d+\):\n· Rat 2 \(F3\): \d+ ft/);
    const blast = await h.run('resolve_area', { label: 'Blast', shape: 'sphere', size_ft: 5, at: 'Rat 2' });
    expect(blast.content.split('\n')[0]).toBe('Blast: 5-ft-radius Sphere centred on Rat 2. Shown on the map until this turn ends.');
  });

  it("opens a door by its label even when the label looks like a square", async () => {
    const h = setup(rats());
    const out = await h.run('update_map', { doors: [{ at: 'Hut 2', state: 'open' }] });
    expect(out.content).toBe('Map updated: the Hut 2 (N5) is now open.');
  });
});

describe("the DM resolves the player's stop and finishes the hero's move (spec §5.5)", () => {
  it('checks the Ogre is in reach, then the hero goes on to A7 and the Ogre\'s Reaction is spent', async () => {
    const h = setup(sampleStopCombat());
    const roll = await h.run('roll_dice', {
      expression: '1d20+6',
      purpose: "Dock Ogre's Opportunity Attack on Mira",
      dc: 12,
      is_attack: true,
      attacker: 'Dock Ogre',
      target: 'hero',
    });
    expect(roll.content.split('\n').at(-1)).toBe('Map: in reach (5 ft); no cover.');
    const out = await h.run('move_tokens', { moves: [{ who: 'hero', to: 'A7' }] });
    expect(out.content).toMatch(/^1\. Mira Voss moved B6 → A7: 5 ft \(B6 A7\); 25 of 30 ft left this turn\. Dock Ogre's Reaction is now used\./);
    const s = h.s().combat as CombatState;
    expect(s.map?.stop).toBeUndefined();
    expect(byName(s, 'Dock Ogre').reactionUsed).toBe(true);
    expect(byName(s, 'Mira Voss').position).toEqual(sq('A7'));
    expect(lastLine(h)?.summary).toBe('You move to A7');
  });
});
