/**
 * The words sent to the image model: the campaign's art style, how the subject is framed, the DM's
 * description, the hero's look when the hero is in the picture, and guardrails (no text, maps or UI).
 * Pure functions, no I/O.
 */
import type { Campaign, Character, ImageSubject } from '@/types';
import { safeEnd } from '@/lib/text';

// ---------------------------------------------------------------------------
// Art styles
// ---------------------------------------------------------------------------

export interface ArtStylePreset {
  id: string;
  label: string;
  /** The text prepended to every picture's prompt. */
  style: string;
}

/** Used when nothing else fits: the spec's house style. */
export const DEFAULT_ART_STYLE = 'painterly fantasy illustration, muted palette, dramatic lighting';

export const ART_STYLE_PRESETS: readonly ArtStylePreset[] = [
  { id: 'painterly', label: 'Painterly', style: DEFAULT_ART_STYLE },
  { id: 'heroic', label: 'Heroic oil', style: 'heroic fantasy oil painting, rich warm colors, golden light, sweeping vistas' },
  { id: 'gritty', label: 'Dark & gritty', style: 'dark gritty fantasy painting, desaturated earthy palette, harsh low light, rough brushwork' },
  { id: 'storybook', label: 'Storybook', style: 'storybook watercolor illustration, soft pastel palette, gentle glowing light' },
  { id: 'eerie', label: 'Eerie', style: 'eerie atmospheric illustration, sickly muted colors, deep shadows, fog' },
  { id: 'adventure', label: 'Bright adventure', style: 'vibrant adventure illustration, bold saturated colors, sunlit and windswept' },
  { id: 'courtly', label: 'Renaissance', style: 'Renaissance-style oil painting, candlelit interiors, deep jewel tones, fine detail' },
  { id: 'ink', label: 'Ink & wash', style: 'ink and wash illustration, loose linework, limited palette with one accent color' },
];

function preset(id: string): ArtStylePreset {
  return ART_STYLE_PRESETS.find((p) => p.id === id) ?? ART_STYLE_PRESETS[0];
}

/** Words in a campaign's tone that point at a style (presets and custom tones alike). */
const TONE_STYLES: readonly { words: RegExp; preset: string }[] = [
  { words: /cosmic|horror|dread|eldritch|creep|haunt|gothic/i, preset: 'eerie' },
  { words: /grim|gritty|dark|bleak|brutal/i, preset: 'gritty' },
  { words: /fairy|whimsy|whimsical|cozy|gentle|light-?hearted|storybook/i, preset: 'storybook' },
  { words: /swashbuckl|pirate|adventure|daring|pulp/i, preset: 'adventure' },
  { words: /intrigue|political|court|noble|scheme/i, preset: 'courtly' },
  { words: /heroic|high fantasy|epic|legend/i, preset: 'heroic' },
];

/** The art style preset that suits a campaign's tone (Painterly when nothing matches). */
export function toneArtStylePreset(tone: string): ArtStylePreset {
  const match = TONE_STYLES.find((t) => t.words.test(tone));
  return preset(match?.preset ?? 'painterly');
}

/** The art style that suits a campaign's tone. */
export function defaultArtStyle(tone: string): string {
  return toneArtStylePreset(tone).style;
}

/** The campaign's own art style, else one that suits its tone. */
export function campaignArtStyle(campaign: Pick<Campaign, 'settings'>): string {
  return campaign.settings.artStyle?.trim() || defaultArtStyle(campaign.settings.tone ?? '');
}

// ---------------------------------------------------------------------------
// Framing and guardrails
// ---------------------------------------------------------------------------

export const SUBJECT_FRAMING: Record<ImageSubject, string> = {
  scene: 'A wide establishing shot of the place, showing its scale, light and atmosphere.',
  character:
    'A character portrait from the waist up, the figure filling the frame with an expressive face, against a simple background that hints at where they are.',
  npc: 'A character portrait from the waist up, the figure filling the frame with an expressive face, against a simple background that hints at where they are.',
  creature: 'The creature in full view in its surroundings, showing its size, anatomy and menace.',
  item: 'A detailed still life of the object, close up on a plain surface, showing its materials and craftsmanship.',
  battle:
    'A dynamic action scene in the middle of the fight, with motion, impact and a dramatic angle. An illustration, not a map, grid or top-down battle plan.',
};

export const IMAGE_GUARDRAILS =
  'Do not include any text, letters, numbers, captions, speech bubbles, signatures or watermarks. ' +
  'No user interface, frames or borders. Not a map, diagram, chart or game board.';

/** Caps keep a runaway description from crowding out the style and the guardrails. */
const MAX_DESCRIPTION = 2400;
const MAX_HERO = 900;
const MAX_STYLE = 300;
const MAX_AVOID = 400;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, safeEnd(t, max - 1)).trimEnd()}…` : t;
}

function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

export interface ImagePromptInput {
  /** The DM's vivid, specific description of the picture. */
  prompt: string;
  subject: ImageSubject;
  artStyle?: string;
  /** The hero's appearance, when the hero is in frame. */
  heroAppearance?: string;
  /** Topics the picture must not show (the campaign's lines and veils). */
  avoid?: readonly string[];
}

/** The full prompt sent to the image model: art style + subject framing + description + guardrails. */
export function buildImagePrompt(input: ImagePromptInput): string {
  const style = clip(input.artStyle ?? '', MAX_STYLE) || DEFAULT_ART_STYLE;
  const hero = clip(input.heroAppearance ?? '', MAX_HERO);
  const avoid = clip((input.avoid ?? []).map((t) => t.trim()).filter(Boolean).join(', '), MAX_AVOID);
  return [
    `Art style: ${sentence(style)}`,
    SUBJECT_FRAMING[input.subject],
    sentence(clip(input.prompt, MAX_DESCRIPTION)),
    hero && `The hero in this picture: ${sentence(hero)}`,
    avoid && `Never show: ${sentence(avoid)}`,
    IMAGE_GUARDRAILS,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// The hero's look, from the sheet
// ---------------------------------------------------------------------------

/** "Wizard 3 (Evoker) and Fighter 1" without the levels: "wizard (Evoker) and fighter". */
function classesText(character: Pick<Character, 'classes'>): string {
  return character.classes
    .map((c) => `${c.name.toLowerCase()}${c.subclass ? ` (${c.subclass})` : ''}`)
    .join(' and ');
}

/** "an elf (high elf lineage) wizard (Evoker)", with the size when it isn't Medium. */
function heroKind(character: Character): string {
  const species = character.species.trim().replace(/^\w/, (ch) => ch.toLowerCase());
  const size = character.size && character.size !== 'Medium' ? `${character.size.toLowerCase()} ` : '';
  const kind = [species, classesText(character)].filter(Boolean).join(' ');
  if (!kind) return '';
  const phrase = `${size}${kind}`;
  return `${/^[aeiou]/i.test(phrase) ? 'an' : 'a'} ${phrase}`;
}

/** Weapons, armor, shields and other gear the hero has equipped (attuned items too). */
export function equippedGear(character: Pick<Character, 'inventory'>, limit = 6): string[] {
  return character.inventory
    .filter((item) => item.equipped || item.attuned)
    .map((item) => item.name.trim())
    .filter(Boolean)
    .slice(0, limit);
}

/** Active transformations change how the hero looks ("Vampirism (Stage 1 of 3)"). */
function transformationsText(character: Pick<Character, 'transformations'>): string {
  return (character.transformations ?? [])
    .filter((t) => t.status === 'active')
    .map((t) => (t.stage ? `${t.name} (${t.stage})` : t.name))
    .join(', ');
}

export interface HeroDescriptionOptions {
  /** Add personality traits (for portraits: they show in the expression and pose). */
  personality?: boolean;
}

/**
 * How the hero looks, from the sheet: name and pronouns, species, classes, appearance notes,
 * lasting transformations and equipped gear. Used whenever the hero is in a picture.
 */
export function describeHero(character: Character, opts: HeroDescriptionOptions = {}): string {
  const name = character.name.trim() || 'The hero';
  const pronouns = character.pronouns?.trim() ? ` (${character.pronouns.trim()})` : '';
  const kind = heroKind(character);
  const parts = [`${name}${pronouns}${kind ? `, ${kind}` : ''}`];
  const appearance = character.personality.appearance?.trim();
  if (appearance) parts.push(`Appearance: ${sentence(appearance)}`);
  const changes = transformationsText(character);
  if (changes) parts.push(`Visibly marked by: ${sentence(changes)}`);
  const gear = equippedGear(character);
  if (gear.length > 0) parts.push(`Carrying or wearing: ${sentence(gear.join(', '))}`);
  if (opts.personality) {
    const traits = character.personality.traits?.trim();
    if (traits) parts.push(`Personality, shown in expression and pose: ${sentence(traits)}`);
  }
  return parts.map(sentence).join(' ');
}

/** True when the text mentions the hero by name (their first name is enough). */
function mentionsHero(text: string, character: Pick<Character, 'name'>): boolean {
  const names = [character.name.trim(), character.name.trim().split(/\s+/)[0]].filter((n) => n.length >= 2);
  return names.some((n) => new RegExp(`(^|[^\\p{L}])${escapeRegExp(n)}([^\\p{L}]|$)`, 'iu').test(text));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether the hero is in the picture: always for their portrait ('character') and in battles;
 * otherwise when the DM's title or description names them.
 */
export function heroInFrame(
  request: { subject: ImageSubject; title: string; prompt: string; heroInFrame?: boolean },
  character: Pick<Character, 'name'> | null,
): boolean {
  if (!character) return false;
  if (request.heroInFrame !== undefined) return request.heroInFrame;
  if (request.subject === 'character' || request.subject === 'battle') return true;
  return mentionsHero(`${request.title}\n${request.prompt}`, character);
}

/** The DM-style description of a portrait of the hero, built from the sheet. */
export function portraitDescription(character: Character): string {
  return `A portrait of ${describeHero(character, { personality: true })}`;
}
