/**
 * Two settings decide how the DM may use transform_character and show_image, and both can change
 * mid-session: the campaign's transformations rule (Table rules) and the player's illustrations
 * setting (Settings → Illustrations, plus whether an OpenAI key is set up). The frozen system prompt
 * renders the current mode of each as a section; when one changes later, the next turn carries a
 * one-line app note with the new mode's guidance. Nothing earlier is edited (append-only): what the
 * DM was last told is read back from the prompt and the notes already in the transcript.
 */
import { DEFAULT_IMAGE_SETTINGS, type AppSettings, type CampaignSettings, type TransformationsMode } from '@/types';
import type { DmImages } from './deps';

/** off = the player switched illustrations off; unavailable = no OpenAI key (or images can't run). */
export type IllustrationMode = 'off' | 'unavailable' | 'request' | 'moments';

export interface TableModes {
  transformations: TransformationsMode;
  illustrations: IllustrationMode;
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
// Mid-session changes: one-line notes (notes are single lines, so parseNotices keeps them whole)
// ---------------------------------------------------------------------------

const NOTICE_PREFIX = 'Setting update — ';
const TRANSFORMATIONS_NOTICE = `${NOTICE_PREFIX}Transformations: `;
const ILLUSTRATIONS_NOTICE = `${NOTICE_PREFIX}Illustrations: `;

/** The note for a new transformations rule (with the general guidance when the DM hasn't had it). */
export function transformationsNotice(mode: TransformationsMode, opts: { withPrinciples: boolean }): string {
  const principles = opts.withPrinciples && mode !== 'off' ? TRANSFORMATION_PRINCIPLES : [];
  return `${TRANSFORMATIONS_NOTICE}${TRANSFORMATION_LABEL[mode]}. ${[TRANSFORMATION_RULE[mode], ...principles].join(' ')}`;
}

export function illustrationsNotice(mode: IllustrationMode): string {
  return `${ILLUSTRATIONS_NOTICE}${ILLUSTRATION_LABEL[mode]}. ${ILLUSTRATION_RULE[mode]}`;
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
  };
  for (const text of notices) {
    told.transformations = noticeMode(text, TRANSFORMATIONS_NOTICE, TRANSFORMATION_MODES, TRANSFORMATION_LABEL) ?? told.transformations;
    told.illustrations = noticeMode(text, ILLUSTRATIONS_NOTICE, ILLUSTRATION_MODES, ILLUSTRATION_LABEL) ?? told.illustrations;
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
  return notices;
}
