/**
 * Three settings decide how the DM may use transform_character, show_image and the battle map, and each can
 * change mid-session: the campaign's transformations rule and battle-maps rule (Table rules) and the player's
 * illustrations setting (Settings → Illustrations, plus whether an OpenAI key is set up). The frozen system prompt
 * renders the current mode of each as a section; when one changes later, the next turn carries a one-line app note
 * with the new mode's guidance. Nothing earlier is edited (append-only): what the DM was last told is read back from
 * the prompt and the notes already in the transcript.
 */
import {
  BATTLE_MAPS_MODES,
  DEFAULT_IMAGE_SETTINGS,
  type AppSettings,
  type BattleMapsMode,
  type CampaignSettings,
  type TransformationsMode,
} from '@/types';
import type { DmImages } from './deps';

/** off = the player switched illustrations off; unavailable = no OpenAI key (or images can't run). */
export type IllustrationMode = 'off' | 'unavailable' | 'request' | 'moments';

export interface TableModes {
  transformations: TransformationsMode;
  illustrations: IllustrationMode;
  battleMaps: BattleMapsMode;
}

const TRANSFORMATION_MODES: readonly TransformationsMode[] = ['off', 'offered', 'consequences'];
const ILLUSTRATION_MODES: readonly IllustrationMode[] = ['off', 'unavailable', 'request', 'moments'];

/** A campaign's transformations rule (missing in older campaigns = 'offered'). */
export function transformationsMode(settings: Pick<CampaignSettings, 'transformations'>): TransformationsMode {
  return settings.transformations ?? 'offered';
}

/** What the illustrations setting allows right now. A failing availability check counts as unavailable. */
export function illustrationMode(settings: AppSettings, available: DmImages['available']): IllustrationMode {
  const frequency = settings.images?.frequency ?? DEFAULT_IMAGE_SETTINGS.frequency;
  if (frequency === 'off') return 'off';
  if (!canIllustrate(settings, available)) return 'unavailable';
  return frequency === 'moments' ? 'moments' : 'request';
}

function canIllustrate(settings: AppSettings, available: DmImages['available']): boolean {
  try {
    return available(settings).ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Transformations
// ---------------------------------------------------------------------------

const TRANSFORMATION_LABEL: Record<TransformationsMode, string> = { off: 'Off', offered: 'Offered', consequences: 'Consequences' };

const TRANSFORMATION_RULE: Record<TransformationsMode, string> = {
  off: 'The hero stays as built and changes only through normal leveling. Never begin or advance a transformation (you may still end one that is active, with transform_character). Ordinary curses, boons and magic items still work as the other table rules allow.',
  offered:
    'You may present transformations as temptations, bargains, rewards or curses-with-a-choice, but nothing changes unless the player chooses it in the fiction: begin one (origin "accepted", player_chose_it: true) or advance it a stage only after the player has explicitly chosen that.',
  consequences:
    'You may offer transformations as temptations, bargains, rewards or curses-with-a-choice (origin "accepted", player_chose_it: true once the player chooses), and the player\'s knowing choices can also transform the hero even if they\'d rather not — bitten by a vampire lord after ignoring the warnings, a pact signed without reading the terms (origin "imposed"). Telegraph the danger clearly before it lands so the choice is a knowing one, and always leave a story path to resist, reverse or cure it; say what it is in how_it_ends.',
};

const TRANSFORMATION_PRINCIPLES: readonly string[] = [
  'Transformations are lasting changes to who the hero is: vampirism, lycanthropy, a parasite slowly remaking the mind, a celestial blessing, a fey mark.',
  "No quota: the fiction decides how often. Never shoehorn one in where it doesn't fit or make it routine, and never withhold one the player actively pursues and earns.",
  'Every transformation brings real costs and drawbacks along with its powers — a weakness, a hunger, a social price, a slow loss of self — and is balanced like homebrew against named SRD comparables.',
  'Let it unfold in stages when the story supports it (partial, then complete, like a slow metamorphosis), each stage a new choice or consequence.',
  "Respect the player's attachment to the hero they built: the change should deepen the character, not erase them. Know how it could end (a cure, a ritual, a price) and record it in how_it_ends.",
  'Apply every beginning, stage and ending with transform_character, then narrate it: a transformation you only narrate did not happen.',
];

/** The campaign-part section for the transformations rule. */
export function transformationsSection(mode: TransformationsMode): string {
  const lines = [`## Transformations: ${TRANSFORMATION_LABEL[mode]}`, TRANSFORMATION_RULE[mode]];
  if (mode !== 'off') lines.push(...TRANSFORMATION_PRINCIPLES.map((p) => `- ${p}`));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Illustrations
// ---------------------------------------------------------------------------

const ILLUSTRATION_LABEL: Record<IllustrationMode, string> = {
  off: 'Off',
  unavailable: 'Not set up',
  request: 'On request',
  moments: 'Key moments',
};

const PAINTED_IN_BACKGROUND =
  "The picture is painted in the background and appears in the log: keep narrating, and don't describe the picture or wait for it.";

const ILLUSTRATION_RULE: Record<IllustrationMode, string> = {
  off: 'The player has switched illustrations off. Never call show_image. If they ask for a picture, say in one short out-of-character line that illustrations are off in Settings → Illustrations, and describe it in words instead.',
  unavailable:
    "Illustrations need the player's own OpenAI API key, and none is set up. Never call show_image or bring up pictures. If the player asks for one, say in one short out-of-character line that they can add an OpenAI API key in Settings → Illustrations, and describe it in words instead.",
  request: `Call show_image only when the player asks to see something ("show me…", "what does she look like?", in or out of character) — never on your own initiative. ${PAINTED_IN_BACKGROUND}`,
  moments: `Call show_image when the player asks to see something, and on your own for a key moment — arriving somewhere new, a big reveal, a fight about to start — at most about once per scene. Never for routine beats. ${PAINTED_IN_BACKGROUND}`,
};

/** The campaign-part section for the illustrations setting. */
export function illustrationsSection(mode: IllustrationMode): string {
  return `## Illustrations: ${ILLUSTRATION_LABEL[mode]}\n${ILLUSTRATION_RULE[mode]}`;
}

// ---------------------------------------------------------------------------
// Battle maps (spec §5.2)
// ---------------------------------------------------------------------------

const BATTLE_MAPS_LABEL: Record<BattleMapsMode, string> = { off: 'Off', auto: 'When it helps', always: 'Every fight' };

/** A campaign's battle-maps rule (missing = 'auto'). */
export function battleMapsMode(settings: Pick<CampaignSettings, 'battleMaps'>): BattleMapsMode {
  return settings.battleMaps ?? 'auto';
}

const BATTLE_MAPS_RULE: Record<BattleMapsMode, string> = {
  off: "The player prefers the theater of the mind: don't put fights on a battle map (start_combat ignores `map`, and update_map create is refused). Describe distances and positions in words and keep them consistent. A map already on the table stays until that fight ends; you may take it away with update_map remove.",
  auto: "Put a fight on the battle map when positions will matter: several foes, ranged attackers, cover, chokepoints, hazards, area spells — or whenever the player plays tactically. Keep a quick scuffle, a single exchange or a chase in the mind's eye. If the player asks for a map, set one up.",
  always: 'The player loves tactical play: put every fight on a battle map, even a small one (start_combat with `map`, or update_map create for a fight already running).',
};

const BATTLE_MAPS_PRINCIPLES: readonly string[] = [
  'Setting up is one call: start_combat with `map` — its size in 5-ft squares (10–20 a side for most rooms; A1 is the top-left, letters run left to right, numbers top to bottom), walls, doors and terrain as squares and ranges ("A1:P1"), named places ("the balcony"), and where the hero and each group start (`hero_position`, `position`: a square or a place). Anything you leave out is placed for you, and an SRD stat block supplies size, speed and reach.',
  'Draw the battlefield the narration describes, with options for both sides — cover, a chokepoint or high ground, a hazard — and start foes at the distance the scene implies (30–60 ft unless it is an ambush). Map only what the hero can perceive; add the rest when it is found.',
  "The app owns positions and geometry: read distances, reach, cover and who stands where from <game_state> and tool results, or ask check_map. Never estimate them. Its cover is what the map shows; you may still rule on what the map can't show.",
  "On each creature's turn move it with move_tokens, one creature at a time, then update_combat next_turn. `to` can be a creature (it ends within reach) or a place; an illegal move is refused with the closest square it can reach. A melee attack needs the attacker in reach: give roll_dice `attacker` and `target` and it checks.",
  "A move stops where leaving a creature's reach provokes an Opportunity Attack. If the hero can take it, move_tokens asks the player itself and tells you the answer; otherwise roll the monster's attack, then repeat the same move to finish it.",
  'The player moves the hero on the map during their turn; <game_state> reports the moves, any Dash or Disengage, and any Opportunity Attack a move provoked — resolve that first, then finish the move as they declared it (move_tokens who "hero"). Otherwise move the hero only as the player declared, or by forced movement.',
  "Resolve every area of effect with resolve_area (it shows on the map and lists exactly who is caught, with cover), then roll saves for exactly those creatures. A player's [Area: …] note gives the parameters to use.",
  "Creatures the hero hasn't noticed are hidden ([hidden] in <game_state>): roll for them with secret: true, and reveal them with update_combat reveal when they are seen.",
  'Narrate places and features ("behind the crates", "up on the gantry"), not square labels, unless the player talks in squares.',
];

/** The campaign-part section for the battle-maps rule (rendered after the illustrations section). */
export function battleMapsSection(mode: BattleMapsMode): string {
  const lines = [`## Battle maps: ${BATTLE_MAPS_LABEL[mode]}`, BATTLE_MAPS_RULE[mode]];
  if (mode !== 'off') lines.push(...BATTLE_MAPS_PRINCIPLES.map((p) => `- ${p}`));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Mid-session changes: one-line notes (notes are single lines, so parseNotices keeps them whole)
// ---------------------------------------------------------------------------

const NOTICE_PREFIX = 'Setting update — ';
const TRANSFORMATIONS_NOTICE = `${NOTICE_PREFIX}Transformations: `;
const ILLUSTRATIONS_NOTICE = `${NOTICE_PREFIX}Illustrations: `;
const BATTLE_MAPS_NOTICE = `${NOTICE_PREFIX}Battle maps: `;

/** The note for a new transformations rule (with the general guidance when the DM hasn't had it). */
export function transformationsNotice(mode: TransformationsMode, opts: { withPrinciples: boolean }): string {
  const principles = opts.withPrinciples && mode !== 'off' ? TRANSFORMATION_PRINCIPLES : [];
  return `${TRANSFORMATIONS_NOTICE}${TRANSFORMATION_LABEL[mode]}. ${[TRANSFORMATION_RULE[mode], ...principles].join(' ')}`;
}

export function illustrationsNotice(mode: IllustrationMode): string {
  return `${ILLUSTRATIONS_NOTICE}${ILLUSTRATION_LABEL[mode]}. ${ILLUSTRATION_RULE[mode]}`;
}

/** "Setting update — Battle maps: <Label>. <rule> [<principles…>]" (one line; the guidance when the DM hasn't had it). */
export function battleMapsNotice(mode: BattleMapsMode, opts: { withPrinciples: boolean }): string {
  const principles = opts.withPrinciples && mode !== 'off' ? BATTLE_MAPS_PRINCIPLES : [];
  return `${BATTLE_MAPS_NOTICE}${BATTLE_MAPS_LABEL[mode]}. ${[BATTLE_MAPS_RULE[mode], ...principles].join(' ')}`;
}

/** A note written by modeNotices() (superseded by a fresh one whenever a turn is re-sent). */
export function isModeNotice(text: string): boolean {
  return text.startsWith(NOTICE_PREFIX);
}

function noticeMode<M extends string>(text: string, prefix: string, modes: readonly M[], label: Record<M, string>): M | undefined {
  return text.startsWith(prefix) ? modes.find((m) => text.startsWith(`${prefix}${label[m]}.`)) : undefined;
}

/**
 * What the DM was last told about each mode in this session: the prompt's section, overridden by
 * any later note. Undefined when the prompt predates these sections (no baseline: no notes then).
 */
export function modesTold(systemPrompt: string, notices: readonly string[]): Partial<TableModes> {
  const told: Partial<TableModes> = {
    transformations: TRANSFORMATION_MODES.find((m) => systemPrompt.includes(transformationsSection(m))),
    illustrations: ILLUSTRATION_MODES.find((m) => systemPrompt.includes(illustrationsSection(m))),
    battleMaps: BATTLE_MAPS_MODES.find((m) => systemPrompt.includes(battleMapsSection(m))),
  };
  for (const text of notices) {
    told.transformations = noticeMode(text, TRANSFORMATIONS_NOTICE, TRANSFORMATION_MODES, TRANSFORMATION_LABEL) ?? told.transformations;
    told.illustrations = noticeMode(text, ILLUSTRATIONS_NOTICE, ILLUSTRATION_MODES, ILLUSTRATION_LABEL) ?? told.illustrations;
    told.battleMaps = noticeMode(text, BATTLE_MAPS_NOTICE, BATTLE_MAPS_MODES, BATTLE_MAPS_LABEL) ?? told.battleMaps;
  }
  return told;
}

/** Notes for the modes that changed since the DM was last told. */
export function modeNotices(told: Partial<TableModes>, current: TableModes): string[] {
  const notices: string[] = [];
  if (told.transformations && told.transformations !== current.transformations) {
    notices.push(transformationsNotice(current.transformations, { withPrinciples: told.transformations === 'off' }));
  }
  if (told.illustrations && told.illustrations !== current.illustrations) notices.push(illustrationsNotice(current.illustrations));
  if (told.battleMaps && told.battleMaps !== current.battleMaps) {
    notices.push(battleMapsNotice(current.battleMaps, { withPrinciples: told.battleMaps === 'off' }));
  }
  return notices;
}
