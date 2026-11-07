/**
 * Stand-in for '@/engine' in Play tests: contract-faithful fakes with scripted d20s, so tests
 * don't depend on the engine module's runtime (or its randomness).
 *
 *   vi.mock('@/engine', () => import('@/ui/play/testing/engineMock'));
 *   queueD20(17, 4);   // the next d20s rolled
 */
import { vi } from 'vitest';
import type { DiceTerm, EngineResult, Rng } from '@/engine';
import type {
  AdvantageState,
  Attack,
  Character,
  ConditionId,
  D20TestResult,
  DieRoll,
  HitPoints,
  RollResult,
} from '@/types';

const d20Queue: number[] = [];

export function queueD20(...naturals: number[]): void {
  d20Queue.push(...naturals);
}

export function resetEngineMock(): void {
  d20Queue.length = 0;
  rollD20Test.mockClear();
  rollDice.mockClear();
  rollDie.mockClear();
  manualD20Result.mockClear();
  manualRollResult.mockClear();
}

function nextD20(): number {
  return d20Queue.shift() ?? 10;
}

/** Stands in for the engine's crypto dice: draws from the queue like every other unscripted roll. */
export const cryptoRng: Rng = { next: () => 0.5 };

/** A die face: from an explicit Rng like the real engine, else queued d20s (and 3 for other dice). */
function face(sides: number, rng: Rng | undefined): number {
  if (rng && rng !== cryptoRng) return Math.min(sides, Math.max(1, Math.floor(rng.next() * sides) + 1));
  return sides === 20 ? nextD20() : 3;
}

export const rollDie = vi.fn((sides: number, rng?: Rng): number => face(sides, rng));

function withDc(result: D20TestResult, dc: number | undefined): D20TestResult {
  return dc === undefined ? result : { ...result, dc, success: result.total >= dc };
}

function d20Result(dice: DieRoll[], natural: number, modifier: number, advantage: AdvantageState): D20TestResult {
  const total = natural + modifier;
  return {
    expression: `${advantage === 'normal' ? '1d20' : advantage === 'advantage' ? '2d20kh1' : '2d20kl1'}${modifier ? (modifier > 0 ? `+${modifier}` : modifier) : ''}`,
    total,
    dice,
    modifier,
    breakdown: `d20 (${natural}) + ${modifier} = ${total}`,
    natural,
    isCritical: natural === 20,
    isFumble: natural === 1,
    advantage,
  };
}

export const rollD20Test = vi.fn(
  (modifier: number, opts: { advantage?: AdvantageState; dc?: number; rng?: Rng } = {}): D20TestResult => {
    const advantage = opts.advantage ?? 'normal';
    const first = face(20, opts.rng);
    if (advantage === 'normal')
      return withDc(d20Result([{ sides: 20, value: first }], first, modifier, advantage), opts.dc);
    const second = face(20, opts.rng);
    const keepFirst = advantage === 'advantage' ? first >= second : first <= second;
    const natural = keepFirst ? first : second;
    const dice: DieRoll[] = [
      { sides: 20, value: first, ...(keepFirst ? {} : { dropped: true }) },
      { sides: 20, value: second, ...(keepFirst ? { dropped: true } : {}) },
    ];
    return withDc(d20Result(dice, natural, modifier, advantage), opts.dc);
  },
);

export const manualD20Result = vi.fn(
  (natural: number, modifier: number, opts: { advantage?: AdvantageState; dc?: number } = {}): D20TestResult => {
    if (!Number.isInteger(natural) || natural < 1 || natural > 20) throw new Error('A d20 shows 1 to 20');
    return withDc(d20Result([{ sides: 20, value: natural }], natural, modifier, opts.advantage ?? 'normal'), opts.dc);
  },
);

export function parseDice(expression: string): DiceTerm[] {
  const source = expression.replace(/\s+/g, '').toLowerCase();
  if (!/^[+-]?(\d*d\d+|\d+)([+-](\d*d\d+|\d+))*$/.test(source)) throw new Error(`Couldn't read '${expression}'`);
  return (source.match(/[+-]?[^+-]+/g) ?? []).map((part): DiceTerm => {
    const sign: 1 | -1 = part.startsWith('-') ? -1 : 1;
    const body = part.replace(/^[+-]/, '');
    const dice = body.match(/^(\d*)d(\d+)$/);
    if (dice) return { kind: 'dice', sign, count: dice[1] ? Number(dice[1]) : 1, sides: Number(dice[2]) };
    return { kind: 'flat', sign, value: Number(body) };
  });
}

export function criticalDiceTerms(terms: readonly DiceTerm[]): DiceTerm[] {
  return terms.map((t) => (t.kind === 'flat' ? t : { ...t, count: t.count * 2 }));
}

/** Every die shows 3 (or a queued d20 for d20s), unless an Rng is given: predictable totals. */
export const rollDice = vi.fn((expression: string, opts: { critical?: boolean; rng?: Rng } = {}): RollResult => {
  const terms = parseDice(expression);
  const dice: DieRoll[] = [];
  let total = 0;
  let modifier = 0;
  for (const t of terms) {
    if (t.kind === 'flat') {
      modifier += t.sign * t.value;
      total += t.sign * t.value;
      continue;
    }
    const count = opts.critical ? t.count * 2 : t.count;
    for (let i = 0; i < count; i++) {
      const value = face(t.sides, opts.rng);
      dice.push({ sides: t.sides, value });
      total += t.sign * value;
    }
  }
  return { expression, total, dice, modifier, breakdown: `${expression} = ${total}` };
});

export const manualRollResult = vi.fn((expression: string, total: number): RollResult => {
  parseDice(expression);
  return { expression, total, dice: [], modifier: 0, breakdown: `${expression} = ${total} (physical dice)` };
});

export function setHeroicInspiration(c: Character, value: boolean): EngineResult {
  if (c.heroicInspiration === value) return { character: c, events: [] };
  return { character: { ...c, heroicInspiration: value }, events: [{ type: 'inspiration', message: 'Heroic Inspiration' }] };
}

export function healthDescriptor(hp: HitPoints): 'unhurt' | 'scratched' | 'bloodied' | 'critical' | 'down' {
  if (hp.current <= 0) return 'down';
  if (hp.current >= hp.max) return 'unhurt';
  if (hp.current <= hp.max / 4) return 'critical';
  if (hp.current <= hp.max / 2) return 'bloodied';
  return 'scratched';
}

export const CONDITIONS = {
  prone: { id: 'prone', name: 'Prone', summary: 'You are on the ground.', effects: [] },
} as unknown as Record<ConditionId, { id: ConditionId; name: string; summary: string; effects: string[] }>;

export const abilityModifier = (score: number): number => Math.floor((score - 10) / 2);
export const proficiencyBonus = (level: number): number => 2 + Math.floor((Math.max(1, level) - 1) / 4);
export const characterLevel = (c: Character): number =>
  Math.max(
    1,
    c.classes.reduce((n, k) => n + k.level, 0),
  );
export const exhaustionPenalty = (c: Character): number => (c.exhaustion ? -2 * c.exhaustion : 0);

export function attackAbilityModifier(c: Character, attack: Attack): number {
  const mod = (score: number) => abilityModifier(score);
  if (attack.ability === 'finesse') return Math.max(mod(c.abilityScores.str), mod(c.abilityScores.dex));
  if (attack.ability === 'spell') return mod(c.abilityScores[c.spellcasting?.ability ?? 'int']);
  return mod(c.abilityScores[attack.ability]);
}

export function attackDamageExpression(c: Character, attack: Attack): string {
  const bonus = attack.addAbilityToDamage === false ? 0 : attackAbilityModifier(c, attack);
  return bonus ? `${attack.damage}${bonus > 0 ? '+' : ''}${bonus}` : attack.damage;
}
