/**
 * Leveling and resting under the 2024 rules (SRD 5.2.1 "Level Advancement", "Multiclassing",
 * "Short Rest", "Long Rest").
 */
import {
  ABILITY_NAMES,
  AC_SPELL_NAMES,
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
import {
  afterConcentrationEnds,
  classCountingByName,
  endAcSpell,
  endHpMaxAdjustmentsWhere,
  familyNamed,
  featureBaseName,
  featureClassOf,
  handSetAcReminder,
  isAlertFeat,
  isGrantedFamilyEntry,
  isToughFeat,
  nameUseCount,
  readsItsTable,
} from './character';
import { asiLevels, featuresAtLevel, findSrdClass, isLibraryId, rulesClassFor, srdClassFor, SRD_FEATURE_USE_SCALES, WARLOCK_INVOCATIONS, type SrdClassInfo } from './classData';
import { cryptoRng, rollDice, type Rng } from './dice';
import { AC_SPELLS, abilityModifier, acSpellNamed, acSpells, characterLevel, formatModifier, proficiencyBonus, speedChangeText, syncArmorClass } from './rules';
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
  /**
   * Multiclass prerequisites of the classes the engine has no SRD data for (a book's: the new class, or one the
   * hero has), checked like the SRD's when the hero multiclasses (SRD 5.2.1 "Multiclassing": 13+ in each).
   */
  multiclassPrimaries?: readonly { name: string; primaryAbilities: readonly Ability[]; primaryRule: 'all' | 'any' }[];
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
  /**
   * Counted families whose entries on the sheet the level-up merged into one (collapseCountedFamilies): reported in
   * place of growth. Absent when there were none.
   */
  merges?: FeatureMerge[];
  /**
   * The names of this level-up's new features folded into an entry the sheet held (the table's "Indomitable (two uses)"
   * growing "Indomitable (one use)"), or renamed by a merge with entries it held (FeatureMerge.renamedNew), which a list
   * of new features leaves out. Absent when there were none.
   */
  folded?: string[];
  /**
   * What the level did to the hero's Speed (speedChangeText: "Speed 40 ft → 45 ft (Unarmored Movement)", Roving's Climb
   * and Swim Speeds), also an event. Absent when it changed nothing.
   */
  speedChange?: string;
}

/**
 * A counted family whose entries on the sheet a level-up merged into one (an older version's "Indomitable (one use)"
 * beside its "Indomitable (two uses)", or the DM's entry of the name beside the class's): what the level-up dialog's
 * notice and Summary and the DM's level_up report instead of growth.
 */
export interface FeatureMerge {
  /** The entry kept: its uses changed by the merge, not by growth (a report of growth by id skips it). */
  id: string;
  /** Its name after the level-up ("Indomitable (two uses)"). */
  name: string;
  /**
   * The sheet's entries merged, by name in sheet order (the kept one's name before the level-up first, when it was one);
   * after the name of the kept one as it came, when it is one of this level-up's new features (renamedNew).
   */
  merged: string[];
  /** For a notice or summary: "merged into Indomitable (two uses) (2 uses, 1 left): Indomitable (one use), Indomitable (two uses)". */
  text: string;
  /**
   * Set when the entry kept is one of this level-up's new features the merge renamed: an entry the sheet held counted
   * more (the class's "Action Surge (one use)" at Fighter 2, kept as the DM's "Action Surge (two uses)"). It is no new
   * feature (LevelUpResult.folded has its name as it came), and `merged` names it first by that name.
   */
  renamedNew?: true;
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
 * A Sorcerer for Draconic Resilience's Hit Points: the SRD's, a 2024 book's (rulesClassFor), or an older book's of the
 * name. Both editions give one per Sorcerer level (SRD 5.2.1 Draconic Sorcery: 3 at Sorcerer 3, then 1 a level; SRD 5.1
 * Draconic Bloodline: 1 at 1st level, then 1 a level).
 */
function isSorcererClass(cl: Pick<ClassLevel, 'classId' | 'name' | 'ref'>): boolean {
  if (rulesClassFor(cl)?.name === 'Sorcerer') return true;
  // A book's class whose edition isn't recorded yet (a hero made before refs recorded it): the one-time top-up pays
  // its levels once it is (data/options/editions.ts), so paying them here too would pay them twice.
  if (cl.ref && !cl.ref.format) return false;
  return nameKey(cl.name) === 'sorcerer';
}

/**
 * Per-level Hit Point bonuses from well-known traits: Dwarven Toughness (+1 per level), the Tough
 * feat (+2 per level; +2 × level when first taken; isToughFeat: a species trait, class feature or
 * transformation power named Tough brings none and doesn't stop the feat's) and Draconic Resilience
 * (+1 per Sorcerer level; the Sorcerer level when gained: 3 at Sorcerer 3, or 1 for an older book's
 * at 1st level), in either edition.
 */
function featureHpBonuses(
  before: readonly Pick<Feature, 'name' | 'source'>[],
  added: readonly Pick<Feature, 'name' | 'source'>[],
  gained: ClassLevel,
  newLevel: number,
): HpBonus[] {
  const bonuses: HpBonus[] = [];
  const had = (name: string) => hasFeatureNamed(before, name);
  const gains = (name: string) => !had(name) && hasFeatureNamed(added, name);
  if (had('Dwarven Toughness')) bonuses.push({ amount: 1, note: 'Dwarven Toughness' });
  if (before.some(isToughFeat)) bonuses.push({ amount: 2, note: 'Tough' });
  else if (added.some(isToughFeat)) bonuses.push({ amount: 2 * newLevel, note: 'Tough' });
  const sorcerer = isSorcererClass(gained);
  if (sorcerer && had('Draconic Resilience')) bonuses.push({ amount: 1, note: 'Draconic Resilience' });
  else if (sorcerer && gains('Draconic Resilience')) bonuses.push({ amount: gained.level, note: 'Draconic Resilience' });
  return bonuses;
}

/**
 * Hit Points a new hero's features add at 1st level, which levelUp adds level by level after (featureHpBonuses): the Tough
 * feat (twice the level) and Draconic Resilience on a Sorcerer (an older book's Draconic Bloodline has it at 1st level). A
 * species' per-level bonus (Dwarven Toughness) is the builder's own.
 */
export function startingFeatureHitPoints(features: readonly Pick<Feature, 'name' | 'source'>[], cl: ClassLevel): number {
  return featureHpBonuses([], features, cl, 1).reduce((sum, b) => sum + b.amount, 0);
}

/**
 * The Hit Points Draconic Resilience gives at the hero's Sorcerer levels (SRD 5.2.1 Draconic Sorcery: "Your Hit Point
 * maximum increases by 3, and it increases by 1 whenever you gain another Sorcerer level"): one per Sorcerer level,
 * a 2024 book's Sorcerer included (rulesClassFor), when the hero has the feature; else 0. For the one-time top-up of
 * heroes made before refs recorded editions (data/options/editions.ts), so only the classes the stand-in rules owed:
 * an older book's Sorcerer, which gains them at level-up now (featureHpBonuses), isn't caught up.
 */
export function draconicResilienceHitPoints(c: Pick<Character, 'classes' | 'features'>): number {
  if (!hasFeatureNamed(c.features, 'Draconic Resilience')) return 0;
  return c.classes.filter((cl) => rulesClassFor(cl)?.name === 'Sorcerer').reduce((sum, cl) => sum + Math.max(0, toInt(cl.level)), 0);
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

function multiclassPrerequisites(
  c: Character,
  newClass: SrdClassInfo | undefined,
  className: string,
  books: NonNullable<LevelUpOptions['multiclassPrimaries']> = [],
): string[] {
  const reminders: string[] = [];
  const toCheck = [...[newClass, ...c.classes.map((cl) => srdClassFor(cl))].filter((x): x is SrdClassInfo => !!x), ...books];
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

/**
 * The choices of a feat a level-up adds (the level-up panel's pick, a level_up extra) that the sheet doesn't make, for
 * the player to make with the DM: SRD 5.2.1 Magic Initiate ("two cantrips of your choice from the Cleric, Druid, or
 * Wizard spell list", its spellcasting ability "(choose when you select this feat)", "a level 1 spell from the same
 * list") and Skilled ("proficiency in any combination of three skills or tools of your choice"), an older book's of the
 * name too.
 */
const FEAT_CHOICE_HINTS: readonly (readonly [name: string, hint: string])[] = [
  ['Magic Initiate', 'Magic Initiate: choose its spell list, two cantrips and a level 1 spell from it, and its spellcasting ability.'],
  ['Skilled', 'Skilled: choose three skills or tools to gain proficiency in.'],
];

/** The entry of the counted family the row `name` belongs to that `sheet` holds: the class's own or the DM's (familyNamed). */
function holdsFamilyEntry(sheet: readonly Feature[], cl: ClassLevel, name: string): boolean {
  const base = featureBaseName(name);
  return sheet.some((f) => (featureClassOf(f, [cl]) !== undefined && familyNamed(f.name, base)) || isGrantedFamilyEntry(f, base));
}

function srdLevelReminders(info: SrdClassInfo, cl: ClassLevel, alreadyAdded: readonly Feature[], added: readonly Feature[]): string[] {
  const level = cl.level;
  const reminders: string[] = [];
  const features = featuresAtLevel(info, level);
  if (features.some((f) => f.endsWith(' Subclass')) && !cl.subclass) reminders.push(`${info.name} ${level}: choose a ${info.name} subclass.`);
  // Unless this level-up added the subclass's feature for this level (the level-up dialog does, and the DM's level_up a
  // book's): one caught up from an earlier level (a subclass chosen late) is by its book's level; the SRD's, without a
  // ref, come with the level's own.
  if (features.includes('Subclass feature') && !added.some((f) => f.source === 'subclass' && (f.ref?.level ?? level) === level)) {
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
  // A row the table names with a use count ("Indomitable (two uses)") is held when the sheet holds an entry of its
  // family that has uses, bare or named with any count (the level-up grew it or folded the row into it, a ruled entry
  // and a DM's higher count included: SRD 5.2.1 Fighter Features table, one Indomitable, "(two uses)" at 13), or a
  // class feature of its name that has uses. An entry of its name under another source (a boon's "Indomitable (one
  // use)", an item's "Action Surge (one use)") is neither, so the row is named, and the class's entry it asks for joins
  // beside that one, as the level-up dialog adds it (SRD 5.2.1 Fighter Features table: "Indomitable (one use)" at 9).
  // Nor is an entry without uses (the DM's "Action Surge (one use)" recorded without uses_max, which the later rows
  // rename): the row is named, and the DM's features_add of it with its count gives that entry its uses (SRD 5.2.1
  // Action Surge: "Starting at level 17, you can use it twice before a rest"). Any entry of its name holds a row
  // without a count.
  const counting = alreadyAdded.filter((x) => x.uses);
  const holds = (f: string) =>
    nameUseCount(f) === null
      ? hasFeatureNamed(alreadyAdded, f)
      : holdsFamilyEntry(counting, cl, f) || hasFeatureNamed(counting.filter((x) => x.source === 'class'), f);
  const missing = named.filter((f) => !holds(f));
  if (missing.length) reminders.push(`New ${info.name} ${level} features to add to the sheet: ${missing.join(', ')}.`);
  for (const feature of named) {
    const hint = CHOICE_HINTS.find(([pattern]) => pattern.test(feature));
    if (hint) reminders.push(hint[1](info.name, level));
  }
  if (info.name === 'Warlock' && WARLOCK_INVOCATIONS[level - 1] > (WARLOCK_INVOCATIONS[level - 2] ?? 0)) {
    reminders.push(`Warlock ${level}: you now know ${WARLOCK_INVOCATIONS[level - 1]} Eldritch Invocations.`);
  }
  if (info.casterType !== 'none') reminders.push(spellReviewReminder(info.name, level));
  return reminders;
}

/**
 * The generic spell line of an SRD class's level-up. Exported so the callers that work out the class's spell choices
 * from its table (src/data/options/spellPicks.ts) can drop exactly this line and say what is owed instead.
 */
export function spellReviewReminder(className: string, level: number): string {
  return `Review your ${className} cantrips and prepared spells for level ${level} (see the class table).`;
}

function slotReminders(before: Character, after: Character): string[] {
  const reminders: string[] = [];
  const beforeHigh = Math.max(0, ...Object.entries(before.spellcasting?.slots ?? {}).filter(([, t]) => (t?.max ?? 0) > 0).map(([l]) => Number(l)));
  const afterHigh = Math.max(0, ...Object.entries(after.spellcasting?.slots ?? {}).filter(([, t]) => (t?.max ?? 0) > 0).map(([l]) => Number(l)));
  // Two Spellcasting classes share the combined table, whose slots can outrun what either class prepares (SRD 5.2.1
  // Multiclassing: "This table might give you spell slots of a higher level than the spells you prepare. You can use
  // those slots but only to cast your lower-level spells.").
  const spellcasting = after.classes.filter((cl) => cl.level > 0 && (cl.casterType === 'full' || cl.casterType === 'half' || cl.casterType === 'third'));
  if (afterHigh > beforeHigh) {
    reminders.push(
      spellcasting.length > 1
        ? `New spell slot level: level ${afterHigh} slots cast your lower-level spells too; each class prepares spells only up to its own level.`
        : `New spell slot level: you can now cast level ${afterHigh} spells.`,
    );
  }
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
 * has a library id) never gets the SRD's table: its uses came from its own text and table (B8). Nor does a number the
 * DM ruled (FeatureUses.ruled).
 */
function featureScale(f: Feature, classes: readonly ClassLevel[]): FeatureScale | undefined {
  if (f.uses?.ruled) return undefined;
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

// ---------------------------------------------------------------------------
// Counted families: one entry for a class feature the class table counts by name
// ---------------------------------------------------------------------------

interface FamilyMember {
  f: Feature;
  /** On the sheet before this level-up. */
  held: boolean;
  /** One of the class's own class features (its source name names the class), not the DM's entry. */
  own: boolean;
  /** The class table's row for this level (an SRD class's), which no sheet holds. */
  row: boolean;
}

interface Collapsed {
  features: Feature[];
  /** "Indomitable (two uses) 1 → 2": an entry the sheet held that the level's row grew. */
  grows: string[];
  merges: FeatureMerge[];
  events: GameEvent[];
  /** This level-up's new features folded into another entry, or renamed by a merge with entries the sheet held (renamedNew). */
  folded: Set<Feature>;
}

/** A member's count: its name's ("Indomitable (two uses)": 2), else its uses' maximum. */
const memberCount = (f: Feature): number => nameUseCount(f.name) ?? Math.max(0, toInt(f.uses?.max));

/**
 * The count the rules table of the hero's class (rulesClassFor: the SRD class, or the SRD class a 2024 book's stands in
 * for) gives a base name (its key: "indomitable") at the class's level: the latest name at or below that level naming it
 * with a use count (SRD 5.2.1 Fighter Features table: "Indomitable (two uses)" at 13, so two at Fighter 13 to 16). Null
 * before the first such name, or for a table that names none.
 */
function tableCountByName(cl: ClassLevel, base: string): number | null {
  let count: number | null = null;
  for (const names of rulesClassFor(cl)?.featuresByLevel.slice(0, cl.level) ?? []) {
    for (const name of names) if (nameKey(featureBaseName(name)) === base) count = nameUseCount(name) ?? count;
  }
  return count;
}

const namesItsCount = (m: FamilyMember): boolean => nameUseCount(m.f.name) !== null;

/** The newer of two members (in sheet order, `m` after `best`): the higher count, else the one named by it, else `m`. */
function newerMember(m: FamilyMember, best: FamilyMember): FamilyMember {
  const [a, b] = [memberCount(m.f), memberCount(best.f)];
  if (a !== b) return a > b ? m : best;
  return namesItsCount(m) || !namesItsCount(best) ? m : best;
}

const usesLeft = (uses: FeatureUses): string => `${uses.max} use${uses.max === 1 ? '' : 's'}, ${uses.max - uses.used} left`;

/**
 * A counted family's merge as a notice or summary says it, from the entry kept as the sheet stores it (its name and
 * uses) and the names merged: "merged into Indomitable (two uses) (2 uses, 1 left): Indomitable (one use), Indomitable
 * (two uses)" (FeatureMerge.text; the level-up dialog's, after it re-reads the uses).
 */
export function featureMergeText(kept: Pick<Feature, 'name' | 'uses'>, merged: readonly string[]): string {
  const left = kept.uses ? usesLeft(kept.uses) : '';
  return `merged into ${kept.name}${left ? ` (${left})` : ''}: ${merged.join(', ')}`;
}

/**
 * One entry for each counted family (SRD 5.2.1 Fighter Features table: "Action Surge (one use)" at Fighter 2 and "(two
 * uses)" at 17; Action Surge: "Starting at level 17, you can use it twice before a rest but only once on a turn"): the
 * hero's class's own class features of one base name (one trailing parenthetical off), named by it alone or with a use
 * count (familyNamed: "Action Surge (Bonus)" is a feature of its own), one of the class's own, on the sheet, new, or the
 * level's row of an SRD class's table, named with a use count, or of a class that counts the base by name
 * (classCountingByName: SRD 5.2.1's Fighter). Only these fold: Ability Score Improvement, Expertise, Metamagic, Improved
 * Brutal Strike and Mystic Arcanum ("(level 7 spell)" counts nothing) repeat as they always have, and so does the DM's
 * own counted name beside a class feature named without one ("Wild Shape (2 uses)" beside the Druid's "Wild Shape").
 * The DM's entries named as the app's reminder names the rows (isGrantedFamilyEntry) join the family of a class that has
 * an entry of it, or of a class that counts the base by name, on their own (an older Fighter the DM's level_up levelled,
 * every row added with features_add); the level's rows of an SRD class's table (`rows`) join a family the sheet holds an
 * entry of. Each family keeps one entry:
 * - the first that holds the DM's ruling (FeatureUses.ruled), with its name and number; the others' spent uses join it,
 *   up to its number;
 * - else the class's first entry whole (id, place, source name, text, ref), or the DM's first when the class has none,
 *   under the newest member's name, the highest count ("Indomitable (three uses)"), with that count as its maximum; spent
 *   uses are all the members', at most the family's count before this level-up (an older sheet's duplicates allowed
 *   more), up to the new maximum. A book class's entry its table's reader reads by its bare name keeps that name
 *   (readsItsTable: a 2024 book's Fighter's "Indomitable" without uses yet, beside the DM's "Indomitable (one use)"), so
 *   the next read gives it the table's count. A maximum above the class's rules table at its class level
 *   (tableCountByName: the DM's "Indomitable" with 3 uses at Fighter 13, where the table gives two) is the DM's ruling,
 *   so the level-up dialog's re-read and the DM's level_up keep it alike; for an entry read by its bare name, only
 *   another member's count makes one (its own is an older reading the next read corrects);
 * - but an entry whose uses follow its class table's counts (a by-table scale: a 2024 book's Fighter as the offline
 *   parser names it, "Indomitable") keeps its own name and its scale, whose count at the class level is its maximum; a
 *   member counting more (the DM's "Indomitable (three uses)" at Fighter 13, where the table gives two) is the DM's
 *   ruling of that number on the same entry.
 * The other entries leave the sheet. A merge of entries the sheet held is reported as one (an event and a FeatureMerge),
 * and a new feature it renamed (the DM's boon named with a higher count before the class's level) is named first in
 * it, as it came, and listed as no new feature; a held entry the level's row grew is reported as growth. `levelled` is
 * the hero with the level's classes, for a scale's count.
 */
function collapseCountedFamilies(
  held: readonly Feature[],
  added: readonly Feature[],
  classes: readonly ClassLevel[],
  rows: readonly Feature[],
  levelled: Character,
): Collapsed {
  const features = [...held, ...added];
  const isNew = new Set(added);
  const collapsed: Collapsed = { features, grows: [], merges: [], events: [], folded: new Set() };
  // By class and base name: "fighter indomitable". `byName`: the class counts the base by name (classCountingByName).
  const families = new Map<string, { base: string; byName: boolean; cl: ClassLevel; members: FamilyMember[] }>();
  const keyOf = (cl: ClassLevel, f: Feature) => `${nameKey(cl.name)} ${nameKey(featureBaseName(f.name))}`;
  const familyOf = (cl: ClassLevel, f: Feature) => {
    const family = families.get(keyOf(cl, f)) ?? { base: nameKey(featureBaseName(f.name)), byName: classCountingByName([cl], featureBaseName(f.name)) !== undefined, cl, members: [] };
    families.set(keyOf(cl, f), family);
    return family;
  };
  for (const f of features) {
    const cl = featureClassOf(f, classes);
    // Another parenthetical ("Action Surge (Bonus)", a DM's homebrew among the level's new features) is a feature of its own.
    if (!cl || !familyNamed(f.name, featureBaseName(f.name))) continue;
    familyOf(cl, f).members.push({ f, held: !isNew.has(f), own: true, row: false });
  }
  for (const f of features) {
    if (featureClassOf(f, classes) || !isGrantedFamilyEntry(f, featureBaseName(f.name))) continue;
    // The family of a class that has an entry of it; else, for a class that counts the base by name, the DM's entries
    // are its family on their own (every row the DM's level_up reminded of, added with features_add).
    const counting = classCountingByName(classes, featureBaseName(f.name));
    const family = [...families.values()].find((x) => x.base === nameKey(featureBaseName(f.name))) ?? (counting ? familyOf(counting, f) : undefined);
    family?.members.push({ f, held: !isNew.has(f), own: false, row: false });
  }
  if (!families.size) return collapsed;
  for (const f of rows) {
    const cl = featureClassOf(f, classes);
    const family = cl ? families.get(keyOf(cl, f)) : undefined;
    if (family?.members.some((m) => m.held)) family.members.push({ f, held: false, own: false, row: true });
  }

  const place = new Map(features.map((f, i) => [f, i]));
  const order = (m: FamilyMember) => (m.row ? features.length : (place.get(m.f) ?? features.length));
  const drop = new Set<Feature>();
  const replace = new Map<Feature, Feature>();
  for (const { base, byName, cl, members } of families.values()) {
    // Counted by the class's own name for it (its entry, its new feature, its table's row, or its table naming the base
    // with a count): the DM's own counted label beside a class feature named without a count is no family.
    if (members.length < 2 || !(byName || members.some((m) => (m.own || m.row) && namesItsCount(m)))) continue;
    members.sort((a, b) => order(a) - order(b));
    const real = members.filter((m) => !m.row);
    const keep = real.find((m) => m.f.uses?.ruled) ?? real.find((m) => m.own) ?? real[0];
    if (!keep) continue;
    const spent = real.reduce((sum, m) => sum + Math.max(0, toInt(m.f.uses?.used)), 0);
    const before = Math.max(0, ...real.filter((m) => m.held).map((m) => memberCount(m.f)));
    // The other members' highest count: above the table's, the DM's ruling on an entry that follows or reads its table.
    const most = Math.max(0, ...members.filter((m) => m !== keep).map((m) => memberCount(m.f)));
    let kept: Feature;
    const ruled = keep.f.uses?.ruled ? keep.f.uses : undefined;
    const tracked = !ruled && keep.f.uses?.scale?.by === 'table' ? keep.f.uses : undefined;
    const table = tracked ? scaledUsesMax(levelled, tracked.scale) : null;
    if (ruled) kept = { ...keep.f, uses: { ...ruled, used: clamp(spent, 0, ruled.max) } };
    else if (tracked && table !== null) {
      // The table's count by its scale; another member's higher count is the DM's ruling on this entry (its scale off).
      const { scale: _scale, ...own } = tracked;
      const uses: FeatureUses = most > table ? { ...own, max: most, ruled: true } : { ...tracked, max: table };
      kept = { ...keep.f, uses: { ...uses, used: clamp(Math.min(spent, before), 0, uses.max) } };
    } else {
      const newest = members.reduce((best, m) => newerMember(m, best));
      const count = memberCount(newest.f);
      const template = keep.f.uses ?? newest.f.uses ?? real.find((m) => m.f.uses)?.f.uses;
      // A book class's entry read by its bare name keeps it, and the next read gives it the table's count (its own count,
      // an older reading, is no ruling). A count above the class's rules table at its level is the DM's ruling (its
      // scale off), as for an entry that follows the table.
      const reads = readsItsTable(keep.f, classes);
      const name = reads ? keep.f.name : newest.f.name;
      // None for a class whose rules table doesn't count the base by name (classCountingByName): no ruling then.
      const rules = tableCountByName(cl, base);
      let uses: FeatureUses | undefined;
      if (template && rules !== null && (reads ? most : count) > rules) {
        const { scale: _scale, ...plain } = template;
        uses = { ...plain, max: count, ruled: true };
      } else if (template) uses = { ...template, max: count };
      kept = { ...keep.f, name, ...(uses ? { uses: { ...uses, used: clamp(Math.min(spent, before), 0, count) } } : {}) };
    }
    replace.set(keep.f, kept);
    for (const m of real) {
      if (m === keep) continue;
      drop.add(m.f);
      if (!m.held) collapsed.folded.add(m.f);
    }
    const heldMembers = real.filter((m) => m.held);
    if (heldMembers.some((m) => m !== keep)) {
      // One of this level-up's new features the merge renamed (an entry the sheet held counted more: the DM's boon "Action
      // Surge (two uses)" before the Fighter's own at 2, SRD 5.2.1 Fighter Features table: "| 2 | +2 | Action Surge (one
      // use), Tactical Mind |"): it is merged too, named first as it came, and no new feature (folded).
      const renamedNew = !keep.held && nameKey(kept.name) !== nameKey(keep.f.name);
      if (renamedNew) collapsed.folded.add(keep.f);
      const merged = [...(renamedNew ? [keep.f.name] : []), ...heldMembers.map((m) => m.f.name)];
      const left = kept.uses ? usesLeft(kept.uses) : '';
      collapsed.events.push(gameEvent('level-up', `${listJoin(merged)} merged into ${kept.name}${left ? `: ${left}` : ''}.`));
      const merge: FeatureMerge = { id: kept.id, name: kept.name, merged, text: featureMergeText(kept, merged) };
      collapsed.merges.push(renamedNew ? { ...merge, renamedNew: true } : merge);
    } else if (keep.held && kept.uses && kept.uses.max !== keep.f.uses?.max) {
      collapsed.grows.push(keep.f.uses ? `${kept.name} ${keep.f.uses.max} → ${kept.uses.max}` : `${kept.name} ${kept.uses.max}`);
    }
  }
  if (!replace.size) return collapsed;
  return { ...collapsed, features: features.flatMap((f) => (drop.has(f) ? [] : [replace.get(f) ?? f])) };
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
  // Alert adds the Proficiency Bonus to Initiative (SRD 5.2.1 Alert: "Initiative Proficiency. When you roll Initiative,
  // you can add your Proficiency Bonus to the roll"): it grows with the bonus, and a hero who gains the feat now (the
  // level-up panel's pick) adds the whole bonus, a trait or power of its name beside it or not (isAlertFeat).
  const alertDelta = c.features.some(isAlertFeat) ? (oldTotal > 0 ? newPb - oldPb : 0) : added.some(isAlertFeat) ? newPb : 0;

  // The level's rows an SRD class's table names with a use count ("Indomitable (two uses)" at Fighter 13; SRD 5.2.1
  // Indomitable: "You can use this feature twice before a Long Rest starting at level 13"): the DM's level_up adds no
  // SRD class features, so they grow the entry the sheet holds (the class's own or the DM's), listed or not. An entry of
  // the row's name among the new features (the level-up dialog's, the DM's) stands for it.
  const rows = info
    ? featuresAtLevel(info, gained.level)
        .filter((name) => nameUseCount(name) !== null && !added.some((f) => nameKey(f.name) === nameKey(name)))
        .map((name): Feature => ({ id: `row:${nameKey(name)}`, name, source: 'class', sourceName: `${gained.name} ${gained.level}`, description: '' }))
    : [];
  const counted = collapseCountedFamilies(c.features, added, classes, rows, { ...c, classes });
  let next: Character = {
    ...c,
    classes,
    hitDice: addHitDie(c, gained.hitDie),
    hp: { ...c.hp, max: c.hp.max + hpGained, current: c.hp.current > 0 || oldTotal === 0 ? c.hp.current + hpGained : c.hp.current },
    features: counted.features,
    ...(alertDelta ? { initiativeBonusExtra: toInt(c.initiativeBonusExtra) + alertDelta } : {}),
  };
  const uses = refreshScaledFeatureUses(next);
  // A new class or subclass can change the AC (Unarmored Defense, Draconic Resilience, Defense).
  const ac = syncArmorClass(c, uses.character, opts.equipment ?? []);
  next = touch(recomputeSlots(ac.character));
  // A class feature that raises Speed at this level (Unarmored Movement at Monk 2, 6, 10, 14, 18; Fast Movement at
  // Barbarian 5; Roving at Ranger 6): worked out when read (speedDetails), so it is told here.
  const speedChange = speedChangeText(c, next);

  const bonusText = bonuses.map((b) => ` + ${b.amount} ${b.note}`).join('');
  const classText = classes.map((cl) => `${cl.name} ${cl.level}`).join(' / ');
  const events: GameEvent[] = [
    gameEvent(
      'level-up',
      `Reached level ${newLevel} (${classText}): +${hpGained} HP (${hp.detail}${bonusText}) → HP max ${next.hp.max}.`,
    ),
  ];
  // A feature folded into an entry the sheet held is no new feature: it shows as that entry's growth.
  const listed = added.filter((f) => !counted.folded.has(f));
  if (listed.length) events.push(gameEvent('feature-restored', `New features: ${listed.map((f) => f.name).join(', ')}.`));
  events.push(...counted.events);
  const usesNow = [...counted.grows, ...uses.changes];
  if (usesNow.length) events.push(gameEvent('level-up', `Feature uses now: ${listJoin(usesNow)}.`));
  events.push(...ac.events.filter((e) => e.type !== 'warning'));
  if (speedChange) events.push(gameEvent('level-up', `${speedChange}.`));

  const reminders: string[] = [];
  if (!existing && oldTotal > 0) reminders.push(...multiclassPrerequisites(c, info, gained.name, opts.multiclassPrimaries));
  // What to add is what the sheet lacks after the fold: a family the level's row grew or folded into is held.
  if (info) reminders.push(...srdLevelReminders(info, gained, counted.features, added));
  else reminders.push(`Check the ${gained.name} class table for level ${gained.level} features and choices.`);
  // A subclass feature no class table lists (SRD 5.2.1 Champion, level 7: "You gain another Fighting Style feat of your
  // choice"; an older book's Champion chooses from the class's printed styles), however it was added.
  if (added.some((f) => nameKey(f.name) === 'additional-fighting-style')) {
    reminders.push(`${gained.name} ${gained.level}: Additional Fighting Style — choose another Fighting Style.`);
  }
  for (const [name, hint] of FEAT_CHOICE_HINTS) if (hasFeatureNamed(added, name)) reminders.push(hint);
  reminders.push(...slotReminders(c, next));
  if (newPb > oldPb && oldTotal > 0) reminders.push(`Proficiency Bonus is now ${formatModifier(newPb)}.`);
  if (alertDelta) reminders.push(`Alert: initiative bonus from your Proficiency Bonus is now ${formatModifier(newPb)}.`);
  // An AC set by hand that the new level would change (see syncArmorClass).
  reminders.push(...ac.events.filter((e) => e.type === 'warning').map((e) => e.message));
  if (c.hp.current <= 0 && oldTotal > 0) reminders.push('Current HP stays at 0 until healed.');

  const folded = added.filter((f) => counted.folded.has(f)).map((f) => f.name);
  return {
    character: next,
    events,
    newLevel,
    hpGained,
    ...(hp.roll ? { hpRoll: hp.roll } : {}),
    reminders,
    ...(counted.merges.length ? { merges: counted.merges } : {}),
    ...(folded.length ? { folded } : {}),
    ...(speedChange ? { speedChange } : {}),
  };
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
  return c.classes.filter((cl) => rulesClassFor(cl)?.name === 'Bard').reduce((sum, cl) => sum + cl.level, 0);
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
  const rangerLevel = c.classes.filter((cl) => rulesClassFor(cl)?.name === 'Ranger').reduce((sum, cl) => sum + cl.level, 0);
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
 * Also: Concentration ends (you sleep), with what ends with it (afterConcentrationEnds), and Resourceful (Human) grants
 * Heroic Inspiration. Every AC spell ends: Mage Armor's 8 hours (srd:spell:mage-armor) and Shield of Faith's 10 minutes
 * are over by the end of the rest; an AC set by hand for either with no record behind it (an old save's) gets a reminder.
 * Like the SRD, it needs at least 1 HP to start. First the Hit Point maximum adjustments that end at a Long Rest end, so
 * HP refill to the maximum restored. Raises go first: Aid's 8 hours are over before the rest finishes (casting it would
 * have stopped the rest: "Casting a spell other than a cantrip"), so if a drain held the maximum within reach of 0, Aid
 * ending kills before the rest's benefits arrive, and the reductions stay. Then the reductions end (SRD 5.2.1 Long
 * Rest: "When you finish the rest … If your Hit Point maximum was reduced, it returns to normal").
 */
export function applyLongRest(start: Character): { character: Character; events: GameEvent[] } {
  if (start.deathSaves.dead) return { character: start, events: [warning("The dead don't rest.")] };
  if (start.hp.current < 1) return { character: start, events: [warning('A Long Rest needs at least 1 HP — stabilize and heal first.')] };
  const raises = endHpMaxAdjustmentsWhere(start, (a) => a.ends === 'long-rest' && a.amount > 0);
  if (raises.character.deathSaves.dead) return raises;
  const ended = endHpMaxAdjustmentsWhere(raises.character, (a) => a.ends === 'long-rest');
  const c = ended.character;

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

  let character = touch({
    ...c,
    hp: { ...c.hp, current: c.hp.max, temp: 0 },
    hitDice: c.hitDice.map((h) => ({ ...h, spent: 0 })),
    features,
    exhaustion,
    deathSaves: { successes: 0, failures: 0, stable: false, dead: false },
    heroicInspiration: c.heroicInspiration || resourceful,
    ...(spellcasting ? { spellcasting } : {}),
  });

  // The AC spells end, the bonus ones before the base ones (Shield of Faith, then Mage Armor: an AC set by hand loses
  // the +2 first, so the warning Mage Armor's end gives has the numbers the rest leaves); then what ends with the
  // Concentration (its hand-set AC reminder, worked out on the AC the rest leaves; none for an AC spell whose record the
  // rest just ended, whose +2 the app took off itself); then a reminder for an AC set by hand for an AC spell that had
  // no record, unless the Concentration's end gave it: never for Mage Armor, which needs no Concentration
  // (srd:spell:mage-armor, Duration: "8 hours"), so an older save's Concentration on it gives none and the rest does.
  // A Concentration under a sheet copy's noted name ("Shield of Faith (scroll)") is that AC spell's (acSpellNamed).
  const recorded = acSpells(c);
  const acEvents: GameEvent[] = [];
  for (const name of [...recorded.filter((n) => AC_SPELLS[n].bonus), ...recorded.filter((n) => !AC_SPELLS[n].bonus)]) {
    const ended = endAcSpell(character, name);
    character = ended.character;
    acEvents.push(...ended.events);
  }
  const concentration = sc?.concentratingOn;
  const heldAcSpell = concentration ? acSpellNamed(concentration) : undefined;
  if (concentration && !(heldAcSpell && recorded.includes(heldAcSpell))) {
    const ended = afterConcentrationEnds(character, concentration);
    character = ended.character;
    acEvents.push(...ended.events);
  }
  for (const name of AC_SPELL_NAMES) {
    if (recorded.includes(name) || (heldAcSpell === name && name !== 'Mage Armor')) continue;
    const reminder = handSetAcReminder(character, name);
    if (reminder) acEvents.push(reminder);
  }

  const parts = [`HP ${c.hp.current} → ${c.hp.max}`];
  if (c.hp.temp > 0) parts.push(`${c.hp.temp} temporary HP lost`);
  if (spentDice > 0) parts.push(`regained ${spentDice} Hit Point ${spentDice === 1 ? 'Die' : 'Dice'}`);
  if (usedSlots > 0) parts.push('all spell slots restored');
  if (regained.length) parts.push(`recharged ${listJoin(regained)}`);
  if (exhaustion !== c.exhaustion) parts.push(`Exhaustion ${c.exhaustion} → ${exhaustion}`);
  if (sc?.concentratingOn) parts.push(`Concentration on ${sc.concentratingOn} ended`);
  if (resourceful) parts.push('gained Heroic Inspiration (Resourceful)');
  return {
    character,
    events: [
      ...raises.events,
      ...ended.events,
      ...acEvents.filter((e) => e.type !== 'warning'),
      gameEvent('rest', `Long rest: ${parts.join('; ')}.`),
      ...acEvents.filter((e) => e.type === 'warning'),
    ],
  };
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
