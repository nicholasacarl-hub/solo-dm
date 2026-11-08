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
import type { ImageAspect } from '@/images';
import {
  ABILITIES,
  CONTENT_KINDS,
  SKILLS,
  type AdvantageState,
  type AreaShape,
  type AreaTerrain,
  type CombatSide,
  type CompassDirection,
  type CreatureSize,
  type DoorState,
  type FeatureSource,
  type ImageSubject,
  type ItemCategory,
  type JournalKind,
  type MoveKind,
  type MoveMode,
  type PlayerRollType,
  type QuestStatus,
  type RechargeOn,
  type TerrainKind,
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
const SIZES = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'] as const satisfies readonly CreatureSize[];
// Battle map vocabularies, kept as tuples (z.enum needs one); a test asserts each equals its @/types list.
const TERRAIN_KINDS = [
  'wall',
  'door',
  'difficult',
  'shallow-water',
  'deep-water',
  'pit',
  'hazard',
  'half-cover',
  'three-quarters-cover',
  'obscured',
] as const satisfies readonly TerrainKind[];
const DOOR_STATES = ['open', 'closed', 'locked'] as const satisfies readonly DoorState[];
const AREA_SHAPES = ['sphere', 'cylinder', 'cone', 'line', 'cube', 'emanation', 'squares'] as const satisfies readonly AreaShape[];
const AREA_TERRAIN = ['difficult', 'obscured', 'hazard'] as const satisfies readonly AreaTerrain[];
const MOVE_KINDS = ['move', 'off-turn', 'forced', 'teleport', 'place'] as const satisfies readonly MoveKind[];
const MOVE_MODES = ['walk', 'fly'] as const satisfies readonly MoveMode[];
const DIRECTIONS = [
  'north',
  'north-east',
  'east',
  'south-east',
  'south',
  'south-west',
  'west',
  'north-west',
] as const satisfies readonly CompassDirection[];

/** The schema tuples that mirror shared type lists (tests check they stay equal). */
export const SCHEMA_VOCABULARIES = {
  sizes: SIZES,
  terrainKinds: TERRAIN_KINDS,
  doorStates: DOOR_STATES,
  areaShapes: AREA_SHAPES,
  areaTerrain: AREA_TERRAIN,
  moveKinds: MOVE_KINDS,
  moveModes: MOVE_MODES,
  directions: DIRECTIONS,
} as const;
const IMAGE_SUBJECTS = ['scene', 'character', 'npc', 'creature', 'item', 'battle'] as const satisfies readonly ImageSubject[];
const IMAGE_ASPECTS = ['landscape', 'portrait', 'square'] as const satisfies readonly ImageAspect[];
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

// --- battle map building blocks ---

const squaresText = (max: number) =>
  str(max).describe(
    'Squares and rectangles, comma-separated: "F5", "A1:P1" (every square between two corners), "A1:P1, A2:A12". A1 is the top-left square; letters run left to right, numbers top to bottom.',
  );

const terrainSpec = z.strictObject({
  kind: z
    .enum(TERRAIN_KINDS)
    .describe(
      'wall: blocks movement and sight (Total Cover). door: a wall while closed or locked; it replaces any wall on its squares. difficult: rubble, furniture, steep stairs (double cost). shallow-water: shin- to waist-deep (double cost). deep-water: swimming (double cost without a Swim Speed). pit: no walking in or across; fliers cross. hazard: fire, acid, spikes (passable; the app reports who enters). half-cover: crates, a low wall (Half Cover; double cost to cross). three-quarters-cover: an arrow slit, a portcullis (Three-Quarters Cover; impassable). obscured: darkness, thick fog (blocks sight only).',
    ),
  squares: squaresText(300),
  label: str(40).optional().describe('What it is, shown on the map: "crates", "bar counter", "chasm".'),
  door: z.enum(DOOR_STATES).optional().describe('kind "door" only: open, closed (default) or locked.'),
});

const placeSpec = z.strictObject({
  name: str(40).describe('A place you will narrate: "the balcony", "the altar".'),
  squares: squaresText(200),
});

const mapSpec = z.strictObject({
  name: str(60).optional().describe('What the battlefield is, e.g. "Smugglers\' cellar".'),
  width: int(4, 40).describe('Columns of 5-ft squares, lettered A, B, C… from the left. Most rooms: 10–20.'),
  height: int(4, 40).describe('Rows of 5-ft squares, numbered 1, 2, 3… from the top.'),
  terrain: z.array(terrainSpec).max(40).optional().describe("Everything that isn't open floor. Map only what the hero can perceive."),
  places: z.array(placeSpec).max(12).optional().describe('Named places you will narrate; positions can name them.'),
});

const speedsSpec = z.strictObject({
  walk: int(0, 200).optional(),
  fly: int(0, 300).optional(),
  swim: int(0, 200).optional(),
  climb: int(0, 200).optional(),
  burrow: int(0, 200).optional(),
  hover: z.boolean().optional().describe('It can hover (stays aloft while Prone or Incapacitated).'),
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
  position: str(120)
    .optional()
    .describe(
      'Battle map: where it starts — a square ("E5"; for Large and bigger, the top-left square of its space), a place ("the balcony"), or one square per creature ("E5, F5, G5"). Omit to let the app place it.',
    ),
  elevation_ft: int(0, 500).optional().describe('Battle map: feet above the ground (a flier, a creature on a ledge). Default 0.'),
  size: z.enum(SIZES).optional().describe('Battle map size. Default: from the SRD stat block, else Medium.'),
  speeds: speedsSpec.optional().describe('Speeds in feet. Default: from the SRD stat block, else walk 30.'),
  reach_ft: int(5, 60).optional().describe('Longest melee reach in feet. Default: from the SRD stat block, else 5.'),
  hidden: z
    .boolean()
    .optional()
    .describe("The hero hasn't noticed it (an ambusher, an invisible foe): kept off the player's tracker, map and log until update_combat reveal."),
});

const areaFields = {
  shape: z.enum(AREA_SHAPES),
  size_ft: int(5, 500)
    .optional()
    .describe('Sphere and Cylinder: the radius. Cone and Line: the length. Cube: the side. Emanation: how far it extends. Not for "squares".'),
  width_ft: int(5, 60).optional().describe('Line width (default 5).'),
  height_ft: int(5, 500).optional().describe('Cylinder height (default 40).'),
  at: str(80)
    .optional()
    .describe(
      'Sphere, Cylinder or a placed Cube: its centre — a square ("G4", its centre), a grid corner written as two diagonal squares ("G4/H5"), or a creature. Cone or Line from no creature: the square it starts in.',
    ),
  from: str(80)
    .optional()
    .describe(
      "Who makes it. Cones, Lines, Emanations and a Cube \"originating from you\" come out of this creature's space; for the other shapes the result gives the distance and line of sight from it.",
    ),
  toward: str(80).optional().describe('Cone, Line, or a Cube from a creature: the square or creature it aims at, or a direction ("north-east").'),
  squares: str(300).optional().describe('shape "squares": exactly these squares — "N-foot square" ground effects (Entangle, Grease) or odd shapes: "G7:J10".'),
  include_origin: z.boolean().optional().describe('Include the creature it comes from (Cone, Line, Cube, Emanation; excluded by default).'),
};

const moveSpec = z.strictObject({
  who: str(80).describe('The creature: a name ("Goblin 2"), or "hero".'),
  to: str(80)
    .optional()
    .describe(
      'Where it ends: a square ("E5"; for Large and bigger, the top-left square of its space), a creature (it ends within its reach of that creature by the cheapest route), or a place ("the balcony"). Not needed for a push.',
    ),
  kind: z
    .enum(MOVE_KINDS)
    .optional()
    .describe(
      'move (default): its own movement on its own turn. off-turn: its own movement outside its turn (a readied move, a legendary action). forced: pushed, pulled or shoved — no movement spent, no Opportunity Attacks, stops at walls and creatures. teleport: no path, no Opportunity Attacks; an occupied square shifts it to the nearest open one. place: no rules (arrivals, a climb or jump you ruled on, corrections).',
    ),
  via: str(120).optional().describe('Squares to pass through on the way, in order: "D5, D3". Otherwise the route that provokes the fewest Opportunity Attacks, then the shortest.'),
  partial: z.boolean().optional().describe("If it can't get all the way this turn, move it as far as it can toward `to`."),
  prefer: z.enum(['safest', 'shortest']).optional().describe('safest (default): fewest Opportunity Attacks, then shortest. shortest: ignore them (a mindless rush).'),
  dash: z.boolean().optional().describe('It takes the Dash action now: extra movement equal to its Speed this turn.'),
  dash_again: z.boolean().optional().describe('A second Dash this turn (Cunning Action, a second action).'),
  disengage: z.boolean().optional().describe('It takes the Disengage action: no Opportunity Attacks against its movement for the rest of its turn.'),
  stay_prone: z.boolean().optional().describe('A Prone creature crawls (double cost) instead of standing up first for half its Speed.'),
  mode: z
    .enum(MOVE_MODES)
    .optional()
    .describe('fly: use its Fly Speed (ignores ground terrain and pits; needed to change height). Default walk (swimming is automatic in deep water).'),
  elevation_ft: int(0, 500).optional().describe('Feet above the ground where it ends (mode fly, teleport or place). Walking keeps its height.'),
  push: z
    .strictObject({
      distance_ft: int(5, 120),
      away_from: str(80).optional().describe('A creature or square it is pushed straight away from.'),
      toward: str(80).optional().describe('A creature or square it is pulled straight toward.'),
      direction: z.enum(DIRECTIONS).optional(),
    })
    .optional()
    .describe('kind "forced": a straight push or pull (Shove, Thunderwave, the Push mastery). Give one of away_from, toward or direction.'),
  max_ft: int(5, 1000).optional().describe('kind "teleport": its range (Misty Step 30).'),
  budget_ft: int(5, 400).optional().describe('kind "off-turn": how far it may move (default its Speed).'),
  spend_ft: int(0, 400).optional().describe('kind "place": movement it spends this turn (a climb or jump you ruled on).'),
  declined: z
    .array(str(80))
    .max(8)
    .optional()
    .describe('Repeating a move that stopped for Opportunity Attacks: the creatures there that let it go. The others count as having used their Reaction.'),
});

const damageTypes = z.array(str(30)).max(13);
const otherSpeed = int(5, 120).optional();

/** The mechanical side of a transformation or one of its stages (transform_character). */
const transformationChanges = {
  features_add: z
    .array(
      z.strictObject({
        name: str(80),
        description: str(2000).describe('Rules text: what it does, and its limits or price.'),
        uses_max: int(1, 20).optional(),
        recharge: z.enum(RECHARGES).optional(),
      }),
    )
    .max(6)
    .optional()
    .describe('Powers and drawbacks, added to the sheet as transformation features. Reusing the name of one of its own features rewrites that feature.'),
  defenses_add: z
    .strictObject({
      resistances: damageTypes.optional().describe('Damage types, e.g. ["Necrotic"].'),
      immunities: damageTypes.optional(),
      vulnerabilities: damageTypes.optional(),
      condition_immunities: z.array(str(30)).max(15).optional().describe('Conditions, e.g. ["Poisoned"].'),
    })
    .optional()
    .describe('Defenses it grants. Ones the hero already has are kept as they are.'),
  darkvision: int(10, 300).optional().describe('Darkvision range in feet (a longer one the hero already has is kept).'),
  other_speeds: z
    .strictObject({ fly: otherSpeed, swim: otherSpeed, climb: otherSpeed, burrow: otherSpeed })
    .optional()
    .describe('Speeds in feet (a faster one the hero already has is kept).'),
  speed_change: int(-30, 30).optional().describe('Change to walking speed in feet, e.g. 10 or -10.'),
  size: z.enum(SIZES).optional(),
  ability_changes: z
    .array(z.strictObject({ ability: abilityEnum, change: int(-6, 6) }))
    .max(6)
    .optional()
    .describe('Ability score changes (scores stay within 1–30; a Constitution change also changes the HP maximum).'),
};

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
    attacker: str(80)
      .optional()
      .describe('With is_attack, on a battle map: who attacks. The result adds the distance to `target`, reach, line of sight and cover.'),
    target: str(80).optional().describe('With is_attack, on a battle map: who is attacked (a name, or "hero").'),
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

  transform_character: z.strictObject({
    action: z.enum(['begin', 'advance', 'end']),
    name: str(80).describe('The transformation, e.g. "Vampirism" or "Lycanthropy" (advance and end match it by name).'),
    summary: str(400).optional().describe('begin (required), advance (optional): one or two sentences — what the hero is becoming, and what it costs.'),
    origin: z
      .enum(['accepted', 'imposed'])
      .optional()
      .describe('begin (required): "accepted" = the player chose it in the fiction; "imposed" = the consequence of a knowing choice (Consequences campaigns only).'),
    player_chose_it: z
      .boolean()
      .optional()
      .describe('true only when the player has explicitly chosen this change in the fiction. Required for origin "accepted", and to advance a stage in Offered campaigns.'),
    stage: str(80).optional().describe('begin: the first stage, if it unfolds in stages; advance (required): the new stage, e.g. "Stage 2: the hunger".'),
    how_it_ends: str(300).optional().describe('How it could end: a cure, a ritual, a price. Required for imposed transformations.'),
    ...transformationChanges,
    features_remove: z.array(str(80)).max(6).optional().describe("advance: this transformation's own features the new stage takes away."),
    reason: str(200).describe('What happened in the fiction, shown in the log: "Bitten by Count Varo", "Drank from the Moonwell".'),
  }),

  start_combat: z.strictObject({
    encounter_name: str(80).optional(),
    combatants: z.array(combatantSpec).min(1).max(12).describe('Everyone except the hero, who is added automatically.'),
    player_surprised: z.boolean().optional().describe('The hero is surprised: Disadvantage on their Initiative roll.'),
    map: mapSpec
      .optional()
      .describe('Play this fight on a battle map (see the battle-maps table rule). Omit it to run the fight in the theater of the mind.'),
    hero_position: str(40).optional().describe('Battle map: where the hero starts — a square or a place. Default: placed by the app.'),
  }),

  update_combat: z.strictObject({
    action: z.enum(['next_turn', 'damage', 'heal', 'add', 'remove', 'conditions', 'defeat', 'note', 'reveal', 'hide']),
    target: str(80).optional().describe('Combatant name ("Goblin 2") or id. Required for every action except next_turn and add.'),
    amount: int(0, 9999).optional().describe('Damage or healing (from a roll).'),
    conditions_add: z.array(conditionInput).max(6).optional(),
    conditions_remove: z.array(str(60)).max(6).optional(),
    combatant: combatantSpec.optional().describe('For action "add": the newcomers (with `position` on a battle map).'),
    note: str(400).optional().describe('For action "note": a private note for yourself (never shown to the player).'),
  }),

  end_combat: z.strictObject({
    summary: str(300).describe('How the fight ended, in a sentence.'),
    xp_award: int(0, 1_000_000).optional().describe('Total XP for the encounter (XP campaigns only).'),
  }),

  move_tokens: z.strictObject({
    moves: z
      .array(moveSpec)
      .min(1)
      .max(12)
      .optional()
      .describe(
        'Usually one: the creature whose turn it is. Several for one push that moves many creatures, or for placing tokens. Applied in order; a move that stops for an Opportunity Attack ends the batch.',
      ),
    reactions_used: z
      .array(str(80))
      .max(12)
      .optional()
      .describe(
        'Creatures that just used their Reaction on something else (Shield, Counterspell, a readied action): no Opportunity Attacks from them until their next turn starts.',
      ),
  }),

  update_map: z.strictObject({
    create: mapSpec
      .optional()
      .describe('Put the running fight on a battle map. With replace: true, swap the current map for a new one (a new room).'),
    replace: z.boolean().optional(),
    positions: z
      .array(z.strictObject({ who: str(80), at: str(60).describe('A square or a place.') }))
      .max(24)
      .optional()
      .describe('With create: where creatures stand. Everyone else is placed automatically.'),
    remove: z.boolean().optional().describe('Take the map away: the fight goes on in the theater of the mind.'),
    terrain_add: z.array(terrainSpec).max(20).optional(),
    terrain_clear: z
      .array(str(300))
      .max(10)
      .optional()
      .describe('Squares or ranges to clear of all terrain ("F5", "A1:C3"), or a terrain label ("crates").'),
    doors: z
      .array(z.strictObject({ at: str(60).describe("The door's square or label."), state: z.enum(DOOR_STATES) }))
      .max(8)
      .optional()
      .describe('Open, close or lock doors.'),
    places_add: z.array(placeSpec).max(8).optional(),
    places_remove: z.array(str(40)).max(8).optional(),
    creatures: z
      .array(
        z.strictObject({
          who: str(80).describe('A name, or "hero".'),
          size: z.enum(SIZES).optional(),
          speeds: speedsSpec
            .optional()
            .describe('New speeds (NPCs), or speeds granted to the hero for now (the Fly spell: {"fly": 60, "hover": true}).'),
          reach_ft: int(5, 60).optional(),
          speed_change_ft: int(-120, 120)
            .optional()
            .describe('An ongoing change to all its speeds: Haste +30 on a 30-ft Speed, Slow -15, Ray of Frost -10; 0 clears it.'),
        }),
      )
      .max(12)
      .optional()
      .describe("Change a creature's size, speeds or reach (Enlarge, a new form, Ray of Frost, Haste)."),
    effects_end: z.array(str(60)).max(8).optional().describe('Lasting areas that ended, by label ("Web").'),
  }),

  resolve_area: z.strictObject({
    label: str(40).describe('What it is, shown on the map and in the log: "Fireball", "Fire Breath".'),
    ...areaFields,
    range_ft: int(5, 1000).optional().describe("The effect's range: refused when its centre is farther than this from `from`."),
    lasting: z
      .boolean()
      .optional()
      .describe('It stays on the map until update_map effects_end (Web, Fog Cloud, Spirit Guardians). Otherwise it is shown until this turn ends.'),
    terrain: z
      .array(z.enum(AREA_TERRAIN))
      .max(3)
      .optional()
      .describe('lasting only: what it does to its squares (Web: difficult + obscured; Spike Growth: difficult + hazard; Fog Cloud: obscured).'),
    elevation_ft: int(0, 500).optional().describe('Height of its centre or base above the ground (default: the height of `from`, else 0).'),
  }),

  check_map: z.strictObject({
    from: str(80)
      .optional()
      .describe(
        'A creature or square to measure from. Alone: the distance to everyone and, for a creature, the best cover it can reach this turn (add `to` for line of sight, cover and reach).',
      ),
    to: z.array(str(80)).min(1).max(8).optional().describe('Creatures or squares to measure to: distance, line of sight, cover and reach, both ways.'),
    path_to: str(80)
      .optional()
      .describe(
        'With `from` a creature: can it get to this square, creature or place this turn? Route, cost, Opportunity Attacks it would provoke, and the closest it can get.',
      ),
    area: z.strictObject(areaFields).optional().describe('Preview an area of effect: who it would catch, without showing it to the player.'),
    show: z.boolean().optional().describe('Draw the whole map as text: terrain, places, effects and every creature.'),
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
    ambition: z
      .boolean()
      .optional()
      .describe('true for an ambition: a goal the player set for the hero themselves (found a guild, take the throne). Not a checklist — track its progress on a progress clock.'),
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

  show_image: z.strictObject({
    subject: z
      .enum(IMAGE_SUBJECTS)
      .describe('scene = a place; character = the hero; npc = another person; creature; item; battle = a fight (painted atmospherically, never as a tactical map).'),
    title: str(80).describe('A short caption shown with the picture, e.g. "The drowned bell tower".'),
    prompt: str(1500).describe(
      "A vivid, specific visual description: who and what is in frame, the setting, light, mood and composition. No text, captions, labels, maps or interface elements. The app adds the campaign's art style, and the hero's look from the sheet when they're in frame.",
    ),
    aspect: z.enum(IMAGE_ASPECTS).optional().describe('landscape (scenes, battles), portrait (people, creatures) or square (items). Default: by subject.'),
    hero_in_frame: z
      .boolean()
      .optional()
      .describe('Whether the hero is in the picture. Default: yes for character and battle, otherwise when the title or prompt names them.'),
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
    "Roll dice for the DM's side of the table: NPC and monster attacks, damage, saving throws and checks; random tables; secret checks. The app rolls with real randomness and logs the result (secret rolls go behind the DM screen). For a d20 test give the full expression with its modifier (\"1d20+4\") plus `dc` (the DC, or the target's AC) and `advantage` if any; the result says whether it meets the target. Do NOT use it for the hero's own checks, saves, attacks, damage or initiative — use request_player_roll so the player rolls. Never narrate a result before this returns. On a battle map, give `attacker` and `target` with an attack: the result adds the distance, reach, line of sight and cover the map shows, and warns when a melee attacker isn't in reach.",
  request_player_roll:
    "Ask the player to roll for their hero: ability checks, skill checks, saving throws, attack rolls, damage, death saving throws (and initiative outside start_combat). The app applies the sheet's modifiers and the hero's own conditions, armor and traits (e.g. Disadvantage while Poisoned, an automatic failure for a Paralyzed hero's Dexterity save, Halfling Luck, a Champion's wider critical range — the result says what it applied), rolls per the player's roll mode — instantly, after they tap Roll, or from their physical dice — and returns the total and, with `dc`, success or failure. Call it only when the outcome is uncertain and failure matters; decide the DC and the stakes first and put the stakes in `reason`. For attacks set `dc` to the target's AC (a natural 20 is a Critical Hit, a natural 1 always misses); `attack_name` can be a sheet attack, a spell the hero knows, or another weapon with `ability`. Don't use it for NPC or monster rolls (roll_dice), and don't roll initiative when a fight starts — start_combat does that.",
  update_character:
    "Change the hero's character sheet: HP (damage, healing, temporary HP), conditions, exhaustion, spell slots, concentration, limited-use features, inventory, money, XP, Heroic Inspiration, spells, ability scores (Ability Score Improvements, feats), skill / saving throw / tool proficiencies, languages, AC and speed. Batch several sections in one call. Amounts must come from rolls (roll_dice / request_player_roll results) or fixed rules values — never invented. Returns what changed, warnings (no slot left, not enough gold, item not found) and the hero's new status. Don't use it for NPCs or monsters (update_combat), rests (take_rest), leveling up (level_up) or transformations (transform_character).",
  take_rest:
    "The hero takes a Short Rest (1 hour: may spend Hit Dice to heal; short-rest features recharge) or a Long Rest (8 hours: all HP, spent Hit Dice and spell slots return; one Exhaustion level is removed). For a short rest the player chooses which Hit Dice to spend unless their dice roll automatically. Use only when the hero actually rests and the time passes; never during combat. Narrate any interruption yourself — don't call this if the rest is interrupted early.",
  level_up:
    "Advance the hero one level in a class (for multiclassing, a new class with its hit_die). Applies HP (fixed average by default), Hit Dice, proficiency bonus, spell slots and the class features you list, and returns reminders of choices the player must make (subclass, feats, new spells). Use at story milestones in milestone campaigns, or once the hero has enough XP in XP campaigns. One level per call; then tell the player what improved and ask about their choices.",
  transform_character:
    "Begin, advance or end a transformation — a lasting, story-driven change to who the hero is (vampirism, lycanthropy, a fey mark, a celestial blessing). One call applies the whole change atomically: transformation features, damage resistances, immunities and vulnerabilities, condition immunities, Darkvision and other speeds, walking speed, size and ability scores, recorded on the sheet with its stage and how it could end. `begin` with origin \"accepted\" only after the player has explicitly chosen it in the fiction (player_chose_it: true); origin \"imposed\" only when the campaign's transformations rule is Consequences, after clear warnings, and always with how_it_ends. Give it real costs as well as powers, balanced like homebrew against SRD comparables. `advance` moves it to a new stage and adds traits (features_remove takes its own away); in Offered campaigns only when the player chose it. `end` (a cure, a reversal, a bargain fulfilled) removes everything it granted. Refused when the transformations rule doesn't allow the change. Not for temporary effects (spells, conditions: update_character), ordinary boons or magic items (create_homebrew, update_character), or leveling (level_up).",
  start_combat:
    'Start an encounter when a fight actually begins. Adds the hero automatically, adds each group of combatants ("Goblin" with count 3 becomes Goblin 1–3), rolls NPC initiative, has the player roll the hero\'s initiative, and returns the turn order. Use real values (AC, HP, initiative bonus) from the stat block — get_entry it if unsure. With `map` the fight is played on a battle map: its size in 5-ft squares (A1 is the top-left; letters run left to right, numbers top to bottom), walls, doors and terrain as squares and ranges ("A1:P1"), named places, and where the hero and each group start (`hero_position`, `position`: a square or a place). Anything you leave out is placed automatically, and an SRD stat block supplies size, speed and reach. Map input is checked before anyone rolls. Mark creatures the hero hasn\'t noticed with `hidden`. Don\'t use it for a single blow that settles a scene without a fight. Only one combat can be active.',
  update_combat:
    'Change the active combat. `next_turn` when the current turn ends (on a battle map the result says where the next creature stands and how far it can move); `damage` / `heal` an NPC or monster by `amount` (from a roll); `conditions` to add or remove conditions on an NPC; `defeat` when a combatant falls, flees or surrenders; `remove` to take one out of the order (and off the map); `add` reinforcements via `combatant` (with `position` on a battle map); `reveal` a hidden creature once the hero notices it (it attacks, is found, steps into view) and `hide` one that slips out of sight — hidden creatures stay off the player\'s tracker, map and log, with or without a map; `note` to record a private DM note about a combatant (never shown to the player). Targets are names ("Goblin 2") or ids. The hero\'s HP and conditions are NOT changed here — use update_character.',
  end_combat:
    'End the active combat as soon as the fighting stops (foes defeated, fled or surrendered, or the hero escaped), with a one-line summary. In XP campaigns pass `xp_award` (total XP for the defeated foes); it is ignored in milestone campaigns.',
  move_tokens:
    'Move creatures on the battle map by the rules. The app finds the route (fewest Opportunity Attacks, then shortest; or yours via `via`), charges the movement — Difficult Terrain, other creatures\' spaces and crawling cost double, deep water costs double without a Swim Speed — and refuses an illegal move with the reason, the closest square it can reach, and whether Dash would get there. `to` can be a square, a creature (it ends within reach of it) or a place. Each creature moves on its own turn (kind "move", refused for anyone else: call update_combat next_turn first); readied moves and legendary actions use kind "off-turn", shoves and pushes "forced", teleports "teleport", arrivals and corrections "place". A Prone creature stands first unless stay_prone. A move stops on the square where leaving a creature\'s reach provokes an Opportunity Attack: if the hero can take it, the app asks the player there and then and tells you the answer — don\'t ask again; for a monster or NPC, roll its attack, then repeat the same call to finish the move (add `declined` for any that let it go). Moves run in order and a stop ends the batch. Move the hero only as the player declared, or by forced movement — the player usually moves the hero on the map. Returns where each creature ended, what it cost, what is left, and who is now within reach.',
  update_map:
    'Set up or change the battle map of the active combat. `create` puts the running fight on a map (`replace: true` swaps it for a new room): its size in 5-ft squares, walls, doors and terrain as squares and ranges ("A1:P1"; A1 is the top-left), named places, and `positions` (anyone left out is placed automatically). `terrain_add` / `terrain_clear` and `doors` change the map as the fiction changes it (a door opens, a wall collapses — moves never open doors); `places_add` / `places_remove` name the places you narrate; `creatures` changes a creature\'s size, speeds, reach or an ongoing speed change (Enlarge, the Fly spell, Haste, Ray of Frost); `effects_end` removes lasting areas; `remove` takes the map away. Each call is all-or-nothing. Map only what the hero can perceive and add the rest when it is found. `create` is refused when the campaign\'s battle maps are Off. Use move_tokens for movement and resolve_area for areas of effect.',
  resolve_area:
    'Resolve an area of effect on the battle map — a spell, breath weapon, explosion or aura — and show it to the player. Give the shape and size from the effect\'s text and either `from` (the creature it comes from; aim cones, lines and cubes with `toward`) or `at` (the centre: a square "G4", a corner "G4/H5", or a creature). Returns exactly who is inside, each one\'s cover against it (Half: +2, Three-Quarters: +5 to Dexterity saves), who Total Cover shields, the distance from `from`, and a warning when the hero or an ally is caught. The app\'s rules: a square counts when its centre is inside; spheres and cylinders are round; cones and lines are measured like movement; an Emanation surrounds its creature (and moves with it if lasting). With `lasting` the area stays on the map (Web, Fog Cloud, Spirit Guardians) until update_map effects_end, and `terrain` makes its squares difficult, obscured or hazardous. Then roll the saves for exactly the creatures it lists (the hero\'s with request_player_roll). A player\'s [Area: …] note names the parameters to use. Never decide who is in an area by eye.',
  check_map:
    'Ask the battle map a question without changing anything: the distance between creatures or squares, with line of sight, cover and reach both ways; whether a creature can get to a square, creature or place this turn (route, cost, Opportunity Attacks it would provoke, the closest it can get); who an area would catch, without showing it to the player; what cover a creature can reach this turn; or a text drawing of the whole map. <game_state> already lists positions, distances from the hero and who is within reach — use this for anything else. Never estimate distances, reach or cover yourself.',
  lookup_rules:
    "Search the rules: SRD 5.2.1, the player's imported books (every one switched on in their Library), and this campaign's homebrew. Returns matching rules sections, spells, monsters, items and more, with excerpts. Use it whenever you're unsure of a rule, spell, monster or item — especially imported content you may not know. Don't use it for story facts (search_memory) or the hero's own abilities (get_character_sheet).",
  get_entry:
    'Get the full text of one rules entry by name: a spell, monster stat block, magic item, feat, condition, class feature, rules section, or homebrew. Use when you know the name; use lookup_rules to search.',
  get_character_sheet:
    "Get the hero's full current character sheet: abilities, saves, skills, attacks, spells and slots, features and their uses, inventory, money, personality and backstory. The per-turn status line is usually enough; use this for detail — e.g. to check an item or spell the player says they have.",
  create_homebrew:
    "Save new or modified rules content you are introducing — a spell, magic item, monster, boon, feat, condition or rule change — before it affects play, so the player can read it in their compendium and veto it. Improvise freely whenever the story calls for something made for this moment (a unique reward, a monster variant, a fey bargain, a strange boon). Balance it against named SRD comparables of similar level, rarity or CR and explain why in balance_notes. Only within the campaign's homebrew-freedom setting (refused when homebrew is off). Don't use it for ordinary story facts (update_journal) or for official rules, which are already in the compendium.",
  update_homebrew:
    "Revise or retire homebrew this campaign created — after a player veto, a balance problem, or a story change. Explain why in `reason` (the player sees it). Retire with status 'retired' instead of deleting.",
  update_journal:
    "Record or update the campaign's memory: NPCs, locations, factions, items, lore, events, rulings and notes. Call it when a new named NPC, place, faction or notable item appears, when something important about one changes (an NPC dies, a place is cleared), and whenever you make a rules ruling (kind 'ruling') so you stay consistent. Entries are matched by kind + name. Mark anything the hero hasn't learned with secret: true. Don't use it for quests (update_quest) or threats on a timer (update_clocks).",
  update_quest:
    "Create or update a quest the hero knows about — a rumor, an active quest and its objectives, completion or failure. Matched by title. Add objectives as the hero learns them and mark them done; set status 'completed', 'failed' or 'abandoned' when it ends. Keep your private plans in secret_notes. For an ambition — a big goal the player set for the hero (found a guild, take the throne) — set ambition: true, add objectives only for concrete steps the hero has identified themselves (never a checklist of your own), and track its progress on a progress clock.",
  update_clocks:
    "Create or advance progress clocks: fronts and threats that advance off-screen, countdowns, long projects, and an ambition's progress (6–12 segments by its scale; advance it only for accomplishments the hero earned, and back for setbacks). A new clock needs `segments` (4, 6 or 8 is typical) and a `consequence`. Advance threats when time passes, the hero fails or ignores them, or a complication fits. When a clock fills, its consequence happens: narrate it, then mark the clock resolved. Secret clocks are hidden from the player.",
  search_memory:
    "Search the campaign's memory: journal entries, quests, earlier session recaps and your private notes. Use before reintroducing an NPC, place or thread from an earlier session, or when the player mentions something you don't see in context. Not for rules (lookup_rules).",
  set_scene:
    "Update the scene header the player sees: location, region, time of day, in-world date, weather, mood (omit fields that didn't change). With new_scene: true the app runs a scene check against the tension dial and may return 'altered' or 'interrupted' plus a twist to build the scene around. tension_change is applied first: +1 when the last scene slipped out of the hero's control, −1 when they took charge. Call it when the hero arrives somewhere new, time skips, or conditions change.",
  show_image:
    "Have an illustration painted for the story log: you write the picture, the player's OpenAI image model paints it. Returns at once and the picture appears in the log when it's ready — keep narrating, and don't describe the picture or wait for it. Use it only as the illustrations rule allows (the campaign notes, or a later app note): when the player asks to see something, and — with key moments on — at most about once per scene for a key moment (arriving somewhere new, a big reveal, a fight about to start). Never for routine beats. If illustrations aren't available the result says why; don't mention pictures unless the player asked for one.",
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
  'transform_character',
  'start_combat',
  'update_combat',
  'end_combat',
  'move_tokens',
  'update_map',
  'resolve_area',
  'check_map',
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
  'show_image',
  'consult_oracle',
];

/** Tools that read but never change game state (or commit randomness): safe to regenerate after. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set<ToolName>([
  'lookup_rules',
  'get_entry',
  'get_character_sheet',
  'search_memory',
  'check_map',
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

/**
 * Status text while a tool streams in or runs (never reveals secrets). `opts.isSecret` marks free text the player
 * mustn't see — a roll's purpose that names a creature the hero hasn't noticed — so it stays behind the screen.
 */
export function toolActivity(name: string, input?: unknown, opts: { isSecret?: (text: string) => boolean } = {}): string {
  switch (name) {
    case 'roll_dice': {
      if (input === undefined) return 'Rolling dice…';
      const secret = (input as { secret?: boolean }).secret === true;
      // An attack on a battle map may come from a hidden creature: never name anyone.
      if (field(input, 'attacker')) return secret ? 'Rolling dice behind the screen…' : 'Rolling an attack…';
      const purpose = field(input, 'purpose');
      return purpose && !secret && !opts.isSecret?.(purpose) ? `Rolling: ${purpose}…` : 'Rolling dice behind the screen…';
    }
    case 'request_player_roll':
      return 'Calling for a roll…';
    case 'update_character':
      return 'Updating your character sheet…';
    case 'take_rest':
      return 'Resting…';
    case 'level_up':
      return 'Leveling up…';
    case 'transform_character':
      return 'The change takes hold…';
    case 'start_combat':
      return 'Rolling initiative…';
    case 'update_combat':
      return 'Running the fight…';
    case 'end_combat':
      return 'The dust settles…';
    case 'move_tokens':
      return 'Moving on the battle map…';
    case 'update_map':
      return 'Laying out the battlefield…';
    case 'resolve_area':
      return 'Measuring the blast…';
    case 'check_map':
      return 'Studying the battle map…';
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
    case 'show_image':
      return 'Sketching the picture…';
    case 'consult_oracle':
      return 'Consulting the oracle…';
    default:
      return 'Working…';
  }
}
