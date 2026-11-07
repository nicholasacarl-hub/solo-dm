/**
 * Option metadata for campaign settings: labels plus a one-line explanation of every choice,
 * tone presets, safety-topic presets, cover art choices and the defaults for a new campaign.
 */
import {
  SRD_SOURCE_ID,
  type CampaignSettings,
  type Difficulty,
  type HomebrewFreedom,
  type NarrationLength,
  type PlayerRollMode,
  type RulesFidelity,
  type TransformationsMode,
} from '@/types';
import { ART_STYLE_PRESETS, toneArtStylePreset, type ArtStylePreset } from '@/images';

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  description: string;
}

export const RULES_FIDELITY_OPTIONS: readonly ChoiceOption<RulesFidelity>[] = [
  { value: 'strict', label: 'Strict', description: 'Rules as written; the DM looks things up.' },
  { value: 'balanced', label: 'Balanced', description: 'Rules as written with quick rulings.' },
  { value: 'narrative', label: 'Narrative', description: 'Rule of cool, consistently applied.' },
];

export const HOMEBREW_OPTIONS: readonly ChoiceOption<HomebrewFreedom>[] = [
  { value: 'none', label: 'None', description: 'Published rules only. No new spells, items or monsters.' },
  { value: 'light', label: 'Light', description: 'Small touches: a tweaked monster, a one-of-a-kind trinket.' },
  { value: 'moderate', label: 'Moderate', description: 'New spells, items, foes and boons when the story calls.' },
  { value: 'wild', label: 'Wild', description: 'The DM invents freely, still balanced against the rules.' },
];

export const DIFFICULTY_OPTIONS: readonly ChoiceOption<Difficulty>[] = [
  { value: 'story', label: 'Story', description: 'Gentle. Failure means setbacks, rarely death.' },
  { value: 'standard', label: 'Standard', description: 'Fair fights by the book. Death is possible.' },
  { value: 'hard', label: 'Hard', description: 'Cunning foes, scarcer rests, real risk.' },
  { value: 'brutal', label: 'Brutal', description: 'Merciless. Plan well or perish.' },
];

export const NARRATION_OPTIONS: readonly ChoiceOption<NarrationLength>[] = [
  { value: 'brief', label: 'Brief', description: 'A few tight sentences, then it’s your move.' },
  { value: 'standard', label: 'Standard', description: 'A paragraph or two each turn.' },
  { value: 'rich', label: 'Rich', description: 'Lush, detailed scenes. Slower and costs more.' },
];

export const ROLL_MODE_OPTIONS: readonly ChoiceOption<PlayerRollMode>[] = [
  { value: 'auto', label: 'Auto', description: 'The app rolls for you instantly.' },
  { value: 'prompt', label: 'Tap to roll', description: 'You tap to roll each check, save and attack.' },
  { value: 'physical', label: 'Physical dice', description: 'Roll your own dice and type in the result.' },
];

export type LevelingChoice = 'milestone' | 'xp';
export const LEVELING_OPTIONS: readonly ChoiceOption<LevelingChoice>[] = [
  { value: 'milestone', label: 'Milestones', description: 'Level up when the story reaches a milestone.' },
  { value: 'xp', label: 'Experience points', description: 'Earn XP and level up at the rules’ thresholds.' },
];

export const TRANSFORMATION_OPTIONS: readonly ChoiceOption<TransformationsMode>[] = [
  { value: 'off', label: 'Off', description: 'Your hero stays as you built them and changes only by leveling up.' },
  {
    value: 'offered',
    label: 'Offered — you always choose',
    description: 'Bargains, blessings and curses may tempt you, but nothing changes unless you choose it in the story.',
  },
  {
    value: 'consequences',
    label: 'Consequences can stick',
    description:
      'Choices you make knowingly can change your hero even if you’d rather they didn’t. There’s always a way to resist, reverse or cure it.',
  },
];

/** Campaigns made before transformations existed have no setting: they are 'offered'. */
export const DEFAULT_TRANSFORMATIONS: TransformationsMode = 'offered';

export function transformationsMode(settings: Pick<CampaignSettings, 'transformations'>): TransformationsMode {
  return settings.transformations ?? DEFAULT_TRANSFORMATIONS;
}

/** Short summary labels ("Transformations: offered"). */
export const TRANSFORMATION_SHORT: Record<TransformationsMode, string> = {
  off: 'off',
  offered: 'offered (you choose)',
  consequences: 'consequences can stick',
};

export type DmRollsChoice = 'hidden' | 'shown';
export const DM_ROLLS_OPTIONS: readonly ChoiceOption<DmRollsChoice>[] = [
  { value: 'hidden', label: 'Behind the screen', description: 'The DM rolls in secret; you can reveal rolls later.' },
  { value: 'shown', label: 'In the open', description: 'Every DM roll appears in the log as it happens.' },
];

// ---------------------------------------------------------------------------
// Tone
// ---------------------------------------------------------------------------

export type TonePresetId = 'heroic' | 'grim' | 'swashbuckling' | 'cosmic' | 'fairy-tale' | 'intrigue';

export interface TonePreset {
  id: TonePresetId;
  label: string;
  description: string;
}

export const TONE_PRESETS: readonly TonePreset[] = [
  { id: 'heroic', label: 'Heroic fantasy', description: 'Bold heroes, high stakes, light winning out.' },
  { id: 'grim', label: 'Grim & gritty', description: 'Scarce resources, hard choices, wounds that linger.' },
  { id: 'swashbuckling', label: 'Swashbuckling adventure', description: 'Daring escapes, rivals and treasure maps.' },
  { id: 'cosmic', label: 'Cosmic horror', description: 'Creeping dread and truths best left unknown.' },
  { id: 'fairy-tale', label: 'Fairy-tale whimsy', description: 'Talking beasts, strange bargains, gentle wonder.' },
  { id: 'intrigue', label: 'Political intrigue', description: 'Factions, secrets, words sharper than swords.' },
];

/** The tone text stored on the campaign for a preset (the DM reads it verbatim). */
export function toneText(preset: TonePreset): string {
  return `${preset.label}: ${preset.description.charAt(0).toLowerCase()}${preset.description.slice(1)}`;
}

/** The preset a stored tone came from, if any (also accepts the bare label). */
export function findTonePreset(tone: string): TonePreset | undefined {
  const t = tone.trim().toLowerCase();
  return TONE_PRESETS.find((p) => toneText(p).toLowerCase() === t || p.label.toLowerCase() === t);
}

export function tonePreset(id: TonePresetId): TonePreset {
  return TONE_PRESETS.find((p) => p.id === id) ?? TONE_PRESETS[0];
}

/** Short label for summaries: the preset label, or the custom text. */
export function toneLabel(tone: string): string {
  return findTonePreset(tone)?.label ?? tone.trim();
}

// ---------------------------------------------------------------------------
// Art style (illustrations)
// ---------------------------------------------------------------------------

/** For each style, the alternatives that sit well beside it (a cosmic horror table isn't offered "storybook"). */
const ART_STYLE_ALTERNATIVES: Record<string, readonly string[]> = {
  painterly: ['heroic', 'storybook', 'ink', 'gritty'],
  heroic: ['painterly', 'adventure', 'storybook', 'ink'],
  gritty: ['ink', 'painterly', 'eerie', 'courtly'],
  storybook: ['painterly', 'ink', 'adventure', 'heroic'],
  eerie: ['ink', 'gritty', 'painterly', 'courtly'],
  adventure: ['heroic', 'painterly', 'storybook', 'ink'],
  courtly: ['painterly', 'ink', 'gritty', 'heroic'],
  ink: ['painterly', 'gritty', 'storybook', 'eerie'],
};

/** A few art styles to suggest for a tone: the one that suits it first, then alternatives that fit beside it. */
export function artStyleSuggestions(tone: string): ArtStylePreset[] {
  const match = toneArtStylePreset(tone);
  const alternatives = (ART_STYLE_ALTERNATIVES[match.id] ?? []).flatMap((id) => ART_STYLE_PRESETS.filter((p) => p.id === id));
  return [match, ...alternatives];
}

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

export const SAFETY_PRESETS: readonly string[] = [
  'Graphic violence',
  'Gore',
  'Sexual content',
  'Sexual violence',
  'Harm to children',
  'Animal cruelty',
  'Self-harm',
  'Torture',
  'Spiders & insects',
  'Body horror',
  'Drowning',
  'Claustrophobia',
  'Bigotry',
  'Slavery',
];

// ---------------------------------------------------------------------------
// Cover art (save-slot cards)
// ---------------------------------------------------------------------------

export const COVER_EMOJIS: readonly string[] = [
  '🏮', '🗡️', '🛡️', '🐉', '🏰', '🌲', '🌊', '⛰️',
  '🔮', '📜', '🕯️', '💀', '👑', '🗝️', '🌙', '⚓',
  '🦉', '🍄', '🔥', '❄️', '🏜️', '🧭', '🐺', '🦊',
  '🔔', '⛵', '☄️', '📚', '⛏️', '🐪', '🎭', '🌹',
];

export interface CoverColor {
  name: string;
  value: string;
}

export const COVER_COLORS: readonly CoverColor[] = [
  { name: 'Ember', value: '#e8a33d' },
  { name: 'Crimson', value: '#d4544b' },
  { name: 'Rose', value: '#d4699a' },
  { name: 'Violet', value: '#8b75e8' },
  { name: 'Sky', value: '#4f8fd6' },
  { name: 'Teal', value: '#2f9e9a' },
  { name: 'Moss', value: '#5fa35a' },
  { name: 'Gold', value: '#c9a227' },
  { name: 'Slate', value: '#7d8796' },
];

export const DEFAULT_COVER_EMOJI = '🏮';
export const DEFAULT_COVER_COLOR = COVER_COLORS[0].value;

/** A translucent tint of a cover color over the current surface (no gradients). */
export function coverTint(color: string, percent = 22): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

// ---------------------------------------------------------------------------
// Defaults & names
// ---------------------------------------------------------------------------

/** Settings for a brand-new campaign. */
export function defaultCampaignSettings(): CampaignSettings {
  return {
    tone: toneText(TONE_PRESETS[0]),
    setting: '',
    rulesFidelity: 'balanced',
    homebrewFreedom: 'moderate',
    difficulty: 'standard',
    narrationLength: 'standard',
    playerRollMode: 'prompt',
    showDmRolls: false,
    milestoneLeveling: true,
    enabledSources: [SRD_SOURCE_ID],
    lines: [],
    veils: [],
    playerNotes: '',
    transformations: DEFAULT_TRANSFORMATIONS,
    // artStyle stays unset in the wizard (it follows the tone); creating the campaign fills it in.
  };
}

const NAME_ADJECTIVES = [
  'Ashen', 'Drowned', 'Hollow', 'Silver', 'Ember', 'Sleeping', 'Gilded', 'Broken',
  'Whispering', 'Crimson', 'Last', 'Iron', 'Wandering', 'Forgotten', 'Thorned', 'Starless',
];
const NAME_NOUNS = [
  'Crown', 'Lantern', 'Choir', 'Gate', 'Tide', 'Oath', 'Throne', 'Road',
  'Bell', 'Compass', 'Vigil', 'Garden', 'Ballad', 'Key', 'Mask', 'Pact',
];

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length) % items.length];
}

/** A random evocative campaign name such as "The Ashen Crown" (UI flavor only, not game state). */
export function suggestCampaignName(avoid?: string, random: () => number = Math.random): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const name = `The ${pick(NAME_ADJECTIVES, random)} ${pick(NAME_NOUNS, random)}`;
    if (name !== avoid) return name;
  }
  return 'The Ember Road';
}
