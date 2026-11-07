/**
 * Dice: the DM's own rolls (roll_dice) and the player's rolls (request_player_roll), which
 * resolve per the campaign's roll mode — instantly, or through the roll dialog. Player d20 tests
 * take the sheet into account (engine rollSituation): the hero's conditions and armor add
 * Advantage / Disadvantage or fail a save outright, Halfling Luck rerolls a natural 1, and a
 * Champion's wider critical range applies to weapon attacks.
 */
import {
  applyAttackRollRules,
  attackDamageExpression,
  combineAdvantage,
  findAttack,
  isValidDice,
  parseDice,
  recordDeathSave,
  rerollNaturalOne,
  rollD20Test,
  rollDice,
  rollRequestModifier,
  rollSituation,
  type RollSituation,
} from '@/engine';
import type { AdvantageState, Character, D20TestResult, KnownSpell, PlayerRollRequest } from '@/types';
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
  /** The full result, verdict included (for the DM). */
  result: D20TestResult;
  manual: boolean;
  /** Why the roll failed without being rolled (e.g. a Paralyzed hero's Dexterity save). */
  autoFail?: string;
  /** What the sheet changed about the roll, and situational effects for the DM to judge. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Shared formatting
// ---------------------------------------------------------------------------

function verdict(rollType: string, result: D20TestResult): string {
  if (result.dc === undefined || result.success === undefined) return '';
  const target = rollType === 'attack' ? `AC ${result.dc}` : `DC ${result.dc}`;
  if (rollType === 'attack') {
    if (result.isCritical) return ` vs ${target} → CRITICAL HIT (natural ${result.natural ?? 20})`;
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

function sheetAttacks(c: Character): string {
  return c.attacks.map((a) => a.name).join(', ') || 'none';
}

/** A spell the hero knows, by (case- and punctuation-insensitive) name. */
function findKnownSpell(c: Character, name: string): KnownSpell | undefined {
  const spells = c.spellcasting?.spells ?? [];
  const key = nameKey(name);
  const exact = spells.find((s) => nameKey(s.name) === key);
  if (exact) return exact;
  const words = key.split('-').filter(Boolean);
  const loose = spells.filter((s) => words.every((w) => nameKey(s.name).split('-').includes(w)));
  return loose.length === 1 ? loose[0] : undefined;
}

function isUnarmedName(name: string): boolean {
  return /\b(unarmed|punch|kick|fist|headbutt)/i.test(name);
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
      // The engine prices each kind: a sheet attack's own bonus, a known spell's spell attack bonus,
      // an unarmed strike, or `ability` + proficiency for any other weapon.
      const name = req.attackName?.trim();
      if (!name) {
        if (req.ability) return req;
        throw new ToolInputError(
          'An attack roll needs `attack_name`: an attack on the sheet, a spell the hero knows, or another weapon together with `ability`.',
        );
      }
      const attack = findAttack(c, name);
      if (attack) return { ...req, attackName: attack.name };
      const spell = findKnownSpell(c, name);
      if (spell) return { ...req, attackName: spell.name };
      if (req.ability || isUnarmedName(name)) return { ...req, attackName: name };
      throw new ToolInputError(
        `"${name}" is not an attack on the hero's sheet (attacks: ${sheetAttacks(c)}) or a spell they know. For another weapon, call again with \`ability\` ("str", or "dex" for a ranged or finesse weapon); for a spell attack, use the spell's name.`,
      );
    }
    case 'damage': {
      if (req.expression) {
        if (!isValidDice(req.expression)) throw new ToolInputError(`"${req.expression}" is not a valid dice expression.`);
        return req;
      }
      if (!req.attackName) throw new ToolInputError('A damage roll needs `attack_name` or `expression`.');
      const attack = findAttack(c, req.attackName);
      if (!attack) {
        if (isUnarmedName(req.attackName)) return req;
        throw new ToolInputError(
          `"${req.attackName}" is not an attack on the hero's sheet (attacks: ${sheetAttacks(c)}). For a spell or another weapon, give its damage dice in \`expression\` (e.g. "2d6" for one Scorching Ray, "1d8+2" for a longbow).`,
        );
      }
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
      // The DC is fixed by the rules, so the player sees it.
      return { ...req, dc: 10, revealDc: true };
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

const ADV_LABEL: Record<AdvantageState, string> = { normal: 'a normal roll', advantage: 'Advantage', disadvantage: 'Disadvantage' };

/** What the sheet changed about the roll, for the DM: "The sheet adds Disadvantage (Poisoned)…". */
function situationNotes(requested: AdvantageState, final: AdvantageState, situation: RollSituation): string[] {
  const sources = [
    situation.advantage.length ? `Advantage (${situation.advantage.join(', ')})` : '',
    situation.disadvantage.length ? `Disadvantage (${situation.disadvantage.join(', ')})` : '',
  ].filter(Boolean);
  const lines: string[] = [];
  if (sources.length) {
    const asked = requested === 'normal' ? '' : `; you asked for ${ADV_LABEL[requested]}`;
    lines.push(`The hero's sheet adds ${sources.join(' and ')}${asked}, so this is rolled with ${ADV_LABEL[final]} (they don't stack; one of each cancels out).`);
  }
  for (const note of situation.notes) lines.push(`Check: ${note}`);
  return lines;
}

/** A hidden DC stays hidden in the log: the player's roll card shows no target and no verdict. */
function forLog(result: D20TestResult, revealDc: boolean): D20TestResult {
  if (revealDc || result.dc === undefined) return result;
  const { dc: _dc, success: _success, ...shown } = result;
  return shown;
}

/**
 * Roll for the hero per the campaign's roll mode, log the roll card, and return the result.
 * Applies the sheet first (conditions, armor, Luck, critical range — engine rollSituation).
 */
export async function performPlayerRoll(ctx: ToolContext, input: PlayerRollRequest): Promise<PlayerRollOutcome> {
  const store = ctx.deps.store();
  const campaign = requireCampaign(store);
  const character = requireCharacter(store);
  const prepared = prepareRequest(character, input);
  const d20 = D20_TYPES.has(prepared.rollType);
  const situation = rollSituation(character, prepared);
  const request: PlayerRollRequest = d20 ? { ...prepared, advantage: combineAdvantage(prepared.advantage, situation) } : prepared;
  const { modifier, label } = rollRequestModifier(character, request);
  const notes = d20 ? situationNotes(prepared.advantage, request.advantage, situation) : [];

  if (d20 && situation.autoFail) {
    const result: D20TestResult = {
      expression: '',
      total: 0,
      dice: [],
      modifier,
      breakdown: 'automatic failure (not rolled)',
      ...(request.dc !== undefined ? { dc: request.dc } : {}),
      success: false,
    };
    await logTool(ctx, 'request_player_roll', 'condition', `${label}: automatic failure — ${situation.autoFail}`);
    return { request, label, modifier, result, manual: false, autoFail: situation.autoFail, notes };
  }

  const auto = campaign.settings.playerRollMode === 'auto';
  const rolled = auto ? { result: rollLocally(ctx, request, modifier), manual: false } : await rollWithPlayer(ctx, request, modifier, label);
  let result = rolled.result;

  // The player spent Heroic Inspiration in the roll dialog to reroll: this is the roll that counts.
  if (character.heroicInspiration && ctx.deps.store().character?.heroicInspiration === false) {
    notes.push(
      'The player spent Heroic Inspiration to reroll: this is the new roll, which must be used (the first is discarded). Heroic Inspiration is already marked spent — don\'t spend it again.',
    );
  }
  if (d20 && situation.luck && result.natural === 1 && !/\bLuck\b/.test(result.breakdown)) {
    if (rolled.manual) {
      notes.push(`${situation.luck} The player rolled physical dice: ask them to reroll that d20, then call request_player_roll again with the same parameters.`);
    } else {
      result = rerollNaturalOne(result, { rng: ctx.deps.rng });
      notes.push(`${situation.luck} The natural 1 was rerolled; the result above is the new roll.`);
    }
  }

  result = withVerdict(request.rollType, result, request.dc);
  if (request.rollType === 'attack') result = applyAttackRollRules(result, { critRange: situation.critRange });
  if (request.rollType === 'attack' && result.isCritical && (result.natural ?? 20) < 20) {
    notes.push(`A natural ${result.natural} is a Critical Hit for this hero (wider critical range).`);
  }
  const purpose = request.reason ? `${label} — ${truncate(request.reason, 60)}` : label;
  await logRoll(ctx, { actor: 'player', purpose, result: forLog(result, request.revealDc), manual: rolled.manual, rollType: request.rollType });
  return { request, label, modifier, result, manual: rolled.manual, notes };
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
  const { request, result } = outcome;
  if (outcome.autoFail) {
    const target = request.dc === undefined ? '' : ` vs ${request.rollType === 'attack' ? 'AC' : 'DC'} ${request.dc}`;
    return ok([`${outcome.label}: automatic failure${target} — ${outcome.autoFail} No dice were rolled.`, ...outcome.notes].join('\n'));
  }
  const lines = [describeRoll(outcome.label, request.rollType, result)];
  if (outcome.manual) lines.push('(Rolled on the player\'s physical dice.)');
  lines.push(...outcome.notes);
  if (request.rollType === 'death-save') {
    lines.push(await applyDeathSave(ctx, result.natural ?? result.total));
  }
  if (request.rollType === 'attack' && result.isCritical) {
    lines.push('Roll damage with critical: true.');
  }
  if (result.dc !== undefined && !request.revealDc) {
    lines.push('(The DC was hidden: the player sees their total but not the target or the verdict until you narrate it.)');
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
  await logRoll(ctx, { actor: 'dm', purpose: input.purpose, result, secret: input.secret ?? false, rollType: input.is_attack ? 'attack' : undefined });

  const line = describeRoll(input.purpose, rollType, result);
  const secretNote = input.secret ? ' (secret: hidden from the player)' : '';
  return ok([`${line}${secretNote}`, ...notes].join('\n'));
}
