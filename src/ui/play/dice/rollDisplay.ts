/**
 * How a roll result is labelled for the player: outcome badges (text + tone), DC vs AC wording,
 * the kept/dropped d20s of an advantage roll.
 */
import type { D20TestResult, DieRoll, PlayerRollType, RollResult } from '@/types';

export type OutcomeTone = 'success' | 'danger' | 'gold' | 'neutral';

export interface OutcomeBadge {
  label: string;
  tone: OutcomeTone;
}

/** Text tone classes per outcome (used for the die face and totals). */
export const TONE_TEXT: Record<OutcomeTone, string> = {
  success: 'text-success',
  danger: 'text-danger',
  gold: 'text-gold',
  neutral: 'text-accent',
};

export function isAttackPurpose(purpose: string): boolean {
  return /\battack/i.test(purpose);
}

/** Attack rolls are compared against AC; everything else against a DC. */
export function targetLabel(kind: { rollType?: PlayerRollType; purpose?: string }): 'AC' | 'DC' {
  if (kind.rollType) return kind.rollType === 'attack' ? 'AC' : 'DC';
  return isAttackPurpose(kind.purpose ?? '') ? 'AC' : 'DC';
}

export function d20Dice(roll: RollResult): DieRoll[] {
  return roll.dice.filter((d) => d.sides === 20);
}

/** The kept d20 face, also for plain "1d20+X" rolls that were not made as d20 tests. */
export function naturalOf(roll: RollResult): number | undefined {
  if (roll.natural !== undefined) return roll.natural;
  const kept = roll.dice.filter((d) => !d.dropped);
  return kept.length === 1 && kept[0].sides === 20 ? kept[0].value : undefined;
}

/**
 * Badges for a roll's outcome. Attacks say Hit/Miss (a natural 20 always hits, a natural 1 always
 * misses); checks and saves say Success/Failure, plus Natural 20 / Natural 1 call-outs.
 */
export function outcomeBadges(roll: D20TestResult, attack: boolean): OutcomeBadge[] {
  if (attack) {
    if (roll.isCritical) return [{ label: 'Critical hit', tone: 'gold' }];
    if (roll.isFumble) return [{ label: 'Critical miss', tone: 'danger' }];
    if (roll.success === true) return [{ label: 'Hit', tone: 'success' }];
    if (roll.success === false) return [{ label: 'Miss', tone: 'danger' }];
    return [];
  }
  const badges: OutcomeBadge[] = [];
  if (roll.isCritical) badges.push({ label: 'Natural 20', tone: 'gold' });
  if (roll.isFumble) badges.push({ label: 'Natural 1', tone: 'danger' });
  if (roll.success === true) badges.push({ label: 'Success', tone: 'success' });
  if (roll.success === false) badges.push({ label: 'Failure', tone: 'danger' });
  return badges;
}

/** The single tone that colours the die face: the most notable badge wins. */
export function primaryTone(badges: OutcomeBadge[]): OutcomeTone {
  if (badges.some((b) => b.tone === 'gold')) return 'gold';
  if (badges.some((b) => b.tone === 'danger')) return 'danger';
  if (badges.some((b) => b.tone === 'success')) return 'success';
  return 'neutral';
}

export function advantageLabel(roll: RollResult): string | null {
  if (roll.advantage === 'advantage') return 'Advantage';
  if (roll.advantage === 'disadvantage') return 'Disadvantage';
  const d20s = d20Dice(roll);
  if (d20s.length === 2 && d20s.some((d) => d.dropped)) {
    const kept = d20s.find((d) => !d.dropped);
    const dropped = d20s.find((d) => d.dropped);
    if (kept && dropped) return kept.value >= dropped.value ? 'Advantage' : 'Disadvantage';
  }
  return null;
}
