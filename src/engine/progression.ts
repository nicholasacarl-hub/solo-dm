/**
 * Leveling and resting under the 2024 rules (SRD 5.2.1 "Level Advancement", "Multiclassing",
 * "Short Rest", "Long Rest").
 */
import {
  ABILITY_NAMES,
  type Ability,
  type CasterType,
  type Character,
  type ClassLevel,
  type EquipmentOption,
  type Feature,
  type FeatureScale,
  type FeatureUses,
  type GameEvent,
  type HitDie,
  type ImportedRef,
  type RollResult,
} from '@/types';
import { newId, nameKey, slugify } from '@/lib/id';
import { asiLevels, featuresAtLevel, findSrdClass, isLibraryId, srdClassFor, SRD_FEATURE_USE_SCALES, WARLOCK_INVOCATIONS, type SrdClassInfo } from './classData';
import { cryptoRng, rollDice, type Rng } from './dice';
import { abilityModifier, characterLevel, formatModifier, proficiencyBonus, syncArmorClass } from './rules';
import { recomputeSlots, resetSpellSlots } from './spellcasting';
import { clamp, formatInt, gameEvent, listJoin, toInt, touch, warning } from './util';

/** XP needed to reach each level; index 0 = level 1 (0 XP) … index 19 = level 20. */
export const XP_THRESHOLDS: readonly number[] = [
  0, 300, 900, 2_700, 6_500, 14_000, 23_000, 34_000, 48_000, 64_000, 85_000, 100_000, 120_000, 140_000, 165_000,
  195_000, 225_000, 265_000, 305_000, 355_000,
];

export function levelForXp(xp: number): number {
  const value = toInt(xp);
  let level = 1;
  for (let i = 1; i < XP_THRESHOLDS.length; i++) if (value >= XP_THRESHOLDS[i]) level = i + 1;
  return level;
}

/** XP still needed for the next level, or null at level 20. */
export function xpToNextLevel(c: Character): number | null {
  const level = characterLevel(c);
  if (level >= 20) return null;
  return Math.max(0, XP_THRESHOLDS[level] - toInt(c.xp));
}

export interface LevelUpOptions {
  /** Class to gain a level in (existing class name, or a new class for multiclassing). */
  className: string;
  classId?: string;
  /** Required when adding a new class (SRD classes are looked up automatically). */
  hitDie?: HitDie;
  casterType?: CasterType;
  spellcastingAbility?: Ability;
  subclass?: string;
  /** The SubclassOption id, stored on the class entry with `subclass` (structured imports). */
  subclassId?: string;
  /** Provenance of an imported subclass, stored on the class entry. */
  subclassRef?: ImportedRef;
  /** Provenance of an imported class: copied onto a new class entry. */
  classRef?: ImportedRef;
  /** A subclass that grants spellcasting (third caster): set on the existing class entry together with `subclass`. */
  subclassCasting?: { casterType: CasterType; spellcastingAbility?: Ability };
  /**
   * 'average' = fixed value (die/2 + 1) + CON mod; 'roll' = roll the hit die + CON mod;
   * { fixed: n } = n is the hit-die result (e.g. rolled on physical dice) and the CON mod is added.
   * Minimum 1 HP. A character's very first level always gets the full hit die + CON.
   */
  hpMethod: 'average' | 'roll' | { fixed: number };
  newFeatures?: Omit<Feature, 'id'>[];
  /** Equipment catalog (BuilderData.equipment) for recomputing AC; without it the SRD armor table is used. */
  equipment?: readonly EquipmentOption[];
  rng?: Rng;
}

export interface LevelUpResult {
  character: Character;
  events: GameEvent[];
  newLevel: number;
  hpGained: number;
  hpRoll?: RollResult;
  /** Choices the player still has to make, e.g. "Level 4: choose an Ability Score Improvement or a feat". */
  reminders: string[];
}

function totalClassLevels(c: Character): number {
  return c.classes.reduce((sum, cl) => sum + Math.max(0, toInt(cl.level)), 0);
}

/**
 * The class entry a level-up adds to: by id when one is given (an imported "Fighter" never merges into the
 * SRD Fighter, SRD 5.2.1 "Multiclassing"), by name only for name-only calls (the DM's level_up).
 */
function findClassIndex(classes: readonly ClassLevel[], name: string, classId?: string): number {
  if (classId) return classes.findIndex((cl) => cl.classId === classId);
  const key = nameKey(name);
  return classes.findIndex((cl) => nameKey(cl.name) === key);
}

function hasFeatureNamed(features: readonly { name: string }[], name: string): boolean {
  const key = nameKey(name);
  return features.some((f) => nameKey(f.name) === key);
}

interface HpBonus {
  amount: number;
  note: string;
}

/**
 * Per-level Hit Point bonuses from well-known traits: Dwarven Toughness (+1 per level), Tough
 * (+2 per level; +2 × level when first taken) and Draconic Resilience (+1 per Sorcerer level;
 * +3 when gained at Sorcerer 3).
 */
function featureHpBonuses(before: readonly Feature[], added: readonly { name: string }[], gained: ClassLevel, newLevel: number): HpBonus[] {
  const bonuses: HpBonus[] = [];
  const had = (name: string) => hasFeatureNamed(before, name);
  const gains = (name: string) => !had(name) && hasFeatureNamed(added, name);
  if (had('Dwarven Toughness')) bonuses.push({ amount: 1, note: 'Dwarven Toughness' });
  if (had('Tough')) bonuses.push({ amount: 2, note: 'Tough' });
  else if (gains('Tough')) bonuses.push({ amount: 2 * newLevel, note: 'Tough' });
  const sorcerer = srdClassFor(gained)?.name === 'Sorcerer';
  if (sorcerer && had('Draconic Resilience')) bonuses.push({ amount: 1, note: 'Draconic Resilience' });
  else if (sorcerer && gains('Draconic Resilience')) bonuses.push({ amount: gained.level, note: 'Draconic Resilience' });
  return bonuses;
}

function rollHitPoints(
  die: HitDie,
  conMod: number,
  method: LevelUpOptions['hpMethod'],
  firstLevel: boolean,
  rng: Rng,
): { hp: number; detail: string; roll?: RollResult } {
  const con = formatModifier(conMod);
  if (firstLevel) return { hp: Math.max(1, die + conMod), detail: `level 1: d${die} max ${die} ${con} CON` };
  const isFixed = typeof method === 'object' && method !== null && Number.isFinite(method.fixed);
  if (method === 'average' || (method !== 'roll' && !isFixed)) {
    const fixed = die / 2 + 1;
    return { hp: Math.max(1, fixed + conMod), detail: `fixed ${fixed} ${con} CON` };
  }
  if (method === 'roll') {
    const roll = rollDice(`1d${die}${conMod > 0 ? `+${conMod}` : conMod < 0 ? `${conMod}` : ''}`, { rng });
    return { hp: Math.max(1, roll.total), detail: `rolled ${roll.breakdown}`, roll };
  }
  const value = Math.max(1, toInt(method.fixed, 1));
  return { hp: Math.max(1, value + conMod), detail: `d${die} result ${value} ${con} CON` };
}

function multiclassPrerequisites(c: Character, newClass: SrdClassInfo | undefined, className: string): string[] {
  const reminders: string[] = [];
  const toCheck = [newClass, ...c.classes.map((cl) => srdClassFor(cl))].filter((x): x is SrdClassInfo => !!x);
  const unmet = toCheck.flatMap((info) => {
    const scores = info.primaryAbilities.map((a) => ({ a, score: toInt(c.abilityScores[a], 10) }));
    const ok = info.primaryRule === 'any' ? scores.some((s) => s.score >= 13) : scores.every((s) => s.score >= 13);
    if (ok) return [];
    const needed = scores.map((s) => `${ABILITY_NAMES[s.a]} ${s.score}`).join(info.primaryRule === 'any' ? ' or ' : ' and ');
    return [`${info.name} needs 13+ (${needed})`];
  });
  const unique = [...new Set(unmet)];
  if (unique.length) reminders.push(`Multiclass prerequisite not met: ${unique.join('; ')}. Ask the DM before keeping this level.`);
  reminders.push(`Multiclassing into ${className}: you gain only some of its starting proficiencies (see its multiclassing notes).`);
  return reminders;
}

const CHOICE_HINTS: ReadonlyArray<[RegExp, (cls: string, level: number) => string]> = [
  [/^Fighting Style$/, (cls, l) => `${cls} ${l}: choose a Fighting Style feat.`],
  [/^Expertise$/, (cls, l) => `${cls} ${l}: choose two skill proficiencies to gain Expertise in.`],
  [/^Metamagic$/, (cls, l) => `${cls} ${l}: choose Metamagic options.`],
  [/^Magical Secrets$/, (cls, l) => `${cls} ${l}: Magical Secrets — your prepared spells can now come from the Bard, Cleric, Druid and Wizard lists.`],
  [/^Mystic Arcanum \((level \d) spell\)$/, (cls, l) => `${cls} ${l}: choose a ${cls} spell for your Mystic Arcanum.`],
  [/^Divine Order$|^Primal Order$/, (cls, l) => `${cls} ${l}: choose your ${cls === 'Cleric' ? 'Divine' : 'Primal'} Order.`],
  [/^Weapon Mastery$/, (cls, l) => `${cls} ${l}: choose weapons for Weapon Mastery.`],
];

function srdLevelReminders(info: SrdClassInfo, cl: ClassLevel, alreadyAdded: readonly { name: string }[]): string[] {
  const level = cl.level;
  const reminders: string[] = [];
  const features = featuresAtLevel(info, level);
  if (features.some((f) => f.endsWith(' Subclass')) && !cl.subclass) reminders.push(`${info.name} ${level}: choose a ${info.name} subclass.`);
  if (features.includes('Subclass feature')) {
    reminders.push(`${info.name} ${level}: gain a feature from your subclass${cl.subclass ? ` (${cl.subclass})` : ''}.`);
  }
  if (asiLevels(info).includes(level)) {
    reminders.push(
      `${info.name} ${level}: Ability Score Improvement — raise one score by 2 or two scores by 1 (max 20), or take another feat you qualify for.`,
    );
  }
  if (features.includes('Epic Boon')) reminders.push(`${info.name} ${level}: choose an Epic Boon feat (or another feat you qualify for).`);
  const named = features.filter(
    (f) => f !== 'Ability Score Improvement' && f !== 'Epic Boon' && f !== 'Subclass feature' && !f.endsWith(' Subclass'),
  );
  const missing = named.filter((f) => !hasFeatureNamed(alreadyAdded, f));
  if (missing.length) reminders.push(`New ${info.name} ${level} features to add to the sheet: ${missing.join(', ')}.`);
  for (const feature of named) {
    const hint = CHOICE_HINTS.find(([pattern]) => pattern.test(feature));
    if (hint) reminders.push(hint[1](info.name, level));
  }
  if (info.name === 'Warlock' && WARLOCK_INVOCATIONS[level - 1] > (WARLOCK_INVOCATIONS[level - 2] ?? 0)) {
    reminders.push(`Warlock ${level}: you now know ${WARLOCK_INVOCATIONS[level - 1]} Eldritch Invocations.`);
  }
  if (info.casterType !== 'none') reminders.push(`Review your ${info.name} cantrips and prepared spells for level ${level} (see the class table).`);
  return reminders;
}

function slotReminders(before: Character, after: Character): string[] {
  const reminders: string[] = [];
  const beforeHigh = Math.max(0, ...Object.entries(before.spellcasting?.slots ?? {}).filter(([, t]) => (t?.max ?? 0) > 0).map(([l]) => Number(l)));
  const afterHigh = Math.max(0, ...Object.entries(after.spellcasting?.slots ?? {}).filter(([, t]) => (t?.max ?? 0) > 0).map(([l]) => Number(l)));
  if (afterHigh > beforeHigh) reminders.push(`New spell slot level: you can now cast level ${afterHigh} spells.`);
  const oldPact = before.spellcasting?.pact;
  const newPact = after.spellcasting?.pact;
  if (newPact && (!oldPact || newPact.slotLevel !== oldPact.slotLevel || newPact.slots.max !== oldPact.slots.max)) {
    reminders.push(`Pact Magic: ${newPact.slots.max} slot(s) of level ${newPact.slotLevel}.`);
  }
  return reminders;
}

function addHitDie(c: Character, die: HitDie): Character['hitDice'] {
  const index = c.hitDice.findIndex((h) => h.die === die);
  if (index < 0) return [...c.hitDice, { die, total: 1, spent: 0 }];
  return c.hitDice.map((h, i) => (i === index ? { ...h, total: h.total + 1 } : h));
}

function newClassEntry(opts: LevelUpOptions, info: SrdClassInfo | undefined, hitDie: HitDie): ClassLevel {
  const name = info?.name ?? opts.className.trim();
  const entry: ClassLevel = {
    classId: opts.classId ?? info?.id ?? `class:${slugify(name)}`,
    name,
    level: 1,
    hitDie,
    casterType: opts.casterType ?? info?.casterType ?? 'none',
  };
  const ability = opts.spellcastingAbility ?? info?.spellcastingAbility;
  if (ability) entry.spellcastingAbility = ability;
  if (opts.subclass) entry.subclass = opts.subclass;
  if (opts.subclass && opts.subclassId) entry.subclassId = opts.subclassId;
  if (opts.classRef) entry.ref = opts.classRef;
  if (opts.subclass && opts.subclassRef) entry.subclassRef = opts.subclassRef;
  return withSubclassCasting(entry, opts);
}

/**
 * A subclass that grants spellcasting (a third caster, SRD 5.2.1 "Multiclassing: Spell Slots") makes its
 * class entry count as that caster type from the level it is chosen.
 */
function withSubclassCasting(entry: ClassLevel, opts: LevelUpOptions): ClassLevel {
  const casting = opts.subclassCasting;
  if (!casting || entry.casterType !== 'none') return entry;
  return { ...entry, casterType: casting.casterType, ...(casting.spellcastingAbility ? { spellcastingAbility: casting.spellcastingAbility } : {}) };
}

/**
 * The existing class entry one level up, with the subclass chosen now (name, id, ref) and its spellcasting.
 * The id and ref always describe the same subclass as the name: naming the entry's own subclass again keeps
 * them; a different subclass replaces them, or drops them when the call gives none (a plain name).
 */
function levelledEntry(existing: ClassLevel, opts: LevelUpOptions): ClassLevel {
  const gained: ClassLevel = { ...existing, level: existing.level + 1 };
  if (opts.subclass) {
    const changed = nameKey(opts.subclass) !== nameKey(existing.subclass ?? '') || (opts.subclassId !== undefined && opts.subclassId !== existing.subclassId);
    gained.subclass = opts.subclass;
    if (opts.subclassId) gained.subclassId = opts.subclassId;
    else if (changed) delete gained.subclassId;
    if (opts.subclassRef) gained.subclassRef = opts.subclassRef;
    else if (changed) delete gained.subclassRef;
  }
  return withSubclassCasting(gained, opts);
}

function unchanged(c: Character, message: string): LevelUpResult {
  return { character: c, events: [warning(message)], newLevel: characterLevel(c), hpGained: 0, reminders: [] };
}

// ---------------------------------------------------------------------------
// Feature uses that grow with level
// ---------------------------------------------------------------------------

/** Levels in one class, by SRD class or by name ("Paladin"). */
function levelInClass(c: Character, className: string): number {
  const key = nameKey(className);
  return c.classes
    .filter((cl) => nameKey(cl.name) === key || nameKey(srdClassFor(cl)?.name ?? '') === key)
    .reduce((sum, cl) => sum + Math.max(0, toInt(cl.level)), 0);
}

/**
 * Maximum uses a FeatureScale gives at the character's current levels: the Proficiency Bonus, a
 * multiple of a class level (Lay On Hands: 5 × Paladin level), or the class table's value for the
 * class level (Rages). Null when it can't tell (no levels in that class, a "—" table cell, bad data).
 */
export function scaledUsesMax(c: Character, scale: FeatureScale | undefined): number | null {
  if (!scale || typeof scale !== 'object') return null;
  switch (scale.by) {
    case 'proficiency-bonus':
      return proficiencyBonus(characterLevel(c));
    case 'class-level': {
      const level = levelInClass(c, scale.className ?? '');
      const multiplier = typeof scale.multiplier === 'number' && Number.isFinite(scale.multiplier) ? scale.multiplier : 1;
      const max = Math.floor(level * multiplier);
      return level > 0 && max > 0 ? max : null;
    }
    case 'table': {
      const level = levelInClass(c, scale.className ?? '');
      const values = Array.isArray(scale.values) ? scale.values : [];
      if (level < 1 || values.length === 0) return null;
      const max = toInt(values[Math.min(level, values.length) - 1]);
      return max > 0 ? max : null;
    }
    default:
      return null;
  }
}

/** "Rage (Duration)" -> "Rage". */
function baseName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '');
}

/**
 * The feature's own scale, or for sheets saved before FeatureUses.scale, the SRD table for a well-known
 * class feature of an SRD class. A book's feature (it has a ref) or a feature of a book's class (its entry
 * has a library id) never gets the SRD's table: its uses came from its own text and table (B8).
 */
function featureScale(f: Feature, classes: readonly ClassLevel[]): FeatureScale | undefined {
  if (f.uses?.scale) return f.uses.scale;
  if (f.source !== 'class' || f.ref) return undefined;
  const key = nameKey(baseName(f.name));
  const owner = nameKey(f.sourceName ?? '');
  const scale = SRD_FEATURE_USE_SCALES.find((s) => nameKey(s.feature) === key && owner.startsWith(nameKey(s.className)));
  if (!scale) return undefined;
  const entry = classes.find((cl) => owner.startsWith(nameKey(cl.name)));
  return entry && isLibraryId(entry.classId) ? undefined : scale.scale;
}

/**
 * Re-read the maximum uses of every feature whose uses grow with level (FeatureUses.scale, or the SRD
 * class tables for older sheets), e.g. after a level-up: Rage 2 → 3 at Barbarian 3, Lay On Hands
 * 5 → 10 at Paladin 2. Spent uses stay spent, capped at the new maximum.
 */
export function refreshScaledFeatureUses(c: Character): { character: Character; changes: string[] } {
  const changes: string[] = [];
  const features = c.features.map((f) => {
    const uses = f.uses;
    if (!uses) return f;
    const max = scaledUsesMax(c, featureScale(f, c.classes));
    if (max === null || max === uses.max) return f;
    changes.push(`${f.name} ${uses.max} → ${max}`);
    return { ...f, uses: { ...uses, max, used: clamp(toInt(uses.used), 0, max) } };
  });
  return changes.length ? { character: { ...c, features }, changes } : { character: c, changes };
}

/**
 * Gain one level: class level, HP max and current HP, hit dice, spell slots (recomputed), features,
 * the uses of features that grow with level (refreshScaledFeatureUses), and the AC when the new level
 * changes it (syncArmorClass: an AC set by hand is kept, with a reminder giving the computed value).
 */
export function levelUp(c: Character, opts: LevelUpOptions): LevelUpResult {
  const className = opts.className?.trim() ?? '';
  if (!className) return unchanged(c, 'Level up needs a class name.');
  const oldTotal = totalClassLevels(c);
  if (oldTotal >= 20) return unchanged(c, 'Already level 20 — the highest level. Consider an Epic Boon instead.');

  const index = findClassIndex(c.classes, className, opts.classId);
  const existing = index >= 0 ? c.classes[index] : undefined;
  const info = existing ? srdClassFor(existing) : (findSrdClass(opts.classId) ?? (isLibraryId(opts.classId) ? undefined : findSrdClass(className)));
  let gained: ClassLevel;
  let classes: ClassLevel[];
  if (existing) {
    gained = levelledEntry(existing, opts);
    classes = c.classes.map((cl, i) => (i === index ? gained : cl));
  } else {
    const hitDie = opts.hitDie ?? info?.hitDie;
    if (!hitDie) return unchanged(c, `Unknown class "${className}" — give its hit die to add it.`);
    gained = newClassEntry(opts, info, hitDie);
    classes = [...c.classes, gained];
  }

  const newLevel = oldTotal + 1;
  const conMod = abilityModifier(c.abilityScores.con);
  const hp = rollHitPoints(gained.hitDie, conMod, opts.hpMethod, oldTotal === 0, opts.rng ?? cryptoRng);
  const added = (opts.newFeatures ?? []).map((f): Feature => ({
    ...f,
    id: newId(),
    sourceName: f.sourceName ?? `${gained.name} ${gained.level}`,
  }));
  const bonuses = featureHpBonuses(c.features, added, gained, newLevel);
  const hpGained = hp.hp + bonuses.reduce((sum, b) => sum + b.amount, 0);

  const oldPb = proficiencyBonus(Math.max(1, oldTotal));
  const newPb = proficiencyBonus(newLevel);
  const alertDelta = hasFeatureNamed(c.features, 'Alert') && oldTotal > 0 ? newPb - oldPb : 0;

  let next: Character = {
    ...c,
    classes,
    hitDice: addHitDie(c, gained.hitDie),
    hp: { ...c.hp, max: c.hp.max + hpGained, current: c.hp.current > 0 || oldTotal === 0 ? c.hp.current + hpGained : c.hp.current },
    features: [...c.features, ...added],
    ...(alertDelta ? { initiativeBonusExtra: toInt(c.initiativeBonusExtra) + alertDelta } : {}),
  };
  const uses = refreshScaledFeatureUses(next);
  // A new class or subclass can change the AC (Unarmored Defense, Draconic Resilience, Defense).
  const ac = syncArmorClass(c, uses.character, opts.equipment ?? []);
  next = touch(recomputeSlots(ac.character));

  const bonusText = bonuses.map((b) => ` + ${b.amount} ${b.note}`).join('');
  const classText = classes.map((cl) => `${cl.name} ${cl.level}`).join(' / ');
  const events: GameEvent[] = [
    gameEvent(
      'level-up',
      `Reached level ${newLevel} (${classText}): +${hpGained} HP (${hp.detail}${bonusText}) → HP max ${next.hp.max}.`,
    ),
  ];
  if (added.length) events.push(gameEvent('feature-restored', `New features: ${added.map((f) => f.name).join(', ')}.`));
  if (uses.changes.length) events.push(gameEvent('level-up', `Feature uses now: ${listJoin(uses.changes)}.`));
  events.push(...ac.events.filter((e) => e.type !== 'warning'));

  const reminders: string[] = [];
  if (!existing && oldTotal > 0) reminders.push(...multiclassPrerequisites(c, info, gained.name));
  if (info) reminders.push(...srdLevelReminders(info, gained, [...c.features, ...added]));
  else reminders.push(`Check the ${gained.name} class table for level ${gained.level} features and choices.`);
  reminders.push(...slotReminders(c, next));
  if (newPb > oldPb && oldTotal > 0) reminders.push(`Proficiency Bonus is now ${formatModifier(newPb)}.`);
  if (alertDelta) reminders.push(`Alert: initiative bonus from your Proficiency Bonus is now ${formatModifier(newPb)}.`);
  // An AC set by hand that the new level would change (see syncArmorClass).
  reminders.push(...ac.events.filter((e) => e.type === 'warning').map((e) => e.message));
  if (c.hp.current <= 0 && oldTotal > 0) reminders.push('Current HP stays at 0 until healed.');

  return { character: next, events, newLevel, hpGained, ...(hp.roll ? { hpRoll: hp.roll } : {}), reminders };
}

// ---------------------------------------------------------------------------
// Hit Point Dice and rests
// ---------------------------------------------------------------------------

/**
 * Spend one hit die during a short rest: roll it + CON modifier and heal that much
 * (minimum 1 HP per die, SRD 5.2.1 "Short Rest"). Fails with a warning if no die of that size remains.
 * `opts.roll` can supply a roll made elsewhere (e.g. the short-rest dialog): when its flat modifier is
 * 0 the CON modifier is added, otherwise its total is taken to include it already.
 */
export function spendHitDie(
  c: Character,
  die: HitDie,
  opts: { rng?: Rng; roll?: RollResult } = {},
): { character: Character; events: GameEvent[]; roll: RollResult | null; healed: number } {
  const fail = (message: string) => ({ character: c, events: [warning(message)], roll: null, healed: 0 });
  if (c.deathSaves.dead) return fail("The dead can't spend Hit Point Dice.");
  if (c.hp.current < 1) return fail('Hit Point Dice are spent during a Short Rest, which needs at least 1 HP.');
  const index = c.hitDice.findIndex((h) => h.die === die && h.spent < h.total);
  if (index < 0) {
    const has = c.hitDice.some((h) => h.die === die);
    return fail(has ? `No d${die} Hit Point Dice left to spend.` : `No d${die} Hit Point Dice.`);
  }
  const conMod = abilityModifier(c.abilityScores.con);
  const roll =
    opts.roll ?? rollDice(`1d${die}${conMod > 0 ? `+${conMod}` : conMod < 0 ? `${conMod}` : ''}`, { rng: opts.rng ?? cryptoRng });
  const rolledTotal = opts.roll && opts.roll.modifier === 0 ? opts.roll.total + conMod : roll.total;
  const amount = Math.max(1, rolledTotal);
  const current = Math.min(c.hp.max, c.hp.current + amount);
  const healed = current - c.hp.current;
  const character = touch({
    ...c,
    hp: { ...c.hp, current },
    hitDice: c.hitDice.map((h, i) => (i === index ? { ...h, spent: h.spent + 1 } : h)),
  });
  const left = character.hitDice[index].total - character.hitDice[index].spent;
  const addedCon = opts.roll && opts.roll.modifier === 0 && conMod !== 0;
  const shown = addedCon ? `${roll.breakdown}, ${formatModifier(conMod)} CON = ${rolledTotal}` : roll.breakdown;
  const event = gameEvent(
    'hp-changed',
    `Spent a d${die} Hit Point Die: ${shown}${amount !== rolledTotal ? ' (minimum 1)' : ''} → HP ${c.hp.current} → ${current} (${left} d${die} left)`,
  );
  return { character, events: [event], roll, healed };
}

/** 2024 features that regain only ONE use on a Short Rest (and all uses on a Long Rest). */
const ONE_USE_PER_SHORT_REST = ['rage', 'second-wind', 'channel-divinity', 'wild-shape'];

function regainsOneOnShortRest(feature: Feature): boolean {
  const key = nameKey(feature.name);
  return ONE_USE_PER_SHORT_REST.some((k) => key === k || key.startsWith(`${k}-`));
}

function bardLevel(c: Character): number {
  return c.classes.filter((cl) => srdClassFor(cl)?.name === 'Bard').reduce((sum, cl) => sum + cl.level, 0);
}

/** Uses after a Short Rest (unchanged object when nothing recharges). */
function shortRestUses(c: Character, feature: Feature): FeatureUses | undefined {
  const uses = feature.uses;
  if (!uses || uses.used === 0) return uses;
  if (regainsOneOnShortRest(feature) && uses.recharge !== 'none') return { ...uses, used: uses.used - 1 };
  const fontOfInspiration =
    nameKey(feature.name).startsWith('bardic-inspiration') && (bardLevel(c) >= 5 || hasFeatureNamed(c.features, 'Font of Inspiration'));
  if (uses.recharge === 'short' || uses.recharge === 'turn' || fontOfInspiration) return { ...uses, used: 0 };
  return uses;
}

function restedFeatureNames(before: readonly Feature[], after: readonly Feature[]): string[] {
  return after.flatMap((f, i) => {
    const old = before[i]?.uses;
    if (!f.uses || !old || f.uses.used >= old.used) return [];
    const regained = old.used - f.uses.used;
    return [f.uses.used > 0 ? `${f.name} (${regained} use${regained === 1 ? '' : 's'})` : f.name];
  });
}

function hasTireless(c: Character): boolean {
  const rangerLevel = c.classes.filter((cl) => srdClassFor(cl)?.name === 'Ranger').reduce((sum, cl) => sum + cl.level, 0);
  return rangerLevel >= 10 || hasFeatureNamed(c.features, 'Tireless');
}

/**
 * Short rest: restores features that recharge on a short rest and pact magic slots (hit dice are spent
 * separately). 2024 details: Rage, Second Wind, Channel Divinity and Wild Shape regain one use;
 * Bardic Inspiration recharges from Bard 5 (Font of Inspiration); a Ranger 10+ (Tireless) loses 1 Exhaustion.
 */
export function applyShortRest(c: Character): { character: Character; events: GameEvent[] } {
  if (c.deathSaves.dead) return { character: c, events: [warning("The dead don't rest.")] };
  if (c.hp.current < 1) return { character: c, events: [warning('A Short Rest needs at least 1 HP — stabilize and heal first.')] };

  const features = c.features.map((f) => {
    const uses = shortRestUses(c, f);
    return uses === f.uses ? f : { ...f, uses };
  });
  const regained = restedFeatureNames(c.features, features);
  const pact = c.spellcasting?.pact;
  const spellcasting =
    c.spellcasting && pact && pact.slots.used > 0
      ? { ...c.spellcasting, pact: { ...pact, slots: { ...pact.slots, used: 0 } } }
      : c.spellcasting;
  if (spellcasting !== c.spellcasting && pact) regained.push(`Pact Magic slots (${pact.slots.max}/${pact.slots.max})`);
  const exhaustion = hasTireless(c) && c.exhaustion > 0 ? c.exhaustion - 1 : c.exhaustion;

  const character = touch({ ...c, features, exhaustion, ...(spellcasting ? { spellcasting } : {}) });
  const parts = [regained.length ? `regained ${listJoin(regained)}` : 'nothing to recharge'];
  if (exhaustion !== c.exhaustion) parts.push(`Exhaustion ${c.exhaustion} → ${exhaustion} (Tireless)`);
  const unspent = c.hitDice.reduce((sum, h) => sum + (h.total - h.spent), 0);
  if (unspent > 0 && c.hp.current < c.hp.max) parts.push(`${unspent} Hit Point Dice available to spend`);
  return { character, events: [gameEvent('rest', `Short rest: ${parts.join('; ')}.`)] };
}

/**
 * Long rest (2024): regain all HP and all spent hit dice (SRD 5.2.1), all spell slots, features that
 * recharge on short/long rest or dawn; exhaustion −1; death saves reset; temp HP removed.
 * Also: Concentration ends (you sleep), and Resourceful (Human) grants Heroic Inspiration.
 * Like the SRD, it needs at least 1 HP to start.
 */
export function applyLongRest(c: Character): { character: Character; events: GameEvent[] } {
  if (c.deathSaves.dead) return { character: c, events: [warning("The dead don't rest.")] };
  if (c.hp.current < 1) return { character: c, events: [warning('A Long Rest needs at least 1 HP — stabilize and heal first.')] };

  const regained: string[] = [];
  const features = c.features.map((f) => {
    if (!f.uses || f.uses.used === 0 || f.uses.recharge === 'none') return f;
    regained.push(f.name);
    return { ...f, uses: { ...f.uses, used: 0 } };
  });
  const spentDice = c.hitDice.reduce((sum, h) => sum + h.spent, 0);
  const sc = c.spellcasting;
  const usedSlots = sc ? Object.values(sc.slots).reduce((sum, t) => sum + (t?.used ?? 0), 0) + (sc.pact?.slots.used ?? 0) : 0;
  const spellcasting = sc ? { ...resetSpellSlots(sc), concentratingOn: null } : undefined;
  const exhaustion = clamp(toInt(c.exhaustion) - 1, 0, 6);
  const resourceful = hasFeatureNamed(c.features, 'Resourceful') && !c.heroicInspiration;

  const character = touch({
    ...c,
    hp: { ...c.hp, current: c.hp.max, temp: 0 },
    hitDice: c.hitDice.map((h) => ({ ...h, spent: 0 })),
    features,
    exhaustion,
    deathSaves: { successes: 0, failures: 0, stable: false, dead: false },
    heroicInspiration: c.heroicInspiration || resourceful,
    ...(spellcasting ? { spellcasting } : {}),
  });

  const parts = [`HP ${c.hp.current} → ${c.hp.max}`];
  if (c.hp.temp > 0) parts.push(`${c.hp.temp} temporary HP lost`);
  if (spentDice > 0) parts.push(`regained ${spentDice} Hit Point ${spentDice === 1 ? 'Die' : 'Dice'}`);
  if (usedSlots > 0) parts.push('all spell slots restored');
  if (regained.length) parts.push(`recharged ${listJoin(regained)}`);
  if (exhaustion !== c.exhaustion) parts.push(`Exhaustion ${c.exhaustion} → ${exhaustion}`);
  if (sc?.concentratingOn) parts.push(`Concentration on ${sc.concentratingOn} ended`);
  if (resourceful) parts.push('gained Heroic Inspiration (Resourceful)');
  return { character, events: [gameEvent('rest', `Long rest: ${parts.join('; ')}.`)] };
}

/** XP summary for prompts: "900 XP (1,800 to level 4)". */
export function xpSummary(c: Character): string {
  const next = xpToNextLevel(c);
  const level = characterLevel(c);
  if (next === null) return `${formatInt(toInt(c.xp))} XP (max level)`;
  return next === 0 && levelForXp(c.xp) > level
    ? `${formatInt(toInt(c.xp))} XP (level ${levelForXp(c.xp)} available)`
    : `${formatInt(toInt(c.xp))} XP (${formatInt(next)} to level ${level + 1})`;
}
