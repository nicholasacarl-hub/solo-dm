/**
 * A small stand-in for '@/engine' in DM tests (vi.mock('@/engine', () => import(...))), so the
 * DM's tests never depend on the engine module's runtime behaviour. Simplified rules, typed
 * against the real engine's signatures. Dice come from a queue the test controls.
 */
import type * as Engine from '@/engine';
import {
  SKILL_ABILITY,
  SKILL_NAMES,
  type Ability,
  type ActiveCondition,
  type Attack,
  type Character,
  type Combatant,
  type CombatState,
  type D20TestResult,
  type DieRoll,
  type GameEvent,
  type HitPoints,
  type PlayerRollRequest,
  type RollResult,
} from '@/types';

export type Rng = Engine.Rng;
export type EngineResult = Engine.EngineResult;
export type Likelihood = Engine.Likelihood;
export type DiceTerm = Engine.DiceTerm;

// Transformations and ability score changes run the real engine: pure, and deterministic given ids.
export { changeAbilityScore } from '@/engine/character';
export {
  activeTransformations,
  advanceTransformation,
  beginTransformation,
  endTransformation,
  findTransformation,
  transformationFeatures,
  transformationGrants,
} from '@/engine/transform';
// Condition names run the real matchers (pure): the DM tools decide by them whether a name is a standard condition.
import { matchStandardCondition } from '@/engine/conditions';
export { conditionKey, matchStandardCondition, normalizeConditionId } from '@/engine/conditions';
// get_entry's budget is the sheet's real field limit.
export { SHEET_TEXT_MAX } from '@/engine/summary';
// The battle-map modules run the real engine too (pure; they use the real ./combat and ./conditions inside).
import * as realCombat from '@/engine/combat';
export * from '@/engine/grid';
export * from '@/engine/mapCells';
export * from '@/engine/movement';
export * from '@/engine/sight';
export * from '@/engine/areas';
export * from '@/engine/battleMap';
export * from '@/engine/mapNormalize';

// ---------------------------------------------------------------------------
// Dice (queued values; default = the die's midpoint rounded up)
// ---------------------------------------------------------------------------

let queue: number[] = [];

export const fakeDice = {
  /** Values for the next dice rolled, in order (d20s and damage dice alike). */
  queue(...values: number[]) {
    queue.push(...values);
  },
  reset() {
    queue = [];
  },
  remaining(): number {
    return queue.length;
  },
};

function die(sides: number): number {
  const v = queue.shift();
  return v === undefined ? Math.ceil(sides / 2) : Math.max(1, Math.min(sides, v));
}

export const cryptoRng: Rng = { next: () => 0.5 };
export const seededRng: typeof Engine.seededRng = () => cryptoRng;

export class DiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiceError';
  }
}

export const parseDice: typeof Engine.parseDice = (expression) => {
  const clean = expression.replace(/\s+/g, '').toLowerCase().replace(/d%/g, 'd100');
  if (!clean) throw new DiceError('Empty dice expression.');
  const tokens = clean.match(/[+-]?[^+-]+/g) ?? [];
  if (tokens.join('') !== clean) throw new DiceError(`Bad dice expression "${expression}".`);
  return tokens.map((token): DiceTerm => {
    const sign = token.startsWith('-') ? -1 : 1;
    const body = token.replace(/^[+-]/, '');
    const dice = /^(\d*)d(\d+)(?:(kh|kl)(\d+))?$/.exec(body);
    if (dice) {
      const term: DiceTerm = { kind: 'dice', sign, count: Number(dice[1] || 1), sides: Number(dice[2]) };
      return dice[3] ? { ...term, keep: { mode: dice[3] as 'kh' | 'kl', n: Number(dice[4]) } } : term;
    }
    if (/^\d+$/.test(body)) return { kind: 'flat', sign, value: Number(body) };
    throw new DiceError(`Bad dice term "${token}" in "${expression}".`);
  });
};

export const isValidDice: typeof Engine.isValidDice = (expression) => {
  try {
    parseDice(expression);
    return true;
  } catch {
    return false;
  }
};

export const normalizeDice: typeof Engine.normalizeDice = (e) => e.replace(/\s+/g, '').toLowerCase();

export const rollDice: typeof Engine.rollDice = (expression, opts) => {
  const terms = parseDice(expression);
  const dice: DieRoll[] = [];
  let total = 0;
  let modifier = 0;
  for (const t of terms) {
    if (t.kind === 'flat') {
      total += t.sign * t.value;
      modifier += t.sign * t.value;
      continue;
    }
    const count = opts?.critical ? t.count * 2 : t.count;
    const rolled = Array.from({ length: count }, () => die(t.sides));
    let kept = rolled;
    if (t.keep) {
      const sorted = [...rolled].sort((a, b) => (t.keep?.mode === 'kh' ? b - a : a - b));
      kept = sorted.slice(0, t.keep.n);
    }
    rolled.forEach((value) => dice.push({ sides: t.sides, value }));
    total += t.sign * kept.reduce((a, b) => a + b, 0);
  }
  const faces = dice.map((d) => d.value).join(', ');
  return { expression: normalizeDice(expression), total, dice, modifier, breakdown: `${faces || '0'}${modifier ? ` + ${modifier}` : ''} = ${total}` };
};

export const rollD20Test: typeof Engine.rollD20Test = (modifier, opts) => {
  const first = die(20);
  const advantage = opts?.advantage ?? 'normal';
  const second = advantage === 'normal' ? undefined : die(20);
  const natural = second === undefined ? first : advantage === 'advantage' ? Math.max(first, second) : Math.min(first, second);
  const total = natural + modifier;
  const dice: DieRoll[] = [{ sides: 20, value: first }];
  if (second !== undefined) dice.push({ sides: 20, value: second });
  const result: D20TestResult = {
    expression: `1d20${modifier >= 0 ? '+' : ''}${modifier}`,
    total,
    dice,
    modifier,
    breakdown: `d20 (${dice.map((d) => d.value).join(', ')}) ${modifier >= 0 ? '+' : '-'} ${Math.abs(modifier)} = ${total}`,
    natural,
    isCritical: natural === 20,
    isFumble: natural === 1,
    advantage,
  };
  if (opts?.dc !== undefined) return { ...result, dc: opts.dc, success: total >= opts.dc };
  return result;
};

export const manualD20Result: typeof Engine.manualD20Result = (natural, modifier, opts) => ({
  ...rollD20Test(modifier, opts),
  natural,
  total: natural + modifier,
});

export const manualRollResult: typeof Engine.manualRollResult = (expression, total) => ({
  expression,
  total,
  dice: [],
  modifier: 0,
  breakdown: `${total} (physical dice)`,
});

export const averageRoll: typeof Engine.averageRoll = () => 0;

export const applyAttackRollRules: typeof Engine.applyAttackRollRules = (result, opts) => {
  if (result.natural === undefined) return result;
  const isCritical = result.natural >= (opts?.critRange ?? 20);
  if (result.dc === undefined) return { ...result, isCritical };
  return { ...result, isCritical, success: result.natural === 1 ? false : isCritical ? true : result.total >= result.dc };
};

export const rerollNaturalOne: typeof Engine.rerollNaturalOne = (result, opts) => {
  if (result.natural !== 1) return result;
  const natural = opts?.value ?? die(20);
  const total = natural + result.modifier;
  const next: D20TestResult = {
    ...result,
    natural,
    total,
    dice: [...result.dice.map((d) => (d.sides === 20 && d.value === 1 ? { ...d, dropped: true } : d)), { sides: 20, value: natural }],
    breakdown: `d20 (~~1~~ → ${natural}, Luck) ${result.modifier >= 0 ? '+' : '-'} ${Math.abs(result.modifier)} = ${total}`,
    isCritical: natural === 20,
    isFumble: natural === 1,
  };
  return result.dc === undefined ? next : { ...next, success: total >= result.dc };
};

// ---------------------------------------------------------------------------
// The roll situation (simplified: a few conditions, Luck, Improved Critical)
// ---------------------------------------------------------------------------

export const combineAdvantage: typeof Engine.combineAdvantage = (...states) => {
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
};

export const rollSituation: typeof Engine.rollSituation = (c, req) => {
  const situation: Engine.RollSituation = { advantage: [], disadvantage: [], autoFail: null, notes: [] };
  const has = (id: string) => c.conditions.some((x) => x.id === id);
  const d20 = ['ability', 'skill', 'save', 'attack', 'initiative', 'death-save'].includes(req.rollType);
  if (d20 && c.features.some((f) => key(f.name) === 'luck' && f.source === 'species')) {
    situation.luck = 'Luck (Halfling): a natural 1 is rerolled once, and the new roll must be used.';
  }
  if ((req.rollType === 'attack' || req.rollType === 'skill' || req.rollType === 'ability') && has('poisoned')) situation.disadvantage.push('Poisoned');
  if (req.rollType === 'attack' && has('frightened')) situation.notes.push('Frightened: Disadvantage while the source of fear is in sight.');
  if (req.rollType === 'save' && (req.ability === 'str' || req.ability === 'dex')) {
    const failing = ['paralyzed', 'petrified', 'stunned', 'unconscious'].find(has);
    if (failing) situation.autoFail = `${conditionName(failing)}: automatically fails Strength and Dexterity saving throws.`;
  }
  const spell = c.spellcasting?.spells.some((s) => key(s.name) === key(req.attackName ?? ''));
  if (req.rollType === 'attack' && !spell && c.features.some((f) => key(f.name) === 'improved critical')) situation.critRange = 19;
  return situation;
};

// ---------------------------------------------------------------------------
// Derived stats
// ---------------------------------------------------------------------------

export const abilityModifier: typeof Engine.abilityModifier = (score) => Math.floor((score - 10) / 2);
export const formatModifier: typeof Engine.formatModifier = (m) => (m >= 0 ? `+${m}` : `−${Math.abs(m)}`);
export const proficiencyBonus: typeof Engine.proficiencyBonus = (level) => 2 + Math.floor((Math.max(1, level) - 1) / 4);
export const characterLevel: typeof Engine.characterLevel = (c) => Math.max(1, c.classes.reduce((n, k) => n + k.level, 0));
const pb = (c: Character) => proficiencyBonus(characterLevel(c));
const mod = (c: Character, a: Ability) => abilityModifier(c.abilityScores[a]);

export const initiativeModifier: typeof Engine.initiativeModifier = (c) => mod(c, 'dex') + (c.initiativeBonusExtra ?? 0);

function attackMod(c: Character, attack: Attack): number {
  if (attack.ability === 'finesse') return Math.max(mod(c, 'str'), mod(c, 'dex'));
  if (attack.ability === 'spell') return mod(c, c.spellcasting?.ability ?? 'int');
  return mod(c, attack.ability);
}

export const attackDamageExpression: typeof Engine.attackDamageExpression = (c, attack) => {
  const bonus = attack.addAbilityToDamage === false ? 0 : attackMod(c, attack);
  return bonus === 0 ? attack.damage : `${attack.damage}${bonus > 0 ? '+' : '-'}${Math.abs(bonus)}`;
};

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const findAttack: typeof Engine.findAttack = (c, name) =>
  c.attacks.find((a) => key(a.name) === key(name)) ?? c.attacks.find((a) => key(a.name).includes(key(name)));

/** Off-sheet attacks: a known spell uses the spellcasting ability; anything else `ability` (default STR); plus proficiency. */
function offSheetAttack(c: Character, req: PlayerRollRequest): { modifier: number; label: string } {
  const spell = c.spellcasting?.spells.find((s) => key(s.name) === key(req.attackName ?? ''));
  if (spell) return { modifier: mod(c, c.spellcasting?.ability ?? 'int') + pb(c), label: `${spell.name} attack` };
  const ability = req.ability ?? 'str';
  return { modifier: mod(c, ability) + pb(c), label: req.attackName ? `${req.attackName} attack (${ability.toUpperCase()}, not on sheet)` : 'Attack roll' };
}

export const rollRequestModifier: typeof Engine.rollRequestModifier = (c, req: PlayerRollRequest) => {
  switch (req.rollType) {
    case 'skill': {
      const skill = req.skill ?? 'perception';
      const ability = req.ability ?? SKILL_ABILITY[skill];
      return { modifier: mod(c, ability) + Math.floor(pb(c) * (c.skills[skill] ?? 0)), label: `${SKILL_NAMES[skill]} check (${ability.toUpperCase()})` };
    }
    case 'save': {
      const a = req.ability ?? 'dex';
      return { modifier: mod(c, a) + (c.savingThrows.includes(a) ? pb(c) : 0), label: `${a.toUpperCase()} saving throw` };
    }
    case 'ability':
      return { modifier: mod(c, req.ability ?? 'str'), label: `${(req.ability ?? 'str').toUpperCase()} check` };
    case 'attack': {
      const attack = c.attacks.find((a) => a.name === req.attackName);
      if (!attack) return offSheetAttack(c, req);
      return { modifier: attackMod(c, attack) + (attack.proficient ? pb(c) : 0), label: `${attack.name} attack` };
    }
    case 'initiative':
      return { modifier: initiativeModifier(c), label: 'Initiative' };
    case 'death-save':
      return { modifier: 0, label: 'Death saving throw' };
    case 'damage':
      return { modifier: 0, label: `${req.attackName ?? 'Damage'} damage` };
    default:
      return { modifier: 0, label: 'Roll' };
  }
};

// ---------------------------------------------------------------------------
// Character changes
// ---------------------------------------------------------------------------

const ev = (type: GameEvent['type'], message: string): GameEvent => ({ type, message });
const warn = (c: Character, message: string): EngineResult => ({ character: c, events: [ev('warning', message)] });

export const applyDamage: typeof Engine.applyDamage = (c, amount, opts) => {
  const absorbed = Math.min(c.hp.temp, amount);
  const current = Math.max(0, c.hp.current - (amount - absorbed));
  const events = [ev('hp-changed', `Took ${amount}${opts?.damageType ? ` ${opts.damageType}` : ''} damage (HP ${c.hp.current} → ${current})`)];
  let conditions = c.conditions;
  if (current === 0 && c.hp.current > 0) {
    conditions = [...conditions, { id: 'unconscious' }];
    events.push(ev('dropped-to-zero', 'Dropped to 0 HP — unconscious. Death saving throws begin.'));
  }
  return { character: { ...c, hp: { ...c.hp, temp: c.hp.temp - absorbed, current }, conditions }, events };
};

export const applyHealing: typeof Engine.applyHealing = (c, amount) => {
  const current = Math.min(c.hp.max, c.hp.current + amount);
  return {
    character: { ...c, hp: { ...c.hp, current }, conditions: current > 0 ? c.conditions.filter((x) => x.id !== 'unconscious') : c.conditions },
    events: [ev('hp-changed', `Healed ${amount} (HP ${c.hp.current} → ${current})`)],
  };
};

export const setTempHp: typeof Engine.setTempHp = (c, amount) => ({
  character: { ...c, hp: { ...c.hp, temp: Math.max(c.hp.temp, amount) } },
  events: [ev('temp-hp', `Temporary HP ${Math.max(c.hp.temp, amount)}`)],
});

export const stabilize: typeof Engine.stabilize = (c, how) => {
  if (c.deathSaves.dead || c.hp.current > 0 || c.deathSaves.stable) return { character: c, events: [ev('warning', 'Not stabilized.')] };
  const by = how?.trim() ? ` (${how.trim()})` : '';
  return {
    character: { ...c, deathSaves: { successes: 0, failures: 0, stable: true, dead: false } },
    events: [ev('stabilized', `Stabilized${by}: Stable at 0 HP.`)],
  };
};

export const recordDeathSave: typeof Engine.recordDeathSave = (c, natural) => {
  const ds = { ...c.deathSaves };
  if (natural === 20) {
    return {
      character: { ...c, hp: { ...c.hp, current: 1 }, deathSaves: { successes: 0, failures: 0, stable: false, dead: false } },
      events: [ev('revived', 'Natural 20: regains 1 HP.')],
      outcome: 'revived',
    };
  }
  if (natural >= 10) ds.successes += 1;
  else ds.failures += natural === 1 ? 2 : 1;
  ds.stable = ds.successes >= 3;
  ds.dead = ds.failures >= 3;
  const outcome = ds.dead ? 'dead' : ds.stable ? 'stable' : natural >= 10 ? 'success' : 'failure';
  return { character: { ...c, deathSaves: ds }, events: [ev('death-save', `Death save: ${outcome}`)], outcome };
};

export const conditionName: typeof Engine.conditionName = (id) => id.charAt(0).toUpperCase() + id.slice(1);

/** As the real engine: a standard name ("Poisoned") becomes its id, any other name is kept as a homebrew condition. */
const conditionIdOf = (name: string): string => matchStandardCondition(name)?.id ?? name.trim();

export const addCondition: typeof Engine.addCondition = (c, condition: ActiveCondition) => {
  const id = conditionIdOf(condition.id);
  return {
    character: { ...c, conditions: [...c.conditions.filter((x) => x.id !== id), { ...condition, id }] },
    events: [ev('condition-added', `${conditionName(id)} added`)],
  };
};
export const removeCondition: typeof Engine.removeCondition = (c, name) => {
  const id = c.conditions.some((x) => x.id === name) ? name : conditionIdOf(name);
  return c.conditions.some((x) => x.id === id)
    ? { character: { ...c, conditions: c.conditions.filter((x) => x.id !== id) }, events: [ev('condition-removed', `${conditionName(id)} removed`)] }
    : warn(c, `${conditionName(id)} was not active`);
};
export const changeExhaustion: typeof Engine.changeExhaustion = (c, delta) => {
  const exhaustion = Math.max(0, Math.min(6, c.exhaustion + delta));
  return { character: { ...c, exhaustion }, events: [ev('exhaustion-changed', `Exhaustion ${c.exhaustion} → ${exhaustion}`)] };
};

export const spendSlot: typeof Engine.spendSlot = (c, level) => {
  const track = c.spellcasting?.slots[level];
  if (!c.spellcasting || !track || track.used >= track.max) return { ...warn(c, `No level ${level} spell slot left`), ok: false };
  const slots = { ...c.spellcasting.slots, [level]: { ...track, used: track.used + 1 } };
  return { character: { ...c, spellcasting: { ...c.spellcasting, slots } }, events: [ev('slot-spent', `Level ${level} slot spent`)], ok: true };
};
export const restoreSlot: typeof Engine.restoreSlot = (c, level, count = 1) => {
  const track = c.spellcasting?.slots[level];
  if (!c.spellcasting || !track) return warn(c, `No level ${level} slots`);
  const slots = { ...c.spellcasting.slots, [level]: { ...track, used: Math.max(0, track.used - count) } };
  return { character: { ...c, spellcasting: { ...c.spellcasting, slots } }, events: [ev('slot-restored', `Level ${level} slot restored`)] };
};
export const setConcentration: typeof Engine.setConcentration = (c, spell) =>
  c.spellcasting
    ? { character: { ...c, spellcasting: { ...c.spellcasting, concentratingOn: spell } }, events: [ev('condition-added', spell ? `Concentrating on ${spell}` : 'Concentration ended')] }
    : warn(c, 'Not a spellcaster');

export const findFeature: typeof Engine.findFeature = (c, name) => c.features.find((f) => f.name.toLowerCase().includes(name.toLowerCase()));
export const useFeature: typeof Engine.useFeature = (c, name, amount = 1) => {
  const f = findFeature(c, name);
  if (!f?.uses) return warn(c, `${name} has no limited uses`);
  if (f.uses.max - f.uses.used < amount) return warn(c, `Not enough uses of ${f.name} left`);
  const features = c.features.map((x) => (x.id === f.id && x.uses ? { ...x, uses: { ...x.uses, used: x.uses.used + amount } } : x));
  return { character: { ...c, features }, events: [ev('feature-used', `${f.name} used`)] };
};
export const restoreFeature: typeof Engine.restoreFeature = (c, name) => {
  const f = findFeature(c, name);
  if (!f?.uses) return warn(c, `${name} has no limited uses`);
  const features = c.features.map((x) => (x.id === f.id && x.uses ? { ...x, uses: { ...x.uses, used: 0 } } : x));
  return { character: { ...c, features }, events: [ev('feature-restored', `${f.name} restored`)] };
};
export const addFeature: typeof Engine.addFeature = (c, feature) => ({
  character: { ...c, features: [...c.features, { id: feature.id ?? `feat-${feature.name}`, ...feature }] },
  events: [ev('feature-restored', `Gained ${feature.name}`)],
});
export const removeFeature: typeof Engine.removeFeature = (c, name) => ({
  character: { ...c, features: c.features.filter((f) => f.name !== name) },
  events: [ev('feature-used', `Lost ${name}`)],
});

export const findItem: typeof Engine.findItem = (c, name) => c.inventory.find((i) => i.name.toLowerCase() === name.toLowerCase());
export const addItem: typeof Engine.addItem = (c, item) => {
  const existing = findItem(c, item.name);
  const inventory = existing
    ? c.inventory.map((i) => (i.id === existing.id ? { ...i, quantity: i.quantity + item.quantity } : i))
    : [...c.inventory, { id: item.id ?? `item-${item.name}`, ...item }];
  return { character: { ...c, inventory }, events: [ev('item-added', `${item.name} ×${item.quantity} added`)] };
};
export const removeItem: typeof Engine.removeItem = (c, name, quantity) => {
  const item = findItem(c, name);
  if (!item) return warn(c, `${name} is not in the inventory`);
  const left = quantity === undefined ? 0 : item.quantity - quantity;
  if (left < 0) return warn(c, `Only ${item.quantity} ${item.name}`);
  const inventory = left === 0 ? c.inventory.filter((i) => i.id !== item.id) : c.inventory.map((i) => (i.id === item.id ? { ...i, quantity: left } : i));
  return { character: { ...c, inventory }, events: [ev('item-removed', `${item.name} −${quantity ?? item.quantity}`)] };
};
export const updateItem: typeof Engine.updateItem = (c, name, patch) => {
  const item = findItem(c, name);
  if (!item) return warn(c, `${name} is not in the inventory`);
  return { character: { ...c, inventory: c.inventory.map((i) => (i.id === item.id ? { ...i, ...patch } : i)) }, events: [ev('item-added', `${item.name} updated`)] };
};

export const totalGp: typeof Engine.totalGp = (m) => m.pp * 10 + m.gp + m.ep / 2 + m.sp / 10 + m.cp / 100;
export const changeCurrency: typeof Engine.changeCurrency = (c, delta) => {
  const next = { ...c.currency };
  for (const k of ['cp', 'sp', 'ep', 'gp', 'pp'] as const) next[k] += delta[k] ?? 0;
  if (Object.values(next).some((v) => v < 0)) return warn(c, 'Not enough money');
  return { character: { ...c, currency: next }, events: [ev('currency-changed', `Money: ${JSON.stringify(delta)}`)] };
};

export const XP_THRESHOLDS: readonly number[] = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000];
export const levelForXp: typeof Engine.levelForXp = (xp) => XP_THRESHOLDS.filter((t) => xp >= t).length;
export const xpToNextLevel: typeof Engine.xpToNextLevel = (c) => {
  const level = characterLevel(c);
  return level >= 20 ? null : Math.max(0, XP_THRESHOLDS[level] - c.xp);
};
export const gainXp: typeof Engine.gainXp = (c, amount) => {
  const character = { ...c, xp: c.xp + amount };
  return { character, events: [ev('xp-gained', `XP +${amount}`)], levelUpAvailable: levelForXp(character.xp) > characterLevel(c) };
};

export const addSpell: typeof Engine.addSpell = (c, spell) =>
  c.spellcasting
    ? { character: { ...c, spellcasting: { ...c.spellcasting, spells: [...c.spellcasting.spells, { id: spell.id ?? `sp-${spell.name}`, ...spell }] } }, events: [ev('slot-restored', `Learned ${spell.name}`)] }
    : warn(c, 'Not a spellcaster');
export const removeSpell: typeof Engine.removeSpell = (c, name) =>
  c.spellcasting
    ? { character: { ...c, spellcasting: { ...c.spellcasting, spells: c.spellcasting.spells.filter((s) => s.name !== name) } }, events: [ev('slot-spent', `Forgot ${name}`)] }
    : warn(c, 'Not a spellcaster');

/** Like the engine: features whose uses scale (FeatureUses.scale) get their new maximum. */
function rescaleUses(c: Character): Character {
  const level = (name: string) => c.classes.find((k) => k.name === name)?.level ?? 0;
  const features = c.features.map((f) => {
    const scale = f.uses?.scale;
    if (!f.uses || !scale) return f;
    const max =
      scale.by === 'proficiency-bonus'
        ? pb(c)
        : scale.by === 'class-level'
          ? level(scale.className) * (scale.multiplier ?? 1)
          : (scale.values[Math.max(0, level(scale.className) - 1)] ?? f.uses.max);
    return { ...f, uses: { ...f.uses, max, used: Math.min(f.uses.used, max) } };
  });
  return { ...c, features };
}

export const levelUp: typeof Engine.levelUp = (c, opts) => {
  const classes = c.classes.map((k) => (k.name === opts.className ? { ...k, level: k.level + 1 } : k));
  const hpGained = 4;
  const character = rescaleUses({ ...c, classes, hp: { ...c.hp, max: c.hp.max + hpGained, current: c.hp.current + hpGained } });
  return { character, events: [ev('level-up', `Level ${characterLevel(character)}`)], newLevel: characterLevel(character), hpGained, reminders: ['Choose a new spell'] };
};

export const spendHitDie: typeof Engine.spendHitDie = (c, dieSize, opts) => {
  const entry = c.hitDice.find((h) => h.die === dieSize && h.total > h.spent);
  if (!entry) return { character: c, events: [ev('warning', `No d${dieSize} Hit Dice left`)], roll: null, healed: 0 };
  const roll: RollResult = opts?.roll ?? rollDice(`1d${dieSize}`);
  const healed = Math.max(1, roll.total + mod(c, 'con'));
  const current = Math.min(c.hp.max, c.hp.current + healed);
  return {
    character: { ...c, hp: { ...c.hp, current }, hitDice: c.hitDice.map((h) => (h === entry ? { ...h, spent: h.spent + 1 } : h)) },
    events: [ev('hp-changed', `Hit Die: +${healed} HP`)],
    roll,
    healed,
  };
};
export const applyShortRest: typeof Engine.applyShortRest = (c) => ({ character: c, events: [ev('rest', 'Short rest finished')] });
export const applyLongRest: typeof Engine.applyLongRest = (c) => ({
  character: { ...c, hp: { ...c.hp, current: c.hp.max, temp: 0 }, hitDice: c.hitDice.map((h) => ({ ...h, spent: 0 })) },
  events: [ev('rest', 'Long rest finished')],
});

export const createBlankCharacter: typeof Engine.createBlankCharacter = () => {
  throw new Error('fake engine: createBlankCharacter is not used by the DM');
};

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

// The initiative tracker delegates to the real one, so ids, names, turn order and the Reaction reset (srd:rule:reaction)
// agree with the real map modules (spec §9.5). createCombat keeps a fixed start time for deterministic tests.
export const sortCombatants: typeof Engine.sortCombatants = realCombat.sortCombatants;
export const createCombat: typeof Engine.createCombat = (combatants, encounterName) => ({
  ...realCombat.createCombat(combatants, encounterName),
  startedAt: 0,
});
export const currentCombatant: typeof Engine.currentCombatant = realCombat.currentCombatant;
export const nextTurn: typeof Engine.nextTurn = realCombat.nextTurn;
export const addCombatant: typeof Engine.addCombatant = realCombat.addCombatant;
export const removeCombatant: typeof Engine.removeCombatant = realCombat.removeCombatant;
export const updateCombatant: typeof Engine.updateCombatant = (s, id, patch) => ({
  ...s,
  combatants: s.combatants.map((c) => (c.id === id ? { ...c, ...patch } : c)),
});
export const findCombatant: typeof Engine.findCombatant = realCombat.findCombatant;
function changeHp(s: CombatState, id: string, delta: number): { state: CombatState; events: GameEvent[] } {
  const target = s.combatants.find((c) => c.id === id);
  if (!target?.hp) return { state: s, events: [ev('warning', 'No such combatant')] };
  const current = Math.max(0, Math.min(target.hp.max, target.hp.current + delta));
  const patch: Partial<Combatant> = { hp: { ...target.hp, current }, defeated: current === 0 };
  return { state: updateCombatant(s, id, patch), events: [ev('combat', `${target.name} HP ${target.hp.current} → ${current}`)] };
}
export const damageCombatant: typeof Engine.damageCombatant = (s, id, amount) => changeHp(s, id, -amount);
export const healCombatant: typeof Engine.healCombatant = (s, id, amount) => changeHp(s, id, amount);
export const healthDescriptor: typeof Engine.healthDescriptor = (hp: HitPoints) =>
  hp.current <= 0 ? 'down' : hp.current <= hp.max / 4 ? 'critical' : hp.current <= hp.max / 2 ? 'bloodied' : hp.current < hp.max ? 'scratched' : 'unhurt';
/**
 * A simplified format; like the real one, the player's view leaves hidden creatures out and the DM's tags them, and
 * the hero's line shows the AC the caller passes (the sheet's), never the tracker's copy.
 */
export const summarizeCombat: typeof Engine.summarizeCombat = (s, opts) =>
  [
    `Round ${s.round}`,
    ...s.combatants.flatMap((c, i) => {
      if (opts?.forPlayer && c.hidden) return [];
      const ac = c.isPlayer && opts?.heroAc !== undefined ? ` · AC ${opts.heroAc}` : '';
      const hp = c.hp ? (opts?.forPlayer && c.hideHp ? healthDescriptor(c.hp) : `HP ${c.hp.current}/${c.hp.max}`) : '';
      const hidden = !opts?.forPlayer && c.hidden ? ' [hidden]' : '';
      return [`${i === s.turnIndex ? '▶' : ' '} ${c.initiative} ${c.name}${hidden}${ac}${hp ? ` · ${hp}` : ''}${c.defeated ? ' (down)' : ''}`];
    }),
  ].join('\n');

// ---------------------------------------------------------------------------
// Oracle, conditions, summaries
// ---------------------------------------------------------------------------

export const LIKELIHOOD_TARGETS: Record<Likelihood, number> = {
  'nearly-impossible': 5,
  'very-unlikely': 15,
  unlikely: 30,
  even: 50,
  likely: 70,
  'very-likely': 85,
  'nearly-certain': 95,
};
export const randomTwist: typeof Engine.randomTwist = () => 'An unexpected ally appears';
export const consultOracle: typeof Engine.consultOracle = (question, likelihood) => {
  const roll = die(100);
  const target = LIKELIHOOD_TARGETS[likelihood];
  const yes = roll <= target;
  return { question, likelihood, roll, target, answer: yes ? 'yes' : 'no', label: yes ? 'Yes' : 'No', ...(roll % 11 === 0 ? { twist: randomTwist() } : {}) };
};
export const sceneCheck: typeof Engine.sceneCheck = (tension) => {
  const roll = die(10);
  const outcome = roll > tension ? 'expected' : roll % 2 === 1 ? 'altered' : 'interrupted';
  return { roll, tension, outcome, ...(outcome === 'expected' ? {} : { twist: randomTwist() }) };
};

export const CONDITIONS = {} as typeof Engine.CONDITIONS;

export const saveSourcesChangeText: typeof Engine.saveSourcesChangeText = () => null;
export const characterStatusLine: typeof Engine.characterStatusLine = (c) =>
  `${c.name} (${c.classes.map((k) => `${k.name} ${k.level}`).join(' / ')}) · HP ${c.hp.current}/${c.hp.max}${c.hp.temp ? ` (+${c.hp.temp} temp)` : ''} · AC ${c.armorClass}${c.conditions.length ? ` · Conditions: ${c.conditions.map((x) => conditionName(x.id)).join(', ')}` : ''}`;
export const characterSheetText: typeof Engine.characterSheetText = (c) =>
  `# ${c.name}\n${c.species} ${c.classes.map((k) => `${k.name} ${k.level}`).join(' / ')}\nHP ${c.hp.current}/${c.hp.max} · AC ${c.armorClass}\nAttacks: ${c.attacks.map((a) => a.name).join(', ')}\nInventory: ${c.inventory.map((i) => `${i.name} ×${i.quantity}`).join(', ')}`;

export const casterLevel: typeof Engine.casterLevel = () => 0;
export const spellSlotsForClasses: typeof Engine.spellSlotsForClasses = () => ({ slots: {} });
export const recomputeSlots: typeof Engine.recomputeSlots = (c) => c;
export const ordinal: typeof Engine.ordinal = (n) => `${n}th`;
export const exhaustionPenalty: typeof Engine.exhaustionPenalty = (c) => -2 * c.exhaustion;
export const skillModifier: typeof Engine.skillModifier = (c, skill) => mod(c, SKILL_ABILITY[skill]);
export const savingThrowModifier: typeof Engine.savingThrowModifier = (c, a) => mod(c, a);
export const abilityCheckModifier: typeof Engine.abilityCheckModifier = (c, a) => mod(c, a);
export const passivePerception: typeof Engine.passivePerception = (c) => 10 + mod(c, 'wis');
export const spellcastingAbility: typeof Engine.spellcastingAbility = (c) => c.spellcasting?.ability ?? null;
export const spellSaveDC: typeof Engine.spellSaveDC = () => null;
export const spellAttackBonus: typeof Engine.spellAttackBonus = () => null;
export const attackAbilityModifier: typeof Engine.attackAbilityModifier = (c, a) => attackMod(c, a);
export const attackBonus: typeof Engine.attackBonus = (c, a) => attackMod(c, a) + (a.proficient ? pb(c) : 0);
export const effectiveSpeed: typeof Engine.effectiveSpeed = (c) => c.speed;
/** Unarmored: 10 + DEX; with armor or a shield equipped the sheet's AC is kept (as the engine does for unknown armor). */
export const computeArmorClass: typeof Engine.computeArmorClass = (c) =>
  c.inventory.some((i) => i.equipped && (i.category === 'armor' || i.category === 'shield'))
    ? { ac: c.armorClass, formula: 'armor (fake)' }
    : { ac: 10 + mod(c, 'dex'), formula: `10 + DEX ${mod(c, 'dex')}` };
