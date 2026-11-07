/**
 * What the character's own conditions, gear and traits do to a d20 test (SRD 5.2.1 conditions, Armor,
 * Armor Training, Champion, Halfling): Advantage / Disadvantage sources, automatic failures, a wider
 * critical range, Luck, and situational notes the DM must judge.
 *
 * Use it for every player d20 test, before rolling or opening the roll dialog:
 *
 *   const situation = rollSituation(character, request);
 *   if (situation.autoFail) → don't roll: the test fails (success = false); say why (situation.autoFail).
 *   const advantage = combineAdvantage(request.advantage, situation); // the DM's own state plus the sheet's
 *   … roll with that advantage …
 *   if (situation.luck && result.natural === 1) result = rerollNaturalOne(result, { rng }); // auto mode
 *   if (request.rollType === 'attack') result = applyAttackRollRules(result, { critRange: situation.critRange });
 *   … report situation.advantage / disadvantage / notes in the tool result.
 *
 * combineAdvantage doesn't stack sources, and Advantage plus Disadvantage cancel out, so a DM who already
 * asked for Disadvantage because of Poisoned isn't double-counted.
 */
import type { AdvantageState, Character, PlayerRollRequest } from '@/types';
import { SKILL_ABILITY } from '@/types';
import { nameKey } from '@/lib/id';
import { wornArmor } from './armorData';
import { AUTO_FAIL_STR_DEX_SAVES, conditionKey, conditionName } from './conditions';
import { attackCritRange, findAttack, hasArmorTraining, isIncapacitated } from './rules';

export interface RollSituation {
  /** Sources of Advantage, e.g. "Invisible". */
  advantage: string[];
  /** Sources of Disadvantage, e.g. "Poisoned", "Chain Mail (Stealth)". */
  disadvantage: string[];
  /** Why the roll fails automatically (e.g. a Stunned creature's Dexterity save), else null. */
  autoFail: string | null;
  /** Effects that depend on circumstances the DM must judge ("Frightened: Disadvantage while the source is in sight"). */
  notes: string[];
  /**
   * Weapon and Unarmed Strike attack rolls only: the lowest natural d20 that is a Critical Hit when it
   * is below 20 (Champion's Improved Critical 19, Superior Critical 18). Pass it to applyAttackRollRules.
   */
  critRange?: number;
  /**
   * Halfling Luck: when the d20 shows a 1, the die is rerolled once and the new roll must be used
   * (rerollNaturalOne in auto mode; offer the reroll in the roll dialog).
   */
  luck?: string;
}

/** Halfling's Luck trait (SRD 5.2.1 Halfling): a species trait named "Luck", or a Halfling without the feature list. */
export function hasLuckTrait(c: Character): boolean {
  if (c.features.some((f) => nameKey(f.name) === 'luck' && f.source === 'species')) return true;
  return /\bhalfling\b/i.test(c.species ?? '') && !c.features.some((f) => f.source === 'species');
}

/** Advantage and Disadvantage from any number of sources: one of each cancels out (SRD 5.2.1 Advantage). */
export function combineAdvantage(...states: Array<AdvantageState | RollSituation | undefined>): AdvantageState {
  let adv = false;
  let dis = false;
  for (const s of states) {
    if (!s) continue;
    if (typeof s === 'string') {
      adv ||= s === 'advantage';
      dis ||= s === 'disadvantage';
    } else {
      adv ||= s.advantage.length > 0;
      dis ||= s.disadvantage.length > 0;
    }
  }
  return adv === dis ? 'normal' : adv ? 'advantage' : 'disadvantage';
}

type RollKind = 'attack' | 'check' | 'save' | 'initiative' | 'none';

function rollKind(req: PlayerRollRequest): RollKind {
  switch (req.rollType) {
    case 'attack':
      return 'attack';
    case 'skill':
    case 'ability':
      return 'check';
    case 'save':
      return 'save';
    case 'initiative':
      return 'initiative';
    default:
      return 'none';
  }
}

/** The ability a request's d20 test uses, when the sheet can tell. */
function rollAbility(c: Character, req: PlayerRollRequest): string | null {
  if (req.rollType === 'initiative') return 'dex';
  if (req.rollType === 'skill' || req.rollType === 'ability') return req.ability ?? (req.skill ? SKILL_ABILITY[req.skill] : null);
  if (req.rollType === 'save') return req.ability ?? null;
  if (req.rollType === 'attack') {
    const attack = req.attackName ? findAttack(c, req.attackName) : undefined;
    if (!attack) return req.ability ?? null;
    if (attack.ability === 'finesse') return 'dex';
    return attack.ability === 'spell' ? null : attack.ability;
  }
  return null;
}

/** Conditions, worn armor and traits that affect this roll (see the module comment for how to apply it). */
export function rollSituation(c: Character, req: PlayerRollRequest): RollSituation {
  const situation: RollSituation = { advantage: [], disadvantage: [], autoFail: null, notes: [] };
  // A death saving throw is a D20 Test too, so Luck applies to it.
  if ((rollKind(req) !== 'none' || req.rollType === 'death-save') && hasLuckTrait(c)) {
    situation.luck = 'Luck (Halfling): a natural 1 is rerolled once, and the new roll must be used.';
  }
  const kind = rollKind(req);
  if (kind === 'none') return situation;
  if (kind === 'attack') {
    const critRange = attackCritRange(c, req);
    if (critRange < 20) situation.critRange = critRange;
  }
  const ability = rollAbility(c, req);
  const has = new Set(c.conditions.map((x) => conditionKey(x.id)));
  const name = (id: string) => conditionName(id);

  if (kind === 'attack') {
    for (const id of ['blinded', 'poisoned', 'prone', 'restrained']) if (has.has(id)) situation.disadvantage.push(name(id));
    if (has.has('invisible')) situation.advantage.push(name('invisible'));
    if (has.has('frightened')) situation.notes.push('Frightened: Disadvantage while the source of fear is in sight.');
    if (has.has('grappled')) situation.notes.push('Grappled: Disadvantage against targets other than the grappler.');
    if (has.has('invisible')) situation.notes.push("Invisible: no Advantage against a creature that can see you.");
  }
  if (kind === 'check' || kind === 'initiative') {
    if (has.has('poisoned')) situation.disadvantage.push(name('poisoned'));
    if (has.has('frightened')) situation.notes.push('Frightened: Disadvantage while the source of fear is in sight.');
    if (has.has('blinded')) situation.notes.push('Blinded: automatically fails checks that require sight.');
    if (has.has('deafened')) situation.notes.push('Deafened: automatically fails checks that require hearing.');
  }
  if (kind === 'initiative') {
    if (has.has('invisible')) situation.advantage.push(name('invisible'));
    if (isIncapacitated(c)) situation.disadvantage.push('Incapacitated (surprised)');
  }
  if (kind === 'save' && (ability === 'str' || ability === 'dex')) {
    const failing = [...has].find((id) => AUTO_FAIL_STR_DEX_SAVES.has(id));
    if (failing) situation.autoFail = `${name(failing)}: automatically fails Strength and Dexterity saving throws.`;
    if (ability === 'dex' && has.has('restrained')) situation.disadvantage.push(name('restrained'));
  }

  for (const worn of wornArmor(c.inventory).known) {
    const { stats } = worn;
    if (stats.kind !== 'armor') continue;
    if (stats.stealthDisadvantage && req.skill === 'stealth') situation.disadvantage.push(`${stats.name} (Stealth)`);
    if (stats.armorType && !hasArmorTraining(c, stats.armorType) && (ability === 'str' || ability === 'dex')) {
      situation.disadvantage.push(`${stats.name} (untrained)`);
    }
  }
  return situation;
}
