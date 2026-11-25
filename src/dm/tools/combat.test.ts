import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/engine', () => import('../testing/fakeEngine'));
vi.mock('@/data', () => import('../testing/fakeData'));
vi.mock('@/state/gameStore', () => import('../testing/fakeGameStoreModule'));

import compendiumRaw from '../../../public/srd/compendium.json?raw';
import { createRulesIndex } from '@/data/search';
import { materializeEntries } from '@/data/structured/materialize';
import { sampleCharacter, sampleCombat, sampleMappedCombat, sampleStopCombat } from '@/test/fixtures';
import { gloamwoodEntries, gloamwoodEntryId, gloamwoodRecords, gloamwoodSource, GLOAMWOOD_TITLE } from '@/test/structuredFixtures';
import type { Character, Combatant, CombatState, CompendiumEntry, KnownSpell, LogEntry, MapEffect, RollLogEntry, ToolLogEntry } from '@/types';
import { deps, resetDmDeps, setDmDeps } from '../deps';
import { createFakeRulesIndex, SAMPLE_RULES } from '../testing/fakeData';
import { fakeDice } from '../testing/fakeEngine';
import { setupHarness, type Harness, type HarnessOptions } from '../testing/harness';
import type { ToolContext } from './context';
import { runTool } from './handlers';

beforeEach(() => fakeDice.reset());
afterEach(() => resetDmDeps());

function setup(opts: HarnessOptions = {}): Harness & { run: (name: string, input: unknown) => ReturnType<typeof runTool>; ctx: ToolContext } {
  const h = setupHarness({ withSession: true, ...opts, campaignSettings: { playerRollMode: 'auto', ...opts.campaignSettings } });
  const ctx: ToolContext = { deps: deps(), signal: new AbortController().signal, status: vi.fn() };
  return { ...h, ctx, run: (name, input) => runTool(name, input, ctx) };
}

const toolLines = (log: LogEntry[]) => log.filter((e): e is ToolLogEntry => e.kind === 'tool');
const named = (state: CombatState | null, name: string) => state?.combatants.find((c) => c.name === name);

const SRD_SPELLS = (JSON.parse(compendiumRaw) as CompendiumEntry[]).filter((e) => e.kind === 'spell');
/** The setup with the real rules index over the SRD 5.2.1 spells (its own name lookup) in place of the few test entries. */
function withSrdSpells(opts: HarnessOptions = {}) {
  const h = setup(opts);
  const index = createRulesIndex(SRD_SPELLS);
  setDmDeps({ rulesIndex: async () => index });
  const ctx: ToolContext = { deps: deps(), signal: new AbortController().signal, status: vi.fn() };
  return { ...h, run: (name: string, input: unknown) => runTool(name, input, ctx) };
}
/** A sheet spell as the builder links it to its SRD entry (KnownSpell.id is the entry's id). */
const srdKnown = (id: string, name: string, level: number, source: string, concentration?: boolean): KnownSpell => ({
  id,
  name,
  level,
  prepared: true,
  source,
  ...(concentration ? { concentration } : {}),
});

/** The warehouse of spec §4.5 (its loading door is A5:B7, as in the fixture). */
const WAREHOUSE = {
  name: 'Dockside warehouse',
  width: 16,
  height: 12,
  terrain: [
    { kind: 'wall', squares: 'L5:P5', label: 'office wall' },
    { kind: 'door', squares: 'N5', label: 'office door' },
    { kind: 'wall', squares: 'I4', label: 'pillar' },
    { kind: 'half-cover', squares: 'E5:F6', label: 'crates' },
    { kind: 'difficult', squares: 'H8:J9', label: 'spilled grain' },
    { kind: 'deep-water', squares: 'N10:P12', label: 'flooded dock' },
    { kind: 'hazard', squares: 'G11', label: 'brazier' },
  ],
  places: [
    { name: 'the loading door', squares: 'A5:B7' },
    { name: 'the office', squares: 'L1:P4' },
  ],
};

const BANDITS = { name: 'Bandit', side: 'enemy', count: 2, ac: 12, hp_max: 11, initiative_bonus: 1, stat_block: 'Bandit', position: 'F4' };
const CUTTHROAT = { name: 'Cutthroat', side: 'enemy', ac: 14, hp_max: 16, initiative_bonus: 3, hidden: true, position: 'M8' };
const OLD_TAM = { name: 'Old Tam', side: 'ally', ac: 11, hp_max: 9, initiative_bonus: 0 };
const OGRE = { name: 'Dock Ogre', side: 'enemy', ac: 11, hp_max: 59, initiative_bonus: -1, stat_block: 'Ogre', position: 'H10' };

const START = {
  encounter_name: 'Ambush in the warehouse',
  map: WAREHOUSE,
  hero_position: 'B6',
  combatants: [BANDITS, CUTTHROAT, OLD_TAM, OGRE],
};

describe('start_combat with a battle map (spec §4.5)', () => {
  it('lays out the map, places everyone, takes map stats from the stat blocks, and measures from the hero', async () => {
    // Initiative: Mira 15+2, the Bandits 13+1, the Cutthroat 9+3, Old Tam 5, the Ogre 4−1.
    fakeDice.queue(15, 13, 9, 5, 4);
    const h = setup();
    const out = await h.run('start_combat', START);
    expect(out.isError).toBeUndefined();
    const combat = h.s().combat as CombatState;
    expect(combat.map).toMatchObject({ name: 'Dockside warehouse', width: 16, height: 12 });
    expect(combat.map?.terrain.map((f) => f.label)).toEqual(['office wall', 'office door', 'pillar', 'crates', 'spilled grain', 'flooded dock', 'brazier']);
    expect(combat.map?.terrain[1]).toMatchObject({ kind: 'door', door: 'closed' });
    const at = (name: string) => named(combat, name)?.position;
    expect(at('Mira Voss')).toEqual({ x: 1, y: 5 }); // B6
    expect(at('Bandit 1')).toEqual({ x: 5, y: 3 }); // F4
    expect(at('Bandit 2')).toEqual({ x: 5, y: 2 }); // F3, next to Bandit 1
    expect(at('Cutthroat')).toEqual({ x: 12, y: 7 }); // M8
    expect(at('Old Tam')).toEqual({ x: 1, y: 4 }); // B5, next to the hero
    expect(at('Dock Ogre')).toEqual({ x: 7, y: 9 }); // H10
    expect(named(combat, 'Cutthroat')?.hidden).toBe(true);
    expect(named(combat, 'Dock Ogre')).toMatchObject({ size: 'Large', speeds: { walk: 40 }, reachFt: 5 });
    expect(named(combat, 'Bandit 1')).toMatchObject({ size: 'Medium', speeds: { walk: 30 }, reachFt: 5 });
    expect(named(combat, 'Old Tam')).not.toHaveProperty('size');
    // The hero's map stats are read live from the sheet, never copied.
    expect(named(combat, 'Mira Voss')).not.toHaveProperty('speeds');

    const text = out.content;
    expect(text).toContain('Combat started: Ambush in the warehouse.');
    expect(text).toContain('Battle map: Dockside warehouse, 16×12 squares of 5 ft (A1 is the top-left; letters run left to right, numbers top to bottom).');
    expect(text).toContain('    A B C D E F G H I J K L M N O P');
    expect(text).toContain('  5 . 4 . . ) ) . . . . . # # + # #');
    expect(text).toContain(' 12 . . . . . . . . . . . . . ~ ~ ~');
    expect(text).toContain('Tokens: @ Mira Voss · 1 Bandit 1 · 2 Bandit 2 · 3 [hidden] Cutthroat · 4 Old Tam · 5 Dock Ogre');
    expect(text).toContain('Labels: office wall L5:P5 · office door N5 (closed) · pillar I4 · crates E5:F6 · spilled grain H8:J9 · flooded dock N10:P12 · brazier G11');
    expect(text).toContain('Places: the loading door A5:B7 · the office L1:P4');
    expect(text).toContain('Placed automatically: Bandit 2 at F3 (next to Bandit 1) · Old Tam at B5 (next to Mira Voss). Use move_tokens kind "place" to change that.');
    expect(text).toContain(
      'On the map: Bandit 1–2 Medium, walk 30, reach 5 (stat block) · [hidden] Cutthroat Medium, walk 30, reach 5 (defaults) · Old Tam Medium, walk 30, reach 5 (defaults) · Dock Ogre Large, walk 40, reach 5 (stat block)',
    );
    expect(text).toMatch(/From Mira Voss: Bandit 1 20 ft, Half Cover \(crates\) · Bandit 2 20 ft, Half Cover \([^)]+\) · \[hidden\] Cutthroat 55 ft · Old Tam 5 ft · Dock Ogre 30 ft/);
  });

  it('logs only what the player can see: the visible count, no hidden name, and the map', async () => {
    const h = setup();
    await h.run('start_combat', START);
    const [line] = toolLines(h.s().log);
    expect(line).toMatchObject({ tool: 'start_combat', icon: 'combat', summary: 'Combat started: Ambush in the warehouse (5 combatants)' });
    expect(line.detail).toContain('Battle map: Dockside warehouse (16×12)');
    expect(JSON.stringify(h.s().log)).not.toContain('Cutthroat');
  });

  it('checks every map input before anyone rolls: a bad square never opens the roll dialog', async () => {
    const h = setup({ campaignSettings: { playerRollMode: 'prompt' } });
    const asked: string[] = [];
    h.store.subscribe((s) => {
      if (s.interaction) asked.push(s.interaction.kind);
    });
    const bad = await h.run('start_combat', { ...START, combatants: [{ ...BANDITS, position: 'Q13' }] });
    expect(bad).toMatchObject({ isError: true });
    expect(bad.content).toContain('"Q13" is off the map: columns run A–P and rows 1–12.');
    const place = await h.run('start_combat', { ...START, hero_position: 'the cellar' });
    expect(place.content).toContain('places: the loading door, the office');
    const many = await h.run('start_combat', { ...START, combatants: [{ ...BANDITS, position: 'F4, G4, H4' }] });
    expect(many.content).toContain('3 squares for 2 creatures');
    const terrain = await h.run('start_combat', { ...START, map: { ...WAREHOUSE, terrain: [{ kind: 'wall', squares: 'A1:Z1' }] } });
    expect(terrain.content).toContain('"Z1" is off the map');
    expect(asked).toEqual([]);
    expect(h.s().combat).toBeNull();
    expect(h.s().log).toHaveLength(0);
  });

  it('shifts a creature asked onto a wall to the nearest open square and says why', async () => {
    const h = setup();
    const out = await h.run('start_combat', { ...START, combatants: [{ ...OGRE, position: 'H10' }, { ...BANDITS, count: 1, position: 'I4' }] });
    const bandit = named(h.s().combat, 'Bandit');
    expect(bandit?.position).toBeDefined();
    expect(bandit?.position).not.toEqual({ x: 8, y: 3 });
    expect(out.content).toMatch(/Not where you asked: Bandit at [A-P]\d+ \(I4 is a wall\)\./);
  });

  it('ignores the map with a note when battle maps are Off (D57)', async () => {
    const h = setup({ campaignSettings: { battleMaps: 'off' } });
    const out = await h.run('start_combat', START);
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('Battle maps are Off in this campaign: the map was ignored.');
    expect(h.s().combat?.map).toBeUndefined();
    expect(h.s().combat?.combatants.every((c) => c.position === undefined)).toBe(true);
  });

  it('ignores positions without a map, and nudges toward a map when every fight should have one', async () => {
    const plain = setup();
    const out = await plain.run('start_combat', { combatants: [{ ...BANDITS, position: 'F4' }] });
    expect(out.content).toContain('No map: positions were ignored.');
    expect(out.content).not.toContain('every fight on a battle map');
    const always = setup({ campaignSettings: { battleMaps: 'always' } });
    const nudged = await always.run('start_combat', { combatants: [OLD_TAM] });
    expect(nudged.content).toContain('This campaign plays every fight on a battle map: add one with update_map create.');
  });

  it('runs a fight without a map exactly as before', async () => {
    fakeDice.queue(15, 11);
    const h = setup();
    const out = await h.run('start_combat', { encounter_name: 'Dock ambush', combatants: [{ name: 'Goblin', side: 'enemy', count: 3, ac: 15, hp_max: 7, initiative_bonus: 2 }] });
    expect(h.s().combat?.map).toBeUndefined();
    expect(out.content).not.toContain('Battle map');
    expect(toolLines(h.s().log)[0].summary).toBe('Combat started: Dock ambush (4 combatants)');
  });
});

describe('update_combat: hidden creatures (D41)', () => {
  it('reveal shows the creature to the player with its square; hide takes it away without a log line', async () => {
    const h = setup({ state: { combat: sampleMappedCombat() } });
    const shown = await h.run('update_combat', { action: 'reveal', target: 'Cutthroat' });
    expect(shown.content).toContain('Cutthroat is now visible to the player (M8, 55 ft from Mira Voss).');
    expect(named(h.s().combat, 'Cutthroat')).not.toHaveProperty('hidden');
    expect(toolLines(h.s().log).at(-1)).toMatchObject({ icon: 'combat', summary: 'Cutthroat appears (M8)' });

    const before = h.s().log.length;
    const hidden = await h.run('update_combat', { action: 'hide', target: 'Cutthroat' });
    expect(hidden.content).toContain('Cutthroat is now hidden from the player.');
    expect(named(h.s().combat, 'Cutthroat')?.hidden).toBe(true);
    expect(h.s().log).toHaveLength(before);
  });

  it('reveals without a map too, and refuses the hero', async () => {
    const combat = sampleCombat();
    combat.combatants[2] = { ...combat.combatants[2], hidden: true };
    const h = setup({ state: { combat } });
    await h.run('update_combat', { action: 'reveal', target: 'Bandit 2' });
    expect(toolLines(h.s().log).at(-1)?.summary).toBe('Bandit 2 appears');
    expect(await h.run('update_combat', { action: 'hide', target: 'Mira Voss' })).toMatchObject({ isError: true });
  });

  it("writes no log line for a hidden creature's turn, damage, conditions, defeat or removal", async () => {
    const h = setup({ state: { combat: sampleMappedCombat() } });
    await h.run('update_combat', { action: 'next_turn' }); // Bandit 1 → the Cutthroat (hidden)
    await h.run('update_combat', { action: 'damage', target: 'Cutthroat', amount: 3 });
    await h.run('update_combat', { action: 'conditions', target: 'Cutthroat', conditions_add: [{ condition: 'poisoned' }] });
    await h.run('update_combat', { action: 'defeat', target: 'Cutthroat' });
    await h.run('update_combat', { action: 'remove', target: 'Cutthroat' });
    expect(h.s().log).toHaveLength(0);
    expect(named(h.s().combat, 'Cutthroat')).toBeUndefined();
  });

  it('names only the visible newcomers of a mixed fight, and none when they are hidden', async () => {
    const h = setup({ state: { combat: sampleMappedCombat() } });
    await h.run('update_combat', { action: 'add', combatant: { name: 'Lurker', side: 'enemy', ac: 13, hp_max: 10, initiative_bonus: 2, hidden: true } });
    expect(h.s().log).toHaveLength(0);
    await h.run('update_combat', { action: 'add', combatant: { name: 'Watchman', side: 'ally', ac: 13, hp_max: 10, initiative_bonus: 2 } });
    expect(toolLines(h.s().log).at(-1)?.summary).toBe('Joined the fight: Watchman');
  });
});

describe("update_combat conditions by the DM's own name (SRD 5.2.1 Rules Glossary conditions)", () => {
  it('keeps a name with a condition word inside it as homebrew, tells the DM (not the player), and removes by name', async () => {
    const h = setup({ state: { combat: sampleCombat() } });
    const out = await h.run('update_combat', {
      action: 'conditions',
      target: 'Bandit 1',
      conditions_add: [{ condition: 'Mark of the Invisible Hand', source: 'Thieves guild tattoo' }, { condition: 'Blindness' }],
    });
    expect(named(h.s().combat, 'Bandit 1')?.conditions).toEqual([{ id: 'Mark of the Invisible Hand', source: 'Thieves guild tattoo' }, { id: 'blinded' }]);
    expect(out.content).toContain(
      'Bandit 1: +Mark of the Invisible Hand, +blinded\nKept "Mark of the Invisible Hand" as a homebrew condition: no Invisible rules apply. To apply Invisible, add "Invisible".\n',
    );
    expect(toolLines(h.s().log).at(-1)?.summary).toBe('Bandit 1: +Mark of the Invisible Hand, +blinded');
    // Removals compare as the engine does: case aside, and a homebrew name never takes the condition it mentions.
    await h.run('update_combat', { action: 'conditions', target: 'Bandit 1', conditions_add: [{ condition: 'Invisible' }] });
    await h.run('update_combat', { action: 'conditions', target: 'Bandit 1', conditions_remove: ['mark of the invisible hand', 'BLINDED'] });
    expect(named(h.s().combat, 'Bandit 1')?.conditions).toEqual([{ id: 'invisible' }]);
  });

  it('removes a name the creature has as named, before reading it as a standard condition', async () => {
    const combat = sampleCombat();
    // An older save's homebrew "Fear" beside a real Frightened ("Fear" names Frightened now).
    combat.combatants[2].conditions = [{ id: 'Fear', source: 'older save' }, { id: 'frightened' }];
    const h = setup({ state: { combat } });
    await h.run('update_combat', { action: 'conditions', target: 'Bandit 2', conditions_remove: ['Fear'] });
    expect(named(h.s().combat, 'Bandit 2')?.conditions).toEqual([{ id: 'frightened' }]);
    await h.run('update_combat', { action: 'conditions', target: 'Bandit 2', conditions_remove: ['Fear'] });
    expect(named(h.s().combat, 'Bandit 2')?.conditions).toEqual([]);
  });

  it("reports only what it removed, by the stored name: a name the creature doesn't have is a DM-only note, never the player's log", async () => {
    const combat = sampleCombat();
    combat.combatants[1].conditions = [{ id: 'unconscious', source: 'Sleep' }, { id: 'Hexed', source: 'the Hag hiding in the mist' }];
    const h = setup({ state: { combat } });
    const logged = () => toolLines(h.s().log).map((l) => l.summary);
    // The DM's line prints "Hexed (the Hag hiding in the mist)": copied back, it still finds nothing, and says so to the DM only.
    const out = await h.run('update_combat', { action: 'conditions', target: 'Bandit 1', conditions_remove: ["KO'd", 'Hexed (the Hag hiding in the mist)'] });
    expect(out.content).toContain('Bandit 1: no change');
    expect(out.content).toContain(`Not removed: Bandit 1 has no "KO'd" (it has unconscious, Hexed).`);
    expect(named(h.s().combat, 'Bandit 1')?.conditions).toHaveLength(2);
    expect(logged()).toEqual([]);
    // A mixed call logs only what it removed: the miss (with the DM's typed details) stays in the DM's result.
    const mixed = await h.run('update_combat', { action: 'conditions', target: 'Bandit 1', conditions_remove: ['Unconscious', 'Hexed (the Hag hiding in the mist)'] });
    expect(mixed.content).toContain('Not removed: Bandit 1 has no "Hexed (the Hag hiding in the mist)" (it has unconscious, Hexed).');
    expect(logged()).toEqual(['Bandit 1: −unconscious']);
    // A name the creature has, typed any way, is removed and logged by its stored name, once.
    await h.run('update_combat', { action: 'conditions', target: 'Bandit 1', conditions_remove: ['hexed', 'HEXED'] });
    expect(named(h.s().combat, 'Bandit 1')?.conditions).toEqual([]);
    expect(logged().at(-1)).toBe('Bandit 1: −Hexed');
  });
});

describe('update_combat on a battle map', () => {
  it('places newcomers where asked, or arriving at the edge farthest from the hero', async () => {
    const h = setup({ state: { combat: sampleMappedCombat() } });
    const out = await h.run('update_combat', {
      action: 'add',
      combatant: { name: 'Bandit', side: 'enemy', count: 2, ac: 12, hp_max: 11, initiative_bonus: 1, stat_block: 'Bandit', position: 'K2' },
    });
    expect(out.content).toMatch(/Placed: Bandit 3 at K2 · Bandit 4 at [A-P]\d+ \(next to Bandit 3\)/);
    expect(named(h.s().combat, 'Bandit 3')?.position).toEqual({ x: 10, y: 1 });
    const auto = await h.run('update_combat', { action: 'add', combatant: { name: 'Thug', side: 'enemy', ac: 12, hp_max: 11, initiative_bonus: 0 } });
    expect(auto.content).toMatch(/Placed: Thug at [A-P]\d+ \(arriving from the \w+ edge\)/);
    expect(named(h.s().combat, 'Thug')?.position).toBeDefined();
  });

  it('ignores a position without a map', async () => {
    const h = setup({ state: { combat: sampleCombat() } });
    const out = await h.run('update_combat', { action: 'add', combatant: { name: 'Thug', side: 'enemy', ac: 12, hp_max: 11, initiative_bonus: 0, position: 'A1' } });
    expect(out.content).toContain('No map: positions were ignored.');
    expect(named(h.s().combat, 'Thug')?.position).toBeUndefined();
  });

  it("says where the next creature stands and how far it can move, Prone included", async () => {
    const h = setup({ state: { combat: sampleMappedCombat() } });
    const cutthroat = await h.run('update_combat', { action: 'next_turn' });
    expect(cutthroat.content).toContain('Map: [hidden] Cutthroat is at M8 with 30 ft of movement (walk 30); 55 ft from Mira Voss, out of reach.');
    const bandit = await h.run('update_combat', { action: 'next_turn' });
    expect(bandit.content).toContain('Map: Bandit 2 is at F3 (Prone — standing costs 15 ft) with 30 ft of movement (walk 30); 20 ft from Mira Voss, out of reach.');
  });

  it("hands the hero's turn to the player", async () => {
    const h = setup({ state: { combat: { ...sampleMappedCombat(), turnIndex: 5 } } });
    const out = await h.run('update_combat', { action: 'next_turn' });
    expect(out.content).toContain("Map: Mira Voss's turn — the player moves Mira Voss on the map (30 ft). Don't move Mira Voss unless the player asks.");
  });

  it('reports lasting effects a creature starts inside and turn effects that expire', async () => {
    const base = sampleMappedCombat();
    const map = base.map as NonNullable<CombatState['map']>;
    const web: MapEffect = {
      id: 'e20',
      label: 'Web',
      spec: { shape: 'squares', rects: [{ x0: 5, y0: 2, x1: 5, y1: 2 }] },
      rects: [{ x0: 5, y0: 2, x1: 5, y1: 2 }],
      terrain: ['difficult', 'obscured'],
      duration: 'lasting',
      round: 2,
      turnOfId: 'c-2',
    };
    const fireball: MapEffect = { ...web, id: 'e21', label: 'Fireball', terrain: [], duration: 'turn', round: 2, turnOfId: 'c-5' };
    const h = setup({ state: { combat: { ...base, turnIndex: 2, map: { ...map, effects: [web, fireball] } } } });
    const out = await h.run('update_combat', { action: 'next_turn' }); // the Cutthroat → Bandit 2, standing in the Web
    expect(out.content).toContain('It starts its turn inside Web.');
    expect(out.content).toContain('Fireball is no longer shown.');
  });

  it('reminds the DM that creatures sharing an initiative still take separate turns', async () => {
    const base = sampleMappedCombat({ heroTurn: true });
    const combat = { ...base, combatants: base.combatants.map((c) => (c.name === 'Cutthroat' ? { ...c, initiative: 14 } : c)) };
    const h = setup({ state: { combat } });
    const out = await h.run('update_combat', { action: 'next_turn' });
    expect(out.content).toContain('[hidden] Cutthroat acts next on the same initiative: move Bandit 1, act, then call update_combat next_turn again.');
  });

  it('drops a stop when its mover or one of its reactors leaves the fight', async () => {
    const h = setup({ state: { combat: sampleStopCombat() } });
    expect(h.s().combat?.map?.stop).toBeDefined();
    await h.run('update_combat', { action: 'remove', target: 'Dock Ogre' });
    expect(h.s().combat?.map?.stop).toBeUndefined();
  });

  it('writes against the latest combat: a change made while it waited for the rules index survives', async () => {
    const h = setup({ state: { combat: sampleMappedCombat() } });
    const index = createFakeRulesIndex(SAMPLE_RULES);
    setDmDeps({
      rulesIndex: async () => {
        // The player commits a move while the tool waits (the store is functional: nothing read before is written back).
        await h.s().updateCombat((c) => ({ ...c, combatants: c.combatants.map((x) => (x.isPlayer ? { ...x, position: { x: 2, y: 6 } } : x)) }));
        return index;
      },
    });
    const ctx: ToolContext = { deps: deps(), signal: new AbortController().signal, status: vi.fn() };
    const out = await runTool('update_combat', { action: 'add', combatant: { name: 'Bandit', side: 'enemy', ac: 12, hp_max: 11, initiative_bonus: 1, stat_block: 'Bandit' } }, ctx);
    expect(out.isError).toBeUndefined();
    expect(named(h.s().combat, 'Mira Voss')?.position).toEqual({ x: 2, y: 6 });
    expect(named(h.s().combat, 'Bandit')).toBeDefined();
  });
});

describe('start_combat and update_combat add: numbers from the stat block (spec §6.3)', () => {
  const srdGoblin: CompendiumEntry = {
    id: 'srd:monster:goblin-warrior',
    sourceId: 'srd-5.2.1',
    sourceName: 'SRD 5.2.1',
    kind: 'monster',
    name: 'Goblin Warrior',
    text: '_**Scimitar.**_ _Melee Attack Roll:_ +4, reach 5 ft.',
    data: { size: 'Small', speeds: { walk: 30 }, ac: 15, hp: 10, initiative: 2 },
  };
  /** The real index (with its ranking) over an SRD goblin and the book with every record accepted. */
  function withBook(opts: { campaignSources?: boolean } = {}) {
    const h = setup({ campaignSettings: opts.campaignSources === false ? {} : { enabledSources: ['srd-5.2.1', 'gloam'] } });
    const accepted = gloamwoodRecords('gloam', { status: 'accepted' }).filter((r) => r.data !== null);
    const index = createRulesIndex([srdGoblin, ...materializeEntries(gloamwoodEntries(), accepted, [gloamwoodSource()])]);
    setDmDeps({ rulesIndex: async () => index });
    const ctx: ToolContext = { deps: deps(), signal: new AbortController().signal, status: vi.fn() };
    return { ...h, run: (name: string, input: unknown) => runTool(name, input, ctx) };
  }

  it('takes AC, HP and initiative from a reviewed import, says where they came from, and rolls with the bonus', async () => {
    fakeDice.queue(10, 12);
    const h = withBook();
    const out = await h.run('start_combat', { combatants: [{ name: 'Glimmerwing Drake', side: 'enemy', stat_block: 'Glimmerwing Drake' }] });
    expect(out.isError).toBeUndefined();
    const drake = named(h.s().combat, 'Glimmerwing Drake');
    expect(drake).toMatchObject({ ac: 17, hp: { max: 52, current: 52, temp: 0 }, initiativeBonus: 2, initiative: 14, size: 'Large', reachFt: 10 });
    expect(drake?.speeds).toEqual({ walk: 30, fly: 60, hover: true });
    expect(drake?.statBlockId).toBe(gloamwoodEntryId('Glimmerwing Drake'));
    expect(out.content).toContain(`Glimmerwing Drake: initiative 14 [d20 (12) + 2 = 14] · AC 17, HP 52, initiative +2 from the stat block (${GLOAMWOOD_TITLE})`);
  });

  it('takes them from the SRD, looking the group name up when stat_block is left out', async () => {
    fakeDice.queue(10, 9);
    const h = withBook();
    const out = await h.run('start_combat', { combatants: [{ name: 'Goblin Warrior', side: 'enemy', count: 2 }] });
    expect(out.content).toContain('Goblin Warrior ×2: initiative 11 [d20 (9) + 2 = 11] · AC 15, HP 10, initiative +2 from the stat block (SRD 5.2.1)');
    expect(named(h.s().combat, 'Goblin Warrior 2')).toMatchObject({ ac: 15, hp: { max: 10 }, statBlockId: 'srd:monster:goblin-warrior', statBlockName: 'Goblin Warrior' });
    // The book's unreviewed Goblin Warrior (CR only) never shadows the SRD's numbers.
  });

  it('lets explicit numbers win and notes where they differ from the block', async () => {
    fakeDice.queue(10, 5);
    const h = withBook();
    const out = await h.run('start_combat', { combatants: [{ name: 'Elder Drake', side: 'enemy', stat_block: 'Glimmerwing Drake', ac: 18, hp_max: 52 }] });
    expect(named(h.s().combat, 'Elder Drake')).toMatchObject({ ac: 18, hp: { max: 52 }, initiativeBonus: 2 });
    expect(out.content).toContain('Elder Drake: initiative 7 [d20 (5) + 2 = 7] · initiative +2 from the stat block (The Gloamwood Almanac) (the stat block says AC 17)');
  });

  it('is an error, before anyone rolls, when a number is neither given nor in a stat block', async () => {
    const h = withBook();
    const out = await h.run('start_combat', { combatants: [{ name: 'Lamp Wraith', side: 'enemy', ac: 13 }] });
    expect(out).toMatchObject({ isError: true });
    expect(out.content).toBe(
      'Give hp_max and initiative_bonus for Lamp Wraith: no stat block with those numbers was found (name one in stat_block, or give the numbers).',
    );
    expect(h.s().combat).toBeNull();
    expect(h.s().log).toHaveLength(0);
    // An unreviewed imported stat block has no numbers to give.
    const thin = await h.run('start_combat', { combatants: [{ name: 'Brute', side: 'enemy', stat_block: 'Bramble Hound', ac: 12, hp_max: 20 }] });
    expect(thin.isError).toBeUndefined();
  });

  it('behaves exactly as before when all three numbers are given and no stat_block', async () => {
    fakeDice.queue(10, 11);
    const h = withBook();
    const lookups = vi.fn();
    const index = createRulesIndex([srdGoblin]);
    setDmDeps({ rulesIndex: async () => (lookups(), index) });
    const ctx: ToolContext = { deps: deps(), signal: new AbortController().signal, status: vi.fn() };
    const out = await runTool('start_combat', { combatants: [{ name: 'Goblin Warrior', side: 'enemy', ac: 12, hp_max: 7, initiative_bonus: 1 }] }, ctx);
    expect(out.content).toContain('Goblin Warrior: initiative 12 [d20 (11) + 1 = 12]\n');
    expect(lookups).not.toHaveBeenCalled();
    expect(named(h.s().combat, 'Goblin Warrior')).not.toHaveProperty('statBlockId');
  });

  it('fills reinforcements the same way', async () => {
    const h = withBook();
    h.store.setState({ combat: sampleCombat() });
    fakeDice.queue(15);
    const out = await h.run('update_combat', { action: 'add', combatant: { name: 'Glimmerwing Drake', side: 'enemy', stat_block: 'Glimmerwing Drake' } });
    expect(out.content).toContain('from the stat block (The Gloamwood Almanac)');
    expect(named(h.s().combat, 'Glimmerwing Drake')).toMatchObject({ ac: 17, hp: { max: 52 } });
    const bad = await h.run('update_combat', { action: 'add', combatant: { name: 'Lamp Wraith', side: 'enemy' } });
    expect(bad).toMatchObject({ isError: true });
  });
});

describe("the hero's AC in combat results", () => {
  it("is the sheet's after a mid-fight change (armor_class for Mage Armor), not the copy start_combat took", async () => {
    const heroLine = (text = '') => text.split('\n').find((line) => line.includes('Mira Voss ·'));
    fakeDice.queue(15, 11);
    const h = setup();
    const start = await h.run('start_combat', { combatants: [{ name: 'Bandit', side: 'enemy', ac: 12, hp_max: 11, initiative_bonus: 1 }] });
    expect(heroLine(start.content)).toBe('▶ 17 Mira Voss · AC 12');
    expect(heroLine(toolLines(h.s().log).find((l) => l.tool === 'start_combat')?.detail)).toBe('▶ 17 Mira Voss · AC 12');

    await h.run('update_character', { armor_class: 15, reason: 'Mage Armor' });
    const next = await h.run('update_combat', { action: 'next_turn' });
    expect(heroLine(next.content)).toBe('  17 Mira Voss · AC 15');
    // Nothing syncs the tracker's copy: every view reads the sheet.
    expect(named(h.s().combat, 'Mira Voss')?.ac).toBe(12);
  });
});

describe('end_combat', () => {
  it('lists the final positions the player could see, and the map goes with the fight', async () => {
    const h = setup({ state: { combat: sampleMappedCombat() } });
    await h.run('end_combat', { summary: 'The bandits fled.' });
    expect(h.s().combat).toBeNull();
    const line = toolLines(h.s().log).at(-1);
    expect(line?.detail).toBe(
      'Final positions: Mira Voss B6 (the loading door) · Bandit 1 F4 · Bandit 2 F3 · Old Tam B5 (the loading door) · Dock Ogre H10:I11',
    );
    expect(JSON.stringify(h.s().log)).not.toContain('Cutthroat');
  });
});

// ---------------------------------------------------------------------------
// Spell effects (SPEC §3.2, §3.4, §3.5): NPC Concentration, the app's Constitution saves, countdowns, the end cascade
// ---------------------------------------------------------------------------

const rollLines = (log: LogEntry[]) => log.filter((e): e is RollLogEntry => e.kind === 'roll');

/**
 * sampleCombat() (round 2, Bandit 1's turn) with a Cultist Fanatic after Bandit 1: SRD stat block, Constitution save +1
 * (srd:monster:cultist-fanatic), numbers hidden from the player as an enemy's are by default. Order: Mira Voss 17,
 * Bandit 1 14, Cultist Fanatic 12, Bandit 2 9, Old Tam 5.
 */
function fanaticFight(fanatic: Partial<Combatant> = {}, more: (state: CombatState) => CombatState = (s) => s): CombatState {
  const base = sampleCombat();
  const cultist: Combatant = {
    id: 'c-7',
    name: 'Cultist Fanatic',
    side: 'enemy',
    isPlayer: false,
    initiative: 12,
    initiativeBonus: 2,
    ac: 13,
    hp: { max: 44, current: 44, temp: 0 },
    conditions: [],
    defeated: false,
    hideHp: true,
    statBlockName: 'Cultist Fanatic',
    statBlockId: 'srd:monster:cultist-fanatic',
    ...fanatic,
  };
  const [mira, bandit1, bandit2, oldTam] = base.combatants;
  return more({ ...base, combatants: [mira, bandit1, cultist, bandit2, oldTam] });
}

const holding = (spell: string, roundsLeft?: number): Partial<Combatant> => ({ concentration: roundsLeft === undefined ? { spell } : { spell, roundsLeft } });
const paralyzedMira = (source = 'Hold Person') => sampleCharacter({ conditions: [{ id: 'paralyzed', source }] });
const fanaticOf = (h: Harness) => named(h.s().combat, 'Cultist Fanatic');
const firstLine = (text: string) => text.split('\n')[0];

describe('update_combat concentrate: an NPC or monster (srd:rule:concentration)', () => {
  it('starts it with the countdown from the rules data, and writes no player log line', async () => {
    const h = setup({ state: { combat: fanaticFight() } });
    const out = await h.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: 'Hold Person' });
    expect(out.isError).toBeUndefined();
    // srd:spell:hold-person "Concentration, up to 1 minute": 10 rounds (srd:rule:combat-the-order-of-combat, about 6 seconds each).
    expect(firstLine(out.content)).toBe('Cultist Fanatic is concentrating on Hold Person (10 rounds left).');
    expect(fanaticOf(h)?.concentration).toEqual({ spell: 'Hold Person', roundsLeft: 10 });
    expect(out.content).toContain('Cultist Fanatic · HP 44/44 · Concentrating: Hold Person (10 rounds left)');
    expect(h.s().log).toHaveLength(0);
  });

  it("counts long spells in minutes, the DM's own count as given, and says when nothing counts it", async () => {
    const h = setup({ state: { combat: fanaticFight() } });
    // srd:spell:web "Concentration, up to 1 hour": 600 rounds.
    expect(firstLine((await h.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: 'Web' })).content)).toBe(
      'Cultist Fanatic is concentrating on Web (about 60 minutes left).',
    );
    expect(fanaticOf(h)?.concentration).toEqual({ spell: 'Web', roundsLeft: 600 });
    const given = setup({ state: { combat: fanaticFight() } });
    expect(firstLine((await given.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: 'Web', rounds: 20 })).content)).toBe(
      'Cultist Fanatic is concentrating on Web (20 rounds left).',
    );
    const unknown = setup({ state: { combat: fanaticFight() } });
    const lash = await unknown.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: 'Shadow Lash' });
    expect(firstLine(lash.content)).toBe(
      "Cultist Fanatic is concentrating on Shadow Lash (no countdown: Shadow Lash isn't a spell in the rules data — give rounds to count it).",
    );
    expect(named(unknown.s().combat, 'Cultist Fanatic')?.concentration).toEqual({ spell: 'Shadow Lash' });
  });

  it('refuses a spell that needs no Concentration (srd:spell:shield, Duration: 1 round)', async () => {
    const h = setup({ state: { combat: fanaticFight() } });
    const out = await h.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: 'Shield' });
    expect(out).toEqual({ isError: true, content: "Shield doesn't require Concentration (Duration: 1 round)." });
    expect(fanaticOf(h)).not.toHaveProperty('concentration');
  });

  it('reads a stat block\'s qualified spell without its qualifier, and records the spell\'s own name (srd:spell:hold-person, srd:spell:mind-spike)', async () => {
    // srd:spell:mind-spike: "Duration: Concentration, up to 1 hour".
    const mindSpike: CompendiumEntry = {
      id: 'srd:spell:mind-spike',
      sourceId: 'srd-5.2.1',
      sourceName: 'SRD 5.2.1',
      kind: 'spell',
      name: 'Mind Spike',
      text: 'You drive a spike of psionic energy into the mind of one creature you can see within range.',
      data: { level: 2, concentration: true, duration: 'Concentration, up to 1 hour' },
    };
    const h = setup({ character: paralyzedMira(), rules: [...SAMPLE_RULES, mindSpike], state: { combat: fanaticFight() } });
    // srd:spell:hold-person: "Using a Higher-Level Spell Slot. You can target one additional Humanoid" — the same spell.
    const held = await h.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: 'Hold Person (3rd level)' });
    expect(firstLine(held.content)).toBe('Cultist Fanatic is concentrating on Hold Person (10 rounds left).');
    expect(fanaticOf(h)?.concentration).toEqual({ spell: 'Hold Person', roundsLeft: 10 });
    // So its end names the conditions sourced "Hold Person".
    const ended = await h.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: null });
    expect(ended.content).toContain('Mira Voss is Paralyzed (source: Hold Person): if the spell caused it, remove it with update_character conditions_remove.');
    const spike = await h.run('update_combat', { action: 'concentrate', target: 'Bandit 2', spell: 'Mind Spike (level 4 version)' });
    expect(firstLine(spike.content)).toBe('Bandit 2 is concentrating on Mind Spike (about 60 minutes left).');
    // A qualified name the rules data doesn't know stays as typed, with no countdown.
    const lash = await h.run('update_combat', { action: 'concentrate', target: 'Bandit 1', spell: 'Shadow Lash (empowered)' });
    expect(firstLine(lash.content)).toBe(
      "Bandit 1 is concentrating on Shadow Lash (empowered) (no countdown: Shadow Lash (empowered) isn't a spell in the rules data — give rounds to count it).",
    );
  });

  it('restarts the count on a recast (srd:rule:casting-spells-effects-combining-spell-effects), and a repeat changes nothing', async () => {
    const h = setup({ state: { combat: fanaticFight(holding('Hold Person', 3)) } });
    const out = await h.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: 'Hold Person' });
    expect(firstLine(out.content)).toBe('Cultist Fanatic recasts Hold Person: 10 rounds left.');
    expect(fanaticOf(h)?.concentration).toEqual({ spell: 'Hold Person', roundsLeft: 10 });
    const combat = h.s().combat;
    const again = await h.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: 'hold person' });
    expect(firstLine(again.content)).toBe('Cultist Fanatic recasts Hold Person: 10 rounds left.');
    expect(h.s().combat).toBe(combat);
    // A bonus the app couldn't see (an ally's Bless on the save) is put right with the rounds that were left.
    expect(firstLine((await h.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: 'Hold Person', rounds: 3 })).content)).toBe(
      'Cultist Fanatic recasts Hold Person: 3 rounds left.',
    );
    expect(h.s().log).toHaveLength(0);
  });

  it('ends the spell it held when it starts another (srd:rule:concentration, Another Concentration Effect), naming what that spell held', async () => {
    const h = setup({ character: paralyzedMira(), state: { combat: fanaticFight(holding('Hold Person', 7)) } });
    const out = await h.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: 'Web' });
    expect(out.content).toContain(
      [
        'Cultist Fanatic is concentrating on Web (about 60 minutes left).',
        "Cultist Fanatic's Hold Person ends: it started concentrating on Web.",
        'Mira Voss is Paralyzed (source: Hold Person): if the spell caused it, remove it with update_character conditions_remove.',
      ].join('\n'),
    );
    // Named, never removed: the app can't tell which Paralyzed the spell caused.
    expect(h.s().character?.conditions).toEqual([{ id: 'paralyzed', source: 'Hold Person' }]);
  });

  it('ends it with spell null, and says so when there is nothing to end, defeated or not', async () => {
    const h = setup({ character: paralyzedMira(), state: { combat: fanaticFight(holding('Hold Person', 7)) } });
    const out = await h.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: null });
    expect(out.content.split('\n').slice(0, 2)).toEqual([
      'Cultist Fanatic stops concentrating on Hold Person.',
      'Mira Voss is Paralyzed (source: Hold Person): if the spell caused it, remove it with update_character conditions_remove.',
    ]);
    expect(fanaticOf(h)).not.toHaveProperty('concentration');
    const again = await h.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: null });
    expect(firstLine(again.content)).toBe("Cultist Fanatic isn't concentrating on anything.");
    const defeated = setup({ state: { combat: fanaticFight({ ...holding('Hold Person'), defeated: true }) } });
    expect(firstLine((await defeated.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: null })).content)).toBe(
      'Cultist Fanatic stops concentrating on Hold Person.',
    );
    expect(h.s().log).toHaveLength(0);
  });

  it("refuses what can't concentrate, and spell or rounds with another action", async () => {
    const h = setup({ state: { combat: fanaticFight() } });
    expect(await h.run('update_combat', { action: 'damage', target: 'Bandit 1', amount: 2, spell: 'Bless' })).toEqual({
      isError: true,
      content: '`spell` and `rounds` go with action concentrate.',
    });
    expect((await h.run('update_combat', { action: 'next_turn', rounds: 3 })).isError).toBe(true);
    expect((await h.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic' })).content).toBe(
      'update_combat concentrate needs `spell`: what Cultist Fanatic concentrates on, or null when that ends.',
    );
    const defeated = setup({ state: { combat: fanaticFight({ defeated: true }) } });
    expect((await defeated.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: 'Bless' })).content).toBe(
      "Cultist Fanatic is defeated and can't start concentrating.",
    );
    // srd:rule:concentration: "Your Concentration ends if you have the Incapacitated condition".
    const held = setup({ state: { combat: fanaticFight({ conditions: [{ id: 'paralyzed' }] }) } });
    expect((await held.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: 'Bless' })).content).toBe(
      "Cultist Fanatic can't concentrate while Paralyzed.",
    );
    expect(h.s().combat).toEqual(fanaticFight());
  });
});

describe("update_combat concentrate on the hero: only the countdown of the sheet's spell", () => {
  const blessing = () => sampleCharacter({ spellcasting: { ...sampleCharacter().spellcasting!, concentratingOn: 'Bless' } });

  it('sets the rounds left of the spell the sheet holds (Extended Spell, a higher-level slot)', async () => {
    const h = setup({ character: blessing(), state: { combat: sampleCombat() } });
    const out = await h.run('update_combat', { action: 'concentrate', target: 'Mira Voss', spell: 'Bless', rounds: 20 });
    expect(firstLine(out.content)).toBe("Mira Voss's Bless: 20 rounds left.");
    expect(named(h.s().combat, 'Mira Voss')?.concentrationCountdown).toEqual({ spell: 'Bless', roundsLeft: 20 });
    expect(out.content).toContain('Mira Voss · AC 12 · Bless: about 2 minutes left');
    expect(h.s().log).toHaveLength(0);
  });

  it("names update_character for starting or ending the hero's Concentration", async () => {
    const h = setup({ character: blessing(), state: { combat: sampleCombat() } });
    expect((await h.run('update_combat', { action: 'concentrate', target: 'Mira Voss', spell: null })).content).toBe(
      "Mira Voss's Concentration is on the character sheet: end it with update_character concentration: null.",
    );
    expect((await h.run('update_combat', { action: 'concentrate', target: 'Mira Voss', spell: 'Web', rounds: 5 })).content).toBe(
      'Mira Voss is concentrating on Bless, not Web: for the hero, concentrate only sets rounds (spell "Bless" with rounds); update_character concentration starts or ends the hero\'s Concentration.',
    );
    expect((await h.run('update_combat', { action: 'concentrate', target: 'Mira Voss', spell: 'Bless' })).content).toBe(
      "Give rounds: how long Mira Voss's Bless still lasts (1 minute = 10 rounds).",
    );
    const idle = setup({ state: { combat: sampleCombat() } });
    expect((await idle.run('update_combat', { action: 'concentrate', target: 'Mira Voss', spell: 'Bless', rounds: 5 })).content).toBe(
      'Mira Voss isn\'t concentrating on anything: start it with update_character concentration "Bless".',
    );
    expect(named(h.s().combat, 'Mira Voss')).not.toHaveProperty('concentrationCountdown');
  });

  it('refuses a spell that needs no Concentration for the hero too, before anything is written (srd:spell:shield, srd:spell:mage-armor)', async () => {
    const h = setup({ state: { combat: sampleCombat() } });
    const combat = h.s().combat;
    const character = h.s().character;
    // srd:spell:shield "Duration: 1 round": its +5 is the DM's to fold in, never a Concentration to record.
    expect(await h.run('update_combat', { action: 'concentrate', target: 'Mira Voss', spell: 'Shield', rounds: 1 })).toEqual({
      isError: true,
      content: "Shield doesn't require Concentration (Duration: 1 round). Fold its +5 into the dc of attacks on Mira Voss until the start of Mira Voss's next turn.",
    });
    // srd:spell:mage-armor "Duration: 8 hours": its AC the app records.
    expect(await h.run('update_combat', { action: 'concentrate', target: 'Mira Voss', spell: 'Mage Armor', rounds: 4800 })).toEqual({
      isError: true,
      content: 'Mage Armor doesn\'t require Concentration (Duration: 8 hours). Record its AC with update_character ac_spells_add ["Mage Armor"].',
    });
    expect(h.s().combat).toBe(combat);
    expect(h.s().character).toBe(character);
    expect(h.s().log).toHaveLength(0);
    // A spell the rules data doesn't know is never refused for it: the sheet's Shadow Lash gets its rounds.
    const lashing = sampleCharacter({ spellcasting: { ...sampleCharacter().spellcasting!, concentratingOn: 'Shadow Lash' } });
    const lash = setup({ character: lashing, state: { combat: sampleCombat() } });
    const counted = await lash.run('update_combat', { action: 'concentrate', target: 'Mira Voss', spell: 'Shadow Lash', rounds: 3 });
    expect(firstLine(counted.content)).toBe("Mira Voss's Shadow Lash: 3 rounds left.");
  });

  it("reads the name as given, never a namesake on the sheet (RD1, on SRD 5.2.1's own entries)", async () => {
    const sc = sampleCharacter().spellcasting!;
    // A Wizard's sheet with See Invisibility and not Invisibility (srd:spell:invisibility: "Concentration, up to 1 hour").
    const seeing = (concentratingOn: string | null) =>
      sampleCharacter({ spellcasting: { ...sc, spells: [...sc.spells, srdKnown('srd:spell:see-invisibility', 'See Invisibility', 2, 'Wizard')], concentratingOn } });
    const h = withSrdSpells({ character: seeing('Invisibility'), state: { combat: sampleCombat() } });
    const out = await h.run('update_combat', { action: 'concentrate', target: 'Mira Voss', spell: 'Invisibility', rounds: 300 });
    expect(firstLine(out.content)).toBe("Mira Voss's Invisibility: 300 rounds left.");
    expect(named(h.s().combat, 'Mira Voss')?.concentrationCountdown).toEqual({ spell: 'Invisibility', roundsLeft: 300 });
    // Not concentrating yet: the call that starts it, never See Invisibility's refusal.
    const idle = withSrdSpells({ character: seeing(null), state: { combat: sampleCombat() } });
    expect((await idle.run('update_combat', { action: 'concentrate', target: 'Mira Voss', spell: 'Invisibility', rounds: 300 })).content).toBe(
      'Mira Voss isn\'t concentrating on anything: start it with update_character concentration "Invisibility".',
    );
    // A Cleric's sheet with Shield of Faith and not Shield: Shield is refused, before anything is written (srd:spell:shield:
    // "Duration: 1 round").
    const cleric = (concentratingOn: string) =>
      sampleCharacter({
        spellcasting: {
          ...sc,
          ability: 'wis',
          spells: [srdKnown('srd:spell:shield-of-faith', 'Shield of Faith', 1, 'Cleric', true), srdKnown('srd:spell:bless', 'Bless', 1, 'Cleric', true)],
          concentratingOn,
        },
      });
    const blessing = withSrdSpells({ character: cleric('Bless'), state: { combat: sampleCombat() } });
    const combat = blessing.s().combat;
    const character = blessing.s().character;
    expect(await blessing.run('update_combat', { action: 'concentrate', target: 'Mira Voss', spell: 'Shield', rounds: 1 })).toEqual({
      isError: true,
      content: "Shield doesn't require Concentration (Duration: 1 round). Fold its +5 into the dc of attacks on Mira Voss until the start of Mira Voss's next turn.",
    });
    expect(blessing.s().combat).toBe(combat);
    expect(blessing.s().character).toBe(character);
    expect(blessing.s().log).toHaveLength(0);
    // "Faith" for a held Shield of Faith isn't refused (the rules data has no "Faith"; the sheet's spell needs Concentration)
    // and changes nothing (H9): concentrate gives rounds to the sheet's spell by its name.
    const faithful = withSrdSpells({ character: cleric('Shield of Faith'), state: { combat: sampleCombat() } });
    const before = faithful.s().combat;
    expect((await faithful.run('update_combat', { action: 'concentrate', target: 'Mira Voss', spell: 'Faith', rounds: 5 })).content).toBe(
      'Mira Voss is concentrating on Shield of Faith, not Faith: for the hero, concentrate only sets rounds (spell "Shield of Faith" with rounds); update_character concentration starts or ends the hero\'s Concentration.',
    );
    expect(faithful.s().combat).toBe(before);
  });
});

describe('update_combat damage: the Constitution save the app rolls (srd:rule:concentration, Damage)', () => {
  it("rolls the stat block's save against DC 10 or half the damage, after the damage line, behind the screen for hidden numbers", async () => {
    fakeDice.queue(13);
    const h = setup({ state: { combat: fanaticFight(holding('Hold Person', 3)) } });
    const out = await h.run('update_combat', { action: 'damage', target: 'Cultist Fanatic', amount: 7 });
    expect(out.content).toContain('Cultist Fanatic: HP 37/44\n');
    expect(out.content).toContain('\nConcentration: Constitution save 14 (1d20+1) vs DC 10 — Cultist Fanatic keeps Hold Person.\n');
    expect(fanaticOf(h)?.concentration).toEqual({ spell: 'Hold Person', roundsLeft: 3 });
    const [damage, save] = h.s().log;
    expect(damage).toMatchObject({ kind: 'tool', summary: 'Cultist Fanatic takes 7 damage (scratched)' });
    // The card never names the spell, and an enemy's hidden numbers keep it secret.
    expect(save).toMatchObject({ kind: 'roll', actor: 'dm', purpose: "Cultist Fanatic's Constitution save to keep concentration", secret: true, roll: { total: 14, dc: 10 } });
  });

  it('ends the spell on a failure, with the rounds that were left and what it held', async () => {
    fakeDice.queue(4);
    const h = setup({ character: paralyzedMira(), state: { combat: fanaticFight(holding('Hold Person', 3)) } });
    // 30 damage: DC 15, half the damage taken.
    const out = await h.run('update_combat', { action: 'damage', target: 'Cultist Fanatic', amount: 30 });
    expect(out.content).toContain(
      [
        "Concentration: Constitution save 5 (1d20+1) vs DC 15 — fails: Cultist Fanatic's Hold Person ends (3 rounds were left).",
        'Mira Voss is Paralyzed (source: Hold Person): if the spell caused it, remove it with update_character conditions_remove.',
      ].join('\n'),
    );
    expect(fanaticOf(h)).not.toHaveProperty('concentration');
    expect(rollLines(h.s().log)).toHaveLength(1);
  });

  it('lets a creature with Legendary Resistance decide before anything ends (srd:monster:mummy-lord)', async () => {
    fakeDice.queue(4);
    const lord = { name: 'Mummy Lord', statBlockName: 'Mummy Lord', statBlockId: 'srd:monster:mummy-lord', hp: { max: 187, current: 187, temp: 0 }, ...holding('Insect Plague', 83) };
    const h = setup({ state: { combat: fanaticFight(lord) } });
    const out = await h.run('update_combat', { action: 'damage', target: 'Mummy Lord', amount: 24 });
    expect(out.content).toContain(
      'Concentration: Constitution save 7 (1d20+3) vs DC 12 — fails. Mummy Lord has Legendary Resistance: if it uses one it keeps Insect Plague (nothing to do); otherwise update_combat concentrate target "Mummy Lord" spell null.',
    );
    expect(named(h.s().combat, 'Mummy Lord')?.concentration).toEqual({ spell: 'Insect Plague', roundsLeft: 83 });
  });

  it('leaves the roll to the DM when the stat block gives no saves (an imported, reviewed stat block)', async () => {
    const witch = { name: 'Bog Witch', statBlockName: 'Bog Witch', statBlockId: 'lib:lib-phb:7', ...holding('Hold Person', 5) };
    const h = setup({ state: { combat: fanaticFight(witch) } });
    const out = await h.run('update_combat', { action: 'damage', target: 'Bog Witch', amount: 7 });
    // D10: the purpose the app's own card uses, which never names the spell (srd:rule:casting-spells-effects-targets).
    expect(out.content).toContain(
      'Concentration check: Bog Witch must make a DC 10 Constitution saving throw to keep Hold Person — roll it with roll_dice (purpose "Bog Witch\'s Constitution save to keep concentration", secret: true); on a failure call update_combat concentrate target "Bog Witch" spell null.',
    );
    expect(rollLines(h.s().log)).toHaveLength(0);
    // An ally whose numbers show (and no stat block): no secret, and still no spell in the purpose.
    const combat = sampleCombat();
    combat.combatants[3] = { ...combat.combatants[3], concentration: { spell: 'Bless', roundsLeft: 4 } };
    const ally = setup({ state: { combat } });
    expect((await ally.run('update_combat', { action: 'damage', target: 'Old Tam', amount: 3 })).content).toContain(
      'Concentration check: Old Tam must make a DC 10 Constitution saving throw to keep Bless — roll it with roll_dice (purpose "Old Tam\'s Constitution save to keep concentration"); on a failure call update_combat concentrate target "Old Tam" spell null.',
    );
  });

  it("shows an ally's save card when its numbers show, without the spell", async () => {
    fakeDice.queue(15);
    const combat = sampleCombat();
    combat.combatants[3] = { ...combat.combatants[3], statBlockId: 'srd:monster:cultist-fanatic', concentration: { spell: 'Shield of Faith', roundsLeft: 40 } };
    const h = setup({ state: { combat } });
    await h.run('update_combat', { action: 'damage', target: 'Old Tam', amount: 4 });
    expect(rollLines(h.s().log)[0]).toMatchObject({ purpose: "Old Tam's Constitution save to keep concentration", secret: false });
    expect(JSON.stringify(h.s().log)).not.toContain('Shield of Faith');
  });

  it("logs the save as a save, so a creature named like an attack never gets an attack's card (srd:rule:concentration: a Constitution saving throw)", async () => {
    fakeDice.queue(15);
    const h = setup({ state: { combat: fanaticFight({ name: 'Attack Dog', hideHp: false, ...holding('Hold Person', 3) }) } });
    await h.run('update_combat', { action: 'damage', target: 'Attack Dog', amount: 4 });
    // The roll card reads rollType before guessing from the purpose (an "attack" in it would read as an attack roll).
    expect(rollLines(h.s().log)).toEqual([
      expect.objectContaining({ actor: 'dm', purpose: "Attack Dog's Constitution save to keep concentration", rollType: 'save', secret: false, roll: expect.objectContaining({ dc: 10 }) }),
    ]);
  });

  it('ends it at 0 HP without a roll (srd:rule:damage-and-healing-dropping-to-0-hit-points-instant-death)', async () => {
    fakeDice.queue(20);
    const h = setup({ character: paralyzedMira(), state: { combat: fanaticFight(holding('Hold Person', 3)) } });
    const out = await h.run('update_combat', { action: 'damage', target: 'Cultist Fanatic', amount: 50 });
    expect(out.content).toContain(
      "Cultist Fanatic's Hold Person ends: it drops to 0 HP.\nMira Voss is Paralyzed (source: Hold Person): if the spell caused it, remove it with update_character conditions_remove.",
    );
    expect(fanaticOf(h)).toMatchObject({ defeated: true });
    expect(fanaticOf(h)).not.toHaveProperty('concentration');
    expect(fakeDice.remaining()).toBe(1);
    expect(rollLines(h.s().log)).toHaveLength(0);
  });

  it("rolls nothing for 0 damage or a creature that isn't concentrating", async () => {
    const h = setup({ state: { combat: fanaticFight(holding('Hold Person', 3)) } });
    expect((await h.run('update_combat', { action: 'damage', target: 'Cultist Fanatic', amount: 0 })).content).not.toContain('Concentration');
    expect((await h.run('update_combat', { action: 'damage', target: 'Bandit 2', amount: 3 })).content).not.toContain('Concentration');
    expect(rollLines(h.s().log)).toHaveLength(0);
  });

  it("keeps a hidden creature's damage, save and spell out of the player's view (D41)", async () => {
    fakeDice.queue(2);
    const h = setup({ state: { combat: fanaticFight({ ...holding('Hold Person', 3), hidden: true }) } });
    await h.run('update_combat', { action: 'damage', target: 'Cultist Fanatic', amount: 7 });
    expect(toolLines(h.s().log)).toHaveLength(0);
    expect(rollLines(h.s().log)).toMatchObject([{ secret: true }]);
  });
});

describe('update_combat conditions, defeat and remove on a concentrating creature', () => {
  it('ends it on an Incapacitating condition, never naming back the condition the call added (srd:condition:incapacitated)', async () => {
    const h = setup({ character: paralyzedMira(), state: { combat: fanaticFight(holding('Hold Person', 5)) } });
    // An ally's Hold Person paralyzes the Cultist Fanatic that holds Mira Voss with its own.
    const out = await h.run('update_combat', { action: 'conditions', target: 'Cultist Fanatic', conditions_add: [{ condition: 'Paralyzed', source: 'Hold Person' }] });
    expect(out.content).toContain(
      [
        'Cultist Fanatic: +paralyzed',
        "Cultist Fanatic's Hold Person ends: it is Paralyzed.",
        'Mira Voss is Paralyzed (source: Hold Person): if the spell caused it, remove it with update_character conditions_remove.',
      ].join('\n'),
    );
    expect(out.content).not.toContain('Cultist Fanatic is Paralyzed');
    expect(fanaticOf(h)).not.toHaveProperty('concentration');
    expect(toolLines(h.s().log).map((l) => l.summary)).toEqual(['Cultist Fanatic: +paralyzed']);
  });

  it('keeps the spell on defeat but stops counting it: a creature that fled can still concentrate', async () => {
    const h = setup({ state: { combat: fanaticFight(holding('Hold Person', 5)) } });
    const out = await h.run('update_combat', { action: 'defeat', target: 'Cultist Fanatic' });
    expect(out.content).toContain(
      'Cultist Fanatic is out of the fight\nCultist Fanatic was concentrating on Hold Person: if it fell, end it with update_combat concentrate target "Cultist Fanatic" spell null; if it fled still concentrating, the spell goes on (the app no longer counts it).',
    );
    expect(fanaticOf(h)?.concentration).toEqual({ spell: 'Hold Person' });
    expect(JSON.stringify(h.s().log)).not.toContain('Hold Person');
  });

  it('names the conditions its spell may hold when it leaves the fight', async () => {
    const h = setup({ character: paralyzedMira(), state: { combat: fanaticFight(holding('Hold Person', 7)) } });
    const out = await h.run('update_combat', { action: 'remove', target: 'Cultist Fanatic' });
    expect(out.content).toContain(
      [
        'Cultist Fanatic leaves the fight',
        'Cultist Fanatic was concentrating on Hold Person (7 rounds left): the app no longer tracks it.',
        'Mira Voss is Paralyzed (source: Hold Person): remove it when that spell ends.',
      ].join('\n'),
    );
  });

  it("names the hero's Shield of Faith record its caster's spell may be, when the caster leaves the fight or the fight ends (srd:spell:shield-of-faith)", async () => {
    // srd:spell:shield-of-faith: "granting it a +2 bonus to AC for the duration" (Concentration, up to 10 minutes).
    const recorded = () => sampleCharacter({ armorClass: 14, acFormula: '10 + DEX 2 + Shield of Faith 2', acSpells: ['Shield of Faith'] });
    const tamHolds = (): CombatState => {
      const combat = sampleCombat();
      combat.combatants[3] = { ...combat.combatants[3], concentration: { spell: 'Shield of Faith', roundsLeft: 90 } };
      return combat;
    };
    const line = 'Mira Voss\'s Shield of Faith +2: if it is Old Tam\'s, end it with update_character ac_spells_end ["Shield of Faith"] when that spell ends.';
    const h = setup({ character: recorded(), state: { combat: tamHolds() } });
    const removed = await h.run('update_combat', { action: 'remove', target: 'Old Tam' });
    expect(removed.content).toContain(['Old Tam was concentrating on Shield of Faith (about 9 minutes left): the app no longer tracks it.', line].join('\n'));
    const ends = setup({ character: recorded(), state: { combat: tamHolds() } });
    const ended = await ends.run('end_combat', { summary: 'The bandits fled.' });
    expect(ended.content).toContain(['Still concentrating as the fight ends: Old Tam (Shield of Faith) — the app no longer tracks it.', line].join('\n'));
    // Named, never ended: the record stays until the DM ends it.
    expect(ends.s().character).toMatchObject({ armorClass: 14, acSpells: ['Shield of Faith'] });
    // The hero concentrating on Shield of Faith: the app takes the record to be the hero's own casting.
    const own = setup({
      character: sampleCharacter({ ...recorded(), spellcasting: { ...sampleCharacter().spellcasting!, concentratingOn: 'Shield of Faith' } }),
      state: { combat: tamHolds() },
    });
    expect((await own.run('update_combat', { action: 'remove', target: 'Old Tam' })).content).not.toContain("Mira Voss's Shield of Faith +2");
  });
});

describe('the countdowns at a turn start (srd:rule:casting-spells-duration)', () => {
  it("ends an NPC's spell as its turn starts with no rounds left, and the player's log never names it", async () => {
    const h = setup({ character: paralyzedMira(), state: { combat: fanaticFight(holding('Hold Person', 2)) } });
    const first = await h.run('update_combat', { action: 'next_turn' }); // Bandit 1 → the Cultist Fanatic
    expect(firstLine(first.content)).toBe("Round 2: Cultist Fanatic's turn.");
    expect(fanaticOf(h)?.concentration).toEqual({ spell: 'Hold Person', roundsLeft: 1 });
    for (let i = 0; i < 4; i++) await h.run('update_combat', { action: 'next_turn' }); // … round 3: Mira Voss, Bandit 1
    const out = await h.run('update_combat', { action: 'next_turn' }); // round 3: the Cultist Fanatic again
    expect(out.content).toContain(
      [
        "Round 3: Cultist Fanatic's turn.",
        "Cultist Fanatic's Hold Person ends: its duration is up.",
        'Mira Voss is Paralyzed (source: Hold Person): if the spell caused it, remove it with update_character conditions_remove.',
      ].join('\n'),
    );
    expect(fanaticOf(h)).not.toHaveProperty('concentration');
    expect(JSON.stringify(h.s().log)).not.toContain('Hold Person');
  });

  it("removing the creature whose turn it is starts the next one's turn, and counts it", async () => {
    const webbed = (s: CombatState): CombatState => ({
      ...s,
      turnIndex: 2,
      combatants: s.combatants.map((c) => (c.name === 'Bandit 2' ? { ...c, concentration: { spell: 'Web', roundsLeft: 1 } } : c)),
    });
    const h = setup({ state: { combat: fanaticFight(holding('Bless', 4), webbed) } });
    const out = await h.run('update_combat', { action: 'remove', target: 'Cultist Fanatic' });
    expect(out.content).toContain("Bandit 2's Web ends: its duration is up.");
    expect(named(h.s().combat, 'Bandit 2')).not.toHaveProperty('concentration');
  });

  it("starts the hero's countdown at the hero's turn start, and ends the spell when it runs out, sheet first", async () => {
    // Bless with no countdown yet at a turn start after round 1 (round 3): cast on an earlier turn, so the count starts
    // at rounds − 1 (a spell already running at start_combat starts at the full count in round 1).
    const blessing = sampleCharacter({ spellcasting: { ...sampleCharacter().spellcasting!, concentratingOn: 'Bless' } });
    const h = setup({ character: blessing, state: { combat: { ...sampleCombat(), turnIndex: 3 } } });
    const out = await h.run('update_combat', { action: 'next_turn' }); // Old Tam → Mira Voss, round 3
    expect(named(h.s().combat, 'Mira Voss')?.concentrationCountdown).toEqual({ spell: 'Bless', roundsLeft: 9 });
    expect(out.content).toContain('Mira Voss · AC 12 · Bless: 9 rounds left');

    const counted = sampleCombat().combatants.map((c) => (c.isPlayer ? { ...c, concentrationCountdown: { spell: 'Bless', roundsLeft: 1 } } : c));
    const ending = setup({ character: blessing, state: { combat: { ...sampleCombat(), turnIndex: 3, combatants: counted } } });
    const ended = await ending.run('update_combat', { action: 'next_turn' });
    expect(ended.content).toContain("Round 3: Mira Voss's turn.\nMira Voss's Bless ends: its duration is up.");
    expect(ending.s().character?.spellcasting?.concentratingOn).toBeNull();
    expect(named(ending.s().combat, 'Mira Voss')).not.toHaveProperty('concentrationCountdown');
    // The player is told, after the turn line.
    expect(toolLines(ending.s().log).map((l) => l.summary)).toEqual(["Round 3: Mira Voss's turn.", 'Your concentration on Bless ends: its duration is up']);
  });

  it("takes Shield of Faith's +2 off with the hero's spell, and says so in the player's log", async () => {
    // srd:spell:shield-of-faith: "a +2 bonus to AC for the duration" (Concentration, up to 10 minutes).
    const faithful: Character = sampleCharacter({
      armorClass: 14,
      acFormula: '10 + DEX 2 + Shield of Faith 2',
      acSpells: ['Shield of Faith'],
      spellcasting: { ...sampleCharacter().spellcasting!, concentratingOn: 'Shield of Faith' },
    });
    const counted = sampleCombat().combatants.map((c) => (c.isPlayer ? { ...c, concentrationCountdown: { spell: 'Shield of Faith', roundsLeft: 1 } } : c));
    const h = setup({ character: faithful, state: { combat: { ...sampleCombat(), turnIndex: 3, combatants: counted } } });
    const out = await h.run('update_combat', { action: 'next_turn' });
    expect(out.content).toContain("Mira Voss's Shield of Faith ends: its duration is up.\nShield of Faith ends: AC 14 → 12");
    expect(h.s().character).toMatchObject({ armorClass: 12 });
    expect(h.s().character).not.toHaveProperty('acSpells');
    expect(toolLines(h.s().log).at(-1)?.summary).toBe('Your concentration on Shield of Faith ends: its duration is up — AC 14 → 12');
  });
});

describe("what the app names with a spell's end (§3.5), never removing it", () => {
  /** The warehouse fight with a Cultist Fanatic (c-7) on G4 and a Web of its own on G7:J10. */
  function webFight(fanatic: Partial<Combatant>): CombatState {
    const base = sampleMappedCombat();
    const map = base.map as NonNullable<CombatState['map']>;
    const web: MapEffect = {
      id: 'e20',
      label: 'Web',
      spec: { shape: 'squares', rects: [{ x0: 6, y0: 6, x1: 9, y1: 9 }], fromId: 'c-7' },
      rects: [{ x0: 6, y0: 6, x1: 9, y1: 9 }],
      terrain: ['difficult', 'obscured'],
      duration: 'lasting',
      round: 2,
      turnOfId: 'c-7',
    };
    const cultist: Combatant = { ...fanaticFight().combatants[2], position: { x: 6, y: 3 }, ...fanatic };
    return { ...base, combatants: [...base.combatants, cultist], map: { ...map, effects: [web] } };
  }

  it("names a lasting area that may be the spell's with the exact call, later for a hidden caster", async () => {
    const h = setup({ state: { combat: webFight(holding('Web', 300)) } });
    const out = await h.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: null });
    expect(out.content).toContain('Cultist Fanatic stops concentrating on Web.\nStill on the map: Web (G7:J10) — if it was this spell\'s, end it with update_map effects_end ["Web"].');
    expect(h.s().combat?.map?.effects).toHaveLength(1);
    const hidden = setup({ state: { combat: webFight({ ...holding('Web', 300), hidden: true }) } });
    const quiet = await hidden.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: null });
    expect(quiet.content).toContain(
      'Still on the map: Web (G7:J10) — if it was this spell\'s, end it with update_map effects_end ["Web"] once the player can see it go (not during a hidden creature\'s turn).',
    );
  });

  it("names the hero's Shield of Faith when an NPC's ends, and an AC set by hand for an NPC's spell", async () => {
    const recorded = sampleCharacter({ armorClass: 14, acFormula: '10 + DEX 2 + Shield of Faith 2', acSpells: ['Shield of Faith'] });
    const h = setup({ character: recorded, state: { combat: fanaticFight(holding('Shield of Faith', 30)) } });
    expect((await h.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: null })).content).toContain(
      'Mira Voss\'s Shield of Faith +2: if it was Cultist Fanatic\'s, end it with update_character ac_spells_end ["Shield of Faith"].',
    );
    // A Stone Golem's Slow set by hand on the hero (srd:spell:slow: "a -2 penalty to AC").
    const slowed = sampleCharacter({ armorClass: 10, acFormula: 'set by the DM: Slow' });
    const golem = setup({ character: slowed, state: { combat: fanaticFight({ name: 'Stone Golem', ...holding('Slow', 6) }) } });
    expect((await golem.run('update_combat', { action: 'concentrate', target: 'Stone Golem', spell: null })).content).toContain(
      "Mira Voss's AC 10 was set by hand for Slow: if it counted Slow, set armor_class back to 12 (armor and abilities).",
    );
    // Nothing matches: nothing is printed.
    const plain = setup({ state: { combat: fanaticFight(holding('Bless', 3)) } });
    const out = await plain.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: null });
    expect(out.content.split('\n').slice(0, 2)).toEqual(['Cultist Fanatic stops concentrating on Bless.', '']);
  });

  it("says what else a shared label's call ends: an NPC's Spirit Guardians beside the hero's (srd:rule:concentration)", async () => {
    // srd:rule:concentration: "If the effect's creator loses Concentration, the effect ends": that creator's effect only.
    const base = sampleMappedCombat();
    const zealot: Combatant = { ...fanaticFight().combatants[2], id: 'z-1', name: 'Zealot', position: { x: 11, y: 3 }, ...holding('Spirit Guardians', 50) };
    const guarded = sampleCharacter({ spellcasting: { ...sampleCharacter().spellcasting!, concentratingOn: 'Spirit Guardians' } });
    const h = setup({ character: guarded, state: { combat: { ...base, combatants: [...base.combatants, zealot] } } });
    for (const from of ['Mira Voss', 'Zealot']) {
      expect((await h.run('resolve_area', { label: 'Spirit Guardians', shape: 'emanation', size_ft: 15, from, lasting: true })).isError).toBeUndefined();
    }
    const out = await h.run('update_combat', { action: 'concentrate', target: 'Zealot', spell: null });
    // Only the Zealot's emanation is named, and the line says its call ends the hero's too. The hero's spell goes on, so
    // its area is only placed again (lasting), with no saves rolled for it (D5: resolve_area's own result asks for saves).
    expect(out.content).toContain(
      'Still on the map: Spirit Guardians (15-ft Emanation around Zealot) — if it was this spell\'s, end it with update_map effects_end ["Spirit Guardians"] — effects_end ends every area named "Spirit Guardians" (2 on the map): place again with resolve_area (lasting) any that isn\'t this spell\'s, rolling no saves for it.',
    );
    expect(h.s().combat?.map?.effects).toHaveLength(2);
    // Followed: both go, and the hero's is placed again as a lasting area, around the hero as before.
    expect((await h.run('update_map', { effects_end: ['Spirit Guardians'] })).isError).toBeUndefined();
    expect((await h.run('resolve_area', { label: 'Spirit Guardians', shape: 'emanation', size_ft: 15, from: 'Mira Voss', lasting: true })).isError).toBeUndefined();
    const left = h.s().combat?.map?.effects ?? [];
    expect(left.map((e) => [e.label, e.duration, e.spec.fromId])).toEqual([['Spirit Guardians', 'lasting', named(h.s().combat, 'Mira Voss')?.id]]);
  });

  it('names a repeated label once, so the named call is never refused, and says it ends every area of that name (srd:spell:darkness)', async () => {
    // Two Drow each concentrating on Darkness placed at a point (no caster on either area): either may be the spell's.
    const base = sampleMappedCombat();
    const drow = (id: string, name: string, x: number, y: number): Combatant => ({ ...fanaticFight().combatants[2], id, name, position: { x, y }, ...holding('Darkness', 90) });
    const h = setup({ state: { combat: { ...base, combatants: [...base.combatants, drow('d-1', 'Drow 1', 11, 1), drow('d-2', 'Drow 2', 3, 10)] } } });
    for (const at of ['C3', 'M10']) {
      expect((await h.run('resolve_area', { label: 'Darkness', shape: 'sphere', size_ft: 15, at, lasting: true })).isError).toBeUndefined();
    }
    const out = await h.run('update_combat', { action: 'concentrate', target: 'Drow 1', spell: null });
    const line = out.content.split('\n').find((l) => l.startsWith('Still on the map: Darkness (')) ?? '';
    expect(line).toMatch(/\) · Darkness \(/);
    expect(line).toContain(
      ' — if they were this spell\'s, end them with update_map effects_end ["Darkness"] — effects_end ends every area named "Darkness" (2 on the map): place again with resolve_area (lasting) any that isn\'t this spell\'s, rolling no saves for it.',
    );
    // The named call does what the line says: it isn't refused, and both areas go.
    const call = JSON.parse(/effects_end (\[[^\]]*\])/.exec(line)?.[1] ?? 'null') as string[];
    expect(call).toEqual(['Darkness']);
    const ended = await h.run('update_map', { effects_end: call });
    expect(ended.isError).toBeUndefined();
    expect(h.s().combat?.map?.effects).toEqual([]);
  });

  it("names an NPC's Shield of Faith once, never as an AC set by hand, when the hero holds its record (srd:spell:shield-of-faith)", async () => {
    // An older save's hand-set AC naming Shield of Faith, kept and counted when the record was added (its part appended).
    const kept = sampleCharacter({ armorClass: 20, acFormula: 'set by the DM: Shield of Faith and Haste + Shield of Faith 2', acSpells: ['Shield of Faith'] });
    const h = setup({ character: kept, state: { combat: fanaticFight(holding('Shield of Faith', 30)) } });
    const out = await h.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: null });
    expect(out.content).toContain('Mira Voss\'s Shield of Faith +2: if it was Cultist Fanatic\'s, end it with update_character ac_spells_end ["Shield of Faith"].');
    expect(out.content).not.toContain('was set by hand for Shield of Faith');
  });
});

describe('NPC Concentration never reaches the player (srd:rule:casting-spells-effects-targets)', () => {
  it("keeps a distinctive spell out of the player's log through a whole fight", async () => {
    const ward = "Zorblax's Murmuring Ward";
    fakeDice.queue(2);
    const h = setup({ character: paralyzedMira(ward), state: { combat: fanaticFight() } });
    await h.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: ward, rounds: 2 });
    await h.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: ward, rounds: 2 });
    expect(h.s().log).toHaveLength(0);
    const failed = await h.run('update_combat', { action: 'damage', target: 'Cultist Fanatic', amount: 3 }); // 2 + 1 < 10
    expect(failed.content).toContain(`fails: Cultist Fanatic's ${ward} ends (2 rounds were left).`);
    await h.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: ward, rounds: 1 });
    const expired = await h.run('update_combat', { action: 'next_turn' }); // its turn: the count runs out
    expect(expired.content).toContain(`Cultist Fanatic's ${ward} ends: its duration is up.`);
    await h.run('update_combat', { action: 'concentrate', target: 'Cultist Fanatic', spell: ward });
    const stunned = await h.run('update_combat', { action: 'conditions', target: 'Cultist Fanatic', conditions_add: [{ condition: 'Stunned', source: 'Stunning Strike' }] });
    expect(stunned.content).toContain(`Cultist Fanatic's ${ward} ends: it is Stunned.`);
    await h.run('update_combat', { action: 'concentrate', target: 'Bandit 2', spell: ward, rounds: 4 });
    await h.run('update_combat', { action: 'defeat', target: 'Bandit 2' });
    const ended = await h.run('end_combat', { summary: 'The cultist fled.' });
    expect(ended.content).toContain(`Still concentrating as the fight ends: Bandit 2 (${ward}) — the app no longer tracks it.`);
    expect(toolLines(h.s().log).map((l) => l.summary)).toEqual([
      'Cultist Fanatic takes 3 damage (scratched)',
      "Round 2: Cultist Fanatic's turn.",
      'Cultist Fanatic: +stunned',
      'Bandit 2 is out of the fight',
      'Combat ended: The cultist fled.',
    ]);
    expect(rollLines(h.s().log)).toMatchObject([{ purpose: "Cultist Fanatic's Constitution save to keep concentration", secret: true }]);
    expect(JSON.stringify(h.s().log)).not.toContain('Murmuring');
  });
});

describe('start_combat and end_combat with Concentration running (SPEC §3.4)', () => {
  const concentrating = (spell: string) => sampleCharacter({ spellcasting: { ...sampleCharacter().spellcasting!, concentratingOn: spell } });
  const withCountdown = (spell: string, roundsLeft: number): CombatState => ({
    ...sampleCombat(),
    combatants: sampleCombat().combatants.map((c) => (c.isPlayer ? { ...c, concentrationCountdown: { spell, roundsLeft } } : c)),
  });

  it('start_combat says how the app counts a spell already running', async () => {
    const h = setup({ character: concentrating('Bless') });
    const out = await h.run('start_combat', { combatants: [OLD_TAM] });
    expect(out.content).toContain(
      'Mira Voss is concentrating on Bless: the app counts its 1 minute from Mira Voss\'s first turn; if less is left, give rounds with update_combat concentrate target "Mira Voss" spell "Bless".',
    );
    const unknown = setup({ character: concentrating('Shadow Lash') });
    expect((await unknown.run('start_combat', { combatants: [OLD_TAM] })).content).toContain(
      'Mira Voss is concentrating on Shadow Lash: the app has no duration for it, so it isn\'t counted; give rounds with update_combat concentrate target "Mira Voss" spell "Shadow Lash" to count it.',
    );
    const idle = setup();
    expect((await idle.run('start_combat', { combatants: [OLD_TAM] })).content).not.toContain('concentrating');
  });

  it("names the hero by the sheet's name trimmed, or as The hero when it is blank (D7)", async () => {
    const padded = setup({ character: { ...concentrating('Bless'), name: '  Mira Voss  ' } });
    expect((await padded.run('start_combat', { combatants: [OLD_TAM] })).content).toContain(
      'Mira Voss is concentrating on Bless: the app counts its 1 minute from Mira Voss\'s first turn; if less is left, give rounds with update_combat concentrate target "Mira Voss" spell "Bless".',
    );
    const blank = setup({ character: { ...concentrating('Bless'), name: '   ' } });
    expect((await blank.run('start_combat', { combatants: [OLD_TAM] })).content).toContain("The hero is concentrating on Bless: the app counts its 1 minute from The hero's first turn");
  });

  it('names the end of a sheet Concentration on a spell that needs none, never a concentrate call it would refuse (RD3)', async () => {
    // An older save's Mage Armor (srd:spell:mage-armor: "Duration: 8 hours"), on SRD 5.2.1's own entry.
    const h = withSrdSpells({ character: concentrating('Mage Armor') });
    const out = await h.run('start_combat', { combatants: [OLD_TAM] });
    expect(out.content).toContain(
      'Mage Armor doesn\'t require Concentration (Duration: 8 hours). Record its AC with update_character ac_spells_add ["Mage Armor"]. End it with update_character concentration: null.',
    );
    expect(out.content).not.toContain('update_combat concentrate');
    // The call it names is accepted.
    expect((await h.run('update_character', { concentration: null })).isError).toBeUndefined();
    expect(h.s().character?.spellcasting?.concentratingOn).toBeNull();
    // A mis-flagged Shield (srd:spell:shield: "Duration: 1 round"): its refusal names the hero, "The hero" when blank (D7).
    const blank = withSrdSpells({ character: { ...concentrating('Shield'), name: '   ' } });
    expect((await blank.run('start_combat', { combatants: [OLD_TAM] })).content).toContain(
      "Shield doesn't require Concentration (Duration: 1 round). Fold its +5 into the dc of attacks on The hero until the start of The hero's next turn. End it with update_character concentration: null.",
    );
  });

  it("ends the hero's spell with a minute or less left: it runs out after the fight", async () => {
    const h = setup({ character: concentrating('Bless'), state: { combat: withCountdown('Bless', 4) } });
    const out = await h.run('end_combat', { summary: 'The bandits fled.' });
    expect(out.content).toBe("Combat ended: The bandits fled.\nMira Voss's Bless runs out after the fight (4 rounds were left).");
    expect(h.s().character?.spellcasting?.concentratingOn).toBeNull();
    expect(toolLines(h.s().log).map((l) => l.summary)).toEqual(['Combat ended: The bandits fled.', 'Your concentration on Bless runs out after the fight']);
    // No count yet, but a spell of a minute: it ends too.
    const uncounted = setup({ character: concentrating('Bless'), state: { combat: sampleCombat() } });
    expect((await uncounted.run('end_combat', { summary: 'Done.' })).content).toContain("Mira Voss's Bless runs out after the fight.");
  });

  it('names a longer one with the call that ends it', async () => {
    const h = setup({ character: concentrating('Web'), state: { combat: withCountdown('Web', 90) } });
    const out = await h.run('end_combat', { summary: 'The bandits fled.' });
    expect(out.content).toContain('Mira Voss is still concentrating on Web (about 9 minutes left): end it with update_character concentration: null when it runs out.');
    expect(h.s().character?.spellcasting?.concentratingOn).toBe('Web');
    expect(toolLines(h.s().log)).toHaveLength(1);
    const uncounted = setup({ character: concentrating('Web'), state: { combat: sampleCombat() } });
    expect((await uncounted.run('end_combat', { summary: 'Done.' })).content).toContain(
      'Mira Voss is still concentrating on Web (at most about 60 minutes left): end it with update_character concentration: null when it runs out.',
    );
  });

  it('names NPCs still concentrating, and the conditions their spells may hold on the hero', async () => {
    const h = setup({ character: paralyzedMira(), state: { combat: fanaticFight(holding('Hold Person', 6)) } });
    const out = await h.run('end_combat', { summary: 'Mira broke free.' });
    expect(out.content).toContain(
      [
        'Still concentrating as the fight ends: Cultist Fanatic (Hold Person) — the app no longer tracks it.',
        'Mira Voss is Paralyzed (source: Hold Person): remove it when that spell ends.',
      ].join('\n'),
    );
    expect(JSON.stringify(h.s().log)).not.toContain('Hold Person');
  });
});
