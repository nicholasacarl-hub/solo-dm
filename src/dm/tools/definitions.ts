/**
 * The DM's tool catalog: one Zod schema per tool (validated client-side — eager input streaming
 * means the API does not validate) and the static `tools` array sent with every request. Every
 * object is strict, matching the `additionalProperties: false` the JSON schema advertises: an
 * unknown or misspelled field is an error Claude can fix, never silently dropped.
 *
 * The array is built once, in a fixed order, and never changes during a session: tools render at
 * the start of the prompt, so any change would invalidate the prompt cache and preserved thinking.
 */
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { z } from 'zod';
import type { Likelihood } from '@/engine';
import {
  ABILITIES,
  CONTENT_KINDS,
  SKILLS,
  type AdvantageState,
  type CombatSide,
  type FeatureSource,
  type ItemCategory,
  type JournalKind,
  type PlayerRollType,
  type QuestStatus,
  type RechargeOn,
} from '@/types';

// ---------------------------------------------------------------------------
// Shared vocabularies
// ---------------------------------------------------------------------------

const ADVANTAGE = ['normal', 'advantage', 'disadvantage'] as const satisfies readonly AdvantageState[];
const ROLL_TYPES = [
  'ability',
  'skill',
  'save',
  'attack',
  'damage',
  'initiative',
  'death-save',
  'hit-die',
  'custom',
] as const satisfies readonly PlayerRollType[];
const NPC_SIDES = ['enemy', 'ally', 'neutral'] as const satisfies readonly CombatSide[];
const FEATURE_SOURCES = [
  'class',
  'subclass',
  'species',
  'background',
  'feat',
  'boon',
  'item',
  'homebrew',
  'other',
] as const satisfies readonly FeatureSource[];
const RECHARGES = ['short', 'long', 'dawn', 'turn', 'none'] as const satisfies readonly RechargeOn[];
const ITEM_CATEGORIES = [
  'weapon',
  'armor',
  'shield',
  'gear',
  'tool',
  'consumable',
  'treasure',
  'magic-item',
  'other',
] as const satisfies readonly ItemCategory[];
export const JOURNAL_KINDS = [
  'npc',
  'location',
  'faction',
  'item',
  'lore',
  'event',
  'ruling',
  'note',
] as const satisfies readonly JournalKind[];
const QUEST_STATUSES = ['rumor', 'active', 'completed', 'failed', 'abandoned'] as const satisfies readonly QuestStatus[];
export const LIKELIHOODS = [
  'nearly-impossible',
  'very-unlikely',
  'unlikely',
  'even',
  'likely',
  'very-likely',
  'nearly-certain',
] as const satisfies readonly Likelihood[];

const abilityEnum = z.enum(ABILITIES);
const skillEnum = z.enum(SKILLS);
const contentKindEnum = z.enum(CONTENT_KINDS);

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const str = (max: number) => z.string().min(1).max(max);

const conditionInput = z.strictObject({
  condition: str(60).describe('A condition such as "poisoned", "prone", "frightened", or a homebrew condition name.'),
  source: str(120).optional().describe('What caused it, e.g. "Giant spider venom".'),
  duration: str(120).optional().describe('Free text: "1 minute", "until the end of your next turn", "until cured".'),
});

const combatantSpec = z.strictObject({
  name: str(80).describe('Display name, e.g. "Goblin" (numbered automatically when count > 1) or "Captain Vell".'),
  side: z.enum(NPC_SIDES),
  count: int(1, 20).optional().describe('How many identical creatures (default 1). They share one initiative roll.'),
  ac: int(1, 40),
  hp_max: int(1, 2000).describe('Hit point maximum of each creature.'),
  initiative_bonus: int(-10, 20).describe('Initiative modifier from the stat block (usually its DEX modifier).'),
  stat_block: str(120).optional().describe('Stat block name, e.g. "Goblin Warrior" or a homebrew monster.'),
  hide_hp: z.boolean().optional().describe('Hide exact HP from the player (default: true for enemies).'),
  surprised: z.boolean().optional().describe('Surprised creatures roll initiative with Disadvantage.'),
  notes: str(400).optional(),
});

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const TOOL_SCHEMAS = {
  roll_dice: z.strictObject({
    expression: str(60).describe('Dice expression: NdM terms, keep-highest/lowest and flat modifiers, e.g. "1d20+5", "2d6+3", "4d6kh3", "1d100".'),
    purpose: str(120).describe('What the roll is for, shown in the log: "Bandit 2 attacks Mira", "Goblin Stealth".'),
    dc: int(1, 50).optional().describe('For a d20 test: the DC, or the target\'s AC for an attack roll.'),
    is_attack: z.boolean().optional().describe('An attack roll: a natural 20 always hits (Critical Hit), a natural 1 always misses.'),
    advantage: z.enum(ADVANTAGE).optional().describe('Advantage or Disadvantage on a single-d20 test.'),
    critical: z.boolean().optional().describe('Double the damage dice (Critical Hit damage).'),
    secret: z.boolean().optional().describe('Keep the result behind the DM screen (hidden from the player unless they reveal DM rolls).'),
  }),

  request_player_roll: z.strictObject({
    roll_type: z.enum(ROLL_TYPES),
    ability: abilityEnum.optional().describe('Ability for ability checks and saving throws; for skill checks, an unusual ability to pair with the skill.'),
    skill: skillEnum.optional().describe('Skill for skill checks.'),
    attack_name: str(80)
      .optional()
      .describe(
        'For attack and damage rolls: an attack on the hero\'s sheet, a spell the hero knows (rolled as a spell attack), or another weapon — then also give `ability` ("str", or "dex" for a ranged or finesse weapon). For damage from a spell or an off-sheet weapon, give `expression` instead.',
      ),
    expression: str(60).optional().describe('Dice for damage or custom rolls when no sheet attack applies, e.g. "8d6" for Fireball damage.'),
    dc: int(1, 50).optional().describe('DC, or the target\'s AC for an attack roll. Omit for damage.'),
    reveal_dc: z
      .boolean()
      .optional()
      .describe('Show the DC to the player, before the roll and on their roll card (when the hero would know how hard it is). Otherwise they see only their total until you narrate the outcome.'),
    advantage: z.enum(ADVANTAGE).optional(),
    reason: str(200).describe('What is at stake, shown to the player: "Leap the chasm — on a failure you fall 20 feet".'),
    critical: z.boolean().optional().describe('Damage after a Critical Hit: double the dice.'),
  }),

  update_character: z.strictObject({
    hp: z
      .strictObject({
        amount: int(0, 9999),
        kind: z.enum(['damage', 'healing', 'temp']),
        damage_type: str(30).optional(),
        critical: z.boolean().optional().describe('Damage from a Critical Hit (matters at 0 HP: two death-save failures).'),
      })
      .optional(),
    conditions_add: z.array(conditionInput).max(10).optional(),
    conditions_remove: z.array(str(60)).max(10).optional(),
    exhaustion_change: int(-6, 6).optional().describe('Change in Exhaustion level (+1 gains a level, −1 removes one).'),
    spell_slots_spend: z
      .array(z.strictObject({ level: int(1, 9), pact: z.boolean().optional().describe('Spend a Pact Magic slot.') }))
      .max(5)
      .optional(),
    spell_slots_restore: z.array(z.strictObject({ level: int(1, 9), pact: z.boolean().optional() })).max(9).optional(),
    concentration: z
      .union([str(80), z.null()])
      .optional()
      .describe('Spell the hero starts concentrating on, or null when concentration ends.'),
    features_use: z.array(z.strictObject({ name: str(80), amount: int(1, 20).optional() })).max(10).optional(),
    features_restore: z.array(z.strictObject({ name: str(80), amount: int(1, 20).optional() })).max(10).optional(),
    features_add: z
      .array(
        z.strictObject({
          name: str(80),
          description: str(2000),
          source: z.enum(FEATURE_SOURCES),
          uses_max: int(1, 20).optional(),
          recharge: z.enum(RECHARGES).optional(),
        }),
      )
      .max(5)
      .optional(),
    inventory_add: z
      .array(
        z.strictObject({
          name: str(80),
          quantity: int(1, 9999),
          description: str(1000).optional(),
          category: z.enum(ITEM_CATEGORIES).optional(),
          magic: z.boolean().optional(),
          weight: z.number().min(0).max(5000).optional().describe('Pounds per unit.'),
        }),
      )
      .max(20)
      .optional(),
    inventory_remove: z
      .array(z.strictObject({ name: str(80), quantity: int(1, 9999).optional().describe('Default: all of them.') }))
      .max(20)
      .optional(),
    inventory_update: z
      .array(
        z.strictObject({
          name: str(80),
          equipped: z.boolean().optional(),
          attuned: z.boolean().optional(),
          quantity: int(0, 9999).optional(),
          description: str(1000).optional(),
        }),
      )
      .max(20)
      .optional(),
    currency_change: z
      .strictObject({
        cp: int(-1_000_000, 1_000_000).optional(),
        sp: int(-1_000_000, 1_000_000).optional(),
        ep: int(-1_000_000, 1_000_000).optional(),
        gp: int(-1_000_000, 1_000_000).optional(),
        pp: int(-1_000_000, 1_000_000).optional(),
      })
      .optional()
      .describe('Coins gained (positive) or spent (negative); change is made automatically.'),
    xp_gain: int(1, 1_000_000).optional(),
    heroic_inspiration: z.boolean().optional().describe('true to award Heroic Inspiration, false when it is spent.'),
    spells_add: z
      .array(
        z.strictObject({
          name: str(80),
          level: int(0, 9).describe('0 for a cantrip.'),
          prepared: z.boolean().optional(),
          source: str(80).optional(),
          ritual: z.boolean().optional(),
          concentration: z.boolean().optional(),
          notes: str(400).optional(),
        }),
      )
      .max(10)
      .optional(),
    spells_remove: z.array(str(80)).max(10).optional(),
    ability_scores: z
      .array(
        z.strictObject({
          ability: abilityEnum,
          change: int(-10, 10).describe('Points to add (negative to lower), e.g. 2 for an Ability Score Improvement.'),
          max: int(1, 30).optional().describe('Highest the score may reach: 20 (default) for Ability Score Improvements and feats, 30 for an Epic Boon.'),
        }),
      )
      .max(6)
      .optional()
      .describe(
        "Ability score changes the rules grant: an Ability Score Improvement (+2 to one score or +1 to two), a feat's +1, an Epic Boon. A Constitution change also changes the HP maximum as if the new modifier had applied from level 1; Armor Class is recomputed when it depends on the score.",
      ),
    skill_proficiencies: z
      .array(z.strictObject({ skill: skillEnum, level: z.enum(['none', 'half', 'proficient', 'expertise']) }))
      .max(18)
      .optional()
      .describe(
        'Set skill proficiency levels: "proficient", "expertise" (double proficiency: Bard or Rogue Expertise), "half" (half the Proficiency Bonus, rounded down — Jack of All Trades: set it for each skill the hero lacks) or "none".',
      ),
    saving_throws_add: z.array(abilityEnum).max(6).optional().describe('Gain saving throw proficiency (e.g. the Resilient feat).'),
    tools_add: z.array(str(80)).max(10).optional().describe('Gain tool proficiencies.'),
    languages_add: z.array(str(60)).max(10).optional().describe('Learn languages.'),
    armor_class: int(1, 40).optional().describe('New Armor Class (e.g. after donning armor or a spell like Shield of Faith ends).'),
    speed: int(0, 200).optional().describe('New walking speed in feet.'),
    reason: str(200).optional().describe('Why, shown in the log: "Goblin scimitar", "Bought a rope".'),
  }),

  take_rest: z.strictObject({
    kind: z.enum(['short', 'long']),
    reason: str(200).optional().describe('Where and how the hero rests, shown to the player.'),
  }),

  level_up: z.strictObject({
    class_name: str(60).describe('Class to gain a level in: an existing class, or a new one for multiclassing.'),
    subclass: str(80).optional().describe('Subclass chosen at this level (usually level 3).'),
    hp_method: z.enum(['average', 'roll']).optional().describe('Hit points: the fixed average (default) or a roll.'),
    hit_die: z.union([z.literal(6), z.literal(8), z.literal(10), z.literal(12)]).optional().describe('Required for a new multiclass class.'),
    caster_type: z.enum(['full', 'half', 'third', 'pact', 'none']).optional().describe('For a new multiclass class.'),
    spellcasting_ability: abilityEnum.optional().describe('For a new spellcasting class.'),
    new_features: z
      .array(
        z.strictObject({
          name: str(80),
          description: str(2000),
          uses_max: int(1, 20).optional(),
          recharge: z.enum(RECHARGES).optional(),
        }),
      )
      .max(8)
      .optional()
      .describe('Class features gained at this level (look them up with get_entry if unsure).'),
  }),

  start_combat: z.strictObject({
    encounter_name: str(80).optional(),
    combatants: z.array(combatantSpec).min(1).max(12).describe('Everyone except the hero, who is added automatically.'),
    player_surprised: z.boolean().optional().describe('The hero is surprised: Disadvantage on their Initiative roll.'),
  }),

  update_combat: z.strictObject({
    action: z.enum(['next_turn', 'damage', 'heal', 'add', 'remove', 'conditions', 'defeat', 'note']),
    target: str(80).optional().describe('Combatant name ("Goblin 2") or id. Required for every action except next_turn and add.'),
    amount: int(0, 9999).optional().describe('Damage or healing (from a roll).'),
    conditions_add: z.array(conditionInput).max(6).optional(),
    conditions_remove: z.array(str(60)).max(6).optional(),
    combatant: combatantSpec.optional().describe('For action "add": the newcomers.'),
    note: str(400).optional().describe('For action "note": a private note for yourself (never shown to the player).'),
  }),

  end_combat: z.strictObject({
    summary: str(300).describe('How the fight ended, in a sentence.'),
    xp_award: int(0, 1_000_000).optional().describe('Total XP for the encounter (XP campaigns only).'),
  }),

  lookup_rules: z.strictObject({
    query: str(200),
    kinds: z.array(contentKindEnum).max(6).optional().describe('Limit to kinds of content, e.g. ["spell"] or ["monster"].'),
    limit: int(1, 8).optional().describe('Number of results (default 5).'),
  }),

  get_entry: z.strictObject({
    name: str(120),
    kind: contentKindEnum.optional(),
  }),

  get_character_sheet: z.strictObject({}),

  create_homebrew: z.strictObject({
    kind: contentKindEnum.describe('What it is: spell, magic-item, item, monster, boon, feat, condition, rule…'),
    name: str(100),
    summary: str(300).describe('One line, e.g. "Level 2 Evocation (homebrew)" or "Uncommon wondrous item".'),
    text: str(12000).describe('Full rules text in markdown, written like a rulebook entry.'),
    based_on: str(120).optional().describe('The official content this modifies, if any.'),
    comparables: z.array(str(120)).min(1).max(6).describe('SRD content of similar power you balanced it against.'),
    power_tier: str(60).optional().describe('Spell level, item rarity, CR, or "minor" / "major" for boons.'),
    balance_notes: str(1500).describe('Why it is balanced against the comparables; its costs and limits.'),
  }),

  update_homebrew: z.strictObject({
    name: str(100).describe('Current name of the homebrew entry.'),
    new_name: str(100).optional(),
    summary: str(300).optional(),
    text: str(12000).optional(),
    comparables: z.array(str(120)).min(1).max(6).optional(),
    power_tier: str(60).optional(),
    balance_notes: str(1500).optional(),
    status: z.enum(['active', 'retired']).optional(),
    reason: str(300).describe('Why it changed, shown to the player.'),
  }),

  update_journal: z.strictObject({
    entries: z
      .array(
        z.strictObject({
          kind: z.enum(JOURNAL_KINDS),
          name: str(100),
          summary: str(400).describe('One or two sentences.'),
          details: str(4000).optional().describe('Longer markdown notes.'),
          status: str(40).optional().describe('e.g. "ally", "hostile", "deceased", "missing", "explored".'),
          tags: z.array(str(40)).max(8).optional().describe('Aliases and keywords; they help the app recognize mentions.'),
          secret: z.boolean().optional().describe('The hero has not learned this (hidden from the player).'),
        }),
      )
      .min(1)
      .max(12),
  }),

  update_quest: z.strictObject({
    title: str(120),
    status: z.enum(QUEST_STATUSES).optional(),
    summary: str(600).optional(),
    giver: str(100).optional(),
    reward: str(200).optional(),
    objectives: z
      .array(z.strictObject({ text: str(200), done: z.boolean().optional() }))
      .max(12)
      .optional()
      .describe('Objectives to add or update, matched by text.'),
    secret_notes: str(2000).optional().describe('DM-only notes (hidden from the player).'),
  }),

  update_clocks: z.strictObject({
    clocks: z
      .array(
        z.strictObject({
          name: str(100),
          segments: int(2, 12).optional().describe('Size of a new clock (4, 6 or 8 is typical).'),
          advance: int(-12, 12).optional().describe('Segments to fill (negative to roll back).'),
          set_filled: int(0, 12).optional().describe('Set the filled count exactly.'),
          consequence: str(400).optional().describe('What happens when the clock fills.'),
          kind: z.enum(['threat', 'progress', 'countdown']).optional(),
          secret: z.boolean().optional().describe('Hidden from the player.'),
          resolved: z.boolean().optional().describe('The consequence has landed, or the threat was defused.'),
        }),
      )
      .min(1)
      .max(8),
  }),

  search_memory: z.strictObject({
    query: str(200),
    limit: int(1, 10).optional(),
  }),

  set_scene: z.strictObject({
    location: str(120).optional(),
    region: str(120).optional(),
    time_of_day: str(60).optional(),
    in_world_date: str(80).optional(),
    weather: str(100).optional(),
    mood: str(100).optional(),
    new_scene: z.boolean().optional().describe('A new scene begins: run the scene check.'),
    tension_change: int(-1, 1).optional().describe('+1 when the last scene slipped out of the hero\'s control, −1 when they took charge.'),
  }),

  consult_oracle: z.strictObject({
    question: str(200).describe('A yes/no question about the world.'),
    likelihood: z.enum(LIKELIHOODS),
    secret: z.boolean().optional().describe('Hide it from the player when the question itself would spoil something.'),
  }),
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;
export type ToolInput<N extends ToolName> = z.infer<(typeof TOOL_SCHEMAS)[N]>;

// ---------------------------------------------------------------------------
// Descriptions: when to use each tool, and when not to
// ---------------------------------------------------------------------------

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  roll_dice:
    "Roll dice for the DM's side of the table: NPC and monster attacks, damage, saving throws and checks; random tables; secret checks. The app rolls with real randomness and logs the result (secret rolls go behind the DM screen). For a d20 test give the full expression with its modifier (\"1d20+4\") plus `dc` (the DC, or the target's AC) and `advantage` if any; the result says whether it meets the target. Do NOT use it for the hero's own checks, saves, attacks, damage or initiative — use request_player_roll so the player rolls. Never narrate a result before this returns.",
  request_player_roll:
    "Ask the player to roll for their hero: ability checks, skill checks, saving throws, attack rolls, damage, death saving throws (and initiative outside start_combat). The app applies the sheet's modifiers and the hero's own conditions, armor and traits (e.g. Disadvantage while Poisoned, an automatic failure for a Paralyzed hero's Dexterity save, Halfling Luck, a Champion's wider critical range — the result says what it applied), rolls per the player's roll mode — instantly, after they tap Roll, or from their physical dice — and returns the total and, with `dc`, success or failure. Call it only when the outcome is uncertain and failure matters; decide the DC and the stakes first and put the stakes in `reason`. For attacks set `dc` to the target's AC (a natural 20 is a Critical Hit, a natural 1 always misses); `attack_name` can be a sheet attack, a spell the hero knows, or another weapon with `ability`. Don't use it for NPC or monster rolls (roll_dice), and don't roll initiative when a fight starts — start_combat does that.",
  update_character:
    "Change the hero's character sheet: HP (damage, healing, temporary HP), conditions, exhaustion, spell slots, concentration, limited-use features, inventory, money, XP, Heroic Inspiration, spells, ability scores (Ability Score Improvements, feats), skill / saving throw / tool proficiencies, languages, AC and speed. Batch several sections in one call. Amounts must come from rolls (roll_dice / request_player_roll results) or fixed rules values — never invented. Returns what changed, warnings (no slot left, not enough gold, item not found) and the hero's new status. Don't use it for NPCs or monsters (update_combat), rests (take_rest) or leveling up (level_up).",
  take_rest:
    "The hero takes a Short Rest (1 hour: may spend Hit Dice to heal; short-rest features recharge) or a Long Rest (8 hours: all HP, spent Hit Dice and spell slots return; one Exhaustion level is removed). For a short rest the player chooses which Hit Dice to spend unless their dice roll automatically. Use only when the hero actually rests and the time passes; never during combat. Narrate any interruption yourself — don't call this if the rest is interrupted early.",
  level_up:
    "Advance the hero one level in a class (for multiclassing, a new class with its hit_die). Applies HP (fixed average by default), Hit Dice, proficiency bonus, spell slots and the class features you list, and returns reminders of choices the player must make (subclass, feats, new spells). Use at story milestones in milestone campaigns, or once the hero has enough XP in XP campaigns. One level per call; then tell the player what improved and ask about their choices.",
  start_combat:
    'Start an encounter when a fight actually begins. Adds the hero automatically, adds each group of combatants ("Goblin" with count 3 becomes Goblin 1–3), rolls NPC initiative, has the player roll the hero\'s initiative, and returns the turn order. Use real values (AC, HP, initiative bonus) from the stat block — get_entry it if unsure. Don\'t use it for a single blow that settles a scene without a fight. Only one combat can be active.',
  update_combat:
    'Change the active combat. `next_turn` when the current turn ends; `damage` / `heal` an NPC or monster by `amount` (from a roll); `conditions` to add or remove conditions on an NPC; `defeat` when a combatant falls, flees or surrenders; `remove` to take one out of the order; `add` reinforcements via `combatant`; `note` to record a private DM note about a combatant (never shown to the player). Targets are names ("Goblin 2") or ids. The hero\'s HP and conditions are NOT changed here — use update_character.',
  end_combat:
    'End the active combat as soon as the fighting stops (foes defeated, fled or surrendered, or the hero escaped), with a one-line summary. In XP campaigns pass `xp_award` (total XP for the defeated foes); it is ignored in milestone campaigns.',
  lookup_rules:
    "Search the rules: SRD 5.2.1, the player's imported books (every one switched on in their Library), and this campaign's homebrew. Returns matching rules sections, spells, monsters, items and more, with excerpts. Use it whenever you're unsure of a rule, spell, monster or item — especially imported content you may not know. Don't use it for story facts (search_memory) or the hero's own abilities (get_character_sheet).",
  get_entry:
    'Get the full text of one rules entry by name: a spell, monster stat block, magic item, feat, condition, class feature, rules section, or homebrew. Use when you know the name; use lookup_rules to search.',
  get_character_sheet:
    "Get the hero's full current character sheet: abilities, saves, skills, attacks, spells and slots, features and their uses, inventory, money, personality and backstory. The per-turn status line is usually enough; use this for detail — e.g. to check an item or spell the player says they have.",
  create_homebrew:
    "Save new or modified rules content you are introducing — a spell, magic item, monster, boon, feat, condition or rule change — before it affects play, so the player can read it in their compendium and veto it. Balance it against named SRD comparables of similar level, rarity or CR and explain why in balance_notes. Only within the campaign's homebrew-freedom setting (refused when homebrew is off). Don't use it for ordinary story facts (update_journal) or for official rules, which are already in the compendium.",
  update_homebrew:
    "Revise or retire homebrew this campaign created — after a player veto, a balance problem, or a story change. Explain why in `reason` (the player sees it). Retire with status 'retired' instead of deleting.",
  update_journal:
    "Record or update the campaign's memory: NPCs, locations, factions, items, lore, events, rulings and notes. Call it when a new named NPC, place, faction or notable item appears, when something important about one changes (an NPC dies, a place is cleared), and whenever you make a rules ruling (kind 'ruling') so you stay consistent. Entries are matched by kind + name. Mark anything the hero hasn't learned with secret: true. Don't use it for quests (update_quest) or threats on a timer (update_clocks).",
  update_quest:
    "Create or update a quest the hero knows about — a rumor, an active quest and its objectives, completion or failure. Matched by title. Add objectives as the hero learns them and mark them done; set status 'completed', 'failed' or 'abandoned' when it ends. Keep your private plans in secret_notes.",
  update_clocks:
    'Create or advance progress clocks: fronts and threats that advance off-screen, countdowns, and long projects. A new clock needs `segments` (4, 6 or 8 is typical) and a `consequence`. Advance threats when time passes, the hero fails or ignores them, or a complication fits. When a clock fills, its consequence happens: narrate it, then mark the clock resolved. Secret clocks are hidden from the player.',
  search_memory:
    "Search the campaign's memory: journal entries, quests, earlier session recaps and your private notes. Use before reintroducing an NPC, place or thread from an earlier session, or when the player mentions something you don't see in context. Not for rules (lookup_rules).",
  set_scene:
    "Update the scene header the player sees: location, region, time of day, in-world date, weather, mood (omit fields that didn't change). With new_scene: true the app runs a scene check against the tension dial and may return 'altered' or 'interrupted' plus a twist to build the scene around. tension_change is applied first: +1 when the last scene slipped out of the hero's control, −1 when they took charge. Call it when the hero arrives somewhere new, time skips, or conditions change.",
  consult_oracle:
    "Ask the yes/no oracle when you genuinely don't know how the world would answer and neither the fiction nor the rules decide it (Is anyone home? Did the bridge hold?). Set the likelihood honestly before asking. The answer is yes or no, sometimes with 'and' (stronger) or 'but' (a complication), and doubles add a random twist. Honor it. Don't use it for choices you should make as DM, questions a check should resolve, or to dodge hard calls.",
};

/** Deterministic order of the tools array. */
export const TOOL_ORDER: readonly ToolName[] = [
  'roll_dice',
  'request_player_roll',
  'update_character',
  'take_rest',
  'level_up',
  'start_combat',
  'update_combat',
  'end_combat',
  'lookup_rules',
  'get_entry',
  'get_character_sheet',
  'create_homebrew',
  'update_homebrew',
  'update_journal',
  'update_quest',
  'update_clocks',
  'search_memory',
  'set_scene',
  'consult_oracle',
];

/** Tools that read but never change game state (or commit randomness): safe to regenerate after. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set<ToolName>([
  'lookup_rules',
  'get_entry',
  'get_character_sheet',
  'search_memory',
]);

export function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_SCHEMAS, name);
}

function inputSchemaFor(schema: z.ZodType): BetaTool.InputSchema {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  return { ...json, type: 'object' };
}

function buildTools(): BetaTool[] {
  return TOOL_ORDER.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    input_schema: inputSchemaFor(TOOL_SCHEMAS[name]),
    eager_input_streaming: true,
  }));
}

/** The static tools array sent with every request (frozen; never rebuilt). */
export const DM_TOOLS: readonly BetaTool[] = Object.freeze(buildTools());

// ---------------------------------------------------------------------------
// Friendly activity text for the status bar
// ---------------------------------------------------------------------------

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Status text while a tool streams in or runs (never reveals secrets). */
export function toolActivity(name: string, input?: unknown): string {
  switch (name) {
    case 'roll_dice': {
      if (input === undefined) return 'Rolling dice…';
      const purpose = field(input, 'purpose');
      return purpose && (input as { secret?: boolean }).secret !== true ? `Rolling: ${purpose}…` : 'Rolling dice behind the screen…';
    }
    case 'request_player_roll':
      return 'Calling for a roll…';
    case 'update_character':
      return 'Updating your character sheet…';
    case 'take_rest':
      return 'Resting…';
    case 'level_up':
      return 'Leveling up…';
    case 'start_combat':
      return 'Rolling initiative…';
    case 'update_combat':
      return 'Running the fight…';
    case 'end_combat':
      return 'The dust settles…';
    case 'lookup_rules':
      return 'Consulting the rules…';
    case 'get_entry':
      return 'Consulting the rules…';
    case 'get_character_sheet':
      return 'Reading your character sheet…';
    case 'create_homebrew':
      return 'Inventing something new…';
    case 'update_homebrew':
      return 'Revising homebrew…';
    case 'update_journal':
      return 'Writing in the journal…';
    case 'update_quest':
      return 'Updating your quests…';
    case 'update_clocks':
      return 'The world moves…';
    case 'search_memory':
      return 'Remembering…';
    case 'set_scene':
      return 'Setting the scene…';
    case 'consult_oracle':
      return 'Consulting the oracle…';
    default:
      return 'Working…';
  }
}
