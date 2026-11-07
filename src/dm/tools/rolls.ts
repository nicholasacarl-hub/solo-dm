/**
 * Dice: the DM's own rolls (roll_dice) and the player's rolls (request_player_roll), which
 * resolve per the campaign's roll mode — instantly, or through the roll dialog.
 */
import {
  attackDamageExpression,
  isValidDice,
  parseDice,
  recordDeathSave,
  rollD20Test,
  rollDice,
  rollRequestModifier,
} from '@/engine';
import type { AdvantageState, Attack, Character, D20TestResult, PlayerRollRequest } from '@/types';
import { nameKey } from '@/lib/id';
import { truncate } from '../narration';
import type { ToolInput } from './definitions';
import {
  eventLines,
  logRoll,
  logTool,
  mutateCharacter,
  ok,
  requireCampaign,
  requireCharacter,
  ToolInputError,
  type ToolContext,
  type ToolOutcome,
} from './context';
import { DmCancelledError } from '../errors';

const D20_TYPES = new Set(['ability', 'skill', 'save', 'attack', 'initiative', 'death-save']);

export interface PlayerRollOutcome {
  request: PlayerRollRequest;
  label: string;
  modifier: number;
  result: D20TestResult;
  manual: boolean;
}

// ---------------------------------------------------------------------------
// Shared formatting
// ---------------------------------------------------------------------------

function verdict(rollType: string, result: D20TestResult): string {
  if (result.dc === undefined || result.success === undefined) return '';
  const target = rollType === 'attack' ? `AC ${result.dc}` : `DC ${result.dc}`;
  if (rollType === 'attack') {
    if (result.isCritical) return ` vs ${target} → CRITICAL HIT (natural 20)`;
    if (result.isFumble) return ` vs ${target} → miss (natural 1)`;
    return ` vs ${target} → ${result.success ? 'hit' : 'miss'}`;
  }
  return ` vs ${target} → ${result.success ? 'success' : 'failure'}`;
}

function naturalNote(rollType: string, result: D20TestResult): string {
  if (rollType === 'attack' || rollType === 'death-save') return '';
  if (result.isCritical) return ' (natural 20)';
  if (result.isFumble) return ' (natural 1)';
  return '';
}

export function describeRoll(label: string, rollType: string, result: D20TestResult): string {
  return `${label}: ${result.total} [${result.breakdown}]${verdict(rollType, result)}${naturalNote(rollType, result)}`;
}

/**
 * Apply the 2024 d20 rules to a result: success is total ≥ DC, except that an attack roll always
 * hits on a natural 20 and always misses on a natural 1.
 */
export function withVerdict(rollType: string, result: D20TestResult, dc: number | undefined): D20TestResult {
  if (dc === undefined) return result;
  let success = result.total >= dc;
  if (rollType === 'attack' && result.isCritical) success = true;
  if (rollType === 'attack' && result.isFumble) success = false;
  return { ...result, dc, success };
}

// ---------------------------------------------------------------------------
// The player's rolls
// ---------------------------------------------------------------------------

function findAttack(c: Character, name: string): Attack {
  const key = nameKey(name);
  const attack = c.attacks.find((a) => nameKey(a.name) === key) ?? c.attacks.find((a) => nameKey(a.name).includes(key));
  if (!attack) {
    const known = c.attacks.map((a) => a.name).join(', ') || 'none';
    throw new ToolInputError(`"${name}" is not an attack on the hero's sheet (attacks: ${known}). Use expression for other damage.`);
  }
  return attack;
}

/** Check the request makes sense for its roll type and fill in what the sheet knows. */
function prepareRequest(c: Character, req: PlayerRollRequest): PlayerRollRequest {
  switch (req.rollType) {
    case 'skill':
      if (!req.skill) throw new ToolInputError('A skill check needs `skill`.');
      return req;
    case 'ability':
    case 'save':
      if (!req.ability) throw new ToolInputError(`A ${req.rollType === 'save' ? 'saving throw' : 'ability check'} needs \`ability\`.`);
      return req;
    case 'attack': {
      if (!req.attackName) throw new ToolInputError('An attack roll needs `attack_name` (an attack on the sheet).');
      return { ...req, attackName: findAttack(c, req.attackName).name };
    }
    case 'damage': {
      if (req.expression) {
        if (!isValidDice(req.expression)) throw new ToolInputError(`"${req.expression}" is not a valid dice expression.`);
        return req;
      }
      if (!req.attackName) throw new ToolInputError('A damage roll needs `attack_name` or `expression`.');
      const attack = findAttack(c, req.attackName);
      // The critical flag doubles the dice once, at roll time.
      return { ...req, attackName: attack.name, expression: attackDamageExpression(c, attack, false) };
    }
    case 'custom':
    case 'hit-die':
      if (!req.expression || !isValidDice(req.expression)) {
        throw new ToolInputError(`A ${req.rollType} roll needs a valid dice \`expression\`.`);
      }
      return req;
    case 'death-save':
      if (c.deathSaves.dead) throw new ToolInputError('The hero is dead; there are no death saves to make.');
      if (c.hp.current > 0) throw new ToolInputError('The hero is not at 0 HP, so no death saving throw is needed.');
      if (c.deathSaves.stable) throw new ToolInputError('The hero is stable; they no longer make death saving throws.');
      return { ...req, dc: 10 };
    default:
      return req;
  }
}

function rollLocally(ctx: ToolContext, req: PlayerRollRequest, modifier: number): D20TestResult {
  const rng = ctx.deps.rng;
  if (D20_TYPES.has(req.rollType)) {
    return rollD20Test(modifier, { advantage: req.advantage, dc: req.dc, rng });
  }
  return rollDice(req.expression ?? '1d20', { rng, critical: req.critical });
}

async function rollWithPlayer(
  ctx: ToolContext,
  req: PlayerRollRequest,
  modifier: number,
  label: string,
): Promise<{ result: D20TestResult; manual: boolean }> {
  const store = ctx.deps.store();
  ctx.status(`Waiting for your roll: ${label}…`, 'waiting-player');
  try {
    const response = await store.requestInteraction({ kind: 'roll', id: ctx.deps.newId(), request: req, modifier, label });
    if (response.kind !== 'roll') throw new ToolInputError('The roll dialog returned an unexpected answer.');
    return { result: response.response.result, manual: response.response.manual };
  } catch (err) {
    if (ctx.signal.aborted) throw new DmCancelledError();
    if (err instanceof ToolInputError) throw err;
    throw new ToolInputError('The player dismissed the roll without rolling. Ask again only if it still matters.');
  } finally {
    ctx.status('Reading the dice…', 'tool');
  }
}

/** Roll for the hero per the campaign's roll mode, log the roll card, and return the result. */
export async function performPlayerRoll(ctx: ToolContext, input: PlayerRollRequest): Promise<PlayerRollOutcome> {
  const store = ctx.deps.store();
  const campaign = requireCampaign(store);
  const character = requireCharacter(store);
  const request = prepareRequest(character, input);
  const { modifier, label } = rollRequestModifier(character, request);

  const rolled =
    campaign.settings.playerRollMode === 'auto'
      ? { result: rollLocally(ctx, request, modifier), manual: false }
      : await rollWithPlayer(ctx, request, modifier, label);

  const result = withVerdict(request.rollType, rolled.result, request.dc);
  const purpose = request.reason ? `${label} — ${truncate(request.reason, 60)}` : label;
  await logRoll(ctx, { actor: 'player', purpose, result, manual: rolled.manual });
  return { request, label, modifier, result, manual: rolled.manual };
}

function toRequest(input: ToolInput<'request_player_roll'>): PlayerRollRequest {
  const req: PlayerRollRequest = {
    rollType: input.roll_type,
    revealDc: input.reveal_dc ?? false,
    advantage: (input.advantage ?? 'normal') as AdvantageState,
    reason: input.reason,
  };
  if (input.ability) req.ability = input.ability;
  if (input.skill) req.skill = input.skill;
  if (input.attack_name) req.attackName = input.attack_name;
  if (input.expression) req.expression = input.expression;
  if (input.dc !== undefined) req.dc = input.dc;
  if (input.critical) req.critical = true;
  return req;
}

async function applyDeathSave(ctx: ToolContext, natural: number): Promise<string> {
  const change = await mutateCharacter(ctx, (c) => recordDeathSave(c, natural));
  const ds = change.character.deathSaves;
  const lines = eventLines(change.events);
  await logTool(ctx, 'request_player_roll', 'hp', `Death save: ${change.outcome} (${ds.successes} ✓ / ${ds.failures} ✗)`);
  const tally = `Death saves now: ${ds.successes} successes, ${ds.failures} failures.`;
  return [`Outcome: ${change.outcome}.`, tally, ...lines].join(' ');
}

export async function requestPlayerRoll(input: ToolInput<'request_player_roll'>, ctx: ToolContext): Promise<ToolOutcome> {
  const outcome = await performPlayerRoll(ctx, toRequest(input));
  const lines = [describeRoll(outcome.label, outcome.request.rollType, outcome.result)];
  if (outcome.manual) lines.push('(Rolled on the player\'s physical dice.)');
  if (outcome.request.rollType === 'death-save') {
    lines.push(await applyDeathSave(ctx, outcome.result.natural ?? outcome.result.total));
  }
  if (outcome.request.rollType === 'attack' && outcome.result.isCritical) {
    lines.push('Roll damage with critical: true.');
  }
  return ok(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// The DM's rolls
// ---------------------------------------------------------------------------

/** The flat modifier when the expression is exactly one d20 plus constants ("1d20+4"); else null. */
export function singleD20Modifier(expression: string): number | null {
  const terms = parseDice(expression);
  const dice = terms.filter((t) => t.kind === 'dice');
  if (dice.length !== 1) return null;
  const [d] = dice;
  if (d.kind !== 'dice' || d.count !== 1 || d.sides !== 20 || d.sign !== 1 || d.keep) return null;
  return terms.reduce((sum, t) => (t.kind === 'flat' ? sum + t.sign * t.value : sum), 0);
}

export async function rollDiceTool(input: ToolInput<'roll_dice'>, ctx: ToolContext): Promise<ToolOutcome> {
  if (!isValidDice(input.expression)) {
    let detail = '';
    try {
      parseDice(input.expression);
    } catch (err) {
      detail = err instanceof Error ? ` ${err.message}` : '';
    }
    throw new ToolInputError(`"${input.expression}" is not a valid dice expression.${detail}`);
  }
  const rng = ctx.deps.rng;
  const d20Modifier = singleD20Modifier(input.expression);
  const notes: string[] = [];
  let result: D20TestResult;
  if (d20Modifier !== null) {
    result = rollD20Test(d20Modifier, { advantage: input.advantage ?? 'normal', dc: input.dc, rng });
  } else {
    if (input.advantage && input.advantage !== 'normal') notes.push('(Advantage applies only to a single-d20 roll; it was ignored.)');
    result = rollDice(input.expression, { rng, critical: input.critical });
  }
  const rollType = input.is_attack ? 'attack' : 'check';
  result = withVerdict(rollType, result, input.dc);
  await logRoll(ctx, { actor: 'dm', purpose: input.purpose, result, secret: input.secret ?? false });

  const line = describeRoll(input.purpose, rollType, result);
  const secretNote = input.secret ? ' (secret: hidden from the player)' : '';
  return ok([`${line}${secretNote}`, ...notes].join('\n'));
}
