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
  type PlayerRollRequest,
  type Skill,
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
import { clamp, matchByName, toInt } from './util';

const MINUS = '−';

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

/** Skill modifier: ability mod + floor(PB × proficiency level). Excludes the exhaustion penalty. */
export function skillModifier(c: Character, skill: Skill): number {
  return mod(c, SKILL_ABILITY[skill]) + Math.floor(pb(c) * (c.skills[skill] ?? 0));
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
  const prefix = DAMAGE_PREFIX_RE.exec(text.replace(/[−–]/g, '-'));
  if (!prefix) return null;
  try {
    return parseDice(prefix[0]);
  } catch {
    return null;
  }
}

/**
 * Damage expression including the ability modifier (unless addAbilityToDamage === false),
 * e.g. "1d8+3". With critical=true the dice are doubled ("2d8+3"). Flat terms are merged into one.
 * An unreadable damage string is returned unchanged (rolling it then reports the problem).
 */
export function attackDamageExpression(c: Character, attack: Attack, critical = false): string {
  const terms = parseDamage(attack.damage ?? '');
  if (!terms) return (attack.damage ?? '').trim();
  const abilityBonus = attack.addAbilityToDamage === false ? 0 : attackAbilityModifier(c, attack);
  const dice = terms.filter((t) => t.kind === 'dice');
  const flat = terms.reduce((sum, t) => (t.kind === 'flat' ? sum + t.sign * t.value : sum), abilityBonus);
  const merged: DiceTerm[] = [...(critical ? criticalDiceTerms(dice) : dice)];
  if (flat !== 0 || merged.length === 0) merged.push({ kind: 'flat', sign: flat < 0 ? -1 : 1, value: Math.abs(flat) });
  return formatDice(merged);
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
    const stats = item.category === undefined || item.category === 'armor' ? resolveArmor(item) : null;
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

function trainedWith(c: Character, kind: 'light' | 'medium' | 'heavy' | 'shield'): boolean {
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
export function computeArmorClass(c: Character, catalog: EquipmentOption[]): { ac: number; formula: string } {
  const { known, unknown } = wornArmor(c.inventory, catalog);
  const armors = known.filter((w) => w.stats.kind === 'armor');
  const shields = known.filter((w) => w.stats.kind === 'shield');
  const unknownArmor = unknown.find((i) => i.category === 'armor');
  if (armors.length === 0 && unknownArmor) {
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
  if (armorType && !trainedWith(c, armorType)) {
    notes.push(`untrained in ${armorType} armor: Disadvantage on STR/DEX D20 Tests and no spellcasting`);
  }
  if (shield) {
    if (trainedWith(c, 'shield')) {
      const value = shield.stats.baseAc + shield.bonus;
      ac += value;
      parts.push(`Shield ${value}${shield.bonus ? ` (+${shield.bonus} magic)` : ''}`);
    } else {
      notes.push('no Shield training: the Shield gives no AC');
    }
  }
  if (armors.length && hasFeature(c, 'Defense')) {
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

function skillCheck(c: Character, skill: Skill, ability?: Ability): { modifier: number; label: string } {
  const used = ability ?? SKILL_ABILITY[skill];
  const modifier = mod(c, used) + Math.floor(pb(c) * (c.skills[skill] ?? 0));
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
