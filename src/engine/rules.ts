/**
 * Derived character statistics under the 2024 rules (SRD 5.2.1). Pure functions.
 *
 * The basic modifiers (skills, saves, initiative, attacks) EXCLUDE the Exhaustion penalty; the roll
 * helpers (rollRequestModifier, deathSaveModifier) add it, because it applies to every D20 Test.
 */
import {
  ABILITY_NAMES,
  AC_SPELL_NAMES,
  SKILL_ABILITY,
  SKILL_NAMES,
  type AcSpellName,
  type Ability,
  type Attack,
  type Character,
  type EquipmentOption,
  type Feature,
  type GameEvent,
  type InventoryItem,
  type PlayerRollRequest,
  type Skill,
  type SkillBonus,
} from '@/types';
import { nameKey } from '@/lib/id';
import { resolveArmor, wornArmor, type WornArmor } from './armorData';
import { rulesClassFor } from './classData';
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
import { clamp, gameEvent, listJoin, matchByName, namesPhrase, toInt, warning } from './util';

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

/**
 * Attuned items that aren't explicitly unequipped (rings, cloaks and bracers must be worn to work). Items
 * with structured `bonuses` (imported magic items) are counted by itemBonuses instead, never by name.
 */
function wornAttuned(c: Character) {
  return c.inventory.filter((i) => i.attuned && i.equipped !== false && !i.bonuses);
}

/**
 * Items whose structured bonuses apply now (SRD 5.2.1 "Attunement"): worn (equipped, or attuned and not
 * taken off) and, when the item requires attunement, attuned. The same item counts once, and two copies
 * of a magic item don't stack.
 */
export function activeBonusItems(c: Character): InventoryItem[] {
  const seen = new Set<string>();
  return c.inventory.filter((i) => {
    if (!i.bonuses) return false;
    const worn = i.equipped === true || (i.attuned === true && i.equipped !== false);
    if (!worn || (i.requiresAttunement && !i.attuned)) return false;
    const key = nameKey(i.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One thing that adds to every saving throw beyond ability and proficiency, named for the DM's sheet. */
export interface SaveBonusSource {
  name: string;
  bonus: number;
}

/** Levels in an SRD class, a 2024 book's class standing in for it included (rulesClassFor). */
function classLevelOf(c: Character, className: string): number {
  return c.classes.filter((cl) => rulesClassFor(cl)?.name === className).reduce((sum, cl) => sum + cl.level, 0);
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
 * What adds to every saving throw now, by name: an attuned Ring or Cloak of Protection (SRD 5.2.1 Magic Items: "+1
 * bonus to Armor Class and saving throws"), an active magic item whose text the app read as an always-on bonus to
 * saving throws (activeBonusItems), and the Paladin's Aura of Protection. Each save modifier counts exactly these,
 * so the DM's sheet can name them and the DM can set one aside when a condition in an item's text doesn't hold.
 */
export function saveBonusSources(c: Character): SaveBonusSource[] {
  const out: SaveBonusSource[] = [];
  const worn = new Map<string, string>();
  for (const i of wornAttuned(c)) if (!worn.has(nameKey(i.name))) worn.set(nameKey(i.name), i.name);
  for (const key of PROTECTION_ITEMS) {
    const name = worn.get(key);
    if (name) out.push({ name, bonus: 1 });
  }
  for (const i of activeBonusItems(c)) {
    const bonus = Math.max(0, toInt(i.bonuses?.savingThrows));
    if (bonus) out.push({ name: i.name, bonus });
  }
  const aura = auraOfProtectionBonus(c);
  if (aura) out.push({ name: 'Aura of Protection', bonus: aura });
  return out;
}

/** The sum of saveBonusSources: what every saving throw adds beyond ability and proficiency. */
function saveBonus(c: Character): number {
  return saveBonusSources(c).reduce((sum, s) => sum + s.bonus, 0);
}

/**
 * Saving throw modifier: ability mod + PB if proficient, plus always-on save bonuses the sheet can see
 * (attuned Ring/Cloak of Protection, the Paladin's own Aura of Protection). Excludes the exhaustion penalty.
 */
export function savingThrowModifier(c: Character, ability: Ability): number {
  const proficient = c.savingThrows.includes(ability) ? pb(c) : 0;
  return mod(c, ability) + proficient + saveBonus(c);
}

/** Modifier for a Death Saving Throw: it's a saving throw, so the exhaustion penalty and save bonuses apply. */
export function deathSaveModifier(c: Character): number {
  return exhaustionPenalty(c) + saveBonus(c);
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
  // Martial Arts stops in armor or with a Shield, and the Dexterity the builder gave an attack for it goes with it.
  if (martialArtsFinesse(attack) && wearsArmorOrShield(c)) return mod(c, 'str');
  if (attack.ability === 'finesse' || dexterousMartialArts(c, attack)) return Math.max(mod(c, 'str'), mod(c, 'dex'));
  if (attack.ability === 'spell') return mod(c, spellcastingAbility(c) ?? bestMentalAbility(c));
  return mod(c, attack.ability);
}

/**
 * A Monk's Strength attack with an Unarmed Strike or a Monk weapon (one on the sheet from before the Monk levels, a
 * Fighter's Spear, say): Dexterous Attacks lets it use DEX while no armor or Shield is worn (SRD 5.2.1 Monk, Martial Arts).
 */
function dexterousMartialArts(c: Character, attack: Attack): boolean {
  return attack.ability === 'str' && (nameKey(attack.name) === 'unarmed-strike' || isMonkWeapon(attack)) && isMonk(c) && !wearsArmorOrShield(c);
}

/**
 * Dexterity the builder gave an attack for Martial Arts (SRD 5.2.1 Monk, Dexterous Attacks): a Monk's Unarmed Strike,
 * or a Monk weapon without a Finesse property of its own. The builder does this for any class with Martial Arts (a
 * 2014 book's Monk too), so this doesn't ask whether the engine counts the class as a Monk.
 */
function martialArtsFinesse(attack: Attack): boolean {
  if (attack.ability !== 'finesse') return false;
  if (nameKey(attack.name) === 'unarmed-strike') return true;
  if (!isMonkWeapon(attack)) return false;
  // A weapon whose properties weren't read (a book's table without them) is Finesse by its SRD name.
  const properties = attack.properties ?? [];
  return !(properties.length ? properties.some((p) => /^finesse\b/i.test(p.trim())) : SRD_FINESSE_WEAPONS.has(nameKey(attack.name)));
}

/** SRD 5.2.1 weapons with the Finesse property. */
const SRD_FINESSE_WEAPONS = new Set(['Dagger', 'Dart', 'Rapier', 'Scimitar', 'Shortsword', 'Whip'].map(nameKey));

/**
 * In armor or with a Shield, an Unarmed Strike whose die the builder gave it for Martial Arts (its `scaling`, or its
 * Dexterity) rolls the normal damage instead: 1 (SRD 5.2.1 Unarmed Strike).
 */
function withoutMartialArtsDie(attack: Attack, dice: DiceGroup[], flat: number): { dice: DiceGroup[]; flat: number } {
  if (nameKey(attack.name) !== 'unarmed-strike' || (attack.scaling !== 'martial-arts' && attack.ability !== 'finesse')) return { dice, flat };
  const index = dice.findIndex((t) => t.sign > 0 && !t.keep && t.count === 1);
  return index < 0 ? { dice, flat } : { dice: dice.filter((_, i) => i !== index), flat: flat + 1 };
}

/** SRD 5.2.1 Monk weapons by name, for weapon attacks made before attacks recorded their weapon's category and type. */
const SRD_MONK_WEAPONS = new Set(
  ['Club', 'Dagger', 'Greatclub', 'Handaxe', 'Javelin', 'Light Hammer', 'Mace', 'Quarterstaff', 'Sickle', 'Spear', 'Scimitar', 'Shortsword'].map(nameKey),
);

/**
 * A Monk weapon (SRD 5.2.1 Monk, Martial Arts): a Simple Melee weapon, or a Martial Melee weapon with the Light
 * property; never a ranged weapon (a Dart). By the attack's recorded weapon category and type, else by its SRD name.
 */
export function isMonkWeapon(attack: Pick<Attack, 'name' | 'ability' | 'properties' | 'weaponCategory' | 'weaponType'>): boolean {
  if (attack.ability === 'spell') return false;
  if (!attack.weaponCategory || !attack.weaponType) return SRD_MONK_WEAPONS.has(nameKey(attack.name));
  if (attack.weaponType !== 'melee') return false;
  return attack.weaponCategory === 'simple' || (attack.properties ?? []).some((p) => /^light\b/i.test(p.trim()));
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
 * How an attack's damage dice grow with level: its `scaling`; a Monk's Unarmed Strike or Monk weapon (Martial Arts);
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
  return (nameKey(attack.name) === 'unarmed-strike' || isMonkWeapon(attack)) && isMonk(c) ? 'martial-arts' : undefined;
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
 * - martial-arts: the Martial Arts die for the Monk level replaces a smaller die (a Monk weapon's, a Dagger's d4), or
 *   the Unarmed Strike's flat 1 ("roll 1d6 in place of the normal damage", SRD 5.2.1 Monk). In armor or with a Shield,
 *   none: an Unarmed Strike whose die the builder stored for Martial Arts rolls its normal 1.
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
    if (wearsArmorOrShield(c)) return withoutMartialArtsDie(attack, dice, flat);
    const sides = martialArtsDieSides(classLevelOf(c, 'Monk'));
    if (!sides) return { dice, flat };
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
  const merged: DiceTerm[] = [...(critical ? criticalDiceTerms(base.dice) : base.dice)];
  // Damage without dice never goes below 0 (an Unarmed Strike's 1 with STR 6).
  const flat = merged.length === 0 ? Math.max(0, base.flat + abilityBonus) : base.flat + abilityBonus;
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
  // By id when the entry has one (an imported "Champion" isn't the SRD's); by name for older sheets.
  const isChampion = (cl: Character['classes'][number]) => (cl.subclassId ? cl.subclassId === 'srd:subclass:champion' : /champion/i.test(cl.subclass ?? ''));
  const champion = c.classes
    .filter((cl) => rulesClassFor(cl)?.name === 'Fighter' && isChampion(cl))
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

// ---------------------------------------------------------------------------
// AC from spells: the ones the app works out (Character.acSpells)
// ---------------------------------------------------------------------------

/**
 * What each spell the app counts does to the AC. Mage Armor gives a base AC (srd:spell:mage-armor: "the target's base AC
 * becomes 13 plus its Dexterity modifier"), one more way to work the AC out (srd:rule:armor-class); Shield of Faith a
 * bonus on top of it (srd:spell:shield-of-faith: "a +2 bonus to AC for the duration").
 */
export const AC_SPELLS: Record<AcSpellName, { base?: number; bonus?: number }> = {
  'Mage Armor': { base: 13 },
  'Shield of Faith': { bonus: 2 },
};

/** The AC spell of exactly this name (case and punctuation aside), never a looser match: "Shield" isn't Shield of Faith. */
export function acSpellNamed(name: string): AcSpellName | undefined {
  const key = typeof name === 'string' ? nameKey(name) : '';
  return key ? AC_SPELL_NAMES.find((n) => nameKey(n) === key) : undefined;
}

/** The AC spells recorded on the hero, read leniently (stored rows aren't validated): known names only, once each, in AC_SPELL_NAMES order. */
export function acSpells(c: Pick<Character, 'acSpells'>): AcSpellName[] {
  const stored: unknown[] = Array.isArray(c.acSpells) ? c.acSpells : [];
  const named = new Set(stored.map((n) => (typeof n === 'string' ? acSpellNamed(n) : undefined)));
  return AC_SPELL_NAMES.filter((n) => named.has(n));
}

/** The part of an AC formula a counted spell writes: "Mage Armor: 13" (then "DEX 2"), "Shield of Faith 2". */
function acSpellPart(name: AcSpellName): string {
  const { base, bonus } = AC_SPELLS[name];
  return base !== undefined ? `${name}: ${base}` : `${name} ${bonus ?? 0}`;
}

/** What a spell adds on top of the AC however it is worked out (Shield of Faith's 2; Mage Armor, a base, adds none). */
function acSpellBonus(name: AcSpellName): number {
  return AC_SPELLS[name].bonus ?? 0;
}

function bonusTotal(names: readonly AcSpellName[]): number {
  return names.reduce((sum, n) => sum + acSpellBonus(n), 0);
}

/**
 * Whether `part` is one of the formula's ` + `-separated parts, whole: the part itself, or it with the notes a worked-out
 * formula puts after its last part ("… + Shield of Faith 2 (untrained in heavy armor: …)"). Never a piece of a part:
 * "set by the DM: Shield of Faith 2nd casting" has no "Shield of Faith 2".
 */
function hasPart(formula: string, part: string): boolean {
  return formula.split(' + ').some((p) => p === part || p.startsWith(`${part} (`));
}

/**
 * The recorded AC spells the AC in force counts: those whose part is a whole part of the formula. Mage Armor isn't while
 * armor is worn or another base AC is higher (srd:rule:armor-class: "you can't use more than one"), nor is any under an
 * AC set by hand that doesn't carry its part.
 */
export function countedAcSpells(c: Pick<Character, 'acSpells' | 'acFormula'>): AcSpellName[] {
  const formula = typeof c.acFormula === 'string' ? c.acFormula : '';
  return acSpells(c).filter((n) => hasPart(formula, acSpellPart(n)));
}

/** How an AC formula the DM set by hand starts (update_character armor_class with a reason): "set by the DM: Haste". */
const HAND_SET = 'set by the DM:';

/**
 * The part the app leaves when it takes a counted bonus spell off an AC set by hand whose DM words name that spell
 * ("set by the DM: Shield of Faith and Haste + Shield of Faith ended"): from then on those words no longer say the spell
 * is in the AC (handSetNames), so its next casting adds its bonus again and its end takes it off once
 * (srd:spell:shield-of-faith: "a +2 bonus to AC for the duration"). Never a counted part (countedAcSpells).
 */
function endedPart(name: AcSpellName): string {
  return `${name} ended`;
}

/**
 * Whether an AC set by hand names `spell` in the DM's own words: the formula is "set by the DM: …" and, the app's own
 * parts aside ("Shield of Faith 2", "Mage Armor: 13", "Shield of Faith ended", which are never the DM's words), names the
 * spell as whole words. "set by the DM: Slow from the Stone Golem + Shield of Faith 2" names Slow, not Shield of Faith;
 * an old save's "set by the DM: Shield of Faith" names Shield of Faith, until the app has taken that spell off it
 * ("set by the DM: Shield of Faith + Shield of Faith ended" doesn't).
 */
export function handSetNames(formula: string | undefined, spell: string): boolean {
  if (typeof formula !== 'string' || !formula.startsWith(HAND_SET)) return false;
  const parts = formula.slice(HAND_SET.length).split(' + ');
  const acSpell = acSpellNamed(spell);
  if (acSpell && parts.includes(endedPart(acSpell))) return false;
  const own = new Set<string>(AC_SPELL_NAMES.flatMap((n) => [acSpellPart(n), endedPart(n)]));
  return namesPhrase(parts.filter((part) => !own.has(part)).join(' + '), spell);
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
  // An older or other book's class named like an SRD one gets no SRD Unarmored Defense; a 2024 book's does (rulesClassFor).
  const classNames = new Set(c.classes.map((cl) => rulesClassFor(cl)?.name));
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
    c.classes.some(
      (cl) =>
        rulesClassFor(cl)?.name === 'Sorcerer' &&
        (cl.subclassId ? cl.subclassId === 'srd:subclass:draconic-sorcery' : /draconic/i.test(cl.subclass ?? '')),
    );
  if (draconic) {
    const cha = mod(c, 'cha');
    options.push({ ac: 10 + dex + cha, parts: ['Draconic Resilience: 10', signedPart('DEX', dex), signedPart('CHA', cha)], allowsShield: true });
  }
  // A spell's base AC is one more option, used only without armor (srd:spell:mage-armor: "who isn't wearing armor");
  // last, so a feature that gives as much keeps the AC (the spell then adds nothing).
  for (const name of acSpells(c)) {
    const base = AC_SPELLS[name].base;
    if (base !== undefined) options.push({ ac: base + dex, parts: [acSpellPart(name), signedPart('DEX', dex)], allowsShield: true });
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
 * fighting style, attuned Ring/Cloak of Protection and Bracers of Defense, and the recorded AC spells
 * (Character.acSpells: Mage Armor's base without armor, Shield of Faith's +2). When equipped armor can't
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
  if (armors.length && c.features.some((f) => isFightingStyle(f, 'Defense'))) {
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
  // Structured bonuses (imported magic items): applied once, by the engine, and only while they work.
  const usedShield = shield && hasArmorTraining(c, 'shield') ? shield.item : undefined;
  for (const item of activeBonusItems(c)) {
    const bonus = Math.max(0, toInt(item.bonuses?.ac));
    if (!bonus) continue;
    const when = item.bonuses?.acOnlyWhen;
    if ((when === 'no-armor' || when === 'no-armor-no-shield') && armors.length) continue;
    if (when === 'no-armor-no-shield' && shield) continue;
    // A suit of armor or a shield adds its bonus only when it is the one that counts.
    if (item.armor?.kind === 'armor' && base.worn?.item.id !== item.id) continue;
    if (item.armor?.kind === 'shield' && usedShield?.id !== item.id) continue;
    ac += bonus;
    parts.push(base.worn?.item.id === item.id ? `${bonus} (magic)` : `${item.name} ${bonus}`);
  }
  // Spells that add to the AC however it is worked out (srd:spell:shield-of-faith).
  for (const name of acSpells(c)) {
    const bonus = acSpellBonus(name);
    if (!bonus) continue;
    ac += bonus;
    parts.push(acSpellPart(name));
  }
  const formula = parts.join(' + ') + (notes.length ? ` (${notes.join('; ')})` : '');
  return { ac, formula };
}

/**
 * Where a fighting style comes from: a class or subclass feature (a style the class prints, the Champion's second), a
 * feat (SRD 5.2.1's Fighting Style feats) or the DM's own entry. A species trait, a background's feature, an item, a
 * boon or a form that shares a style's name isn't one.
 */
const STYLE_SOURCES: ReadonlySet<Feature['source']> = new Set(['class', 'subclass', 'feat', 'homebrew', 'other']);
const STYLE_PREFIX = /^(?:additional-)?fighting-style-(?:feat-)?/;
const STYLE_SUFFIXES = ['', '-fighting-style', '-style', '-feat', '-fighting-style-feat', '-style-feat'];

/**
 * Whether a feature is the fighting style `style`, however the sheet names it: "Defense", "Fighting Style (Defense)",
 * "Fighting Style: Defense", "Defense Fighting Style", "Additional Fighting Style (Defense)", "Fighting Style Feat:
 * Defense", "Defense (Fighter 1)"; "Great Weapon Fighting Style" is Great Weapon Fighting. A style a book names so
 * itself ("Fighting Style: Lantern Guard", "Defense Fighting Style") is read the same way, either way round. The
 * Defense AC and the level-up panel's taken styles read it alike.
 */
export function isFightingStyle(f: Pick<Feature, 'name' | 'source'>, style: string): boolean {
  if (!STYLE_SOURCES.has(f.source)) return false;
  return [f.name, f.name.replace(/\s*\([^()]*\)\s*$/, '')].some((name) => namesStyle(name, style) || namesStyle(style, name));
}

/** `name` is `style` with a style's words around it, or none: a prefix ("Fighting Style: …"), a suffix ("… Style"). */
function namesStyle(name: string, style: string): boolean {
  const rest = nameKey(name).replace(STYLE_PREFIX, '');
  return [nameKey(style), nameKey(style).replace(STYLE_PREFIX, '')].some((key) => rest.startsWith(key) && STYLE_SUFFIXES.includes(rest.slice(key.length)));
}

/** Equipped armor whose stats aren't known, when no known armor is worn (computeArmorClass then keeps the sheet's AC). */
export function unknownWornArmor(c: Character, catalog: readonly EquipmentOption[]): InventoryItem | undefined {
  const { known, unknown } = wornArmor(c.inventory, catalog);
  if (known.some((w) => w.stats.kind === 'armor')) return undefined;
  return unknown.find((i) => i.category === 'armor');
}

/** `formula` without the last ` + `-separated part that is exactly `part`. */
function withoutPart(formula: string, part: string): string {
  const parts = formula.split(' + ');
  const index = parts.lastIndexOf(part);
  return index < 0 ? formula : parts.filter((_, i) => i !== index).join(' + ');
}

/** Armor on, known or not (srd:spell:mage-armor: "a willing creature who isn't wearing armor"); a Shield isn't armor. */
function armorIsWorn(c: Character, catalog: readonly EquipmentOption[]): boolean {
  const { known, unknown } = wornArmor(c.inventory, catalog);
  return known.some((w) => w.stats.kind === 'armor') || unknown.some((i) => i.category === 'armor');
}

type AcSync = { character: Character; events: GameEvent[] };

/**
 * An AC the engine can't work out (set by hand, or armor it can't identify) moved by `delta`, what the spells that
 * changed move it by: the parts of `added` (bonus spells recorded, not in it yet) are appended to the stored formula and
 * those of `ended` (bonus spells it counted) taken out, so it still says what it counts ("set by the DM: Haste + Shield
 * of Faith 2"). An ended spell the DM's own words still name leaves its "ended" part behind, so those words stop
 * counting it ("set by the DM: Shield of Faith and Haste + Shield of Faith ended"); recorded again, that part gives way
 * to the spell's own.
 */
function movedBySpells(after: Character, delta: number, added: readonly AcSpellName[], ended: readonly AcSpellName[]): AcSync {
  let formula = after.acFormula ?? '';
  for (const n of ended) {
    formula = withoutPart(formula, acSpellPart(n));
    if (acSpellBonus(n) && handSetNames(formula, n)) formula = `${formula} + ${endedPart(n)}`;
  }
  for (const n of added) {
    formula = withoutPart(formula, endedPart(n));
    formula = formula ? `${formula} + ${acSpellPart(n)}` : acSpellPart(n);
  }
  const stored = after.armorClass;
  const ac = stored + delta;
  const changes = [...added.map((n) => `${n} ${formatModifier(acSpellBonus(n))}`), ...ended.map((n) => `${n} ${formatModifier(-acSpellBonus(n))}`)];
  return {
    character: { ...after, armorClass: ac, acFormula: formula },
    events: [gameEvent('combat', `AC ${stored} → ${ac} (${changes.join(', ')})`)],
  };
}

/**
 * A formula the engine didn't just work out (set by hand, or kept for armor it can't identify) loses the part of a base
 * AC spell that no longer applies: Mage Armor's "Mage Armor: 13" once its record ends, or while armor is worn
 * (srd:spell:mage-armor: "a willing creature who isn't wearing armor"; srd:rule:armor-class: one base calculation
 * only). The stored AC stays: a base can't be taken out by a delta, and the warnings say what gear and features give.
 * Only for a spell recorded before or after the change: a hero without the records keeps the formula as it was.
 */
function withoutStaleBases(before: Character, r: AcSync, catalog: readonly EquipmentOption[]): AcSync {
  const after = r.character;
  const formula = after.acFormula;
  if (typeof formula !== 'string' || !(formula.startsWith('set by the DM') || unknownWornArmor(after, catalog))) return r;
  const had = acSpells(before);
  const has = acSpells(after);
  const armored = armorIsWorn(after, catalog);
  const stale = new Set(
    AC_SPELL_NAMES.filter((n) => AC_SPELLS[n].base !== undefined && (had.includes(n) || has.includes(n)) && (!has.includes(n) || armored)).map(acSpellPart),
  );
  // The first part is the DM's own words ("set by the DM: …") or the armor's, never a spell's part.
  const parts = formula.split(' + ');
  const kept = parts.filter((p, i) => i === 0 || !stale.has(p));
  return kept.length === parts.length ? r : { character: { ...after, acFormula: kept.join(' + ') }, events: r.events };
}

/**
 * Keep the stored Armor Class in step after a change that can affect it: a new level (Unarmored
 * Defense from multiclassing, Draconic Resilience), equipping, attuning or dropping an item, or an AC
 * spell recorded or ended (Character.acSpells). One rule for every change, in this order:
 * 1. What the spells that changed move the AC by: the bonuses of those recorded (Shield of Faith's +2), less those of
 *    the ended ones the AC counted (their part is in its formula). One it didn't count isn't in the stored AC, so
 *    ending it moves nothing.
 * 2. A spell just recorded that an AC set by hand already names in the DM's words (an old save's "set by the DM: Shield
 *    of Faith", handSetNames) is already in it: its bonus isn't added again (srd:rule:casting-spells-effects-combining-
 *    spell-effects: the same spell's effects "don't combine"). When gear, features and spells give that same AC
 *    (armor the engine knows), the AC becomes derived. Otherwise it is kept, the spell's part is appended (so it is
 *    counted, and ending Shield of Faith later takes its 2 off), anything else that changed moves it as below, and a
 *    warning says so. Only for an AC above what gear, features and the AC spells its formula counts gave (or under
 *    armor the engine can't identify); a recorded spell the formula doesn't count (a Mage Armor recorded beside the
 *    DM's words) isn't in that baseline. One no higher is taken not to hold it, with a warning: the spell is added as
 *    below, and when that moves the AC the warning says how to put the AC back, for the DM's words may have counted it
 *    beside a penalty the app doesn't count (srd:spell:slow: "it takes a -2 penalty to AC"). Once the app has ended
 *    the spell, the words no longer name it (movedBySpells' "Shield of Faith ended").
 * 3. With armor the engine can't identify, computeArmorClass keeps the stored AC: only the spells move it.
 * 4. The sheet's AC counts as derived when it equals computeArmorClass(before); it then becomes the AC computed for
 *    `after`. Armor it can't identify keeps the stored AC and the parts of the bonus spells it counted, its own part
 *    giving the AC less their bonuses ("Elven Chain (stats unknown — AC kept at 16) + Shield of Faith 2" at 18).
 * 5. Otherwise it was set by hand: it moves by the spells' change (a hand-set "Haste" 18 plus Shield of Faith is 20;
 *    Shield of Faith ending takes its 2 back off, whatever the rest adds up to), or, when that is nothing, it is kept
 *    and a warning gives the computed value.
 * 6. A formula the engine didn't work out drops a Mage Armor part that no longer applies (withoutStaleBases).
 * Without a catalog the SRD armor table is used. No events when the computed AC doesn't change.
 */
export function syncArmorClass(before: Character, after: Character, catalog: readonly EquipmentOption[] = []): AcSync {
  const was = acSpells(before);
  const recorded = acSpells(after);
  const counted = countedAcSpells(before);
  const added = recorded.filter((n) => !was.includes(n));
  const stored = after.armorClass;
  const unknown = unknownWornArmor(after, catalog);
  const wasAc = computeArmorClass(before, catalog);
  // Step 2's baseline: gear, features and only the AC spells the formula itself counts.
  const gearAc = computeArmorClass({ ...before, acSpells: counted }, catalog).ac;
  const holdsMore = unknown !== undefined || stored > gearAc;
  const named = added.filter((n) => handSetNames(after.acFormula, n));
  const alreadyIn = holdsMore ? named : [];
  const adds = added.filter((n) => acSpellBonus(n) && !alreadyIn.includes(n));
  const ends = was.filter((n) => acSpellBonus(n) && !recorded.includes(n) && counted.includes(n));
  const delta = bonusTotal(adds) - bonusTotal(ends);
  const now = computeArmorClass(after, catalog);
  const done = (r: AcSync): AcSync => withoutStaleBases(before, r, catalog);
  /**
   * Step 2's other side: spells the DM's words name on an AC no higher than the baseline are taken not to be in it. Used
   * on the two results that move the AC (derived, or moved by the spells' change), which step 2 has not kept, so any
   * `named` here is such a spell: the warning says how to put the stored AC back.
   */
  const taken = (r: AcSync): AcSync => {
    if (!named.length) return r;
    const names = listJoin(named);
    const them = named.length === 1 ? 'it' : 'them';
    const note = warning(
      `AC ${stored}, set by hand, names ${names}, but gear and features alone give ${gearAc}, so the app now counts ${names} as well (AC ${r.character.armorClass}): if ${stored} already counted ${them} beside a penalty the app doesn't count (such as Slow), set the AC to ${stored}.`,
    );
    return { ...r, events: [...r.events, note] };
  };

  if (alreadyIn.length) {
    if (!unknown && now.ac === stored) return { character: { ...after, acFormula: now.formula }, events: [] };
    const names = listJoin(alreadyIn);
    const offs = alreadyIn.filter((n) => acSpellBonus(n)).map((n) => `ending ${n} takes ${acSpellBonus(n)} off`);
    const gear = unknown ? '' : ` Gear, features and spells give ${now.ac} (${now.formula}); update the AC if that is right.`;
    const note = warning(
      `AC ${stored} was set by hand naming ${names}: kept, and ${names} ${alreadyIn.length === 1 ? 'is' : 'are'} now counted in it${offs.length ? ` (${offs.join('; ')})` : ''}.${gear}`,
    );
    const kept: Character = { ...after, acFormula: [after.acFormula ?? '', ...alreadyIn.map(acSpellPart)].join(' + ') };
    const moved = delta !== 0 ? movedBySpells(kept, delta, adds, ends) : { character: kept, events: [] };
    return done({ character: moved.character, events: [...moved.events, note] });
  }
  if (delta !== 0 && unknown) return done(movedBySpells(after, delta, adds, ends));
  if (now.ac === wasAc.ac && now.formula === wasAc.formula) return done({ character: after, events: [] });
  const derived = before.armorClass === wasAc.ac && stored === before.armorClass;
  if (derived) {
    if (unknown) {
      // The stored AC stands for armor it can't identify, and still holds the bonus spells it counted: the armor's part
      // keeps the AC less their bonuses, so the words and the number agree once they end.
      const kept = counted.filter((n) => acSpellBonus(n) && recorded.includes(n));
      const armor = computeArmorClass({ ...after, armorClass: stored - bonusTotal(kept) }, catalog).formula;
      const newly = unknown.id !== unknownWornArmor(before, catalog)?.id;
      return done({
        character: { ...after, acFormula: [armor, ...kept.map(acSpellPart)].join(' + ') },
        events: newly ? [warning(`AC kept at ${stored}: ${unknown.name}'s armor stats are unknown, so set the AC by hand.`)] : [],
      });
    }
    if (now.ac === stored) return { character: { ...after, acFormula: now.formula }, events: [] };
    return taken({
      character: { ...after, armorClass: now.ac, acFormula: now.formula },
      events: [gameEvent('combat', `AC ${stored} → ${now.ac} (${now.formula})`)],
    });
  }
  if (delta !== 0) return taken(done(movedBySpells(after, delta, adds, ends)));
  if (now.ac === stored) return done({ character: after, events: [] });
  return done({
    character: after,
    events: [
      warning(
        `AC kept at ${stored}: it differs from the ${wasAc.ac} that gear and features gave, so it may include an effect the app doesn't count or a manual change. Gear and features now give AC ${now.ac} (${now.formula}); update the AC if that is right.`,
      ),
    ],
  });
}

// ---------------------------------------------------------------------------
// Player roll requests
// ---------------------------------------------------------------------------

const ABBR = (a: Ability) => a.toUpperCase();

/** Find an attack on the sheet by (case-insensitive, fuzzy) name. */
export function findAttack(c: Character, name: string): Attack | undefined {
  return matchByName(c.attacks, name, (a) => a.name).match;
}

/**
 * An unarmed strike by name: "Unarmed Strike (Bonus Action)", "Kick", "Punch", "Headbutt", or a fist named alone ("Fist",
 * "Bare Fists", "Fist Strike", "Fist (…)"). Never a spell or weapon that names a fist: Arcane Hand's "Clenched Fist",
 * "Spectral Fist", "Fist-sized Rock" (the DM gives those their dice or ability).
 */
export function isUnarmedStrikeName(name: string): boolean {
  return /\b(unarmed|punch|kick|headbutt)|^\s*(bare\s+)?fists?(\s+strikes?)?\s*(\(|$)/i.test(name) && !/\bclenched\W+fists?\b|\barcane\W+hand\b/i.test(name);
}

function isMonk(c: Character): boolean {
  return classLevelOf(c, 'Monk') > 0;
}

/** Attack bonus for an attack that isn't on the sheet: unarmed strikes, known spells, or a best guess. */
function improvisedAttack(c: Character, req: PlayerRollRequest): { modifier: number; label: string } {
  const name = (req.attackName ?? '').trim();
  const spell = name && c.spellcasting ? matchByName(c.spellcasting.spells, name, (s) => s.name).match : undefined;
  if (spell) return { modifier: spellAttackBonus(c) ?? pb(c) + mod(c, bestMentalAbility(c)), label: `${spell.name} attack` };
  if (name && isUnarmedStrikeName(name)) {
    // The sheet's Unarmed Strike when it has one, as for the damage (unarmedDamageExpression).
    const sheet = findAttack(c, 'Unarmed Strike');
    if (sheet) return { modifier: attackBonus(c, sheet), label: 'Unarmed Strike attack' };
    const ability = isMonk(c) && !wearsArmorOrShield(c) ? Math.max(mod(c, 'str'), mod(c, 'dex')) : mod(c, 'str');
    return { modifier: ability + pb(c), label: 'Unarmed Strike attack' };
  }
  const ability = req.ability ?? 'str';
  return { modifier: mod(c, ability) + pb(c), label: name ? `${name} attack (${ABBR(ability)}, not on sheet)` : 'Attack roll' };
}

/** Everyone's Unarmed Strike (SRD 5.2.1 Unarmed Strike: 1 plus the Strength modifier, Bludgeoning), for a sheet without one. */
const UNARMED_STRIKE: Attack = { id: 'unarmed-strike', name: 'Unarmed Strike', ability: 'str', proficient: true, damage: '1', damageType: 'bludgeoning' };

/**
 * Damage for an unarmed strike by any name ("Kick", "Punch"): the sheet's Unarmed Strike, else everyone's, with a Monk's
 * Martial Arts die and Dexterity while unarmored (SRD 5.2.1 Monk, Martial Arts); never below 0 (attackDamageExpression).
 */
export function unarmedDamageExpression(c: Character, critical = false): string {
  const sheet = findAttack(c, 'Unarmed Strike');
  return (sheet && attackDamageExpression(c, sheet, critical)) || attackDamageExpression(c, UNARMED_STRIKE, critical);
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
      return { modifier: saveBonus(c), label: 'Saving throw' };
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
      if (req.attackName && isUnarmedStrikeName(req.attackName)) return unarmedDamageExpression(c, req.critical);
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
