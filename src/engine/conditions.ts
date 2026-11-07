/**
 * The 2024 conditions (SRD 5.2.1 Rules Glossary), summarized for the sheet and the DM.
 * Effects are paraphrased from the glossary entries.
 */
import { CONDITION_IDS, type ConditionId } from '@/types';

export interface ConditionInfo {
  id: ConditionId;
  name: string;
  /** One sentence. */
  summary: string;
  /** Bullet-point effects paraphrased from SRD 5.2.1. */
  effects: string[];
}

export const CONDITIONS: Record<ConditionId, ConditionInfo> = {
  blinded: {
    id: 'blinded',
    name: 'Blinded',
    summary: "You can't see, so sight-based checks fail and you fight at a disadvantage.",
    effects: [
      "You can't see, and you automatically fail any ability check that requires sight.",
      'Attack rolls against you have Advantage, and your attack rolls have Disadvantage.',
    ],
  },
  charmed: {
    id: 'charmed',
    name: 'Charmed',
    summary: "You can't bring yourself to harm the charmer, who also finds it easier to sway you.",
    effects: [
      "You can't attack the charmer or target it with damaging abilities or magical effects.",
      'The charmer has Advantage on any ability check to interact with you socially.',
    ],
  },
  deafened: {
    id: 'deafened',
    name: 'Deafened',
    summary: "You can't hear, so hearing-based checks fail.",
    effects: ["You can't hear, and you automatically fail any ability check that requires hearing."],
  },
  exhaustion: {
    id: 'exhaustion',
    name: 'Exhaustion',
    summary: 'Cumulative weariness (levels 1–6) that drags down every D20 Test and your Speed; level 6 is death.',
    effects: [
      'Each time you receive this condition, your Exhaustion level rises by 1; you die at level 6.',
      'Every D20 Test (ability check, attack roll or saving throw) is reduced by 2 × your Exhaustion level.',
      'Your Speed is reduced by 5 feet × your Exhaustion level.',
      'Finishing a Long Rest lowers your Exhaustion level by 1; the condition ends at level 0.',
    ],
  },
  frightened: {
    id: 'frightened',
    name: 'Frightened',
    summary: "Fear makes you falter while its source is in sight, and you won't move toward it.",
    effects: [
      'You have Disadvantage on ability checks and attack rolls while the source of your fear is within line of sight.',
      "You can't willingly move closer to the source of your fear.",
    ],
  },
  grappled: {
    id: 'grappled',
    name: 'Grappled',
    summary: "You're held in place, and you can only fight your grappler effectively.",
    effects: [
      "Your Speed is 0 and can't increase.",
      'You have Disadvantage on attack rolls against any target other than the grappler.',
      "The grappler can drag or carry you, but each foot it moves costs 1 extra foot unless you're Tiny or at least two sizes smaller than it.",
    ],
  },
  incapacitated: {
    id: 'incapacitated',
    name: 'Incapacitated',
    summary: "You can't act, react, speak, or keep your Concentration.",
    effects: [
      "You can't take any action, Bonus Action, or Reaction.",
      'Your Concentration is broken.',
      "You can't speak.",
      "If you're Incapacitated when you roll Initiative, you have Disadvantage on the roll.",
    ],
  },
  invisible: {
    id: 'invisible',
    name: 'Invisible',
    summary: "Others can't see you, which helps your attacks and hinders theirs.",
    effects: [
      "If you're Invisible when you roll Initiative, you have Advantage on the roll.",
      "Effects that require their target to be seen don't affect you unless their creator can somehow see you; what you wear and carry is concealed too.",
      'Attack rolls against you have Disadvantage, and your attack rolls have Advantage — except against a creature that can somehow see you.',
    ],
  },
  paralyzed: {
    id: 'paralyzed',
    name: 'Paralyzed',
    summary: "You're frozen in place and helpless against nearby attackers.",
    effects: [
      'You have the Incapacitated condition.',
      "Your Speed is 0 and can't increase.",
      'You automatically fail Strength and Dexterity saving throws.',
      'Attack rolls against you have Advantage.',
      'Any attack roll that hits you is a Critical Hit if the attacker is within 5 feet of you.',
    ],
  },
  petrified: {
    id: 'petrified',
    name: 'Petrified',
    summary: "You're turned to inanimate stone (or a similar substance): helpless, but very hard to harm.",
    effects: [
      'You and the nonmagical objects you wear and carry become a solid inanimate substance, usually stone; your weight is multiplied by ten and you stop aging.',
      'You have the Incapacitated condition.',
      "Your Speed is 0 and can't increase.",
      'Attack rolls against you have Advantage.',
      'You automatically fail Strength and Dexterity saving throws.',
      'You have Resistance to all damage.',
      'You have Immunity to the Poisoned condition.',
    ],
  },
  poisoned: {
    id: 'poisoned',
    name: 'Poisoned',
    summary: "You're sickened, which hampers your attacks and ability checks.",
    effects: ['You have Disadvantage on attack rolls and ability checks.'],
  },
  prone: {
    id: 'prone',
    name: 'Prone',
    summary: "You're on the ground: you crawl or spend movement to stand, and nearby attackers have the edge.",
    effects: [
      "Your only movement options are to crawl or to spend half your Speed (round down) to stand up, which ends the condition; you can't stand if your Speed is 0.",
      'You have Disadvantage on attack rolls.',
      'An attack roll against you has Advantage if the attacker is within 5 feet of you; otherwise it has Disadvantage.',
    ],
  },
  restrained: {
    id: 'restrained',
    name: 'Restrained',
    summary: "You're bound or held fast: unable to move, easier to hit, and clumsy.",
    effects: [
      "Your Speed is 0 and can't increase.",
      'Attack rolls against you have Advantage, and your attack rolls have Disadvantage.',
      'You have Disadvantage on Dexterity saving throws.',
    ],
  },
  stunned: {
    id: 'stunned',
    name: 'Stunned',
    summary: "You're reeling and can't act or defend yourself well.",
    effects: [
      'You have the Incapacitated condition.',
      'You automatically fail Strength and Dexterity saving throws.',
      'Attack rolls against you have Advantage.',
    ],
  },
  unconscious: {
    id: 'unconscious',
    name: 'Unconscious',
    summary: "You're out cold and unaware: helpless, prone, and open to critical hits from adjacent attackers.",
    effects: [
      "You have the Incapacitated and Prone conditions and drop whatever you're holding; when this condition ends, you remain Prone.",
      "Your Speed is 0 and can't increase.",
      'Attack rolls against you have Advantage.',
      'You automatically fail Strength and Dexterity saving throws.',
      'Any attack roll that hits you is a Critical Hit if the attacker is within 5 feet of you.',
      "You're unaware of your surroundings.",
    ],
  },
};

/** Conditions that include the Incapacitated condition (and therefore break Concentration). */
export const INCAPACITATING_CONDITIONS: ReadonlySet<string> = new Set<string>([
  'incapacitated',
  'paralyzed',
  'petrified',
  'stunned',
  'unconscious',
]);

/** Conditions whose Speed is 0 (2024: Stunned and Incapacitated no longer zero your Speed). */
export const SPEED_ZERO_CONDITIONS: ReadonlySet<string> = new Set<string>([
  'grappled',
  'paralyzed',
  'petrified',
  'restrained',
  'unconscious',
]);

/** Conditions under which you automatically fail Strength and Dexterity saving throws. */
export const AUTO_FAIL_STR_DEX_SAVES: ReadonlySet<string> = new Set<string>([
  'paralyzed',
  'petrified',
  'stunned',
  'unconscious',
]);

const STANDARD = new Set<string>(CONDITION_IDS);

/** Word stems and phrases that mean a standard condition. Checked word by word, in order. */
const SYNONYMS: ReadonlyArray<[RegExp, ConditionId]> = [
  [/\bknocked\s+(?:out|unconscious)\b|\bunconscious(?:ness)?\b|\basleep\b|\bsleeping\b|\bknocked\s*out\b|\bko'?d?\b/, 'unconscious'],
  [/\bprone\b|\bknocked\s+(?:down|over)\b/, 'prone'],
  [/\bblind(?:ed|ness)?\b/, 'blinded'],
  [/\bdeaf(?:ened|ness)?\b/, 'deafened'],
  [/\bcharm(?:ed)?\b/, 'charmed'],
  [/\bexhaust(?:ed|ion)\b|\bfatigued?\b/, 'exhaustion'],
  [/\bfright(?:en(?:ed)?)?\b|\bafraid\b|\bscared\b|\bterrified\b/, 'frightened'],
  [/\bgrappl(?:ed|e|ing)\b|\bgrabbed\b/, 'grappled'],
  [/\bincapacitat(?:ed|e|ion)\b/, 'incapacitated'],
  [/\binvisib(?:le|ility)\b/, 'invisible'],
  [/\bparaly(?:zed|sed|sis|ze|se)\b/, 'paralyzed'],
  [/\bpetrif(?:ied|y|ication)\b|\bturned\s+to\s+stone\b/, 'petrified'],
  [/\bpoison(?:ed)?\b/, 'poisoned'],
  [/\brestrain(?:ed|t)?\b/, 'restrained'],
  [/\bstun(?:ned)?\b/, 'stunned'],
];

/** Map free text ("Poisoned", "knocked prone") to a standard condition id, or null. */
export function normalizeConditionId(input: string): ConditionId | null {
  const text = (typeof input === 'string' ? input : '').toLowerCase().replace(/[_-]+/g, ' ').trim();
  if (!text) return null;
  if (STANDARD.has(text)) return text as ConditionId;
  let best: { id: ConditionId; index: number } | null = null;
  for (const [pattern, id] of SYNONYMS) {
    const match = pattern.exec(text);
    if (match && (best === null || match.index < best.index)) best = { id, index: match.index };
  }
  return best?.id ?? null;
}

/** Whole-input aliases accepted when adding or removing conditions. */
const ALIASES: Record<string, ConditionId> = {
  blind: 'blinded',
  charm: 'charmed',
  deaf: 'deafened',
  exhausted: 'exhaustion',
  fatigue: 'exhaustion',
  fatigued: 'exhaustion',
  afraid: 'frightened',
  scared: 'frightened',
  fear: 'frightened',
  frighten: 'frightened',
  grapple: 'grappled',
  grabbed: 'grappled',
  incapacitate: 'incapacitated',
  invisibility: 'invisible',
  paralysis: 'paralyzed',
  paralysed: 'paralyzed',
  petrify: 'petrified',
  poison: 'poisoned',
  restrain: 'restrained',
  stun: 'stunned',
  asleep: 'unconscious',
  'knocked out': 'unconscious',
  'knocked unconscious': 'unconscious',
  'knocked prone': 'prone',
  'knocked down': 'prone',
};

/**
 * Stricter than normalizeConditionId, for adding/removing conditions: the input must BE a condition
 * ("Poisoned", "knocked prone") or start with a condition's full name ("Frightened of the dragon"),
 * so homebrew names like "Poison Mist" stay homebrew. `detail` is any trailing text.
 */
export function matchStandardCondition(input: string): { id: ConditionId; detail: string } | null {
  const key = (typeof input === 'string' ? input : '').toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!key) return null;
  if (STANDARD.has(key)) return { id: key as ConditionId, detail: '' };
  if (ALIASES[key]) return { id: ALIASES[key], detail: '' };
  for (const id of CONDITION_IDS) {
    if (key.startsWith(id) && /^[\s(:,-]/.test(key.slice(id.length))) {
      const detail = input.trim().slice(id.length).replace(/^[\s(:,-]+|[\s)]+$/g, '');
      return { id, detail };
    }
  }
  return null;
}

/** A stable comparison key for a condition id: the standard id when it is one, else a lowercased name. */
export function conditionKey(id: string): string {
  const lower = id.trim().toLowerCase();
  return STANDARD.has(lower) ? lower : lower.replace(/\s+/g, ' ');
}

/** Display name for a standard or homebrew condition id. */
export function conditionName(id: string): string {
  const key = conditionKey(id);
  if (STANDARD.has(key)) return CONDITIONS[key as ConditionId].name;
  const raw = id.trim().replace(/[_-]+/g, ' ');
  if (!raw) return 'Unknown condition';
  // Keep the author's casing for homebrew names; otherwise capitalize the first letter.
  return /[A-Z]/.test(raw) ? raw : raw.charAt(0).toUpperCase() + raw.slice(1);
}
