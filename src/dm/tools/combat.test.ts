import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/engine', () => import('../testing/fakeEngine'));
vi.mock('@/data', () => import('../testing/fakeData'));
vi.mock('@/state/gameStore', () => import('../testing/fakeGameStoreModule'));

import { createRulesIndex } from '@/data/search';
import { materializeEntries } from '@/data/structured/materialize';
import { sampleCombat, sampleMappedCombat, sampleStopCombat } from '@/test/fixtures';
import { gloamwoodEntries, gloamwoodEntryId, gloamwoodRecords, gloamwoodSource, GLOAMWOOD_TITLE } from '@/test/structuredFixtures';
import type { CombatState, CompendiumEntry, LogEntry, MapEffect, ToolLogEntry } from '@/types';
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
