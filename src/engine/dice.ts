/**
 * Dice: expression parsing and rolling. Pure and deterministic given an Rng.
 *
 * Supported syntax (case-insensitive, spaces allowed around + and -):
 *   NdM            2d6, d20 (N defaults to 1), d100 / d%
 *   NdMkhK / klK   4d6kh3 (keep highest 3), 2d20kl1; also k3 (= kh3), dl1 (drop lowest), dh1 (drop highest)
 *   +/- terms      1d8+2d6+3, 1d20-1 (a typographic minus "−" is accepted too)
 * Constants alone ("5") are valid. Max 100 dice per term, sides 1–1000.
 */
import type { AdvantageState, D20TestResult, DieRoll, RollResult } from '@/types';

/** Uniform random source in [0, 1). */
export interface Rng {
  next(): number;
}

const UINT32_RANGE = 0x1_0000_0000;

function cryptoUint32(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0];
}

/** Cryptographically strong RNG (crypto.getRandomValues). The default everywhere in the app. */
export const cryptoRng: Rng = {
  next() {
    // 27 + 26 random bits -> a uniform double on the 2^53 grid in [0, 1).
    const hi = cryptoUint32() >>> 5;
    const lo = cryptoUint32() >>> 6;
    return (hi * 67_108_864 + lo) / 9_007_199_254_740_992;
  },
};

/** Deterministic RNG for tests (mulberry32). */
export function seededRng(seed: number): Rng {
  let state = Math.trunc(seed) >>> 0;
  return {
    next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
    },
  };
}

/**
 * Uniform integer in [0, n). With cryptoRng this uses rejection sampling on raw 32-bit values, so
 * every die face is exactly equally likely (no modulo bias); other sources use floor(next() × n).
 */
export function randomInt(n: number, rng: Rng = cryptoRng): number {
  const size = Math.max(1, Math.trunc(n));
  if (rng === cryptoRng) {
    const limit = UINT32_RANGE - (UINT32_RANGE % size);
    for (;;) {
      const x = cryptoUint32();
      if (x < limit) return x % size;
    }
  }
  return Math.min(size - 1, Math.max(0, Math.floor(rng.next() * size)));
}

/** One die face, 1..sides. */
export function rollDie(sides: number, rng: Rng = cryptoRng): number {
  return randomInt(sides, rng) + 1;
}

export class DiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiceError';
  }
}

export type DiceTerm =
  | { kind: 'dice'; sign: 1 | -1; count: number; sides: number; keep?: { mode: 'kh' | 'kl'; n: number } }
  | { kind: 'flat'; sign: 1 | -1; value: number };

type DiceGroup = Extract<DiceTerm, { kind: 'dice' }>;

const MAX_DICE_PER_TERM = 100;
const MAX_SIDES = 1000;
const MAX_TERMS = 30;
const MAX_FLAT = 1_000_000;
const EXAMPLE = 'try something like 2d6+3';

// One term: optional sign, then NdM with an optional keep/drop suffix, or a plain number.
const TERM_RE = /\s*([+-])?\s*(?:(\d*)d(\d+|%)(?:(kh|kl|dh|dl|k)(\d*))?|(\d+))\s*/y;

function unreadable(input: string): DiceError {
  return new DiceError(`Couldn't read '${input.trim()}' — ${EXAMPLE}`);
}

function parseDiceGroup(sign: 1 | -1, match: RegExpExecArray): DiceGroup {
  const text = match[0].trim();
  const count = match[2] === '' ? 1 : Number(match[2]);
  const sides = match[3] === '%' ? 100 : Number(match[3]);
  if (count < 1) throw new DiceError(`'${text}' rolls no dice — roll at least 1`);
  if (count > MAX_DICE_PER_TERM) throw new DiceError(`Too many dice in '${text}' — roll at most ${MAX_DICE_PER_TERM} per term`);
  if (sides < 1 || sides > MAX_SIDES) throw new DiceError(`'${text}' has an impossible die — dice have 1 to ${MAX_SIDES} sides`);

  const mode = match[4];
  if (!mode) return { kind: 'dice', sign, count, sides };
  const n = match[5] === '' ? 1 : Number(match[5]);
  const dropping = mode === 'dl' || mode === 'dh';
  const kept = dropping ? count - n : n;
  if (dropping && n < 1) throw new DiceError(`'${text}' drops no dice — drop at least 1`);
  if (kept < 1) throw new DiceError(`'${text}' would drop every die — keep at least 1`);
  if (kept > count) throw new DiceError(`Can't keep ${kept} of ${count} dice in '${text}'`);
  if (kept === count) return { kind: 'dice', sign, count, sides };
  const keepMode = mode === 'kl' || mode === 'dh' ? 'kl' : 'kh';
  return { kind: 'dice', sign, count, sides, keep: { mode: keepMode, n: kept } };
}

/** Parse an expression into terms. Throws DiceError with a helpful message on bad input. */
export function parseDice(expression: string): DiceTerm[] {
  const input = typeof expression === 'string' ? expression : '';
  const source = input.toLowerCase().replace(/[\u2212\u2012\u2013\u2014]/g, '-');
  if (!source.trim()) throw new DiceError(`Nothing to roll — ${EXAMPLE}`);

  const terms: DiceTerm[] = [];
  let pos = 0;
  while (pos < source.length) {
    TERM_RE.lastIndex = pos;
    const match = TERM_RE.exec(source);
    // Every term after the first needs an explicit + or -.
    if (!match || (terms.length > 0 && !match[1])) throw unreadable(input);
    const sign: 1 | -1 = match[1] === '-' ? -1 : 1;
    if (match[6] !== undefined) {
      const value = Number(match[6]);
      if (value > MAX_FLAT) throw new DiceError(`${match[6]} is too large a number to add`);
      terms.push({ kind: 'flat', sign, value });
    } else {
      terms.push(parseDiceGroup(sign, match));
    }
    if (terms.length > MAX_TERMS) throw new DiceError(`That expression is too long — use at most ${MAX_TERMS} terms`);
    pos = TERM_RE.lastIndex;
  }
  return terms;
}

export function isValidDice(expression: string): boolean {
  try {
    parseDice(expression);
    return true;
  } catch (err) {
    if (err instanceof DiceError) return false;
    throw err;
  }
}

/** Format parsed terms back into a normalized expression string. */
export function formatDice(terms: readonly DiceTerm[]): string {
  return terms
    .map((t, i) => {
      const sign = t.sign < 0 ? '-' : i === 0 ? '' : '+';
      if (t.kind === 'flat') return `${sign}${t.value}`;
      return `${sign}${t.count}d${t.sides}${t.keep ? `${t.keep.mode}${t.keep.n}` : ''}`;
    })
    .join('');
}

/** Normalized string form of an expression ("1d20 + 5" -> "1d20+5"). Throws DiceError when invalid. */
export function normalizeDice(expression: string): string {
  return formatDice(parseDice(expression));
}

/**
 * Critical-hit dice: every dice term is rolled twice (2024 rules: "roll the attack's damage dice
 * twice"). Plain terms double their count; keep-highest/lowest terms are repeated as a second group.
 */
export function criticalDiceTerms(terms: readonly DiceTerm[]): DiceTerm[] {
  return terms.flatMap((t): DiceTerm[] => {
    if (t.kind === 'flat') return [t];
    if (t.keep) return [t, { ...t }];
    return [{ ...t, count: t.count * 2 }];
  });
}

/** The critical-hit form of an expression: "1d8+3" -> "2d8+3". Throws DiceError when invalid. */
export function criticalDice(expression: string): string {
  return formatDice(criticalDiceTerms(parseDice(expression)));
}

/** "1d20+5", "2d20kh1-1", "2d20kl1" for a d20 test with a flat modifier. */
export function d20Expression(modifier: number, advantage: AdvantageState = 'normal'): string {
  const dice = advantage === 'advantage' ? '2d20kh1' : advantage === 'disadvantage' ? '2d20kl1' : '1d20';
  const mod = Math.round(modifier);
  return mod > 0 ? `${dice}+${mod}` : mod < 0 ? `${dice}${mod}` : dice;
}

const MINUS = '\u2212';

function keptIndexes(values: readonly number[], keep: DiceGroup['keep']): Set<number> {
  if (!keep) return new Set(values.map((_, i) => i));
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => (keep.mode === 'kh' ? b.value - a.value : a.value - b.value) || a.index - b.index);
  return new Set(order.slice(0, keep.n).map((o) => o.index));
}

interface RolledGroup {
  term: DiceGroup;
  dice: DieRoll[];
  sum: number;
}

function rollGroup(term: DiceGroup, rng: Rng): RolledGroup {
  const values = Array.from({ length: term.count }, () => rollDie(term.sides, rng));
  const kept = keptIndexes(values, term.keep);
  const dice = values.map((value, i): DieRoll => (kept.has(i) ? { sides: term.sides, value } : { sides: term.sides, value, dropped: true }));
  const sum = values.reduce((total, value, i) => (kept.has(i) ? total + value : total), 0);
  return { term, dice, sum };
}

function groupLabel(group: RolledGroup): string {
  const { term } = group;
  const name = term.count === 1 || term.keep?.n === 1 ? `d${term.sides}` : `${term.count}d${term.sides}`;
  const faces = group.dice.map((d) => (d.dropped ? `~~${d.value}~~` : String(d.value))).join(', ');
  return `${name} (${faces})`;
}

interface BreakdownPart {
  sign: 1 | -1;
  text: string;
  flat: boolean;
}

function joinBreakdown(parts: readonly BreakdownPart[], total: number): string {
  const body = parts
    .map((p, i) => (i === 0 ? (p.sign < 0 ? `${MINUS}${p.text}` : p.text) : `${p.sign < 0 ? ` ${MINUS} ` : ' + '}${p.text}`))
    .join('');
  // A lone constant ("5") needs no "= 5".
  return parts.length === 1 && parts[0].flat ? body : `${body} = ${formatSigned(total)}`;
}

function formatSigned(n: number): string {
  return n < 0 ? `${MINUS}${Math.abs(n)}` : String(n);
}

/** The single kept d20 of a d20 test, when the expression has exactly one (positive) d20 group keeping one die. */
function d20Info(groups: readonly RolledGroup[]): Pick<RollResult, 'natural' | 'isCritical' | 'isFumble' | 'advantage'> {
  const d20Groups = groups.filter((g) => g.term.sides === 20);
  if (d20Groups.length !== 1) return {};
  const [group] = d20Groups;
  const keepsOne = group.term.count === 1 || group.term.keep?.n === 1;
  if (!keepsOne || group.term.sign < 0) return {};
  const natural = group.dice.find((d) => !d.dropped)?.value;
  if (natural === undefined) return {};
  const advantage: AdvantageState = !group.term.keep ? 'normal' : group.term.keep.mode === 'kh' ? 'advantage' : 'disadvantage';
  return { natural, isCritical: natural === 20, isFumble: natural === 1, advantage };
}

function rollTerms(terms: readonly DiceTerm[], rng: Rng): RollResult {
  const groups: RolledGroup[] = [];
  const parts: BreakdownPart[] = [];
  let total = 0;
  let modifier = 0;
  for (const term of terms) {
    if (term.kind === 'flat') {
      modifier += term.sign * term.value;
      total += term.sign * term.value;
      parts.push({ sign: term.sign, text: String(term.value), flat: true });
      continue;
    }
    const group = rollGroup(term, rng);
    groups.push(group);
    total += term.sign * group.sum;
    parts.push({ sign: term.sign, text: groupLabel(group), flat: false });
  }
  return {
    expression: formatDice(terms),
    total,
    dice: groups.flatMap((g) => g.dice),
    modifier,
    breakdown: joinBreakdown(parts, total),
    ...d20Info(groups),
  };
}

/**
 * Roll an expression.
 * @param opts.critical double the number of dice in every dice term (critical-hit damage).
 * For a single-d20 expression ("1d20+5", "2d20kh1+2") natural / isCritical / isFumble / advantage are set.
 */
export function rollDice(expression: string, opts: { rng?: Rng; critical?: boolean } = {}): RollResult {
  const parsed = parseDice(expression);
  return rollTerms(opts.critical ? criticalDiceTerms(parsed) : parsed, opts.rng ?? cryptoRng);
}

/** Roll damage: like rollDice, but the total can't go below 0 (SRD 5.2.1 "Damage Rolls"). */
export function rollDamage(expression: string, opts: { rng?: Rng; critical?: boolean } = {}): RollResult {
  const result = rollDice(expression, opts);
  if (result.total >= 0) return result;
  return { ...result, total: 0, breakdown: `${result.breakdown} → 0 (damage can't be negative)` };
}

function withDc<T extends RollResult>(result: T, dc: number | undefined): D20TestResult {
  if (typeof dc !== 'number' || !Number.isFinite(dc)) return result;
  return { ...result, dc, success: result.total >= dc };
}

function cleanModifier(modifier: number): number {
  return Number.isFinite(modifier) ? Math.round(modifier) || 0 : 0;
}

/**
 * Roll a d20 test (ability check, saving throw, attack roll) with a flat modifier.
 * Advantage rolls 2d20 and keeps the higher; disadvantage keeps the lower.
 * Sets natural, isCritical (natural 20), isFumble (natural 1), and success when dc is given
 * (success = total >= dc; callers handle attack-roll auto-hit/miss rules — see applyAttackRollRules).
 */
export function rollD20Test(
  modifier: number,
  opts: { advantage?: AdvantageState; dc?: number; rng?: Rng } = {},
): D20TestResult {
  const advantage = opts.advantage ?? 'normal';
  const result = rollDice(d20Expression(cleanModifier(modifier), advantage), { rng: opts.rng });
  return withDc({ ...result, advantage }, opts.dc);
}

/**
 * Build a D20TestResult from a natural d20 the player rolled on physical dice.
 * With advantage/disadvantage the player reports the die they kept; only that die is recorded.
 */
export function manualD20Result(
  natural: number,
  modifier: number,
  opts: { advantage?: AdvantageState; dc?: number } = {},
): D20TestResult {
  if (!Number.isInteger(natural) || natural < 1 || natural > 20) {
    throw new DiceError(`A d20 shows a whole number from 1 to 20 — got ${String(natural)}`);
  }
  const mod = cleanModifier(modifier);
  const advantage = opts.advantage ?? 'normal';
  const total = natural + mod;
  const parts: BreakdownPart[] = [{ sign: 1, text: `d20 (${natural})`, flat: false }];
  if (mod !== 0) parts.push({ sign: mod < 0 ? -1 : 1, text: String(Math.abs(mod)), flat: true });
  const result: RollResult = {
    expression: d20Expression(mod, advantage),
    total,
    dice: [{ sides: 20, value: natural }],
    modifier: mod,
    breakdown: joinBreakdown(parts, total),
    natural,
    isCritical: natural === 20,
    isFumble: natural === 1,
    advantage,
  };
  return withDc(result, opts.dc);
}

/** Build a RollResult from a total the player rolled on physical dice for a non-d20 expression. */
export function manualRollResult(expression: string, total: number): RollResult {
  const terms = parseDice(expression);
  if (!Number.isInteger(total)) throw new DiceError(`Enter the total you rolled as a whole number — got ${String(total)}`);
  const normalized = formatDice(terms);
  const modifier = terms.reduce((sum, t) => (t.kind === 'flat' ? sum + t.sign * t.value : sum), 0);
  const result: RollResult = {
    expression: normalized,
    total,
    dice: [],
    modifier,
    breakdown: `${normalized} = ${formatSigned(total)} (physical dice)`,
  };
  const groups = terms.filter((t): t is DiceGroup => t.kind === 'dice');
  if (groups.length === 1 && groups[0].sides === 20 && groups[0].count === 1 && groups[0].sign > 0) {
    const natural = total - modifier;
    if (natural >= 1 && natural <= 20) Object.assign(result, { natural, isCritical: natural === 20, isFumble: natural === 1 });
  }
  return result;
}

/** P(Binomial(n, p) = t) for t = 0..n. */
function binomialPmf(n: number, p: number): number[] {
  const pmf = new Array<number>(n + 1).fill(0);
  if (p <= 0) {
    pmf[0] = 1;
    return pmf;
  }
  if (p >= 1) {
    pmf[n] = 1;
    return pmf;
  }
  let prob = (1 - p) ** n;
  pmf[0] = prob;
  for (let t = 1; t <= n; t++) {
    prob *= ((n - t + 1) / t) * (p / (1 - p));
    pmf[t] = prob;
  }
  return pmf;
}

/**
 * Exact expected sum of a dice group. For keep-highest k of n, the kept dice showing at least x number
 * min(k, B) where B ~ Binomial(n, P(die >= x)); summing those expectations over x gives the mean.
 */
function groupAverage(term: DiceGroup): number {
  const { count: n, sides: m, keep } = term;
  if (!keep) return (n * (m + 1)) / 2;
  let expected = 0;
  for (let x = 1; x <= m; x++) {
    const pmf = binomialPmf(n, (m - x + 1) / m);
    for (let t = 0; t <= n; t++) {
      const keptAtLeastX = keep.mode === 'kh' ? Math.min(keep.n, t) : Math.max(0, t - (n - keep.n));
      expected += keptAtLeastX * pmf[t];
    }
  }
  return expected;
}

/** Average result of an expression (e.g. "2d6+3" -> 10; "4d6kh3" -> ~12.24). Throws DiceError when invalid. */
export function averageRoll(expression: string): number {
  const avg = parseDice(expression).reduce(
    (sum, t) => sum + t.sign * (t.kind === 'flat' ? t.value : groupAverage(t)),
    0,
  );
  return Math.round(avg * 1e6) / 1e6;
}

/** Lowest and highest possible totals of an expression ("2d6+3" -> 5..15). Throws DiceError when invalid. */
export function diceRange(expression: string): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (const t of parseDice(expression)) {
    const kept = t.kind === 'flat' ? 0 : (t.keep?.n ?? t.count);
    const lo = t.kind === 'flat' ? t.value : kept;
    const hi = t.kind === 'flat' ? t.value : kept * t.sides;
    if (t.sign > 0) {
      min += lo;
      max += hi;
    } else {
      min -= hi;
      max -= lo;
    }
  }
  return { min, max };
}

/**
 * Attack-roll rules on top of a d20 test against AC (SRD 5.2.1 "Rolling 1s and 20s"): a natural 20
 * always hits and is a Critical Hit, a natural 1 always misses. `critRange` (e.g. 19 for a Champion's
 * Improved Critical) widens the critical range.
 */
export function applyAttackRollRules(result: D20TestResult, opts: { critRange?: number } = {}): D20TestResult {
  if (result.natural === undefined) return result;
  const critRange = Math.min(20, Math.max(2, Math.trunc(opts.critRange ?? 20)));
  const isCritical = result.natural >= critRange;
  if (result.dc === undefined) return { ...result, isCritical };
  const success = result.natural === 1 ? false : isCritical ? true : result.total >= result.dc;
  return { ...result, isCritical, success };
}
