/**
 * What the character's own conditions and gear do to a d20 test (SRD 5.2.1 conditions, Armor,
 * Armor Training): Advantage / Disadvantage sources, automatic failures, and situational notes the
 * DM must judge. Combine with the DM's requested state via combineAdvantage — multiple sources don't
 * stack, and Advantage plus Disadvantage cancel out.
 */
import type { AdvantageState, Character, PlayerRollRequest } from '@/types';
import { SKILL_ABILITY } from '@/types';
import { wornArmor } from './armorData';
import { AUTO_FAIL_STR_DEX_SAVES, conditionKey, conditionName } from './conditions';
import { findAttack, hasArmorTraining, isIncapacitated } from './rules';

export interface RollSituation {
  /** Sources of Advantage, e.g. "Invisible". */
  advantage: string[];
  /** Sources of Disadvantage, e.g. "Poisoned", "Chain Mail (Stealth)". */
  disadvantage: string[];
  /** Why the roll fails automatically (e.g. a Stunned creature's Dexterity save), else null. */
  autoFail: string | null;
  /** Effects that depend on circumstances the DM must judge ("Frightened: Disadvantage while the source is in sight"). */
  notes: string[];
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

/** Conditions and worn armor that affect this roll. */
export function rollSituation(c: Character, req: PlayerRollRequest): RollSituation {
  const situation: RollSituation = { advantage: [], disadvantage: [], autoFail: null, notes: [] };
  const kind = rollKind(req);
  if (kind === 'none') return situation;
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
