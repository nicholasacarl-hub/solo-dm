/**
 * transform_character: begin, advance or end a transformation (vampirism, lycanthropy, a celestial
 * blessing) within the campaign's transformations rule. The engine applies the whole change
 * atomically (src/engine/transform.ts); this handler enforces the table rule and the player's
 * consent, logs a prominent line for the player, and tells the DM exactly what changed.
 *
 * - off: nothing begins or advances (an active transformation may still end: the hero goes back
 *   to as built).
 * - offered: nothing changes unless the player chose it — no imposed transformations, and both a
 *   beginning and a new stage need player_chose_it: true.
 * - consequences: imposed transformations too, always with a story path back (how_it_ends).
 */
import {
  activeTransformations,
  advanceTransformation,
  beginTransformation,
  characterStatusLine,
  endTransformation,
  findTransformation,
  type TransformationChanges,
  type TransformationOptions,
  type TransformationResult,
} from '@/engine';
import { nameKey } from '@/lib/id';
import type { Character, Transformation, TransformationsMode } from '@/types';
import { transformationsMode } from '../modes';
import type { ToolInput } from './definitions';
import {
  changesOf,
  defined,
  logTool,
  mutateCharacter,
  ok,
  requireCampaign,
  requireCharacter,
  ToolInputError,
  warningsOf,
  type ToolContext,
  type ToolOutcome,
} from './context';

type Input = ToolInput<'transform_character'>;

const NOTHING = 'Nothing changed.';

// ---------------------------------------------------------------------------
// Validation and the table rule
// ---------------------------------------------------------------------------

const MECHANICS = ['features_add', 'features_remove', 'defenses_add', 'darkvision', 'other_speeds', 'speed_change', 'size', 'ability_changes'] as const;

function given(input: Input, fields: readonly (keyof Input)[]): string[] {
  return fields.filter((f) => input[f] !== undefined).map(String);
}

/** Fields that don't belong to the action, and fields the action needs. */
function checkShape(input: Input): void {
  const misplaced =
    input.action === 'begin'
      ? given(input, ['features_remove'])
      : input.action === 'advance'
        ? given(input, ['origin'])
        : given(input, ['summary', 'origin', 'stage', 'how_it_ends', ...MECHANICS]);
  if (misplaced.length) {
    const hint =
      input.action === 'end'
        ? ' `end` takes only name and reason: it undoes everything the transformation granted. Use update_character afterwards for anything that lingers.'
        : input.action === 'advance'
          ? ' The origin is set when a transformation begins.'
          : ' A new transformation has no features of its own to remove yet.';
    throw new ToolInputError(`${input.action}: ${misplaced.join(', ')} ${misplaced.length > 1 ? "don't" : "doesn't"} apply.${hint} ${NOTHING}`);
  }
  if (input.action === 'begin') {
    const missing = [!input.summary && 'summary', !input.origin && 'origin'].filter(Boolean);
    if (missing.length) throw new ToolInputError(`begin needs ${missing.join(' and ')}. ${NOTHING}`);
  }
  if (input.action === 'advance' && !input.stage) throw new ToolInputError(`advance needs the new stage. ${NOTHING}`);
}

const OFF = `Transformations are off in this campaign: the hero stays as built and changes only through normal leveling. ${NOTHING} (An active transformation may still end. The player can change this rule in the table rules.)`;

/** Why the campaign's transformations rule (or missing consent) refuses this change, or null. */
function transformationRefusal(mode: TransformationsMode, input: Input): string | null {
  if (input.action === 'end') return null;
  if (mode === 'off') return OFF;
  if (input.action === 'advance') {
    if (mode === 'offered' && input.player_chose_it !== true) {
      return `In this campaign a transformation only changes when the player chooses it. ${NOTHING} Present the next stage in the fiction as a choice, and call again with player_chose_it: true once they take it.`;
    }
    return null;
  }
  if (input.origin === 'imposed') {
    if (mode !== 'consequences') {
      return `This campaign's transformations rule is Offered: nothing changes unless the player chooses it, so a transformation can't be imposed. ${NOTHING} Offer it in the fiction instead — a temptation, a bargain, a curse with a choice — and begin it with origin "accepted" once they choose it.`;
    }
    if (!input.how_it_ends) return `An imposed transformation always needs a story path to resist, reverse or cure it: give how_it_ends. ${NOTHING}`;
    return null;
  }
  if (input.player_chose_it !== true) {
    return `An accepted transformation begins only after the player has explicitly chosen it in the fiction. ${NOTHING} Offer it, let them decide, then call again with player_chose_it: true.`;
  }
  return null;
}

/** The transformation an advance or end refers to, or a clear error. */
function requireActive(hero: Character, name: string): Transformation {
  const found = findTransformation(hero, name);
  if (found) return found;
  const active = activeTransformations(hero).map((t) => t.name);
  throw new ToolInputError(`The hero has no active transformation named "${name}" (active: ${active.join(', ') || 'none'}). ${NOTHING}`);
}

// ---------------------------------------------------------------------------
// Applying it
// ---------------------------------------------------------------------------

function changesFrom(input: Input): TransformationChanges {
  const d = input.defenses_add;
  const features = input.features_add?.map((f) => ({
    name: f.name,
    description: f.description,
    ...(f.uses_max ? { uses: { max: f.uses_max, recharge: f.recharge ?? 'long' } } : {}),
  }));
  const defenses = d
    ? defined({ resistances: d.resistances, immunities: d.immunities, vulnerabilities: d.vulnerabilities, conditionImmunities: d.condition_immunities })
    : undefined;
  return defined({
    features,
    defenses,
    darkvision: input.darkvision,
    otherSpeeds: input.other_speeds,
    speedChange: input.speed_change,
    size: input.size,
    abilityChanges: input.ability_changes,
  });
}

function apply(input: Input, c: Character, opts: TransformationOptions): TransformationResult {
  switch (input.action) {
    case 'begin':
      return beginTransformation(
        c,
        { name: input.name, summary: input.summary ?? '', origin: input.origin ?? 'accepted', ...defined({ stage: input.stage, howItEnds: input.how_it_ends }), ...changesFrom(input) },
        opts,
      );
    case 'advance':
      return advanceTransformation(
        c,
        input.name,
        { stage: input.stage ?? '', ...defined({ summary: input.summary, howItEnds: input.how_it_ends, removeFeatures: input.features_remove }), ...changesFrom(input) },
        opts,
      );
    case 'end':
      return endTransformation(c, input.name, opts);
  }
}

function headline(input: Input, before: Transformation | undefined, t: Transformation): string {
  if (input.action === 'begin') return `Transformation: ${t.name} begins${t.stage ? ` — ${t.stage}` : ''}`;
  if (input.action === 'advance') return `Transformation: ${t.name} — ${before?.stage ?? 'begun'} → ${t.stage ?? ''}`;
  return `Transformation ended: ${t.name}`;
}

const ORIGIN_TEXT: Record<Transformation['origin'], string> = { accepted: 'chosen by the hero', imposed: 'imposed by the story' };

/** The expandable detail of the log card (markdown). */
/** What changed, without the engine's opening event (the headline says it). */
function changeLines(result: TransformationResult): string[] {
  return changesOf(result.events)
    .slice(1)
    .map((e) => `- ${e.message}`);
}

function logDetail(input: Input, t: Transformation, result: TransformationResult): string {
  const changes = changeLines(result);
  const parts = [
    input.action === 'end' ? '' : t.summary,
    input.action === 'begin' ? `**Origin:** ${ORIGIN_TEXT[t.origin]}` : '',
    changes.length ? `**${input.action === 'end' ? 'Undone' : 'Changes'}:**\n${changes.join('\n')}` : '',
    input.action !== 'end' && t.howItEnds ? `**How it could end:** ${t.howItEnds}` : '',
    `**Why:** ${input.reason}`,
  ];
  return parts.filter(Boolean).join('\n\n');
}

function reply(input: Input, t: Transformation, result: TransformationResult, hero: Character): string {
  const changes = changeLines(result);
  const warnings = warningsOf(result.events).map((e) => `Warning: ${e.message}`);
  const lines = [...changes, ...warnings];
  if (input.action !== 'end' && t.howItEnds) lines.push(`How it could end: ${t.howItEnds}`);
  lines.push(
    input.action === 'end'
      ? 'Narrate what the hero is left with; anything that lingers (a scar, a memory, a remnant power) goes through update_character.'
      : 'Narrate the change in the fiction — its costs as well as its powers — and let it matter in play. The player sees it on their sheet.',
  );
  lines.push(`Status: ${characterStatusLine(hero)}`);
  return lines.join('\n');
}

export async function transformCharacterTool(input: Input, ctx: ToolContext): Promise<ToolOutcome> {
  const store = ctx.deps.store();
  const campaign = requireCampaign(store);
  const hero = requireCharacter(store);
  const mode = transformationsMode(campaign.settings);
  // Off refuses anything new outright, before any detail of the call matters.
  if (mode === 'off' && input.action !== 'end') throw new ToolInputError(OFF);
  checkShape(input);
  const refused = transformationRefusal(mode, input);
  if (refused) throw new ToolInputError(refused);

  const before = input.action === 'begin' ? undefined : requireActive(hero, input.name);
  if (input.action === 'begin') {
    const duplicate = activeTransformations(hero).find((t) => nameKey(t.name) === nameKey(input.name));
    if (duplicate) throw new ToolInputError(`${duplicate.name} is already active (${duplicate.stage ?? 'no stage'}): advance it to a new stage instead. ${NOTHING}`);
  }
  const opts: TransformationOptions = {
    session: store.activeSession?.number ?? campaign.sessionCount,
    now: ctx.deps.now(),
    newId: () => ctx.deps.newId(),
  };
  const result = await mutateCharacter(ctx, (c) => apply(input, c, opts));
  const t = result.transformation;
  if (!t) throw new ToolInputError(`${warningsOf(result.events).map((e) => e.message).join(' ')} ${NOTHING}`.trim());

  const summary = headline(input, before, t);
  await logTool(ctx, 'transform_character', 'transform', summary, { detail: logDetail(input, t, result), refId: t.id });
  return ok(`${summary}.\n${reply(input, t, result, result.character)}`);
}
