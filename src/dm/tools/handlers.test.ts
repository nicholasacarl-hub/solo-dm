import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/engine', () => import('../testing/fakeEngine'));
vi.mock('@/data', () => import('../testing/fakeData'));
vi.mock('@/state/gameStore', () => import('../testing/fakeGameStoreModule'));

import { sampleCombat } from '@/test/fixtures';
import type { LogEntry, ToolLogEntry } from '@/types';
import type { CompendiumEntry } from '@/types';
import { deps, resetDmDeps, setDmDeps } from '../deps';
import { createFakeRulesIndex, SAMPLE_RULES } from '../testing/fakeData';
import { fakeDice } from '../testing/fakeEngine';
import { autoRespond } from '../testing/fakeStore';
import { dialogRoll, setupHarness, type Harness, type HarnessOptions } from '../testing/harness';
import type { ToolContext } from './context';
import { DM_TOOLS, TOOL_ORDER } from './definitions';
import { runTool } from './handlers';
import { RULES_HIT_LIMIT, RULES_OUTPUT_LIMIT } from './rules';

beforeEach(() => fakeDice.reset());
afterEach(() => resetDmDeps());

function setup(opts: HarnessOptions = {}): Harness & { run: (name: string, input: unknown) => ReturnType<typeof runTool>; ctx: ToolContext } {
  const h = setupHarness({ withSession: true, campaignSettings: { playerRollMode: 'auto', ...opts.campaignSettings }, ...opts });
  const ctx: ToolContext = { deps: deps(), signal: new AbortController().signal, status: vi.fn() };
  return { ...h, ctx, run: (name, input) => runTool(name, input, ctx) };
}

const toolLines = (log: LogEntry[]) => log.filter((e): e is ToolLogEntry => e.kind === 'tool');

describe('tool definitions', () => {
  it('sends every tool in a fixed order with eager input streaming and a clean object schema', () => {
    expect(DM_TOOLS.map((t) => t.name)).toEqual(TOOL_ORDER);
    for (const tool of DM_TOOLS) {
      expect(tool.eager_input_streaming).toBe(true);
      expect(tool.input_schema.type).toBe('object');
      expect(tool.input_schema).not.toHaveProperty('$schema');
      expect(tool.description?.length).toBeGreaterThan(80);
    }
    expect(JSON.stringify(DM_TOOLS)).toBe(JSON.stringify(DM_TOOLS.map((t) => ({ ...t }))));
  });
});

describe('roll_dice', () => {
  it('rolls a d20 test with advantage against a DC and logs a secret DM roll', async () => {
    fakeDice.queue(5, 17);
    const h = setup();
    const out = await h.run('roll_dice', { expression: '1d20+3', purpose: 'Guard Perception', dc: 15, advantage: 'advantage', secret: true });
    expect(out.isError).toBeUndefined();
    expect(out.content).toMatch(/Guard Perception: 20 .*DC 15 → success/);
    expect(h.s().log.at(-1)).toMatchObject({ kind: 'roll', actor: 'dm', secret: true, roll: { total: 20, success: true, natural: 17 } });
    expect(h.s().log.at(-1)).not.toHaveProperty('rollType');
  });

  it('tags attack rolls so the log can say "vs AC" and Hit/Miss', async () => {
    fakeDice.queue(12);
    const h = setup();
    await h.run('roll_dice', { expression: '1d20+4', purpose: 'Stranger stabs at you', dc: 17, is_attack: true });
    expect(h.s().log.at(-1)).toMatchObject({ kind: 'roll', rollType: 'attack' });
  });

  it('applies the natural-20 rule to attack rolls', async () => {
    fakeDice.queue(20);
    const h = setup();
    const out = await h.run('roll_dice', { expression: '1d20+1', purpose: 'Rat bites', dc: 25, is_attack: true });
    expect(out.content).toMatch(/CRITICAL HIT/);
    expect(h.s().log.at(-1)).toMatchObject({ roll: { success: true, isCritical: true } });
  });

  it('rejects an invalid expression without logging a roll', async () => {
    const h = setup();
    const out = await h.run('roll_dice', { expression: '2q6', purpose: 'Oops' });
    expect(out).toMatchObject({ isError: true });
    expect(h.s().log).toHaveLength(0);
  });
});

describe('request_player_roll', () => {
  it('rolls immediately in auto mode with the sheet modifier', async () => {
    fakeDice.queue(12);
    const h = setup();
    const out = await h.run('request_player_roll', { roll_type: 'skill', skill: 'arcana', dc: 15, reason: 'Recognize the sigil' });
    // Mira: INT 17 (+3) + proficiency 2 = +5 → 17.
    expect(out.content).toMatch(/Arcana check \(INT\): 17 .*DC 15 → success/);
    expect(h.s().interaction).toBeNull();
    expect(h.s().log.at(-1)).toMatchObject({ kind: 'roll', actor: 'player', purpose: 'Arcana check (INT) — Recognize the sigil' });
  });

  it('applies death saving throws to the sheet', async () => {
    fakeDice.queue(4);
    const h = setup();
    await h.s().updateCharacter((c) => ({ ...c, hp: { ...c.hp, current: 0 } }));
    const out = await h.run('request_player_roll', { roll_type: 'death-save', reason: 'Cling to life' });
    expect(out.content).toMatch(/Outcome: failure/);
    expect(h.s().character?.deathSaves.failures).toBe(1);
  });

  it('refuses a death save while the hero has HP', async () => {
    const h = setup();
    expect(await h.run('request_player_roll', { roll_type: 'death-save', reason: 'x' })).toMatchObject({ isError: true });
  });

  it('checks attack names against the sheet and rolls damage from the attack', async () => {
    const h = setup();
    const missing = await h.run('request_player_roll', { roll_type: 'attack', attack_name: 'Greataxe', dc: 12, reason: 'Hit it' });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('Dagger, Fire Bolt');

    fakeDice.queue(3, 4);
    const dmg = await h.run('request_player_roll', { roll_type: 'damage', attack_name: 'dagger', critical: true, reason: 'Crit!' });
    // Dagger 1d4 + DEX 2, dice doubled on a critical: 3 + 4 + 2.
    expect(dmg.content).toMatch(/: 9 /);
  });
});

describe('request_player_roll: attacks that are not on the sheet', () => {
  it('rolls a known leveled spell as a spell attack and a found weapon with `ability`', async () => {
    fakeDice.queue(10, 10);
    const h = setup();
    const ray = await h.run('request_player_roll', { roll_type: 'attack', attack_name: 'scorching ray', dc: 13, reason: 'Ray at the cultist' });
    expect(ray.isError).toBeUndefined();
    // Mira: INT 17 (+3) + proficiency 2 = +5 → 15 vs AC 13.
    expect(ray.content).toMatch(/Scorching Ray attack: 15 .*AC 13 → hit/);
    const bow = await h.run('request_player_roll', { roll_type: 'attack', attack_name: 'Longbow', ability: 'dex', dc: 13, reason: 'Shoot the bow you found' });
    expect(bow.isError).toBeUndefined();
    // DEX 14 (+2) + proficiency 2 = +4 → 14.
    expect(bow.content).toMatch(/Longbow attack \(DEX, not on sheet\): 14 .*→ hit/);
  });

  it('explains how to roll an off-sheet weapon when `ability` is missing', async () => {
    const h = setup();
    const out = await h.run('request_player_roll', { roll_type: 'attack', attack_name: 'Longbow', dc: 13, reason: 'Shoot' });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('Dagger, Fire Bolt');
    expect(out.content).toMatch(/`ability`/);
    const damage = await h.run('request_player_roll', { roll_type: 'damage', attack_name: 'Longbow', reason: 'Arrow' });
    expect(damage.isError).toBe(true);
    expect(damage.content).toMatch(/`expression`/);
  });
});

describe('request_player_roll: hidden DCs stay hidden in the log', () => {
  const lastRoll = (h: Harness) => h.s().log.filter((e) => e.kind === 'roll').at(-1);

  it('logs the target and verdict only when the DC is revealed; the DM always gets the verdict', async () => {
    fakeDice.queue(12, 12);
    const h = setup();
    await h.run('request_player_roll', { roll_type: 'skill', skill: 'arcana', dc: 15, reveal_dc: true, reason: 'Read the runes' });
    expect(lastRoll(h)).toMatchObject({ roll: { total: 17, dc: 15, success: true } });

    const stab = await h.run('request_player_roll', { roll_type: 'attack', attack_name: 'Dagger', dc: 12, reason: 'Stab the guard' });
    expect(stab.content).toMatch(/vs AC 12 → hit/);
    const card = lastRoll(h);
    expect(card?.kind === 'roll' && card.roll.total).toBe(16);
    expect(card?.kind === 'roll' && card.roll).not.toHaveProperty('dc');
    expect(card?.kind === 'roll' && card.roll).not.toHaveProperty('success');
  });

  it('shows the fixed DC 10 of a death saving throw', async () => {
    fakeDice.queue(12);
    const h = setup();
    await h.s().updateCharacter((c) => ({ ...c, hp: { ...c.hp, current: 0 } }));
    await h.run('request_player_roll', { roll_type: 'death-save', reason: 'Cling to life' });
    expect(lastRoll(h)).toMatchObject({ roll: { dc: 10, success: true } });
  });
});

describe("request_player_roll: the hero's own conditions, traits and features", () => {
  it('adds Disadvantage from a condition on the sheet and says so', async () => {
    fakeDice.queue(15, 4);
    const h = setup();
    await h.s().updateCharacter((c) => ({ ...c, conditions: [{ id: 'poisoned' }] }));
    const out = await h.run('request_player_roll', { roll_type: 'attack', attack_name: 'Dagger', dc: 12, reason: 'Stab' });
    // Disadvantage keeps the 4: 4 + 4 = 8, a miss.
    expect(out.content).toMatch(/Dagger attack: 8 .*→ miss/);
    expect(out.content).toContain('Disadvantage (Poisoned)');
    expect(h.s().log.at(-1)).toMatchObject({ kind: 'roll', roll: { advantage: 'disadvantage', natural: 4 } });
  });

  it('fails a Paralyzed hero\'s Dexterity save without rolling', async () => {
    fakeDice.queue(20);
    const h = setup({ campaignSettings: { playerRollMode: 'prompt' } });
    await h.s().updateCharacter((c) => ({ ...c, conditions: [{ id: 'paralyzed' }] }));
    const out = await h.run('request_player_roll', { roll_type: 'save', ability: 'dex', dc: 12, reason: 'Dodge the boulder' });
    expect(out.isError).toBeUndefined();
    expect(out.content).toMatch(/automatic failure vs DC 12 — Paralyzed/);
    expect(fakeDice.remaining()).toBe(1);
    expect(h.s().interaction).toBeNull();
    expect(h.s().log.some((e) => e.kind === 'roll')).toBe(false);
    expect(toolLines(h.s().log).at(-1)?.summary).toMatch(/automatic failure/);
  });

  it('rerolls a natural 1 for a Halfling with Luck (auto mode)', async () => {
    fakeDice.queue(1, 17);
    const h = setup();
    await h.s().updateCharacter((c) => ({
      ...c,
      features: [...c.features, { id: 'f-luck', name: 'Luck', description: 'Reroll natural 1s.', source: 'species', sourceName: 'Halfling' }],
    }));
    const out = await h.run('request_player_roll', { roll_type: 'skill', skill: 'arcana', dc: 15, reason: 'Recall the rite' });
    expect(out.content).toMatch(/Arcana check \(INT\): 22 .*→ success/);
    expect(out.content).toContain('Luck (Halfling)');
  });

  it("treats a Champion's natural 19 as a Critical Hit", async () => {
    fakeDice.queue(19);
    const h = setup();
    await h.s().updateCharacter((c) => ({
      ...c,
      features: [...c.features, { id: 'f-ic', name: 'Improved Critical', description: '19–20.', source: 'subclass', sourceName: 'Champion' }],
    }));
    const out = await h.run('request_player_roll', { roll_type: 'attack', attack_name: 'Dagger', dc: 30, reason: 'Stab' });
    expect(out.content).toMatch(/CRITICAL HIT \(natural 19\)/);
    expect(out.content).toContain('Roll damage with critical: true.');
  });

  it('tells the DM when the player spent Heroic Inspiration to reroll in the dialog', async () => {
    const h = setup({ campaignSettings: { playerRollMode: 'prompt' } });
    autoRespond(h.store, (req) => {
      if (req.kind !== 'roll') return null;
      // The dialog's "Reroll with Heroic Inspiration" spends it through the store before answering.
      void h.s().updateCharacter((c) => ({ ...c, heroicInspiration: false }));
      return { kind: 'roll', response: { result: dialogRoll(16, req.modifier, req.request.dc), manual: false } };
    });
    const out = await h.run('request_player_roll', { roll_type: 'skill', skill: 'athletics', dc: 15, reason: 'Climb the wall' });
    expect(out.content).toMatch(/spent Heroic Inspiration to reroll/);
  });
});

describe('update_character', () => {
  it('applies batched sections in one update and logs one line per section', async () => {
    const h = setup();
    const out = await h.run('update_character', {
      hp: { amount: 8, kind: 'damage', damage_type: 'slashing' },
      inventory_remove: [{ name: 'Potion of Healing', quantity: 1 }],
      currency_change: { gp: -5 },
      reason: 'Goblin scimitar',
    });
    const s = h.s();
    expect(s.character?.hp.current).toBe(4);
    expect(s.character?.inventory.find((i) => i.name === 'Potion of Healing')?.quantity).toBe(1);
    expect(s.character?.currency.gp).toBe(18);
    const lines = toolLines(s.log);
    expect(lines.map((l) => l.icon)).toEqual(['hp', 'item', 'coin']);
    expect(lines[0].summary).toBe('HP 12 → 4 (8 slashing · Goblin scimitar)');
    expect(out.content).toContain('Status: Mira Voss');
  });

  it('reports engine warnings without failing', async () => {
    const h = setup();
    await h.run('update_character', { spell_slots_spend: [{ level: 2 }] });
    const out = await h.run('update_character', { spell_slots_spend: [{ level: 2 }, { level: 2 }] });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('Warning: No level 2 spell slot left');
  });

  it('turns an "exhaustion" condition into an exhaustion level', async () => {
    const h = setup();
    await h.run('update_character', { conditions_add: [{ condition: 'Exhaustion' }, { condition: 'Poisoned', duration: '1 hour' }] });
    expect(h.s().character?.exhaustion).toBe(1);
    expect(h.s().character?.conditions).toEqual([{ id: 'poisoned', duration: '1 hour' }]);
  });

  it('rejects an empty change', async () => {
    const h = setup();
    expect(await h.run('update_character', { reason: 'nothing' })).toMatchObject({ isError: true });
  });

  it('refuses unknown fields instead of silently dropping them', async () => {
    const h = setup();
    const out = await h.run('update_character', { hp: { amount: 7, kind: 'damage' }, temp_hp: 5 });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('unknown field "temp_hp"');
    expect(h.s().character?.hp.current).toBe(12);
    const roll = await h.run('request_player_roll', { roll_type: 'save', ability: 'dex', DC: 15, reason: 'Dodge' });
    expect(roll.isError).toBe(true);
    expect(roll.content).toContain('"DC"');
    const nested = await h.run('update_character', { hp: { amount: 3, kind: 'damage', type: 'fire' } });
    expect(nested.content).toContain('hp: unknown field "type"');
  });
});

describe('update_character: ability scores and proficiencies (Ability Score Improvements, feats, Expertise)', () => {
  it('raises a score with the cap of 20, and a Constitution change moves HP as if from level 1', async () => {
    const h = setup();
    // Mira, Wizard 3: CON 13 (+1) → 15 (+2): +1 HP per level = +3 (SRD 5.2.1: Constitution changes).
    const out = await h.run('update_character', { ability_scores: [{ ability: 'con', change: 2 }], reason: 'Level 4 ASI' });
    expect(out.isError).toBeUndefined();
    expect(h.s().character?.abilityScores.con).toBe(15);
    expect(h.s().character?.hp).toMatchObject({ max: 20, current: 15 });
    expect(out.content).toContain('HP maximum 17 → 20');

    await h.s().updateCharacter((c) => ({ ...c, abilityScores: { ...c.abilityScores, int: 19 } }));
    const capped = await h.run('update_character', { ability_scores: [{ ability: 'int', change: 2 }] });
    expect(h.s().character?.abilityScores.int).toBe(20);
    expect(capped.content).toContain('capped at 20');

    await h.s().updateCharacter((c) => ({ ...c, abilityScores: { ...c.abilityScores, str: 21 } }));
    const above = await h.run('update_character', { ability_scores: [{ ability: 'str', change: 1 }] });
    expect(h.s().character?.abilityScores.str).toBe(21);
    expect(above.content).toContain('Warning: Strength is already 21');
  });

  it('recomputes AC when a score it depends on changes, unless the AC was set by hand', async () => {
    const h = setup();
    await h.run('update_character', { ability_scores: [{ ability: 'dex', change: 2 }] });
    // Unarmored: 10 + DEX (14 → 16).
    expect(h.s().character?.armorClass).toBe(13);
    expect(toolLines(h.s().log).at(-1)?.summary).toContain('AC 12 → 13');

    const mageArmor = setup();
    await mageArmor.s().updateCharacter((c) => ({ ...c, armorClass: 15 }));
    const out = await mageArmor.run('update_character', { ability_scores: [{ ability: 'dex', change: 2 }] });
    expect(mageArmor.s().character?.armorClass).toBe(15);
    expect(out.content).toMatch(/AC stays 15 \(set by hand\).*13/);
  });

  it('sets skill proficiency levels and adds saves, tools and languages', async () => {
    const h = setup();
    await h.run('update_character', {
      skill_proficiencies: [
        { skill: 'arcana', level: 'expertise' },
        { skill: 'history', level: 'none' },
        { skill: 'athletics', level: 'half' },
      ],
      saving_throws_add: ['con', 'int'],
      tools_add: ["Calligrapher's Supplies"],
      languages_add: ['Draconic'],
    });
    const c = h.s().character;
    expect(c?.skills).toMatchObject({ arcana: 2, athletics: 0.5 });
    expect(c?.skills).not.toHaveProperty('history');
    expect(c?.savingThrows).toEqual(['int', 'wis', 'con']);
    expect(c?.tools).toContain("Calligrapher's Supplies");
    expect(c?.languages).toContain('Draconic');
  });
});

describe('rests and leveling', () => {
  it('spends Hit Dice automatically on a short rest in auto mode', async () => {
    fakeDice.queue(4);
    const h = setup();
    const out = await h.run('take_rest', { kind: 'short' });
    // One d6 (4) + CON 1 = 5 → 12 + 5 = 17 (full), so only one die is spent.
    expect(h.s().character?.hp.current).toBe(17);
    expect(h.s().character?.hitDice[0].spent).toBe(2);
    expect(out.content).toMatch(/1 Hit Die spent, \+5 HP/);
  });

  it('asks the player which Hit Dice to spend in prompt mode', async () => {
    const h = setup({ campaignSettings: { playerRollMode: 'prompt' } });
    autoRespond(h.store, (req) =>
      req.kind === 'short-rest'
        ? { kind: 'short-rest', response: { spent: [{ die: 6, roll: { expression: '1d6', total: 2, dice: [{ sides: 6, value: 2 }], modifier: 0, breakdown: '2' }, healed: 3 }] } }
        : null,
    );
    await h.run('take_rest', { kind: 'short', reason: 'Under the pier' });
    expect(h.s().character?.hp.current).toBe(15);
  });

  it('refuses to rest during combat; long rests restore HP', async () => {
    const h = setup({ state: { combat: sampleCombat() } });
    expect(await h.run('take_rest', { kind: 'long' })).toMatchObject({ isError: true });
    await h.s().setCombat(null);
    await h.run('take_rest', { kind: 'long' });
    expect(h.s().character?.hp.current).toBe(17);
  });

  it('reports the limited-use features whose uses grew with the level', async () => {
    const h = setup();
    await h.s().updateCharacter((c) => ({
      ...c,
      features: [
        ...c.features,
        {
          id: 'f-tides',
          name: 'Tidal Surge',
          description: 'Test feature.',
          source: 'class',
          uses: { max: 2, used: 1, recharge: 'long', scale: { by: 'table', className: 'Wizard', values: [2, 2, 2, 3] } },
        },
      ],
    }));
    const out = await h.run('level_up', { class_name: 'Wizard' });
    expect(out.content).toContain('Tidal Surge: 2 → 3 uses');
    expect(h.s().character?.features.find((f) => f.id === 'f-tides')?.uses).toMatchObject({ max: 3, used: 1 });
  });

  it('levels up in milestone campaigns but needs the XP in XP campaigns', async () => {
    const xp = setup({ campaignSettings: { milestoneLeveling: false } });
    expect(await xp.run('level_up', { class_name: 'Wizard' })).toMatchObject({ isError: true });

    const milestone = setup();
    const out = await milestone.run('level_up', { class_name: 'Wizard' });
    expect(milestone.s().character?.classes[0].level).toBe(4);
    expect(out.content).toContain('Choose a new spell');
    expect(toolLines(milestone.s().log).at(-1)).toMatchObject({ icon: 'level' });
  });
});

describe('combat', () => {
  it('starts combat: numbers groups, rolls initiative, adds the hero', async () => {
    fakeDice.queue(15, 11);
    const h = setup();
    const out = await h.run('start_combat', {
      encounter_name: 'Dock ambush',
      combatants: [{ name: 'Goblin', side: 'enemy', count: 3, ac: 15, hp_max: 7, initiative_bonus: 2, stat_block: 'Goblin Warrior' }],
    });
    const combat = h.s().combat;
    expect(combat?.combatants.map((c) => c.name)).toEqual(['Mira Voss', 'Goblin 1', 'Goblin 2', 'Goblin 3']);
    expect(combat?.combatants[0]).toMatchObject({ isPlayer: true, initiative: 17 });
    expect(combat?.combatants[1]).toMatchObject({ initiative: 13, hideHp: true, hp: { max: 7, current: 7, temp: 0 } });
    expect(out.content).toContain("Round 1: Mira Voss's turn.");
    expect(await h.run('start_combat', { combatants: [{ name: 'Rat', side: 'enemy', ac: 10, hp_max: 1, initiative_bonus: 0 }] })).toMatchObject({ isError: true });
  });

  it('refuses to damage the hero through the tracker', async () => {
    const h = setup({ state: { combat: sampleCombat() } });
    const out = await h.run('update_combat', { action: 'damage', target: 'Mira Voss', amount: 5 });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('update_character');
  });

  it('damages NPCs, hiding exact HP from the player but not from the DM', async () => {
    const h = setup({ state: { combat: sampleCombat() } });
    const out = await h.run('update_combat', { action: 'damage', target: 'bandit 2', amount: 6 });
    expect(out.content).toContain('Bandit 2: HP 5/11');
    expect(toolLines(h.s().log).at(-1)?.summary).toBe('Bandit 2 takes 6 damage (bloodied)');
    const unknown = await h.run('update_combat', { action: 'heal', target: 'Nobody', amount: 1 });
    expect(unknown.content).toContain('Combatants: Mira Voss, Bandit 1, Bandit 2, Old Tam');
  });

  it('keeps combatant notes behind the DM screen', async () => {
    const h = setup({ state: { combat: sampleCombat() } });
    const out = await h.run('update_combat', { action: 'note', target: 'Bandit 2', note: 'Actually the missing keeper Halvard' });
    expect(out.content).toContain('Halvard');
    expect(toolLines(h.s().log).at(-1)).toMatchObject({ secret: true });
  });

  it('advances turns and ends combat, awarding XP only in XP campaigns', async () => {
    const h = setup({ state: { combat: sampleCombat() }, campaignSettings: { milestoneLeveling: false } });
    const next = await h.run('update_combat', { action: 'next_turn' });
    expect(next.content).toContain("Round 2: Bandit 2's turn.");
    await h.run('end_combat', { summary: 'The bandits fled.', xp_award: 50 });
    expect(h.s().combat).toBeNull();
    expect(h.s().character?.xp).toBe(950);

    const milestone = setup({ state: { combat: sampleCombat() } });
    const out = await milestone.run('end_combat', { summary: 'Done.', xp_award: 50 });
    expect(out.content).toContain('milestone');
    expect(milestone.s().character?.xp).toBe(900);
  });
});

describe('rules and homebrew', () => {
  it('caps rules output and only searches sources enabled for the campaign', async () => {
    const h = setup();
    const out = await h.run('lookup_rules', { query: 'fire opportunity attack', limit: 8 });
    expect(out.content.length).toBeLessThanOrEqual(RULES_OUTPUT_LIMIT + 200);
    expect(out.content).toContain('Opportunity Attacks');
    expect(out.content).toContain('truncated');
    expect(out.content.split('## ')[1].length).toBeLessThan(RULES_HIT_LIMIT + 300);
    expect(out.content).not.toContain('Forbidden Fire');
    expect(toolLines(h.s().log).at(-1)).toMatchObject({ icon: 'rules' });
  });

  it('gets one entry by name, and not from a disabled source', async () => {
    const h = setup();
    expect((await h.run('get_entry', { name: 'fireball' })).content).toContain('8d6 Fire damage');
    expect(toolLines(h.s().log).at(-1)).toMatchObject({ summary: 'Looked up: Fireball' });
    expect(toolLines(h.s().log).at(-1)?.secret).toBeUndefined();
    expect((await h.run('get_entry', { name: 'Forbidden Fire' })).content).toMatch(/^No entry named/);
    // Monster lookups could spoil a surprise: they stay behind the DM screen.
    await h.run('get_entry', { name: 'Bandit', kind: 'monster' });
    expect(toolLines(h.s().log).at(-1)).toMatchObject({ summary: 'Looked up: Bandit', secret: true });
  });

  it("searches every import switched on in the Library, and marks imported text so saves can leave it out", async () => {
    const h = setup();
    const imported = { id: 'lib:phb:fireball', sourceId: 'lib-phb', sourceName: 'My PHB notes', kind: 'spell' as const, name: 'Fireball', text: 'Imported Fireball text.' };
    setDmDeps({ rulesIndex: async () => createFakeRulesIndex([...SAMPLE_RULES, imported]) });
    const run = (name: string, input: unknown) => runTool(name, input, { ...h.ctx, deps: deps() });
    // The campaign enables only the SRD; the import is on in the Library (so it is in the index).
    expect(h.s().campaign?.settings.enabledSources).toEqual(['srd-5.2.1']);
    const search = await run('lookup_rules', { query: 'imported fireball' });
    expect(search.content).toContain('<imported-content source="My PHB notes">\n## Fireball (spell · My PHB notes)\nImported Fireball text.\n</imported-content>');
    const entry = await run('get_entry', { name: 'Fireball', kind: 'spell' });
    expect(entry.content).toMatch(/^<imported-content source="My PHB notes">[\s\S]*Imported Fireball text\.[\s\S]*<\/imported-content>$/);
    // SRD text is not marked.
    const srd = await run('get_entry', { name: 'Bandit' });
    expect(srd.content).not.toContain('<imported-content');
  });

  it('never hides an allowed SRD entry behind an off-limits entry of the same name', async () => {
    const h = setup();
    const offLimits: CompendiumEntry = { id: 'lib:off:fireball', sourceId: 'lib-off', sourceName: 'Switched-off notes', kind: 'spell', name: 'Fireball', text: 'Off-limits Fireball.' };
    const index = createFakeRulesIndex([...SAMPLE_RULES, offLimits]);
    // The index's name lookup prefers the import, but this campaign may not use that source.
    setDmDeps({ rulesIndex: async () => ({ ...index, sources: () => [{ id: 'srd-5.2.1', name: 'SRD 5.2.1', count: 3 }] }) });
    const out = await runTool('get_entry', { name: 'Fireball', kind: 'spell' }, { ...h.ctx, deps: deps() });
    expect(out.content).toContain('8d6 Fire damage');
    expect(out.content).not.toContain('Off-limits');
  });

  it('refuses homebrew when the campaign disables it', async () => {
    const h = setup({ campaignSettings: { homebrewFreedom: 'none' } });
    const out = await h.run('create_homebrew', {
      kind: 'boon',
      name: 'Sea Blessing',
      summary: 'Minor boon',
      text: 'Breathe water for 1 minute once per long rest.',
      comparables: ['Water Breathing'],
      balance_notes: 'Narrow and short.',
    });
    expect(out.isError).toBe(true);
    expect(h.s().homebrew).toHaveLength(0);
  });

  it('saves homebrew to the campaign compendium and refreshes the rules index', async () => {
    const h = setup();
    const input = {
      kind: 'magic-item',
      name: 'Tidecaller Lantern',
      summary: 'Uncommon wondrous item',
      text: 'While lit, you can see through fog as if it were clear.',
      based_on: 'Fireball',
      comparables: ['Lantern of Revealing', 'Goggles of Night'],
      power_tier: 'uncommon',
      balance_notes: 'Situational vision; no damage.',
    };
    await h.run('create_homebrew', input);
    const [entry] = h.s().homebrew;
    expect(entry).toMatchObject({
      name: 'Tidecaller Lantern',
      kind: 'magic-item',
      sourceId: 'homebrew',
      origin: 'dm',
      status: 'active',
      campaignId: 'camp-1',
      basedOn: { name: 'Fireball', id: 'srd:spell:fireball' },
    });
    expect(entry.balanceNotes).toContain('Compared with: Lantern of Revealing, Goggles of Night.');
    expect(h.invalidateRulesIndex).toHaveBeenCalledTimes(1);
    expect(await h.run('create_homebrew', input)).toMatchObject({ isError: true });

    await h.run('update_homebrew', { name: 'tidecaller lantern', status: 'retired', reason: 'Player veto' });
    expect(h.s().homebrew[0].status).toBe('retired');
    expect(h.invalidateRulesIndex).toHaveBeenCalledTimes(2);
    expect(toolLines(h.s().log).at(-1)?.summary).toBe('Homebrew retired: Tidecaller Lantern — Player veto');
  });
});

describe('journal, quests, clocks, scene, oracle, memory', () => {
  it('upserts journal entries, merging tags and marking secrets', async () => {
    const h = setup();
    await h.run('update_journal', {
      entries: [
        { kind: 'npc', name: 'old tam', summary: 'Now missing an eye and a boat.', tags: ['fisher'] },
        { kind: 'faction', name: 'The Tidewardens', summary: 'Smugglers who run the breakwater.', secret: true },
      ],
    });
    const tam = h.s().journal.find((j) => j.name.toLowerCase() === 'old tam');
    expect(tam?.tags).toEqual(['dockhand', 'witness', 'fisher']);
    const lines = toolLines(h.s().log);
    expect(lines.map((l) => [l.summary, l.secret ?? false])).toEqual([
      ['Journal: Old Tam (NPC) updated', false],
      ['Journal: The Tidewardens (Faction) added', true],
    ]);
  });

  it('creates quests and completes objectives by text', async () => {
    const h = setup();
    const out = await h.run('update_quest', { title: 'find keeper halvard', objectives: [{ text: 'Reach the lighthouse at low tide', done: true }, { text: 'Open the lantern room' }] });
    const quest = h.s().quests.find((q) => q.id === 'q-1');
    expect(quest?.objectives.map((o) => [o.text, o.done])).toEqual([
      ['Question Old Tam', true],
      ['Reach the lighthouse at low tide', true],
      ['Open the lantern room', false],
    ]);
    expect(out.content).toContain('Open objectives: Open the lantern room');
  });

  it('records an ambition without a checklist, and reminds the DM how it is earned', async () => {
    const h = setup();
    const out = await h.run('update_quest', { title: "Found a thieves' guild", summary: 'The docks will answer to Mira.', ambition: true });
    const quest = h.s().quests.find((q) => q.title === "Found a thieves' guild");
    expect(quest).toMatchObject({ ambition: true, status: 'active', objectives: [] });
    expect(toolLines(h.s().log).at(-1)).toMatchObject({ icon: 'quest', summary: "New ambition: Found a thieves' guild", refId: quest?.id });
    expect(out.content).toContain('progress clock (update_clocks, kind "progress", 6–12 segments by its scale)');
    expect(out.content).toContain('goes back for setbacks');
    expect(out.content).toContain('threat clock');
    expect(out.content).toContain('A declaration alone is not progress.');
    expect(out.content).not.toContain('never a checklist of your own');

    // A step the hero named; the flag sticks when an update leaves it out.
    const step = await h.run('update_quest', { title: "found a thieves' guild", objectives: [{ text: 'Win over the dockside urchins' }] });
    expect(step.content).toContain("Ambition: Found a thieves' guild — new objective: Win over the dockside urchins");
    expect(step.content).toContain('only for concrete steps the hero has identified themselves — never a checklist of your own');
    expect(step.content).not.toContain('6–12 segments');
    expect(h.s().quests.find((q) => q.id === quest?.id)?.ambition).toBe(true);
    expect((await h.run('search_memory', { query: 'thieves guild' })).content).toContain("Found a thieves' guild (Ambition, active)");

    const demoted = await h.run('update_quest', { title: "Found a thieves' guild", ambition: false });
    expect(demoted.content).toContain("Quest: Found a thieves' guild — no longer an ambition");
    expect(h.s().quests.find((q) => q.id === quest?.id)?.ambition).toBe(false);
  });

  it('turns an existing quest into an ambition', async () => {
    const h = setup();
    const out = await h.run('update_quest', { title: 'Find Keeper Halvard', ambition: true });
    expect(out.content).toContain('Ambition: Find Keeper Halvard — now an ambition');
    expect(out.content).toContain('6–12 segments');
    // Ordinary quests are untouched by any of this.
    const plain = await h.run('update_quest', { title: 'The smugglers of Gull Cove', status: 'active' });
    expect(plain.content).toBe('Quest: The smugglers of Gull Cove — active. Status: active. Open objectives: none.');
    expect(h.s().quests.find((q) => q.title === 'The smugglers of Gull Cove')).not.toHaveProperty('ambition');
  });

  it('creates and advances clocks, flagging the moment one fills', async () => {
    const h = setup();
    const created = await h.run('update_clocks', { clocks: [{ name: 'Storm front', consequence: 'The harbor floods.' }] });
    expect(created.content).toContain('4 segments');
    const filled = await h.run('update_clocks', { clocks: [{ name: 'the tide turns', advance: 3 }] });
    expect(filled.content).toMatch(/FILLED\. Consequence: The causeway floods/);
    const secret = await h.run('update_clocks', { clocks: [{ name: 'Something stirs below', advance: 1 }] });
    expect(secret.content).toContain('3/6');
    expect(toolLines(h.s().log).at(-1)).toMatchObject({ secret: true });
  });

  it('sets the scene, nudges tension within 1–9, and runs the scene check after the nudge', async () => {
    fakeDice.queue(6);
    const h = setup({ campaign: { tension: 9 } });
    const out = await h.run('set_scene', { location: 'The breakwater', weather: 'gale', new_scene: true, tension_change: 1 });
    expect(h.s().campaign?.tension).toBe(9);
    expect(h.s().campaign?.scene).toMatchObject({ location: 'The breakwater', weather: 'gale', timeOfDay: 'dusk' });
    expect(out.content).toMatch(/Scene check: d10 = 6 vs tension 9 → INTERRUPTED/);
    expect(toolLines(h.s().log).map((l) => l.secret ?? false)).toEqual([false, true]);

    const calm = setup({ campaign: { tension: 1 } });
    await calm.run('set_scene', { tension_change: -1 });
    expect(calm.s().campaign?.tension).toBe(1);
  });

  it('consults the oracle and searches the campaign memory', async () => {
    fakeDice.queue(40);
    const h = setup();
    const oracle = await h.run('consult_oracle', { question: 'Is the keeper alive?', likelihood: 'likely' });
    expect(oracle.content).toMatch(/likely, 70%.*d100 = 40 → Yes/);
    const memory = await h.run('search_memory', { query: 'Keeper Halvard lighthouse' });
    expect(memory.content).toContain('Keeper Halvard (NPC, missing, secret)');
    expect(memory.content).toContain('Find Keeper Halvard (Quest, active)');
  });

  it('returns the full character sheet', async () => {
    const h = setup();
    expect((await h.run('get_character_sheet', {})).content).toContain('# Mira Voss');
  });

  it("returns a journal entry whole when the query names it, though the prompt's journal line cuts long details", async () => {
    const h = setup();
    const details = [
      "Corvin swore on his mother's lamp to find the dragon whose scale he carries.",
      'He means to drink from its hoard-spring and become a dragon himself, whatever it costs.',
      'His chained blades grow hot whenever they come near the hoard under the old quarry.',
      'He keeps a ledger of every rumor of wings: the drowned bell at Kettleford, the ash on the north road, the shepherd who saw a shadow cross the moon. '.repeat(3),
      'He has told no one but Old Tam about the quarry, and Tam has told no one at all.',
    ].join('\n\n');
    await h.run('update_journal', { entries: [{ kind: 'lore', name: "Corvin's Oath", summary: 'What the hero swore at twelve.', details }] });
    const exact = (await h.run('search_memory', { query: "corvin's oath" })).content;
    expect(exact).toContain('the hoard under the old quarry.');
    expect(exact).toContain('Tam has told no one at all.');
    const partial = (await h.run('search_memory', { query: 'oath dragon' })).content;
    expect(partial).not.toContain('Tam has told no one at all.');
  });
});
