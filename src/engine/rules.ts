/**
 * Derived character statistics under the 2024 rules (SRD 5.2.1). Pure functions.
 *
 * The basic modifiers (skills, saves, initiative, attacks) EXCLUDE the Exhaustion penalty; the roll
 * helpers (rollRequestModifier, deathSaveModifier) add it, because it applies to every D20 Test.
 */
import {
  ABILITY_NAMES,
  SKILL_ABILITY,
  SKILL_NAMES,
  type Ability,
  type Attack,
  type Character,
  type EquipmentOption,
  type GameEvent,
  type InventoryItem,
  type PlayerRollRequest,
  type Skill,
  type SkillBonus,
} from '@/types';
import { nameKey } from '@/lib/id';
import { resolveArmor, wornArmor, type WornArmor } from './armorData';
import { srdClassFor } from './classData';
import { INCAPACITATING_CONDITIONS, SPEED_ZERO_CONDITIONS, conditionKey, conditionName } from './conditions';
import {
  DiceError,
  criticalDice,
  criticalDiceTerms,
  d20Expression,
  formatDice,
  normalizeDice,
  parseDice,
  type DiceTerm,
} from './dice';
import { clamp, gameEvent, matchByName, toInt, warning } from './util';

const MINUS = '\u2212';

/** floor((score - 10) / 2) */
export function abilityModifier(score: number): number {
  return Math.floor((toInt(score, 10) - 10) / 2);
}

/** "+3", "+0", "−1" (uses a true minus sign). */
export function formatModifier(mod: number): string {
  const n = toInt(mod);
  return n < 0 ? `${MINUS}${Math.abs(n)}` : `+${n}`;
}

/** +2 at levels 1–4, +3 at 5–8, +4 at 9–12, +5 at 13–16, +6 at 17–20. */
export function proficiencyBonus(level: number): number {
  const l = clamp(toInt(level, 1), 1, 20);
  return Math.floor((l - 1) / 4) + 2;
}

/** Total character level (sum of class levels, minimum 1). */
export function characterLevel(c: Character): number {
  return Math.max(1, c.classes.reduce((sum, cl) => sum + Math.max(0, toInt(cl.level)), 0));
}

function abilityScore(c: Character, ability: Ability): number {
  return toInt(c.abilityScores[ability], 10);
}

function mod(c: Character, ability: Ability): number {
  return abilityModifier(abilityScore(c, ability));
}

function pb(c: Character): number {
  return proficiencyBonus(characterLevel(c));
}

/** Exhaustion level clamped to 0–6. */
export function exhaustionLevel(c: Character): number {
  return clamp(toInt(c.exhaustion), 0, 6);
}

/** 2024 Exhaustion: −2 × exhaustion level applied to every d20 test (0 when not exhausted). */
export function exhaustionPenalty(c: Character): number {
  const level = exhaustionLevel(c);
  return level === 0 ? 0 : -2 * level;
}

/** True when the character has the (standard or homebrew) condition. */
export function hasCondition(c: Character, id: string): boolean {
  const key = conditionKey(id);
  return c.conditions.some((cond) => conditionKey(cond.id) === key);
}

/** Incapacitated, or a condition that includes it (Paralyzed, Petrified, Stunned, Unconscious). */
export function isIncapacitated(c: Character): boolean {
  return c.conditions.some((cond) => INCAPACITATING_CONDITIONS.has(conditionKey(cond.id)));
}

/**
 * Level-1 Order options that add WIS (minimum +1) to Intelligence checks with two skills (SRD 5.2.1
 * Cleric "Divine Order: Thaumaturge", Druid "Primal Order: Magician"). Derived from the feature the
 * builder adds ("Divine Order (Thaumaturge)") for sheets that don't list them in skillBonuses.
 */
const ORDER_SKILL_BONUSES: ReadonlyArray<{ feature: RegExp; key: string; bonus: SkillBonus }> = [
  {
    feature: /^(divine-order-)?thaumaturge$/,
    key: 'thaumaturge',
    bonus: { skills: ['arcana', 'religion'], ability: 'wis', minimum: 1, source: 'Thaumaturge (Divine Order)' },
  },
  {
    feature: /^(primal-order-)?magician$/,
    key: 'magician',
    bonus: { skills: ['arcana', 'nature'], ability: 'wis', minimum: 1, source: 'Magician (Primal Order)' },
  },
];

/** The sheet's skill bonuses plus Thaumaturge / Magician derived from features (never both for one source). */
export function skillBonuses(c: Character): SkillBonus[] {
  const listed = (c.skillBonuses ?? []).filter((b) => Array.isArray(b?.skills));
  const derived = ORDER_SKILL_BONUSES.filter(
    (o) => c.features.some((f) => o.feature.test(nameKey(f.name))) && !listed.some((b) => nameKey(b.source ?? '').includes(o.key)),
  ).map((o) => o.bonus);
  return [...listed, ...derived];
}

/** Value of one skill bonus: ability modifier + flat, raised to its minimum. */
export function skillBonusValue(c: Character, bonus: SkillBonus): number {
  const raw = (bonus.ability ? mod(c, bonus.ability) : 0) + toInt(bonus.flat);
  return bonus.minimum === undefined ? raw : Math.max(toInt(bonus.minimum), raw);
}

/** Total bonus to checks with a skill (the same source counts once). */
function skillBonusTotal(c: Character, skill: Skill): number {
  const seen = new Set<string>();
  let total = 0;
  for (const bonus of skillBonuses(c)) {
    const key = nameKey(bonus.source ?? '');
    if (!bonus.skills.includes(skill) || seen.has(key)) continue;
    seen.add(key);
    total += skillBonusValue(c, bonus);
  }
  return total;
}

/**
 * Skill modifier: ability mod + floor(PB × proficiency level) + skill bonuses (Thaumaturge, Magician…).
 * Excludes the exhaustion penalty.
 */
export function skillModifier(c: Character, skill: Skill): number {
  return mod(c, SKILL_ABILITY[skill]) + Math.floor(pb(c) * (c.skills[skill] ?? 0)) + skillBonusTotal(c, skill);
}

const PROTECTION_ITEMS = new Set(['ring-of-protection', 'cloak-of-protection']);

/** Attuned items that aren't explicitly unequipped (rings, cloaks and bracers must be worn to work). */
function wornAttuned(c: Character) {
  return c.inventory.filter((i) => i.attuned && i.equipped !== false);
}

/** +1 per distinct attuned Ring / Cloak of Protection (SRD magic items: +1 to AC and saving throws). */
function protectionItemBonus(c: Character): number {
  const owned = new Set(wornAttuned(c).map((i) => nameKey(i.name)));
  return [...PROTECTION_ITEMS].filter((key) => owned.has(key)).length;
}

function classLevelOf(c: Character, className: string): number {
  return c.classes.filter((cl) => srdClassFor(cl)?.name === className).reduce((sum, cl) => sum + cl.level, 0);
}

function hasFeature(c: Character, name: string): boolean {
  const key = nameKey(name);
  return c.features.some((f) => nameKey(f.name) === key);
}

/** Paladin's Aura of Protection (level 6): +CHA (min +1) to saves, inactive while Incapacitated. */
function auraOfProtectionBonus(c: Character): number {
  if (isIncapacitated(c)) return 0;
  const hasAura = classLevelOf(c, 'Paladin') >= 6 || hasFeature(c, 'Aura of Protection');
  return hasAura ? Math.max(1, mod(c, 'cha')) : 0;
}

/**
 * Saving throw modifier: ability mod + PB if proficient, plus always-on save bonuses the sheet can see
 * (attuned Ring/Cloak of Protection, the Paladin's own Aura of Protection). Excludes the exhaustion penalty.
 */
export function savingThrowModifier(c: Character, ability: Ability): number {
  const proficient = c.savingThrows.includes(ability) ? pb(c) : 0;
  return mod(c, ability) + proficient + protectionItemBonus(c) + auraOfProtectionBonus(c);
}

/** Modifier for a Death Saving Throw: it's a saving throw, so the exhaustion penalty and save bonuses apply. */
export function deathSaveModifier(c: Character): number {
  return exhaustionPenalty(c) + protectionItemBonus(c) + auraOfProtectionBonus(c);
}

/** Raw ability check (no skill): the ability modifier. */
export function abilityCheckModifier(c: Character, ability: Ability): number {
  return mod(c, ability);
}

/** DEX modifier + initiativeBonusExtra. */
export function initiativeModifier(c: Character): number {
  return mod(c, 'dex') + toInt(c.initiativeBonusExtra);
}

/** 10 + Perception modifier + passivePerceptionExtra. */
export function passivePerception(c: Character): number {
  return 10 + skillModifier(c, 'perception') + toInt(c.passivePerceptionExtra);
}

/** The character's spellcasting ability, or null for non-casters. */
export function spellcastingAbility(c: Character): Ability | null {
  if (c.spellcasting?.ability) return c.spellcasting.ability;
  const caster = c.classes.find((cl) => cl.casterType !== 'none' && cl.spellcastingAbility);
  return caster?.spellcastingAbility ?? null;
}

/** 8 + PB + spellcasting ability modifier, or null for non-casters. */
export function spellSaveDC(c: Character, ability?: Ability): number | null {
  const a = ability ?? spellcastingAbility(c);
  return a ? 8 + pb(c) + mod(c, a) : null;
}

/** PB + spellcasting ability modifier, or null for non-casters. */
export function spellAttackBonus(c: Character, ability?: Ability): number | null {
  const a = ability ?? spellcastingAbility(c);
  return a ? pb(c) + mod(c, a) : null;
}

/** The highest of INT / WIS / CHA (used when a spell attack has no recorded spellcasting ability). */
function bestMentalAbility(c: Character): Ability {
  return (['int', 'wis', 'cha'] as const).reduce((best, a) => (mod(c, a) > mod(c, best) ? a : best), 'int' as Ability);
}

/** Ability modifier used by an attack (resolves 'finesse' and 'spell'). */
export function attackAbilityModifier(c: Character, attack: Attack): number {
  if (attack.ability === 'finesse') return Math.max(mod(c, 'str'), mod(c, 'dex'));
  if (attack.ability === 'spell') return mod(c, spellcastingAbility(c) ?? bestMentalAbility(c));
  return mod(c, attack.ability);
}

/** Attack roll bonus: ability mod + PB (if proficient) + attackBonusExtra. */
export function attackBonus(c: Character, attack: Attack): number {
  return attackAbilityModifier(c, attack) + (attack.proficient ? pb(c) : 0) + toInt(attack.attackBonusExtra);
}

const DAMAGE_PREFIX_RE =
  /^\s*[+-]?\s*(?:\d*d(?:\d+|%)(?:k[hl]?\d*|d[hl]\d*)?|\d+)(?:\s*[+-]\s*(?:\d*d(?:\d+|%)(?:k[hl]?\d*|d[hl]\d*)?|\d+))*/i;

/** Parse a damage string leniently: "1d8 slashing" and "1d6+2 (versatile 1d8)" read their leading dice. */
function parseDamage(text: string): DiceTerm[] | null {
  try {
    return parseDice(text);
  } catch (err) {
    if (!(err instanceof DiceError)) throw err;
  }
  const prefix = DAMAGE_PREFIX_RE.exec(text.replace(/[\u2212\u2013]/g, '-'));
  if (!prefix) return null;
  try {
    return parseDice(prefix[0]);
  } catch {
    return null;
  }
}

type DiceGroup = Extract<DiceTerm, { kind: 'dice' }>;

/**
 * How many times a cantrip's base damage dice are rolled at a character level: ×2 at 5, ×3 at 11,
 * ×4 at 17 (SRD 5.2.1 "Cantrip Upgrade", e.g. Fire Bolt 1d10 → 2d10 → 3d10 → 4d10).
 */
export function cantripDiceMultiplier(level: number): number {
  const l = toInt(level, 1);
  return l >= 17 ? 4 : l >= 11 ? 3 : l >= 5 ? 2 : 1;
}

/** Sides of the Monk's Martial Arts die by Monk level (SRD 5.2.1 Monk Features table): d6, d8 at 5, d10 at 11, d12 at 17. */
export function martialArtsDieSides(monkLevel: number): 6 | 8 | 10 | 12 | null {
  const l = toInt(monkLevel);
  if (l < 1) return null;
  return l >= 17 ? 12 : l >= 11 ? 10 : l >= 5 ? 8 : 6;
}

function isEldritchBlast(attack: Attack): boolean {
  return nameKey(attack.name).startsWith('eldritch-blast');
}

/**
 * How an attack's damage dice grow with level: its `scaling`; a Monk's Unarmed Strike (Martial Arts);
 * or, on sheets made before the `scaling` field existed (no attack has one), a spell-attack cantrip —
 * notes "Cantrip" or a known cantrip of the same name. Newer sheets leave out `scaling` on purpose for
 * cantrips that don't gain dice.
 */
export function attackScaling(c: Character, attack: Attack): Attack['scaling'] {
  if (attack.scaling === 'cantrip' || attack.scaling === 'martial-arts') return attack.scaling;
  if (attack.ability === 'spell') {
    if (c.attacks.some((a) => a.scaling)) return undefined;
    const known = (c.spellcasting?.spells ?? []).some((s) => s.level === 0 && nameKey(s.name) === nameKey(attack.name));
    return known || /\bcantrip\b/i.test(attack.notes ?? '') ? 'cantrip' : undefined;
  }
  return nameKey(attack.name) === 'unarmed-strike' && isMonk(c) ? 'martial-arts' : undefined;
}

/**
 * Eldritch Blast's beams at the hero's level: 1, then 2 at character level 5, 3 at 11 and 4 at 17, each
 * a separate attack roll for 1d10 (SRD 5.2.1 Eldritch Blast, "Cantrip Upgrade"); null for other attacks.
 */
export function eldritchBlastBeams(c: Character, attack: Attack): number | null {
  return isEldritchBlast(attack) ? cantripDiceMultiplier(characterLevel(c)) : null;
}

/** Wearing armor or wielding a Shield (Martial Arts works only without either). */
function wearsArmorOrShield(c: Character): boolean {
  const { known, unknown } = wornArmor(c.inventory);
  return known.length > 0 || unknown.length > 0;
}

/**
 * Damage dice after level scaling (`flat` = the damage string's own flat bonus):
 * - cantrip: every die rolled ×1/2/3/4 by character level — except Eldritch Blast, which gains beams
 *   instead. Sheets without a `scaling` field are scaled only from the cantrip's single base die.
 * - martial-arts: the Martial Arts die for the Monk level replaces a smaller die, or the Unarmed Strike's
 *   flat 1 ("roll 1d6 in place of the normal damage", SRD 5.2.1 Monk), unless armor or a Shield is worn.
 */
function scaledDamage(c: Character, attack: Attack, dice: DiceGroup[], flat: number): { dice: DiceGroup[]; flat: number } {
  const scaling = attackScaling(c, attack);
  if (scaling === 'cantrip') {
    if (isEldritchBlast(attack)) return { dice, flat };
    const baseDie = dice.length === 1 && dice[0].count === 1 && !dice[0].keep;
    if (!attack.scaling && !baseDie) return { dice, flat };
    const n = cantripDiceMultiplier(characterLevel(c));
    return { dice: dice.map((t) => (t.keep ? t : { ...t, count: t.count * n })), flat };
  }
  if (scaling === 'martial-arts') {
    const sides = martialArtsDieSides(classLevelOf(c, 'Monk'));
    if (!sides || wearsArmorOrShield(c)) return { dice, flat };
    const index = dice.findIndex((t) => t.sign > 0 && !t.keep);
    if (index < 0) return flat >= 1 ? { dice: [{ kind: 'dice', sign: 1, count: 1, sides }], flat: flat - 1 } : { dice, flat };
    if (dice[index].count !== 1 || dice[index].sides >= sides) return { dice, flat };
    return { dice: dice.map((t, i) => (i === index ? { ...t, sides } : t)), flat };
  }
  return { dice, flat };
}

/**
 * Damage expression including the ability modifier (unless addAbilityToDamage === false),
 * e.g. "1d8+3". Cantrip and Martial Arts dice grow with level (see attackScaling): a level-5 Fire Bolt
 * is "2d10". With critical=true the dice are doubled ("2d8+3"). Flat terms are merged into one.
 * An unreadable damage string is returned unchanged (rolling it then reports the problem).
 */
export function attackDamageExpression(c: Character, attack: Attack, critical = false): string {
  const terms = parseDamage(attack.damage ?? '');
  if (!terms) return (attack.damage ?? '').trim();
  const abilityBonus = attack.addAbilityToDamage === false ? 0 : attackAbilityModifier(c, attack);
  const base = scaledDamage(
    c,
    attack,
    terms.filter((t): t is DiceGroup => t.kind === 'dice'),
    terms.reduce((sum, t) => (t.kind === 'flat' ? sum + t.sign * t.value : sum), 0),
  );
  const flat = base.flat + abilityBonus;
  const merged: DiceTerm[] = [...(critical ? criticalDiceTerms(base.dice) : base.dice)];
  if (flat !== 0 || merged.length === 0) merged.push({ kind: 'flat', sign: flat < 0 ? -1 : 1, value: Math.abs(flat) });
  return formatDice(merged);
}

// ---------------------------------------------------------------------------
// Critical hits
// ---------------------------------------------------------------------------

/** Has a feature by name, ignoring a "(…)" suffix ("Improved Critical (Champion)"). */
function hasFeatureBase(c: Character, name: string): boolean {
  const key = nameKey(name);
  return c.features.some((f) => nameKey(f.name) === key || nameKey(f.name.replace(/\s*\([^)]*\)\s*$/, '')) === key);
}

/**
 * The lowest natural d20 that scores a Critical Hit with the hero's weapon and Unarmed Strike attacks:
 * 18 with Superior Critical (Champion 15), 19 with Improved Critical (Champion 3), else 20
 * (SRD 5.2.1 Fighter, "Fighter Subclass: Champion").
 */
export function weaponCritRange(c: Character): number {
  const champion = c.classes
    .filter((cl) => srdClassFor(cl)?.name === 'Fighter' && /champion/i.test(cl.subclass ?? ''))
    .reduce((sum, cl) => sum + Math.max(0, toInt(cl.level)), 0);
  if (champion >= 15 || hasFeatureBase(c, 'Superior Critical')) return 18;
  if (champion >= 3 || hasFeatureBase(c, 'Improved Critical')) return 19;
  return 20;
}

/** A spell attack: a sheet attack using the spellcasting ability, or (off the sheet) a known spell's name. */
function isSpellAttack(c: Character, attackName: string | undefined): boolean {
  const name = attackName?.trim() ?? '';
  if (!name) return false;
  const attack = findAttack(c, name);
  if (attack) return attack.ability === 'spell';
  return !!(c.spellcasting && matchByName(c.spellcasting.spells, name, (s) => s.name).match);
}

/**
 * Critical range for a roll request: weaponCritRange for weapon and Unarmed Strike attack rolls; 20 for
 * spell attacks and every other roll. Judge the roll with applyAttackRollRules(result, { critRange }).
 */
export function attackCritRange(c: Character, req: Pick<PlayerRollRequest, 'rollType' | 'attackName'>): number {
  if (req.rollType !== 'attack') return 20;
  const range = weaponCritRange(c);
  return range < 20 && !isSpellAttack(c, req.attackName) ? range : 20;
}

export interface SpeedDetails {
  /** Walking speed after penalties. */
  speed: number;
  /** Walking speed on the sheet. */
  base: number;
  /** Why the speed differs, e.g. "Exhaustion 2: −10 ft". */
  notes: string[];
}

/** Heavy armor below its Strength requirement costs 10 ft of Speed (SRD 5.2.1 Armor table). */
function heavyArmorNote(c: Character): string | null {
  const strength = abilityScore(c, 'str');
  for (const item of c.inventory) {
    if (!item.equipped) continue;
    const stats = item.category === undefined || item.category === 'armor' || item.category === 'magic-item' ? resolveArmor(item) : null;
    if (stats?.strength && strength < stats.strength) return `${stats.name} needs Strength ${stats.strength}: ${MINUS}10 ft`;
  }
  return null;
}

/** Walking speed with an explanation of every penalty applied. */
export function speedDetails(c: Character): SpeedDetails {
  const base = Math.max(0, toInt(c.speed));
  if (c.deathSaves.dead) return { speed: 0, base, notes: ['Dead'] };
  const zeroing = c.conditions.map((cond) => conditionKey(cond.id)).find((id) => SPEED_ZERO_CONDITIONS.has(id));
  if (zeroing) return { speed: 0, base, notes: [`${conditionName(zeroing)}: Speed 0`] };
  const notes: string[] = [];
  let speed = base;
  const armorNote = heavyArmorNote(c);
  if (armorNote) {
    speed -= 10;
    notes.push(armorNote);
  }
  const exhaustion = exhaustionLevel(c);
  if (exhaustion > 0) {
    speed -= 5 * exhaustion;
    notes.push(`Exhaustion ${exhaustion}: ${MINUS}${5 * exhaustion} ft`);
  }
  return { speed: Math.max(0, speed), base, notes };
}

/** Walking speed after exhaustion (−5 ft per level) and speed-zeroing conditions (grappled, restrained...). */
export function effectiveSpeed(c: Character): number {
  return speedDetails(c).speed;
}

// ---------------------------------------------------------------------------
// Armor Class
// ---------------------------------------------------------------------------

/** Armor Training for an armor category or Shields ("Light armor", "Shields", "All armor"). */
export function hasArmorTraining(c: Character, kind: 'light' | 'medium' | 'heavy' | 'shield'): boolean {
  return c.armorTraining.some((t) => {
    const text = t.toLowerCase();
    return kind === 'shield' ? text.includes('shield') : text.includes(kind) || text.includes('all armor');
  });
}

function signedPart(label: string, value: number): string {
  return `${label} ${value < 0 ? `${MINUS}${Math.abs(value)}` : value}`;
}

interface AcOption {
  ac: number;
  parts: string[];
  allowsShield: boolean;
  worn?: WornArmor;
}

function armoredOption(c: Character, worn: WornArmor): AcOption {
  const dexMod = mod(c, 'dex');
  const { stats } = worn;
  const parts = [`${stats.name} ${stats.baseAc}`];
  let ac = stats.baseAc;
  if (stats.dexCap !== 0) {
    const dex = stats.dexCap === null ? dexMod : Math.min(dexMod, stats.dexCap);
    ac += dex;
    parts.push(`${signedPart('DEX', dex)}${stats.dexCap !== null && dexMod > stats.dexCap ? ` (max ${stats.dexCap})` : ''}`);
  }
  if (worn.bonus) {
    ac += worn.bonus;
    parts.push(`${worn.bonus} (magic)`);
  }
  return { ac, parts, allowsShield: true, worn };
}

function unarmoredOptions(c: Character): AcOption[] {
  const dex = mod(c, 'dex');
  const options: AcOption[] = [{ ac: 10 + dex, parts: ['10', signedPart('DEX', dex)], allowsShield: true }];
  const classNames = new Set(c.classes.map((cl) => srdClassFor(cl)?.name ?? cl.name));
  const udSources = c.features.filter((f) => nameKey(f.name) === 'unarmored-defense').map((f) => (f.sourceName ?? '').toLowerCase());
  if (classNames.has('Barbarian') || udSources.some((s) => s.includes('barbarian'))) {
    const con = mod(c, 'con');
    options.push({ ac: 10 + dex + con, parts: ['Unarmored Defense: 10', signedPart('DEX', dex), signedPart('CON', con)], allowsShield: true });
  }
  if (classNames.has('Monk') || udSources.some((s) => s.includes('monk'))) {
    const wis = mod(c, 'wis');
    options.push({ ac: 10 + dex + wis, parts: ['Unarmored Defense: 10', signedPart('DEX', dex), signedPart('WIS', wis)], allowsShield: false });
  }
  const draconic =
    hasFeature(c, 'Draconic Resilience') ||
    c.classes.some((cl) => srdClassFor(cl)?.name === 'Sorcerer' && /draconic/i.test(cl.subclass ?? ''));
  if (draconic) {
    const cha = mod(c, 'cha');
    options.push({ ac: 10 + dex + cha, parts: ['Draconic Resilience: 10', signedPart('DEX', dex), signedPart('CHA', cha)], allowsShield: true });
  }
  return options;
}

function bestOf(options: AcOption[]): AcOption {
  return options.reduce((best, o) => (o.ac > best.ac ? o : best));
}

/**
 * Armor class from equipped armor/shield in the inventory (falls back to 10 + DEX). Returns a formula note.
 * Handles light/medium (DEX max 2)/heavy armor, +N magic armor and shields, shield training (an
 * untrained shield gives no AC), Barbarian/Monk Unarmored Defense, Draconic Resilience, the Defense
 * fighting style, attuned Ring/Cloak of Protection and Bracers of Defense. When equipped armor can't
 * be identified, the sheet's current AC is kept.
 */
export function computeArmorClass(c: Character, catalog: readonly EquipmentOption[] = []): { ac: number; formula: string } {
  const { known } = wornArmor(c.inventory, catalog);
  const armors = known.filter((w) => w.stats.kind === 'armor');
  const shields = known.filter((w) => w.stats.kind === 'shield');
  const unknownArmor = unknownWornArmor(c, catalog);
  if (unknownArmor) {
    return { ac: c.armorClass, formula: `${unknownArmor.name} (stats unknown — AC kept at ${c.armorClass})` };
  }

  const notes: string[] = [];
  const shield = shields.length
    ? shields.reduce((best, s) => (s.stats.baseAc + s.bonus > best.stats.baseAc + best.bonus ? s : best))
    : undefined;
  const options = armors.length ? armors.map((w) => armoredOption(c, w)) : unarmoredOptions(c);
  const usable = shield ? options.filter((o) => o.allowsShield) : options;
  const base = bestOf(usable.length ? usable : options);
  let ac = base.ac;
  const parts = [...base.parts];

  if (armors.length > 1) notes.push('only one suit of armor counts');
  const armorType = base.worn?.stats.armorType;
  if (armorType && !hasArmorTraining(c, armorType)) {
    notes.push(`untrained in ${armorType} armor: Disadvantage on STR/DEX D20 Tests and no spellcasting`);
  }
  if (shield) {
    if (hasArmorTraining(c, 'shield')) {
      const value = shield.stats.baseAc + shield.bonus;
      ac += value;
      parts.push(`Shield ${value}${shield.bonus ? ` (+${shield.bonus} magic)` : ''}`);
    } else {
      notes.push('no Shield training: the Shield gives no AC');
    }
  }
  if (armors.length && c.features.some((f) => /^(fighting-style-)?defense(-fighting-style)?$/.test(nameKey(f.name)))) {
    ac += 1;
    parts.push('Defense 1');
  }
  const counted = new Set<string>();
  for (const item of wornAttuned(c)) {
    const key = nameKey(item.name);
    if (counted.has(key)) continue; // the same magic item's bonus doesn't stack
    if (PROTECTION_ITEMS.has(key)) {
      ac += 1;
      parts.push(`${item.name} 1`);
      counted.add(key);
    } else if (key === 'bracers-of-defense' && !armors.length && !shield) {
      ac += 2;
      parts.push(`${item.name} 2`);
      counted.add(key);
    }
  }
  const formula = parts.join(' + ') + (notes.length ? ` (${notes.join('; ')})` : '');
  return { ac, formula };
}

/** Equipped armor whose stats aren't known, when no known armor is worn (computeArmorClass then keeps the sheet's AC). */
function unknownWornArmor(c: Character, catalog: readonly EquipmentOption[]): InventoryItem | undefined {
  const { known, unknown } = wornArmor(c.inventory, catalog);
  if (known.some((w) => w.stats.kind === 'armor')) return undefined;
  return unknown.find((i) => i.category === 'armor');
}

/**
 * Keep the stored Armor Class in step after a change that can affect it: a new level (Unarmored
 * Defense from multiclassing, Draconic Resilience), or equipping, attuning or dropping an item.
 * The sheet's AC counts as derived when it equals computeArmorClass(before); it then becomes the AC
 * computed for `after`. Otherwise it was set by hand or by an effect the engine doesn't model (Mage
 * Armor, armor it can't identify), so it is kept and a warning gives the computed value instead.
 * Without a catalog the SRD armor table is used. No events when the computed AC doesn't change.
 */
export function syncArmorClass(
  before: Character,
  after: Character,
  catalog: readonly EquipmentOption[] = [],
): { character: Character; events: GameEvent[] } {
  const was = computeArmorClass(before, catalog);
  const now = computeArmorClass(after, catalog);
  if (now.ac === was.ac && now.formula === was.formula) return { character: after, events: [] };
  const stored = after.armorClass;
  const derived = before.armorClass === was.ac && stored === before.armorClass;
  if (!derived) {
    if (now.ac === stored) return { character: after, events: [] };
    return {
      character: after,
      events: [
        warning(
          `AC kept at ${stored}: it differs from the ${was.ac} that gear and features gave, so it may include a spell such as Mage Armor or a manual change. Gear and features now give AC ${now.ac} (${now.formula}); update the AC if that is right.`,
        ),
      ],
    };
  }
  const unknown = unknownWornArmor(after, catalog);
  if (unknown && unknown.id !== unknownWornArmor(before, catalog)?.id) {
    return {
      character: { ...after, acFormula: now.formula },
      events: [warning(`AC kept at ${stored}: ${unknown.name}'s armor stats are unknown, so set the AC by hand.`)],
    };
  }
  if (now.ac === stored) return { character: { ...after, acFormula: now.formula }, events: [] };
  return {
    character: { ...after, armorClass: now.ac, acFormula: now.formula },
    events: [gameEvent('combat', `AC ${stored} → ${now.ac} (${now.formula})`)],
  };
}

// ---------------------------------------------------------------------------
// Player roll requests
// ---------------------------------------------------------------------------

const ABBR = (a: Ability) => a.toUpperCase();

/** Find an attack on the sheet by (case-insensitive, fuzzy) name. */
export function findAttack(c: Character, name: string): Attack | undefined {
  return matchByName(c.attacks, name, (a) => a.name).match;
}

function isUnarmed(name: string): boolean {
  return /\b(unarmed|punch|kick|fist|headbutt)/i.test(name);
}

function isMonk(c: Character): boolean {
  return classLevelOf(c, 'Monk') > 0;
}

/** Attack bonus for an attack that isn't on the sheet: unarmed strikes, known spells, or a best guess. */
function improvisedAttack(c: Character, req: PlayerRollRequest): { modifier: number; label: string } {
  const name = (req.attackName ?? '').trim();
  const spell = name && c.spellcasting ? matchByName(c.spellcasting.spells, name, (s) => s.name).match : undefined;
  if (spell) return { modifier: spellAttackBonus(c) ?? pb(c) + mod(c, bestMentalAbility(c)), label: `${spell.name} attack` };
  if (name && isUnarmed(name)) {
    const ability = isMonk(c) ? Math.max(mod(c, 'str'), mod(c, 'dex')) : mod(c, 'str');
    return { modifier: ability + pb(c), label: 'Unarmed Strike attack' };
  }
  const ability = req.ability ?? 'str';
  return { modifier: mod(c, ability) + pb(c), label: name ? `${name} attack (${ABBR(ability)}, not on sheet)` : 'Attack roll' };
}

/**
 * A skill check, optionally with another ability (the DM's call). Skill bonuses such as Thaumaturge's
 * apply to the skill's usual ability only ("Intelligence (Arcana or Religion) checks").
 */
function skillCheck(c: Character, skill: Skill, ability?: Ability): { modifier: number; label: string } {
  const used = ability ?? SKILL_ABILITY[skill];
  const bonus = used === SKILL_ABILITY[skill] ? skillBonusTotal(c, skill) : 0;
  const modifier = mod(c, used) + Math.floor(pb(c) * (c.skills[skill] ?? 0)) + bonus;
  return { modifier, label: `${SKILL_NAMES[skill]} check (${ABBR(used)})` };
}

function baseRollModifier(c: Character, req: PlayerRollRequest): { modifier: number; label: string } {
  switch (req.rollType) {
    case 'skill':
    case 'ability':
      if (req.skill) return skillCheck(c, req.skill, req.ability);
      if (req.ability) return { modifier: abilityCheckModifier(c, req.ability), label: `${ABILITY_NAMES[req.ability]} check` };
      return { modifier: 0, label: 'Ability check' };
    case 'save':
      if (req.ability) return { modifier: savingThrowModifier(c, req.ability), label: `${ABILITY_NAMES[req.ability]} saving throw` };
      return { modifier: protectionItemBonus(c) + auraOfProtectionBonus(c), label: 'Saving throw' };
    case 'attack': {
      const attack = req.attackName ? findAttack(c, req.attackName) : undefined;
      return attack ? { modifier: attackBonus(c, attack), label: `${attack.name} attack` } : improvisedAttack(c, req);
    }
    case 'initiative':
      return { modifier: initiativeModifier(c), label: 'Initiative' };
    case 'death-save':
      return { modifier: deathSaveModifier(c), label: 'Death saving throw' };
    default:
      return { modifier: 0, label: '' };
  }
}

function nonD20Label(c: Character, req: PlayerRollRequest): string {
  if (req.rollType === 'hit-die') return 'Hit Point Die';
  if (req.rollType === 'damage') {
    const attack = req.attackName ? findAttack(c, req.attackName) : undefined;
    const name = attack?.name ?? (req.attackName?.trim() || '');
    return `${name ? `${name} damage` : 'Damage'}${req.critical ? ' (critical)' : ''}`;
  }
  const expression = req.expression?.trim();
  if (!expression) return 'Roll';
  try {
    return `Roll ${normalizeDice(expression)}`;
  } catch {
    return `Roll ${expression}`;
  }
}

/**
 * Modifier and label for a player roll request, e.g. { modifier: 5, label: "Stealth check (DEX)" }.
 * Includes the exhaustion penalty for d20 tests. For 'damage' / 'custom' / 'hit-die' the modifier is 0
 * and the expression carries any bonus (see rollRequestExpression).
 */
export function rollRequestModifier(c: Character, req: PlayerRollRequest): { modifier: number; label: string } {
  if (req.rollType === 'damage' || req.rollType === 'custom' || req.rollType === 'hit-die') {
    return { modifier: 0, label: nonD20Label(c, req) };
  }
  const base = baseRollModifier(c, req);
  // deathSaveModifier already includes the exhaustion penalty.
  const penalty = req.rollType === 'death-save' ? 0 : exhaustionPenalty(c);
  return { modifier: base.modifier + penalty, label: base.label };
}

/**
 * The full dice expression a roll request resolves to: "2d20kh1+5" for d20 tests (modifier from
 * rollRequestModifier), the sheet attack's damage ("2d4+2" for a critical Dagger hit) or the request's
 * own dice for damage, the request's dice for custom rolls, and largest-unspent-die + CON for hit dice.
 * Throws DiceError when the request's dice are invalid or a damage roll has nothing to roll.
 */
export function rollRequestExpression(c: Character, req: PlayerRollRequest): string {
  switch (req.rollType) {
    case 'damage': {
      const attack = req.attackName ? findAttack(c, req.attackName) : undefined;
      if (attack) return attackDamageExpression(c, attack, req.critical);
      if (req.expression) return req.critical ? criticalDice(req.expression) : normalizeDice(req.expression);
      if (req.attackName && isUnarmed(req.attackName)) {
        return formatDice([{ kind: 'flat', sign: 1, value: Math.max(0, 1 + mod(c, 'str')) }]);
      }
      throw new DiceError('A damage roll needs an attack from the sheet or dice to roll (e.g. 1d8+3)');
    }
    case 'custom':
      return normalizeDice(req.expression?.trim() || '1d20');
    case 'hit-die': {
      if (req.expression?.trim()) return normalizeDice(req.expression);
      const available = c.hitDice.filter((h) => h.spent < h.total).sort((a, b) => b.die - a.die);
      const die = available[0]?.die ?? c.hitDice[0]?.die ?? c.classes[0]?.hitDie ?? 8;
      const con = mod(c, 'con');
      return `1d${die}${con > 0 ? `+${con}` : con < 0 ? `${con}` : ''}`;
    }
    default:
      return d20Expression(rollRequestModifier(c, req).modifier, req.advantage);
  }
}
