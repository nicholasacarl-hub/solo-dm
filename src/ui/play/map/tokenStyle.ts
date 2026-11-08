/**
 * How a token looks (spec §7.7, D62), colour-blind safe and never by colour alone: the hero is an accent circle
 * with a double ring, allies blue circles, enemies red diamonds, neutrals dashed rings. Health is a glyph (plus an
 * arc for creatures whose HP the player may see); conditions are two-letter pills. Pure.
 */
import type { ActiveCondition, CombatSide, ConditionId, HitPoints } from '@/types';

export type TokenShape = 'hero' | 'ally' | 'enemy' | 'neutral';

export function tokenShape(side: CombatSide): TokenShape {
  if (side === 'player') return 'hero';
  if (side === 'ally') return 'ally';
  if (side === 'enemy') return 'enemy';
  return 'neutral';
}

export const TOKEN_FILL: Readonly<Record<TokenShape, string>> = {
  hero: 'var(--accent)',
  ally: 'var(--info)',
  enemy: 'var(--danger)',
  neutral: 'var(--surface-3)',
};

export const TOKEN_INK: Readonly<Record<TokenShape, string>> = {
  hero: 'var(--token-ink)',
  ally: 'var(--token-ink)',
  enemy: 'var(--token-ink)',
  neutral: 'var(--text)',
};

/** The side as the player reads it ("enemy", "ally"). */
export const SIDE_WORD: Readonly<Record<CombatSide, string>> = {
  player: 'you',
  ally: 'ally',
  enemy: 'enemy',
  neutral: 'neutral',
};

const CONDITION_ABBR: Readonly<Record<ConditionId, string>> = {
  blinded: 'Bl',
  charmed: 'Ch',
  deafened: 'De',
  exhaustion: 'Ex',
  frightened: 'Fr',
  grappled: 'Gr',
  incapacitated: 'Ic',
  invisible: 'In',
  paralyzed: 'Pa',
  petrified: 'Pe',
  poisoned: 'Po',
  prone: 'Pr',
  restrained: 'Re',
  stunned: 'St',
  unconscious: 'Un',
};

/** "Pr", "Ex2"; a homebrew condition shows its first two letters. */
export function conditionAbbr(c: Pick<ActiveCondition, 'id' | 'level'>): string {
  const abbr = (CONDITION_ABBR as Partial<Record<string, string>>)[c.id] ?? capitalizeTwo(c.id);
  return c.id === 'exhaustion' && c.level ? `${abbr}${c.level}` : abbr;
}

function capitalizeTwo(id: string): string {
  const letters = id.replace(/[^\p{L}]/gu, '');
  return letters ? letters[0].toUpperCase() + (letters[1] ?? '').toLowerCase() : '?';
}

/** Up to three pills and how many more there are (spec §7.7). */
export function conditionPills(conditions: readonly Pick<ActiveCondition, 'id' | 'level'>[]): { pills: string[]; more: number } {
  const all = conditions.map(conditionAbbr);
  return { pills: all.slice(0, 3), more: Math.max(0, all.length - 3) };
}

export type HealthDescriptor = 'unhurt' | 'scratched' | 'bloodied' | 'critical' | 'down';
export type HealthGlyph = 'bloodied' | 'critical' | 'down';

/** Half a drop = bloodied, a cracked heart = critical, a skull = down; nothing while unhurt or scratched. */
export function healthGlyph(descriptor: HealthDescriptor | null): HealthGlyph | null {
  return descriptor === 'bloodied' || descriptor === 'critical' || descriptor === 'down' ? descriptor : null;
}

/** The HP arc's colour by the tracker's thresholds (CombatTracker's HealthLine). */
export function healthTone(hp: HitPoints): string {
  const ratio = hp.max > 0 ? Math.max(0, Math.min(1, hp.current / hp.max)) : 0;
  if (ratio > 0.5) return 'var(--success)';
  if (ratio > 0.25) return 'var(--gold)';
  return 'var(--danger)';
}

export function hpRatio(hp: HitPoints): number {
  return hp.max > 0 ? Math.max(0, Math.min(1, hp.current / hp.max)) : 0;
}
