/**
 * TEST ONLY: a small, deterministic stand-in for '@/engine', so builder and sheet tests don't
 * depend on another module's runtime behaviour. Each function follows the engine contract's
 * documented semantics closely enough for UI tests. Usage:
 *
 *   vi.mock('@/engine', async () => (await import('@/ui/builder/testing/fakeEngine')).fakeEngine);
 */
import type * as Engine from '@/engine';
import type {
  Ability,
  Attack,
  Character,
  ClassLevel,
  D20TestResult,
  DieRoll,
  EquipmentOption,
  GameEvent,
  InventoryItem,
  PactMagic,
  RollResult,
  Skill,
  SpellSlotLevel,
  SpellSlots,
} from '@/types';
import { SKILL_ABILITY } from '@/types';

type Rng = Engine.Rng;

let counter = 0;
const id = () => `fake-${++counter}`;

/** Rolls come from a queue when set (tests), otherwise cycle 1..sides. */
const queue: number[] = [];
export function queueRolls(...values: number[]): void {
  queue.push(...values);
}
export function clearRolls(): void {
  queue.length = 0;
}

function nextDie(sides: number, rng?: Rng): number {
  if (queue.length) return queue.shift() as number;
  if (rng) return Math.min(sides, Math.floor(rng.next() * sides) + 1);
  return Math.ceil(sides / 2);
}

const mod = (score: number) => Math.floor((score - 10) / 2);
const pb = (level: number) => 2 + Math.floor((Math.max(1, level) - 1) / 4);
const level = (c: Character) => Math.max(1, c.classes.reduce((n, k) => n + k.level, 0));
const bump = (c: Character): Character => ({ ...c, updatedAt: c.updatedAt + 1 });

function rollDice(expression: string, opts: { rng?: Rng; critical?: boolean } = {}): RollResult {
  const terms = expression.replace(/\s+/g, '').match(/[+-]?[^+-]+/g) ?? [];
  const dice: DieRoll[] = [];
  let total = 0;
  let modifier = 0;
  for (const raw of terms) {
    const sign = raw.startsWith('-') ? -1 : 1;
    const body = raw.replace(/^[+-]/, '');
    const m = /^(\d*)d(\d+)(?:(kh|kl)(\d+))?$/i.exec(body);
    if (!m) {
      modifier += sign * Number(body);
      continue;
    }
    const count = (Number(m[1] || 1) || 1) * (opts.critical ? 2 : 1);
    const sides = Number(m[2]);
    const rolled = Array.from({ length: count }, () => ({ sides, value: nextDie(sides, opts.rng) }) as DieRoll);
    if (m[3]) {
      const keep = Number(m[4]);
      const order = rolled.map((d, i) => ({ d, i })).sort((a, b) => (m[3] === 'kh' ? b.d.value - a.d.value : a.d.value - b.d.value));
      order.slice(keep).forEach(({ d }) => (d.dropped = true));
    }
    for (const d of rolled) if (!d.dropped) total += sign * d.value;
    dice.push(...rolled);
  }
  total += modifier;
  return { expression, total, dice, modifier, breakdown: `${expression} = ${total}` };
}

function d20(natural: number, modifier: number, dc?: number): D20TestResult {
  const total = natural + modifier;
  return {
    expression: `1d20${modifier >= 0 ? '+' : ''}${modifier}`,
    total,
    dice: [{ sides: 20, value: natural }],
    modifier,
    breakdown: `d20 (${natural}) ${modifier >= 0 ? '+' : '−'} ${Math.abs(modifier)} = ${total}`,
    natural,
    isCritical: natural === 20,
    isFumble: natural === 1,
    advantage: 'normal',
    ...(dc !== undefined ? { dc, success: total >= dc } : {}),
  };
}

function saveMod(c: Character, a: Ability): number {
  return mod(c.abilityScores[a]) + (c.savingThrows.includes(a) ? pb(level(c)) : 0);
}

function skillMod(c: Character, s: Skill): number {
  return mod(c.abilityScores[SKILL_ABILITY[s]]) + Math.floor(pb(level(c)) * (c.skills[s] ?? 0));
}

function castAbility(c: Character): Ability | null {
  return c.spellcasting?.ability ?? c.classes.find((k) => k.spellcastingAbility)?.spellcastingAbility ?? null;
}

function attackMod(c: Character, a: Attack): number {
  const s = c.abilityScores;
  if (a.ability === 'finesse') return Math.max(mod(s.str), mod(s.dex));
  if (a.ability === 'spell') return mod(s[castAbility(c) ?? 'int']);
  return mod(s[a.ability]);
}

const FULL_SLOTS: number[][] = [[2], [3], [4, 2], [4, 3], [4, 3, 2]];

function slotsFor(classes: ClassLevel[]): { slots: SpellSlots; pact?: PactMagic } {
  const full = classes.filter((k) => k.casterType === 'full').reduce((n, k) => n + k.level, 0);
  const half = classes.filter((k) => k.casterType === 'half').reduce((n, k) => n + Math.ceil(k.level / 2), 0);
  const total = full + half;
  const slots: SpellSlots = {};
  (FULL_SLOTS[total - 1] ?? []).forEach((max, i) => (slots[(i + 1) as SpellSlotLevel] = { max, used: 0 }));
  const pactClass = classes.find((k) => k.casterType === 'pact');
  return pactClass ? { slots, pact: { slotLevel: 1, slots: { max: pactClass.level >= 2 ? 2 : 1, used: 0 } } } : { slots };
}

const evt = (type: GameEvent['type'], message: string): GameEvent => ({ type, message });

function updateItem(c: Character, name: string, patch: Partial<Omit<InventoryItem, 'id'>>) {
  const found = c.inventory.find((i) => i.name.toLowerCase() === name.toLowerCase());
  if (!found) return { character: c, events: [evt('warning', `No ${name}`)] };
  return { character: bump({ ...c, inventory: c.inventory.map((i) => (i === found ? { ...i, ...patch } : i)) }), events: [] };
}

function computeArmorClass(c: Character, catalog: EquipmentOption[]): { ac: number; formula: string } {
  const find = (item: InventoryItem) => catalog.find((o) => o.id === item.compendiumId || o.name.toLowerCase() === item.name.toLowerCase());
  const armorItem = c.inventory.find((i) => i.equipped && find(i)?.category === 'armor');
  const shieldItem = c.inventory.find((i) => i.equipped && find(i)?.category === 'shield');
  const dex = mod(c.abilityScores.dex);
  let ac = 10 + dex;
  let formula = '10 + DEX';
  const armor = armorItem && find(armorItem);
  if (armor) {
    const cap = armor.dexCap === undefined || armor.dexCap === null ? dex : Math.min(dex, armor.dexCap);
    ac = (armor.armorClass ?? 10) + cap;
    formula = `${armor.name} ${armor.armorClass}${armor.dexCap === 0 ? '' : ' + DEX'}`;
  }
  const shield = shieldItem && find(shieldItem);
  const has = (name: string) => c.features.some((f) => f.name === name);
  const unarmored = c.features.find((f) => f.name === 'Unarmored Defense');
  if (!armor && unarmored) {
    // Like the engine: Barbarian adds CON (shield allowed), Monk adds WIS (no shield).
    const monk = /monk/i.test(unarmored.sourceName ?? '');
    if (!(monk && shield)) {
      const extra = mod(c.abilityScores[monk ? 'wis' : 'con']);
      if (extra > 0) {
        ac += extra;
        formula = `Unarmored Defense: 10 + DEX + ${monk ? 'WIS' : 'CON'}`;
      }
    }
  }
  if (shield) {
    ac += shield.armorClass ?? 2;
    formula += ` + Shield ${shield.armorClass ?? 2}`;
  }
  if (armor && has('Defense')) {
    ac += 1;
    formula += ' + Defense 1';
  }
  return { ac, formula };
}

export const fakeEngine = {
  // dice
  cryptoRng: { next: () => 0.5 },
  seededRng: () => ({ next: () => 0.5 }),
  rollDice,
  rollD20Test: (modifier: number, opts: { dc?: number; rng?: Rng } = {}) => d20(nextDie(20, opts.rng), modifier, opts.dc),
  manualD20Result: (natural: number, modifier: number, opts: { dc?: number } = {}) => d20(natural, modifier, opts.dc),
  manualRollResult: (expression: string, total: number): RollResult => ({ expression, total, dice: [], modifier: 0, breakdown: `${expression} = ${total} (physical dice)` }),
  averageRoll: (expression: string) => {
    const m = /^(\d*)d(\d+)([+-]\d+)?$/.exec(expression.replace(/\s+/g, ''));
    return m ? Math.floor((Number(m[1] || 1) * (Number(m[2]) + 1)) / 2) + Number(m[3] ?? 0) : Number(expression) || 0;
  },
  isValidDice: (expression: string) => /^[\dd+\-khl\s]+$/i.test(expression),

  // rules
  abilityModifier: mod,
  formatModifier: (n: number) => (n >= 0 ? `+${n}` : `−${Math.abs(n)}`),
  proficiencyBonus: pb,
  characterLevel: level,
  exhaustionPenalty: (c: Character) => -2 * c.exhaustion,
  skillModifier: skillMod,
  savingThrowModifier: saveMod,
  abilityCheckModifier: (c: Character, a: Ability) => mod(c.abilityScores[a]),
  initiativeModifier: (c: Character) => mod(c.abilityScores.dex) + (c.initiativeBonusExtra ?? 0),
  passivePerception: (c: Character) => 10 + skillMod(c, 'perception') + (c.passivePerceptionExtra ?? 0),
  spellcastingAbility: castAbility,
  spellSaveDC: (c: Character, a?: Ability) => {
    const ability = a ?? castAbility(c);
    return ability ? 8 + pb(level(c)) + mod(c.abilityScores[ability]) : null;
  },
  spellAttackBonus: (c: Character, a?: Ability) => {
    const ability = a ?? castAbility(c);
    return ability ? pb(level(c)) + mod(c.abilityScores[ability]) : null;
  },
  attackAbilityModifier: attackMod,
  attackBonus: (c: Character, a: Attack) => attackMod(c, a) + (a.proficient ? pb(level(c)) : 0) + (a.attackBonusExtra ?? 0),
  attackDamageExpression: (c: Character, a: Attack, critical?: boolean) => {
    const dice = critical ? a.damage.replace(/(\d*)d(\d+)/g, (_m, n: string, s: string) => `${Number(n || 1) * 2}d${s}`) : a.damage;
    if (a.addAbilityToDamage === false) return dice;
    const m = attackMod(c, a);
    return m === 0 ? dice : `${dice}${m > 0 ? '+' : '-'}${Math.abs(m)}`;
  },
  effectiveSpeed: (c: Character) => Math.max(0, c.speed - 5 * c.exhaustion),
  computeArmorClass,
  rollRequestModifier: (c: Character, req: { rollType: string; skill?: Skill; ability?: Ability; attackName?: string }) => {
    const penalty = -2 * c.exhaustion;
    if (req.rollType === 'skill' && req.skill) return { modifier: skillMod(c, req.skill) + penalty, label: `${req.skill} check` };
    if (req.rollType === 'save' && req.ability) return { modifier: saveMod(c, req.ability) + penalty, label: `${req.ability.toUpperCase()} save` };
    if (req.rollType === 'attack') {
      const atk = c.attacks.find((a) => a.name === req.attackName);
      return { modifier: (atk ? attackMod(c, atk) + (atk.proficient ? pb(level(c)) : 0) : 0) + penalty, label: `${req.attackName} attack` };
    }
    if (req.rollType === 'initiative') return { modifier: mod(c.abilityScores.dex) + penalty, label: 'Initiative' };
    if (req.rollType === 'death-save') return { modifier: penalty, label: 'Death saving throw' };
    if (req.ability) return { modifier: mod(c.abilityScores[req.ability]) + penalty, label: `${req.ability.toUpperCase()} check` };
    return { modifier: 0, label: 'Roll' };
  },

  // spellcasting
  casterLevel: (classes: ClassLevel[]) => classes.reduce((n, k) => n + (k.casterType === 'full' ? k.level : 0), 0),
  spellSlotsForClasses: slotsFor,
  recomputeSlots: (c: Character) => c,
  ordinal: (n: number) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`,
  spendSlot: (c: Character, lvl: SpellSlotLevel, opts: { pact?: boolean } = {}) => {
    const sc = c.spellcasting;
    if (!sc) return { character: c, events: [], ok: false };
    if (opts.pact && sc.pact) {
      if (sc.pact.slots.used >= sc.pact.slots.max) return { character: c, events: [evt('warning', 'No pact slots')], ok: false };
      return { character: bump({ ...c, spellcasting: { ...sc, pact: { ...sc.pact, slots: { ...sc.pact.slots, used: sc.pact.slots.used + 1 } } } }), events: [evt('slot-spent', 'Pact slot spent')], ok: true };
    }
    const track = sc.slots[lvl];
    if (!track || track.used >= track.max) return { character: c, events: [evt('warning', 'No slots left')], ok: false };
    return { character: bump({ ...c, spellcasting: { ...sc, slots: { ...sc.slots, [lvl]: { ...track, used: track.used + 1 } } } }), events: [evt('slot-spent', 'Slot spent')], ok: true };
  },
  restoreSlot: (c: Character, lvl: SpellSlotLevel, count = 1, opts: { pact?: boolean } = {}) => {
    const sc = c.spellcasting;
    if (!sc) return { character: c, events: [] };
    if (opts.pact && sc.pact) {
      return { character: bump({ ...c, spellcasting: { ...sc, pact: { ...sc.pact, slots: { ...sc.pact.slots, used: Math.max(0, sc.pact.slots.used - count) } } } }), events: [] };
    }
    const track = sc.slots[lvl];
    if (!track) return { character: c, events: [] };
    return { character: bump({ ...c, spellcasting: { ...sc, slots: { ...sc.slots, [lvl]: { ...track, used: Math.max(0, track.used - count) } } } }), events: [evt('slot-restored', 'Slot restored')] };
  },

  // character
  createBlankCharacter: (campaignId: string): Character => ({
    id: id(),
    campaignId,
    name: '',
    species: '',
    background: '',
    classes: [],
    xp: 0,
    abilityScores: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    savingThrows: [],
    skills: {},
    tools: [],
    languages: ['Common'],
    weaponProficiencies: [],
    armorTraining: [],
    weaponMasteries: [],
    armorClass: 10,
    speed: 30,
    size: 'Medium',
    hp: { max: 1, current: 1, temp: 0 },
    hitDice: [],
    deathSaves: { successes: 0, failures: 0, stable: false, dead: false },
    conditions: [],
    exhaustion: 0,
    heroicInspiration: false,
    features: [],
    attacks: [],
    inventory: [],
    currency: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
    personality: {},
    notes: '',
    createdAt: 1,
    updatedAt: 1,
  }),
  applyDamage: (c: Character, amount: number) => {
    const fromTemp = Math.min(c.hp.temp, amount);
    const current = Math.max(0, c.hp.current - (amount - fromTemp));
    return { character: bump({ ...c, hp: { ...c.hp, temp: c.hp.temp - fromTemp, current } }), events: [evt('hp-changed', `HP ${c.hp.current} → ${current}`)] };
  },
  applyHealing: (c: Character, amount: number) => {
    const current = Math.min(c.hp.max, c.hp.current + amount);
    return { character: bump({ ...c, hp: { ...c.hp, current } }), events: [evt('hp-changed', `HP ${c.hp.current} → ${current}`)] };
  },
  setTempHp: (c: Character, amount: number) => ({ character: bump({ ...c, hp: { ...c.hp, temp: Math.max(c.hp.temp, amount) } }), events: [evt('temp-hp', 'temp')] }),
  recordDeathSave: (c: Character, natural: number) => {
    const success = natural >= 10;
    const ds = { ...c.deathSaves };
    if (natural === 20) return { character: bump({ ...c, hp: { ...c.hp, current: 1 }, deathSaves: { successes: 0, failures: 0, stable: false, dead: false } }), events: [], outcome: 'revived' as const };
    if (success) ds.successes += 1;
    else ds.failures += natural === 1 ? 2 : 1;
    const outcome = ds.failures >= 3 ? ('dead' as const) : ds.successes >= 3 ? ('stable' as const) : success ? ('success' as const) : ('failure' as const);
    ds.dead = outcome === 'dead';
    ds.stable = outcome === 'stable';
    return { character: bump({ ...c, deathSaves: ds }), events: [], outcome };
  },
  changeExhaustion: (c: Character, delta: number) => ({ character: bump({ ...c, exhaustion: Math.max(0, Math.min(6, c.exhaustion + delta)) }), events: [] }),
  setConcentration: (c: Character, spellName: string | null) =>
    c.spellcasting ? { character: bump({ ...c, spellcasting: { ...c.spellcasting, concentratingOn: spellName } }), events: [] } : { character: c, events: [] },
  findFeature: (c: Character, name: string) => c.features.find((f) => f.name.toLowerCase() === name.toLowerCase()),
  useFeature: (c: Character, name: string, amount = 1) => ({
    character: bump({ ...c, features: c.features.map((f) => (f.name === name && f.uses ? { ...f, uses: { ...f.uses, used: Math.min(f.uses.max, f.uses.used + amount) } } : f)) }),
    events: [evt('feature-used', name)],
  }),
  restoreFeature: (c: Character, name: string, amount?: number) => ({
    character: bump({ ...c, features: c.features.map((f) => (f.name === name && f.uses ? { ...f, uses: { ...f.uses, used: Math.max(0, f.uses.used - (amount ?? f.uses.used)) } } : f)) }),
    events: [evt('feature-restored', name)],
  }),
  findItem: (c: Character, name: string) => c.inventory.find((i) => i.name.toLowerCase() === name.toLowerCase()),
  addItem: (c: Character, item: Omit<InventoryItem, 'id'> & { id?: string }) => {
    const existing = c.inventory.find((i) => i.name.toLowerCase() === item.name.toLowerCase() && !i.magic);
    const inventory = existing
      ? c.inventory.map((i) => (i === existing ? { ...i, quantity: i.quantity + item.quantity } : i))
      : [...c.inventory, { ...item, id: item.id ?? id() }];
    return { character: bump({ ...c, inventory }), events: [evt('item-added', item.name)] };
  },
  removeItem: (c: Character, name: string, quantity?: number) => {
    const existing = c.inventory.find((i) => i.name.toLowerCase() === name.toLowerCase());
    if (!existing) return { character: c, events: [evt('warning', `No ${name}`)] };
    const left = quantity === undefined ? 0 : existing.quantity - quantity;
    const inventory = left > 0 ? c.inventory.map((i) => (i === existing ? { ...i, quantity: left } : i)) : c.inventory.filter((i) => i !== existing);
    return { character: bump({ ...c, inventory }), events: [evt('item-removed', name)] };
  },
  updateItem,
  totalGp: (cur: Character['currency']) => cur.pp * 10 + cur.gp + cur.ep / 2 + cur.sp / 10 + cur.cp / 100,
  addCondition: (c: Character, condition: Character['conditions'][number]) => ({ character: bump({ ...c, conditions: [...c.conditions.filter((x) => x.id !== condition.id), condition] }), events: [] }),
  removeCondition: (c: Character, conditionId: string) => ({ character: bump({ ...c, conditions: c.conditions.filter((x) => x.id !== conditionId) }), events: [] }),

  // progression
  XP_THRESHOLDS: [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000],
  levelForXp: (xp: number) => [0, 300, 900, 2700, 6500].filter((t) => xp >= t).length,
  xpToNextLevel: (c: Character) => {
    const thresholds = [0, 300, 900, 2700, 6500, 14000];
    const next = thresholds[level(c)];
    return next === undefined ? null : Math.max(0, next - c.xp);
  },
  levelUp: (c: Character, opts: Engine.LevelUpOptions): Engine.LevelUpResult => {
    const existing = c.classes.find((k) => k.name === opts.className);
    const classes = existing
      ? c.classes.map((k) => (k === existing ? { ...k, level: k.level + 1, ...(opts.subclass ? { subclass: opts.subclass } : {}) } : k))
      : [...c.classes, { classId: opts.classId ?? opts.className, name: opts.className, level: 1, hitDie: opts.hitDie ?? 8, casterType: opts.casterType ?? 'none' }];
    const die = existing?.hitDie ?? opts.hitDie ?? 8;
    const con = mod(c.abilityScores.con);
    let hpRoll: RollResult | undefined;
    let base: number;
    if (opts.hpMethod === 'average') base = die / 2 + 1;
    else if (opts.hpMethod === 'roll') {
      hpRoll = rollDice(`1d${die}`, { rng: opts.rng });
      base = hpRoll.total;
    } else base = opts.hpMethod.fixed;
    const hpGained = Math.max(1, base + con);
    const newLevel = level(c) + 1;
    const hitDice = c.hitDice.some((h) => h.die === die)
      ? c.hitDice.map((h) => (h.die === die ? { ...h, total: h.total + 1 } : h))
      : [...c.hitDice, { die, total: 1, spent: 0 }];
    const features = [...c.features, ...(opts.newFeatures ?? []).map((f) => ({ ...f, id: id() }))];
    return {
      character: bump({ ...c, classes, hitDice, features, hp: { ...c.hp, max: c.hp.max + hpGained, current: c.hp.current + hpGained } }),
      events: [evt('level-up', `Level ${newLevel}`)],
      newLevel,
      hpGained,
      ...(hpRoll ? { hpRoll } : {}),
      reminders: newLevel === 4 ? ['Level 4: choose an Ability Score Improvement or a feat'] : [],
    };
  },
  spendHitDie: (c: Character) => ({ character: c, events: [], roll: null, healed: 0 }),

  // conditions
  CONDITIONS: {} as (typeof Engine)['CONDITIONS'],
  conditionName: (conditionId: string) => conditionId.charAt(0).toUpperCase() + conditionId.slice(1),
  normalizeConditionId: () => null,
} satisfies Partial<typeof Engine>;
