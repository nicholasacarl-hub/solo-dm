/**
 * Character state transitions. Every function is pure: it returns a NEW Character plus
 * GameEvents describing what happened (used for log lines and DM tool results).
 * Functions never throw for game-rule problems (e.g. not enough gold); they return the
 * unchanged character with a 'warning' event instead. updatedAt is bumped on change.
 *
 * Rules follow SRD 5.2.1 "Damage and Healing" and the Rules Glossary.
 */
import {
  ABILITY_NAMES,
  AC_SPELL_NAMES,
  HP_MAX_ENDS,
  type AcSpellName,
  type Ability,
  type ActiveCondition,
  type Character,
  type Currency,
  type EquipmentOption,
  type Feature,
  type FeatureSource,
  type FeatureUses,
  type GameEvent,
  type HpMaxAdjustment,
  type HpMaxEnds,
  type InventoryItem,
  type KnownSpell,
  type Spellcasting,
} from '@/types';
import { nameKey, newId } from '@/lib/id';
import { safeEnd } from '@/lib/text';
import { wornArmor } from './armorData';
import { CONDITIONS, INCAPACITATING_CONDITIONS, conditionKey, conditionName, matchStandardCondition } from './conditions';
import { levelForXp } from './progression';
import {
  AC_SPELLS,
  abilityModifier,
  acSpellNamed,
  acSpells,
  characterLevel,
  deathSaveModifier,
  exhaustionLevel,
  formatModifier,
  hasCondition,
  initiativeModifier,
  proficiencyBonus,
  spellcastingAbility,
  syncArmorClass,
  unknownWornArmor,
} from './rules';
import { handSetAcNaming } from './spellEffects';
import { clamp, formatInt, gameEvent, lookupProblem, matchByName, toInt, touch, warning, type NameMatch } from './util';

export interface EngineResult {
  character: Character;
  events: GameEvent[];
}

function unchanged(c: Character, message: string): EngineResult {
  return { character: c, events: [warning(message)] };
}

const MINUS = '\u2212';
const FRESH_DEATH_SAVES = { successes: 0, failures: 0, stable: false, dead: false } as const;

/** A blank level-1 character shell with sane defaults (used by the builder). */
export function createBlankCharacter(campaignId: string): Character {
  const now = Date.now();
  return {
    id: newId(),
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
    acFormula: '10 + DEX 0',
    speed: 30,
    size: 'Medium',
    // HP come from the first class level (hit die + CON); the builder or levelUp fills them in.
    hp: { max: 0, current: 0, temp: 0 },
    hitDice: [],
    deathSaves: { ...FRESH_DEATH_SAVES },
    conditions: [],
    exhaustion: 0,
    heroicInspiration: false,
    features: [],
    attacks: [],
    inventory: [],
    currency: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
    personality: {},
    notes: '',
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Hit points, dying and death
// ---------------------------------------------------------------------------

/** Constitution save DC to keep Concentration after taking damage: max(10, half the damage), at most 30. */
export function concentrationSaveDC(damage: number): number {
  return clamp(Math.floor(Math.max(0, toInt(damage)) / 2), 10, 30);
}

/** Concentration ends on its own (0 HP, death, an Incapacitating condition), with what ends with it (afterConcentrationEnds). */
function endConcentration(c: Character, reason: string): EngineResult {
  const spell = c.spellcasting?.concentratingOn;
  if (!c.spellcasting || !spell) return { character: c, events: [] };
  const ended = afterConcentrationEnds({ ...c, spellcasting: { ...c.spellcasting, concentratingOn: null } }, spell);
  return { character: ended.character, events: [gameEvent('condition-removed', `Concentration on ${spell} ends (${reason}).`), ...ended.events] };
}

function withCondition(conditions: readonly ActiveCondition[], condition: ActiveCondition): ActiveCondition[] {
  const key = conditionKey(condition.id);
  return conditions.some((x) => conditionKey(x.id) === key) ? [...conditions] : [...conditions, condition];
}

function withoutCondition(conditions: readonly ActiveCondition[], id: string): ActiveCondition[] {
  const key = conditionKey(id);
  return conditions.filter((x) => conditionKey(x.id) !== key);
}

/** Back above 0 HP: Unconscious ends (you remain Prone — SRD 5.2.1 Unconscious) and death saves reset. */
function revive(c: Character, current: number): Character {
  const conditions = withCondition(withoutCondition(c.conditions, 'unconscious'), { id: 'prone', source: 'Fell unconscious' });
  return { ...c, hp: { ...c.hp, current }, conditions, deathSaves: { ...FRESH_DEATH_SAVES } };
}

function die(c: Character, deathSaves: Character['deathSaves'], message: string): EngineResult {
  const ended = endConcentration({ ...c, hp: { ...c.hp, current: 0 }, deathSaves }, 'death');
  return { character: touch(ended.character), events: [gameEvent('died', message), ...ended.events] };
}

/** "8 slashing", or "8 damage" when the type is unknown. */
function damageLabel(amount: number, damageType?: string): string {
  return `${amount} ${damageType?.trim() || 'damage'}`;
}

/**
 * Damage while already at 0 HP: one death-save failure (two on a critical hit); massive damage kills. A Stable
 * creature starts its tallies from zero (SRD 5.2.1 Death Saving Throws: both reset when it becomes Stable), even when
 * the sheet's pips marked it Stable without resetting them.
 */
function damageAtZero(c: Character, amount: number, temp: number, label: string, critical: boolean): EngineResult {
  const saves = c.deathSaves.stable ? { ...c.deathSaves, successes: 0, failures: 0 } : c.deathSaves;
  const added = critical ? 2 : 1;
  const failures = Math.min(3, saves.failures + added);
  const base = { ...c, hp: { ...c.hp, temp } };
  if (amount >= c.hp.max) {
    return die(base, { ...saves, failures, stable: false, dead: true }, `Took ${label} at 0 HP — at least the HP maximum (${c.hp.max}): dies instantly.`);
  }
  if (failures >= 3) {
    return die(base, { ...saves, failures: 3, stable: false, dead: true }, `Took ${label} at 0 HP — third death save failure: dies.`);
  }
  const wasStable = c.deathSaves.stable ? ' No longer Stable.' : '';
  const character = touch({ ...base, deathSaves: { ...saves, failures, stable: false } });
  const message = `Took ${label} at 0 HP — ${added} death save failure${added > 1 ? 's' : ''}${critical ? ' (critical hit)' : ''} (${failures}/3).${wasStable}`;
  return { character, events: [gameEvent('death-save', message)] };
}

/**
 * Apply damage (2024 rules): temporary HP absorb first; at 0 HP the character falls unconscious
 * (adds the Unconscious condition and resets death saves). Massive damage: if damage remaining
 * after reaching 0 HP is >= HP max, the character dies. Damage taken while already at 0 HP adds one
 * death-save failure (two if `critical`); three failures = dead. Damage at 0 HP that equals or exceeds
 * the HP max kills. Damage while concentrating emits a Concentration-check warning (DC from
 * concentrationSaveDC); dropping to 0 ends Concentration.
 */
export function applyDamage(
  c: Character,
  amount: number,
  opts: { critical?: boolean; damageType?: string; applyDefenses?: boolean } = {},
): EngineResult {
  const rawDamage = Math.max(0, toInt(amount));
  if (rawDamage === 0) return { character: c, events: [] };
  if (c.deathSaves.dead) return unchanged(c, 'Already dead — further damage has no effect.');
  const defenses = opts.applyDefenses === false ? null : adjustForDefenses(c, rawDamage, opts.damageType);
  if (defenses?.immune) return unchanged(c, `Immune to ${defenses.type} damage — no damage taken.`);
  const damage = defenses ? defenses.amount : rawDamage;
  if (damage === 0) return unchanged(c, defenses?.note ? `No damage taken (${defenses.note}).` : 'No damage taken.');
  const result = applyAdjustedDamage(c, damage, opts);
  if (!defenses?.note) return result;
  const note = gameEvent('hp-changed', `Damage adjusted: ${defenses.note}.`);
  return { character: result.character, events: [note, ...result.events] };
}

function listHas(list: readonly string[] | undefined, value: string): boolean {
  return (list ?? []).some((entry) => entry.trim().toLowerCase() === value);
}

/**
 * 2024 order of application: immunity → 0; otherwise Resistance halves (round down), then
 * Vulnerability doubles. Matching is by damage type, case-insensitive.
 */
function adjustForDefenses(
  c: Character,
  damage: number,
  damageType: string | undefined,
): { amount: number; immune: boolean; type: string; note: string | null } {
  const type = damageType?.trim().toLowerCase() ?? '';
  if (!type) return { amount: damage, immune: false, type, note: null };
  if (listHas(c.damageImmunities, type)) return { amount: 0, immune: true, type, note: null };
  let amount = damage;
  const notes: string[] = [];
  if (listHas(c.damageResistances, type)) {
    const halved = Math.floor(amount / 2);
    notes.push(`Resistance to ${type} halves ${amount} → ${halved}`);
    amount = halved;
  }
  if (listHas(c.damageVulnerabilities, type)) {
    notes.push(`Vulnerability to ${type} doubles ${amount} → ${amount * 2}`);
    amount *= 2;
  }
  return { amount, immune: false, type, note: notes.length ? notes.join('; ') : null };
}

function applyAdjustedDamage(c: Character, damage: number, opts: { critical?: boolean; damageType?: string }): EngineResult {

  const absorbed = Math.min(Math.max(0, c.hp.temp), damage);
  const temp = c.hp.temp - absorbed;
  const toHp = damage - absorbed;
  const label = damageLabel(damage, opts.damageType);
  const tempNote = absorbed ? `; ${absorbed} absorbed by temporary HP` : '';
  // RAW: damage absorbed by temporary HP is still damage taken, so it still costs a death save.
  if (c.hp.current <= 0) {
    const full = `${damage} ${opts.damageType?.trim() ? `${opts.damageType.trim()} ` : ''}damage`;
    return damageAtZero(c, damage, temp, `${full}${absorbed ? ` (${absorbed} absorbed by temporary HP)` : ''}`, !!opts.critical);
  }

  const remaining = c.hp.current - toHp;
  if (remaining > 0 || toHp === 0) {
    const character = touch({ ...c, hp: { ...c.hp, current: remaining, temp } });
    const events = [
      toHp === 0
        ? gameEvent('temp-hp', `Temporary HP ${c.hp.temp} → ${temp} (${label} absorbed)`)
        : gameEvent('hp-changed', `HP ${c.hp.current} → ${remaining} (${label}${tempNote})`),
    ];
    const spell = c.spellcasting?.concentratingOn;
    if (spell) events.push(warning(`Concentration check: DC ${concentrationSaveDC(damage)} Constitution saving throw to keep ${spell}.`));
    return { character, events };
  }

  const overflow = -remaining;
  const zeroed = { ...c, hp: { ...c.hp, current: 0, temp } };
  if (overflow >= c.hp.max) {
    return die(
      zeroed,
      { successes: 0, failures: 0, stable: false, dead: true },
      `HP ${c.hp.current} → 0 (${label}${tempNote}) — massive damage: ${overflow} left over is at least the HP maximum (${c.hp.max}). Dies instantly.`,
    );
  }
  const down: Character = {
    ...zeroed,
    conditions: withCondition(c.conditions, { id: 'unconscious', source: '0 Hit Points' }),
    deathSaves: { ...FRESH_DEATH_SAVES },
  };
  const ended = endConcentration(down, 'Unconscious');
  return {
    character: touch(ended.character),
    events: [
      gameEvent('dropped-to-zero', `HP ${c.hp.current} → 0 (${label}${tempNote}) — Unconscious. Death saving throws begin.`),
      ...ended.events,
    ],
  };
}

/** Heal (capped at HP max). Healing from 0 HP revives: removes Unconscious and resets death saves. Dead characters cannot be healed. */
export function applyHealing(c: Character, amount: number): EngineResult {
  const heal = Math.max(0, toInt(amount));
  if (heal === 0) return { character: c, events: [] };
  if (c.deathSaves.dead) {
    return unchanged(c, "Dead characters can't regain Hit Points — only magic such as Revivify or Raise Dead can bring them back.");
  }
  if (c.hp.current >= c.hp.max) return unchanged(c, `Already at full HP (${c.hp.current}/${c.hp.max}).`);
  const current = Math.min(c.hp.max, c.hp.current + heal);
  if (c.hp.current <= 0) {
    return {
      character: touch(revive(c, current)),
      events: [gameEvent('revived', `HP 0 → ${current} (healed ${heal}) — conscious again, but still Prone.`)],
    };
  }
  return {
    character: touch({ ...c, hp: { ...c.hp, current } }),
    events: [gameEvent('hp-changed', `HP ${c.hp.current} → ${current} (healed ${current - c.hp.current})`)],
  };
}

/** Temporary HP don't stack: keep the higher of current and new. */
export function setTempHp(c: Character, amount: number): EngineResult {
  const value = Math.max(0, toInt(amount));
  if (value === 0) return { character: c, events: [] };
  if (c.deathSaves.dead) return unchanged(c, "The dead can't gain temporary HP.");
  if (value <= c.hp.temp) {
    return {
      character: c,
      events: [gameEvent('temp-hp', `Kept ${c.hp.temp} temporary HP — temporary HP don't stack, and ${value} isn't higher.`)],
    };
  }
  const note = c.hp.current <= 0 ? " (temporary HP don't restore consciousness)" : '';
  return {
    character: touch({ ...c, hp: { ...c.hp, temp: value } }),
    events: [gameEvent('temp-hp', `Temporary HP ${c.hp.temp} → ${value}${note}`)],
  };
}

/** Remove all temporary HP (e.g. the effect that granted them ended). */
export function clearTempHp(c: Character): EngineResult {
  if (c.hp.temp <= 0) return { character: c, events: [] };
  return {
    character: touch({ ...c, hp: { ...c.hp, temp: 0 } }),
    events: [gameEvent('temp-hp', `Temporary HP ${c.hp.temp} → 0`)],
  };
}

type DeathSaveOutcome = 'success' | 'failure' | 'stable' | 'revived' | 'dead';

/**
 * Another creature stabilized the dying hero (SRD 5.2.1 Stabilizing a Character: the Help action's DC 10 Wisdom
 * (Medicine) check, a Healer's Kit, Spare the Dying): Stable at 0 HP and still Unconscious, the death saves stop and both
 * tallies reset (Death Saving Throws), until damage starts them again. `how` says who or what did it.
 */
export function stabilize(c: Character, how?: string): EngineResult {
  if (c.deathSaves.dead) return unchanged(c, "The dead can't be stabilized.");
  if (c.hp.current > 0) return unchanged(c, `Not dying (HP ${c.hp.current}): only a creature at 0 HP can be stabilized.`);
  if (c.deathSaves.stable) return unchanged(c, 'Already Stable.');
  const by = how?.trim() ? ` (${how.trim()})` : '';
  return {
    character: touch({ ...c, deathSaves: { successes: 0, failures: 0, stable: true, dead: false } }),
    events: [gameEvent('stabilized', `Stabilized${by}: Stable at 0 HP (still Unconscious), no more death saving throws unless damaged again.`)],
  };
}

/**
 * Record a death saving throw from the natural d20 (2024): 10+ success, 9- failure, natural 1 = two
 * failures, natural 20 = regain 1 HP (revived). Three successes = stable (the tallies reset, SRD 5.2.1);
 * three failures = dead. A death save is a saving throw, so the Exhaustion penalty and always-on save
 * bonuses (see deathSaveModifier) apply to the total; naturals 1 and 20 are judged on the die alone.
 * Throws RangeError if `natural` isn't a whole number 1–20 (a caller bug, not a game event).
 */
export function recordDeathSave(c: Character, natural: number): EngineResult & { outcome: DeathSaveOutcome } {
  if (!Number.isInteger(natural) || natural < 1 || natural > 20) {
    throw new RangeError(`A death saving throw needs a natural d20 result from 1 to 20 (got ${String(natural)}).`);
  }
  if (c.deathSaves.dead) return { ...unchanged(c, 'Already dead — no more death saving throws.'), outcome: 'dead' };
  if (c.hp.current > 0) return { ...unchanged(c, `Not dying (HP ${c.hp.current}) — no death saving throw needed.`), outcome: 'stable' };
  if (c.deathSaves.stable) {
    return { ...unchanged(c, 'Stable — no death saving throws unless damaged again.'), outcome: 'stable' };
  }

  if (natural === 20) {
    return {
      character: touch(revive(c, 1)),
      events: [gameEvent('revived', 'Death save: natural 20 — regains 1 HP and is conscious again (still Prone).')],
      outcome: 'revived',
    };
  }
  const modifier = deathSaveModifier(c);
  const total = natural + modifier;
  const rolled = modifier ? `natural ${natural}, ${total} after modifiers` : `natural ${natural}`;
  const saves = c.deathSaves;

  if (natural !== 1 && total >= 10) {
    const successes = saves.successes + 1;
    if (successes >= 3) {
      return {
        character: touch({ ...c, deathSaves: { successes: 0, failures: 0, stable: true, dead: false } }),
        events: [gameEvent('stabilized', `Death save succeeded (${rolled}) — third success: Stable at 0 HP (still Unconscious).`)],
        outcome: 'stable',
      };
    }
    return {
      character: touch({ ...c, deathSaves: { ...saves, successes } }),
      events: [gameEvent('death-save', `Death save succeeded (${rolled}) — ${successes} success${successes > 1 ? 'es' : ''}, ${saves.failures} failure${saves.failures === 1 ? '' : 's'}.`)],
      outcome: 'success',
    };
  }

  const added = natural === 1 ? 2 : 1;
  const failures = Math.min(3, saves.failures + added);
  const why = natural === 1 ? 'natural 1 counts as two failures' : rolled;
  if (failures >= 3) {
    const result = die(c, { ...saves, failures: 3, stable: false, dead: true }, `Death save failed (${why}) — third failure: dies.`);
    return { ...result, outcome: 'dead' };
  }
  return {
    character: touch({ ...c, deathSaves: { ...saves, failures } }),
    events: [gameEvent('death-save', `Death save failed (${why}) — ${saves.successes} success${saves.successes === 1 ? '' : 'es'}, ${failures} failure${failures > 1 ? 's' : ''}.`)],
    outcome: 'failure',
  };
}

// ---------------------------------------------------------------------------
// Hit Point maximum adjustments
// ---------------------------------------------------------------------------
//
// hp.max stays the maximum in force, so every reader (healing, Hit Point Dice, rests, massive damage, Bloodied) keeps
// reading one number. hpMaxAdjustments records each change beyond what the app counts with the amount it made, so
// ending one takes back exactly that, whatever level-ups or Constitution changes came between.

const HP_MAX_NAME_MAX = 60;

/** How long an adjustment lasts, for labels: "until a Long Rest", "until ended", "lasting". */
export function hpMaxEndsText(ends: HpMaxEnds): string {
  return ends === 'long-rest' ? 'until a Long Rest' : ends === 'when-ended' ? 'until ended' : 'lasting';
}

function readEnds(ends: unknown): HpMaxEnds {
  return (HP_MAX_ENDS as readonly unknown[]).includes(ends) ? (ends as HpMaxEnds) : 'when-ended';
}

/**
 * The sheet's adjustments, read leniently: a name (on one line, at most 60 characters, as the engine writes it, so a
 * longer one from a hand-edited file can still be ended) and a whole, non-zero amount; an unknown `ends` reads as
 * 'when-ended'.
 */
export function hpMaxAdjustments(c: Pick<Character, 'hpMaxAdjustments'>): HpMaxAdjustment[] {
  return (Array.isArray(c.hpMaxAdjustments) ? c.hpMaxAdjustments : []).flatMap((a) => {
    const name = typeof a?.name === 'string' ? adjustmentName(a.name) : '';
    const amount = toInt(a?.amount);
    return name && amount !== 0 ? [{ name, amount, ends: readEnds(a.ends) }] : [];
  });
}

/** "Aid +5 (until a Long Rest)", "Life Drain −10 (until a Long Rest)", "Tough (missed at 1st level) +4 (lasting)". */
export function hpMaxAdjustmentLabel(a: HpMaxAdjustment): string {
  return `${a.name} ${formatModifier(a.amount)} (${hpMaxEndsText(a.ends)})`;
}

/** A name on one line, at most 60 characters. */
function adjustmentName(name: unknown): string {
  const flat = String(name ?? '').replace(/\s+/g, ' ').trim();
  return flat.slice(0, safeEnd(flat, HP_MAX_NAME_MAX)).trimEnd();
}

/** The spell or effect a name is for: "Aid (3rd level)" is Aid (SRD 5.2.1 Combining Spell Effects). */
function effectKey(name: string): string {
  return nameKey(splitQualifier(name)?.base ?? name);
}

function withAdjustments(c: Character, list: readonly HpMaxAdjustment[]): Character {
  const next: Character = { ...c, hpMaxAdjustments: [...list] };
  if (!list.length) delete next.hpMaxAdjustments;
  return next;
}

/** A maximum of 0 kills (SRD 5.2.1 Instant Death: "A creature dies if its Hit Point maximum reaches 0."); temporary HP go too. */
function dieAtMaxZero(c: Character, message: string): EngineResult {
  return die({ ...c, hp: { max: 0, current: 0, temp: 0 } }, { ...c.deathSaves, stable: false, dead: true }, message);
}

export interface HpMaxChange {
  /** The spell or effect ("Aid", "Life Drain"), or what a lasting change is for ("Tough (missed at 1st level)"). */
  name: string;
  /** Signed change to the maximum. */
  change: number;
  ends: HpMaxEnds;
}

/**
 * Raise or lower the Hit Point maximum, recorded in hpMaxAdjustments so it can be ended.
 * - An effect that raises it (Aid, Heroes' Feast) adds as much to current HP, waking a hero at 0 HP (SRD 5.2.1 Falling
 *   Unconscious: "until you regain any Hit Points"). The same spell again doesn't add (Combining Spell Effects: "the
 *   effects of the same spell cast multiple times don't combine"): only a stronger casting replaces it, by the difference.
 * - An effect that lowers it (Life Drain, a curse) adds up under one name and lowers current HP only to fit (Hit Points:
 *   "You can't have more Hit Points than your Hit Point maximum"); a maximum of 0 kills. Harm stops at 1 (SRD 5.2.1 Harm:
 *   "This spell can't reduce a target's Hit Point maximum below 1").
 * - A lasting change (`never`: a ruling, a boon, missed Hit Points) is bookkeeping, like a Constitution change: current
 *   HP moves with it, a hero at 0 HP stays at 0, and it never takes the maximum below 1. The same name again adds up, and
 *   a total of 0 takes it back.
 */
export function adjustHpMax(c: Character, spec: HpMaxChange): EngineResult {
  const name = adjustmentName(spec.name);
  const change = toInt(spec.change);
  const ends = readEnds(spec.ends);
  if (!name) return unchanged(c, 'A Hit Point maximum adjustment needs a name.');
  if (change === 0) return unchanged(c, 'No change to the Hit Point maximum.');
  if (c.deathSaves.dead) return unchanged(c, "The hero is dead: the Hit Point maximum doesn't change (an adjustment can still be ended).");
  if (c.hp.max <= 0) return unchanged(c, 'No Hit Point maximum yet.');
  const list = hpMaxAdjustments(c);
  const problem = hpMaxNameProblem(list, name, change, ends);
  if (problem) return unchanged(c, problem);
  if (ends === 'never') return lastingHpMaxChange(c, list, name, change);
  return change > 0 ? raiseHpMax(c, list, name, change, ends) : lowerHpMax(c, list, name, -change, ends);
}

/**
 * Why `name` can't take this change, or null. One name is one entry, so hp_max_end and the status line know each by its
 * name alone: an effect's change can't go the other way under an effect's name, and no change can end differently from
 * the entry already under its name (a stronger casting of the same spell replaces its entry whatever its end). A lasting
 * change under a lasting entry's name adds up either way, and a total of 0 takes it back.
 */
function hpMaxNameProblem(list: readonly HpMaxAdjustment[], name: string, change: number, ends: HpMaxEnds): string | null {
  const held = hpMaxNameHolder(list, name, change, ends);
  if (!held) return null;
  const { entry, opposite } = held;
  return opposite
    ? `${entry.name} ${entry.amount > 0 ? 'raises' : 'lowers'} the Hit Point maximum: end it first, or give this change another name.`
    : `${hpMaxAdjustmentLabel(entry)} goes by that name: give this change another name, or end that one first.`;
}

/** The entry under `name` that keeps it from taking this change (hpMaxNameProblem), and whether it goes the other way. */
function hpMaxNameHolder(
  list: readonly HpMaxAdjustment[],
  name: string,
  change: number,
  ends: HpMaxEnds,
): { entry: HpMaxAdjustment; opposite: boolean } | null {
  const named = list.filter((a) => nameKey(a.name) === nameKey(name));
  const opposite = ends !== 'never' && named.find((a) => a.ends !== 'never' && a.amount > 0 !== change > 0);
  if (opposite) return { entry: opposite, opposite: true };
  const recast = (a: HpMaxAdjustment) => change > 0 && ends !== 'never' && a.amount > 0 && a.ends !== 'never';
  const other = named.find((a) => a.ends !== ends && !recast(a));
  return other ? { entry: other, opposite: false } : null;
}

function raiseHpMax(c: Character, list: readonly HpMaxAdjustment[], name: string, amount: number, ends: HpMaxEnds): EngineResult {
  const index = list.findIndex((a) => a.ends !== 'never' && a.amount > 0 && effectKey(a.name) === effectKey(name));
  const same = index >= 0 ? list[index] : undefined;
  if (same && amount <= same.amount) {
    return unchanged(c, `${same.name} ${formatModifier(same.amount)} already applies: the same spell's effects don't combine (the most potent applies), so only a stronger casting replaces it.`);
  }
  const gain = amount - (same?.amount ?? 0);
  const entry: HpMaxAdjustment = { name, amount, ends };
  const max = c.hp.max + gain;
  const base = withAdjustments({ ...c, hp: { ...c.hp, max } }, same ? list.map((a, i) => (i === index ? entry : a)) : [...list, entry]);
  const why = `${name} ${formatModifier(amount)}${same ? ` replaces ${same.name} ${formatModifier(same.amount)}` : ''}, ${hpMaxEndsText(ends)}`;
  if (c.hp.current <= 0) {
    return {
      character: touch(revive(base, gain)),
      events: [gameEvent('revived', `HP maximum ${c.hp.max} → ${max}, HP 0 → ${gain} (${why}) — conscious again, but still Prone.`)],
    };
  }
  const current = c.hp.current + gain;
  return {
    character: touch({ ...base, hp: { ...base.hp, current } }),
    events: [gameEvent('hp-changed', `HP maximum ${c.hp.max} → ${max}, HP ${c.hp.current} → ${current} (${why})`)],
  };
}

function lowerHpMax(c: Character, list: readonly HpMaxAdjustment[], name: string, amount: number, ends: HpMaxEnds): EngineResult {
  const harm = effectKey(name) === 'harm';
  const applied = Math.min(amount, harm ? c.hp.max - 1 : c.hp.max);
  if (applied <= 0) return unchanged(c, "Harm can't reduce a target's Hit Point maximum below 1 (it is 1).");
  const index = list.findIndex((a) => a.ends === ends && a.amount < 0 && nameKey(a.name) === nameKey(name));
  const total = (index >= 0 ? list[index].amount : 0) - applied;
  const next = index >= 0 ? list.map((a, i) => (i === index ? { ...a, amount: total } : a)) : [...list, { name, amount: -applied, ends }];
  const max = c.hp.max - applied;
  const floor = applied < amount && harm ? ": it can't reduce a Hit Point maximum below 1" : '';
  const why = `${name} ${formatModifier(-applied)}${floor}${index >= 0 ? `, ${formatModifier(total)} in all` : ''}, ${hpMaxEndsText(ends)}`;
  const base = withAdjustments({ ...c, hp: { ...c.hp, max } }, next);
  if (max <= 0) return dieAtMaxZero(base, `HP maximum ${c.hp.max} → 0 (${why}): a creature dies if its Hit Point maximum reaches 0.`);
  const current = Math.min(c.hp.current, max);
  const hp = current !== c.hp.current ? `, HP ${c.hp.current} → ${current}` : '';
  return { character: touch({ ...base, hp: { ...base.hp, current } }), events: [gameEvent('hp-changed', `HP maximum ${c.hp.max} → ${max}${hp} (${why})`)] };
}

function lastingHpMaxChange(c: Character, list: readonly HpMaxAdjustment[], name: string, change: number): EngineResult {
  const max = c.hp.max + change;
  if (max < 1) return unchanged(c, `A lasting change can't take the Hit Point maximum below 1 (it is ${c.hp.max}).`);
  const index = list.findIndex((a) => a.ends === 'never' && nameKey(a.name) === nameKey(name));
  const total = (index >= 0 ? list[index].amount : 0) + change;
  const next =
    index < 0
      ? [...list, { name, amount: change, ends: 'never' as const }]
      : list.flatMap((a, i) => (i !== index ? [a] : total === 0 ? [] : [{ ...a, amount: total }]));
  const current = c.hp.current > 0 ? clamp(c.hp.current + change, 1, max) : 0;
  const sum = index < 0 ? '' : total === 0 ? ', taken back' : `, ${formatModifier(total)} in all`;
  const hp = c.hp.current > 0 ? `, HP ${c.hp.current} → ${current}` : '';
  const atZero = c.hp.current > 0 ? '' : '; HP stays 0 until healed';
  return {
    character: touch(withAdjustments({ ...c, hp: { ...c.hp, max, current } }, next)),
    events: [gameEvent('hp-changed', `HP maximum ${c.hp.max} → ${max}${hp} (${name} ${formatModifier(change)}${sum}, lasting)${atZero}`)],
  };
}

/**
 * End the adjustments each name finds (findHpMaxAdjustments; with `ends`, only those that end so). Its time ran out,
 * Greater Restoration ended the reductions (SRD 5.2.1 Greater Restoration: "Any reduction to the target's Hit Point
 * maximum"), or a lasting one is taken back. All of them end together (endHpMaxAdjustmentsWhere), so the order of the
 * names never matters: a raise that ran out first is ended alone, first. A name that finds nothing warns with what is
 * left in effect.
 */
export function endHpMaxAdjustments(c: Character, names: string | readonly string[], ends?: HpMaxEnds): EngineResult {
  const { indices, missing } = findHpMaxAdjustments(c, names, ends);
  const ended = endHpMaxAdjustmentsWhere(c, (_, i) => indices.has(i));
  const left = hpMaxAdjustments(ended.character);
  const inEffect = left.length ? ` (in effect: ${left.map(hpMaxAdjustmentLabel).join(', ')})` : '';
  const notFound = missing.map((given) => warning(`No Hit Point maximum adjustment named "${given}"${inEffect}.`));
  return { character: ended.character, events: [...ended.events, ...notFound] };
}

/**
 * The entries of hpMaxAdjustments (by index) each name finds, and the names (as the engine writes them) that find none.
 * A name finds the entries named exactly; else a bare name finds those for the same spell or effect ("Aid" finds "Aid
 * (3rd level)") and a qualified one the bare entry ("Aid (2nd level)" finds "Aid"), never another qualifier's ("Bite
 * (Otyugh)" doesn't find "Bite (Vampire Spawn)", another creature's).
 */
export function findHpMaxAdjustments(c: Pick<Character, 'hpMaxAdjustments'>, names: string | readonly string[], ends?: HpMaxEnds): { indices: Set<number>; missing: string[] } {
  const list = hpMaxAdjustments(c);
  const indices = new Set<number>();
  const missing: string[] = [];
  for (const name of typeof names === 'string' ? [names] : names) {
    const given = adjustmentName(name);
    const where = (keyOf: (n: string) => string, key: string) =>
      given ? list.flatMap((a, i) => ((!ends || a.ends === ends) && keyOf(a.name) === key ? [i] : [])) : [];
    const exact = where(nameKey, nameKey(given));
    const base = splitQualifier(given)?.base;
    const found = exact.length ? exact : base ? where(nameKey, nameKey(base)) : where(effectKey, effectKey(given));
    if (!found.length) missing.push(given);
    for (const i of found) indices.add(i);
  }
  return { indices, missing };
}

/**
 * Take `shortfall` off the newest reductions, an effect's before a lasting one's (a ruling is part of the hero's own
 * maximum, and outlasts the effect that ran it into 0), so the records still add up to a maximum held at 0.
 */
function absorbShortfall(list: readonly (HpMaxAdjustment | null)[], shortfall: number): (HpMaxAdjustment | null)[] {
  const next: (HpMaxAdjustment | null)[] = [...list];
  let left = shortfall;
  for (const lasting of [false, true]) {
    for (let j = next.length - 1; j >= 0 && left > 0; j -= 1) {
      const x = next[j];
      if (!x || x.amount >= 0 || (x.ends === 'never') !== lasting) continue;
      const take = Math.min(left, -x.amount);
      left -= take;
      next[j] = x.amount + take === 0 ? null : { ...x, amount: x.amount + take };
    }
  }
  return next;
}

/**
 * End every adjustment that passes `test` (given each entry of hpMaxAdjustments and its index), giving back exactly what
 * each changed: every reduction first (a lasting one taken back too), then the effects' raises, then lasting raises, so
 * ending a drain or a ruling together with Aid never dips the maximum.
 * - A reduction ending raises the maximum only: "returns to normal" doesn't heal.
 * - A raise ending lowers current HP only to fit. If that leaves a maximum of 0 (Aid ending under a bigger curse), the
 *   hero dies, and the shortfall comes off the newest reductions left (absorbShortfall), so ending them later gives back
 *   the hero's own maximum.
 * - A lasting entry is taken back as bookkeeping (current HP moves with it; a hero at 0 stays at 0), never below 1.
 * On the dead it is bookkeeping only: how a hero drained to 0 gets a maximum back. They stay dead. When nothing ends (a
 * lasting entry that stays), the character comes back unchanged, with the warnings.
 */
export function endHpMaxAdjustmentsWhere(c: Character, test: (a: HpMaxAdjustment, index: number) => boolean): EngineResult {
  const all = hpMaxAdjustments(c);
  const rank = (a: HpMaxAdjustment) => (a.amount < 0 ? 0 : a.ends === 'never' ? 2 : 1);
  const order = all.flatMap((a, i) => (test(a, i) ? [i] : [])).sort((i, j) => rank(all[i]) - rank(all[j]) || i - j);
  if (!order.length) return { character: c, events: [] };
  // The entries as they stand: null once ended; a reduction shrinks when a shortfall comes off it.
  let list: (HpMaxAdjustment | null)[] = [...all];
  let character = c;
  const events: GameEvent[] = [];
  const setHp = (max: number, current: number) => {
    character = { ...character, hp: { ...character.hp, max, current } };
  };
  for (const i of order) {
    const a = list[i];
    if (!a) continue;
    const label = `${a.name} ${formatModifier(a.amount)}`;
    const { max, current } = character.hp;
    const after = max - a.amount;
    const hpText = (now: number) => (now !== current ? `, HP ${current} → ${now}` : '');
    if (a.ends === 'never') {
      if (after < 1) {
        events.push(warning(`${label} stays: taking it back would leave a Hit Point maximum below 1.`));
        continue;
      }
      const now = current > 0 ? clamp(current - a.amount, 1, after) : 0;
      list[i] = null;
      setHp(after, now);
      events.push(gameEvent('hp-changed', `${label} taken back: HP maximum ${max} → ${after}${hpText(now)}`));
      continue;
    }
    list[i] = null;
    if (after > 0) {
      const now = Math.min(current, after);
      setHp(after, now);
      events.push(gameEvent('hp-changed', `${label} ends: HP maximum ${max} → ${after}${hpText(now)}`));
      continue;
    }
    // A raise ending at a maximum of 0 or less: the shortfall comes off the reductions left, so the records still add up
    // to the maximum.
    list = absorbShortfall(list, -after);
    if (character.deathSaves.dead) {
      setHp(0, 0);
      events.push(gameEvent('hp-changed', `${label} ends: HP maximum ${max} → 0`));
      continue;
    }
    const died = dieAtMaxZero(character, `${label} ends: HP maximum ${max} → 0 — a creature dies if its Hit Point maximum reaches 0.`);
    character = died.character;
    events.push(...died.events);
  }
  if (events.every((e) => e.type === 'warning')) return { character: c, events };
  return { character: touch(withAdjustments(character, list.filter((x): x is HpMaxAdjustment => x !== null))), events };
}

/**
 * The damage a hit deals the hero after the Defenses (Immunity 0, then Resistance halves, then Vulnerability doubles;
 * SRD 5.2.1 Order of Application): what a drain lowers the maximum by. Temporary HP don't lower it (damage they absorb is
 * still damage taken), nor does damage past 0 HP. 0 for the dead.
 */
export function damageTaken(c: Character, amount: number, damageType?: string): number {
  const raw = Math.max(0, toInt(amount));
  if (raw === 0 || c.deathSaves.dead) return 0;
  return adjustForDefenses(c, raw, damageType).amount;
}

/**
 * Why a draining hit can't go under the name `drain`, or null: a blank name, or one another change already holds
 * (hpMaxNameProblem). applyDrainingDamage then refuses the hit whole, so its damage never lands without its drain. The
 * hit applies before hp_max_end, so the holder can only be ended in an earlier call; a name of its own comes first, as
 * ending a reduction a curse or poison keeps (SRD 5.2.1 Death Dog, Mummy) would give back what it still holds down. The
 * example (SRD 5.2.1 Wight: "Life Drain") is left out when an entry already goes by it.
 */
export function drainProblem(c: Pick<Character, 'hpMaxAdjustments'>, drain: string): string | null {
  const name = adjustmentName(drain);
  if (!name) return 'A drain needs a name (the effect, as in "Life Drain").';
  const list = hpMaxAdjustments(c);
  const held = hpMaxNameHolder(list, name, -1, 'long-rest');
  if (!held) return null;
  const example = 'Life Drain (Wight)';
  const asIn = list.some((a) => nameKey(a.name) === nameKey(example)) ? '' : ` (as in "${example}")`;
  return `${hpMaxAdjustmentLabel(held.entry)} goes by that name: give the drain a name of its own${asIn}, or end that one in an earlier call (hp applies before hp_max_end).`;
}

/**
 * Damage that also lowers the Hit Point maximum by the damage taken, under the name `drain` (a Wraith's Life Drain,
 * Harm): applyDamage first, so massive damage and damage at 0 HP are judged on the maximum before the drain; then, if the
 * hero lives, adjustHpMax until a Long Rest (SRD 5.2.1 Long Rest: "If your Hit Point maximum was reduced, it returns to
 * normal"). A name the drain can't take (drainProblem) refuses the hit whole.
 */
export function applyDrainingDamage(c: Character, amount: number, opts: { critical?: boolean; damageType?: string; drain: string }): EngineResult {
  const problem = drainProblem(c, opts.drain);
  if (problem) return unchanged(c, `${problem} This hit wasn't applied (neither its damage nor its drain).`);
  const hit = applyDamage(c, amount, { critical: opts.critical, damageType: opts.damageType });
  const taken = damageTaken(c, amount, opts.damageType);
  if (taken === 0 || hit.character.deathSaves.dead) return hit;
  const drained = adjustHpMax(hit.character, { name: opts.drain, change: -taken, ends: 'long-rest' });
  return { character: drained.character, events: [...hit.events, ...drained.events] };
}

/**
 * Change the Initiative bonus beyond Dexterity by `delta` (update_character initiative_change): a ruling, or an Alert the
 * app didn't count. Always a change, never a total, so Alert's share stays and level-ups keep growing it.
 */
export function changeInitiativeBonus(c: Character, delta: number): EngineResult {
  const d = toInt(delta);
  if (d === 0) return { character: c, events: [] };
  const character = touch({ ...c, initiativeBonusExtra: toInt(c.initiativeBonusExtra) + d });
  return { character, events: [gameEvent('combat', `Initiative ${formatModifier(initiativeModifier(c))} → ${formatModifier(initiativeModifier(character))}`)] };
}

// ---------------------------------------------------------------------------
// Conditions and exhaustion
// ---------------------------------------------------------------------------

/**
 * Add a condition (no duplicates; refreshes source/duration). Use changeExhaustion for exhaustion —
 * adding "Exhaustion" here is forwarded to it (gaining `level` levels, default 1). Standard names and
 * simple aliases ("knocked prone") map to standard ids; anything else is kept as a homebrew condition.
 * Incapacitating conditions end Concentration.
 */
export function addCondition(c: Character, condition: ActiveCondition): EngineResult {
  const raw = String(condition.id ?? '').trim();
  if (!raw) return unchanged(c, 'A condition needs a name.');
  const standard = matchStandardCondition(raw);
  if (standard?.id === 'exhaustion') return changeExhaustion(c, Math.max(1, toInt(condition.level, 1)));
  if (c.deathSaves.dead) return unchanged(c, "The dead don't gain conditions.");
  if (standard?.id === 'poisoned' && hasCondition(c, 'petrified')) return unchanged(c, 'Petrified creatures have Immunity to the Poisoned condition.');
  const immuneKey = (standard?.id ?? raw).toLowerCase();
  if ((c.conditionImmunities ?? []).some((x) => x.trim().toLowerCase() === immuneKey)) {
    return unchanged(c, `Immune to the ${conditionName(standard?.id ?? raw)} condition.`);
  }

  const id = standard?.id ?? raw;
  const entry: ActiveCondition = { ...condition, id };
  if (standard?.detail && !entry.source) entry.source = standard.detail;
  const key = conditionKey(id);
  const index = c.conditions.findIndex((x) => conditionKey(x.id) === key);
  const conditions = index >= 0 ? c.conditions.map((x, i) => (i === index ? entry : x)) : [...c.conditions, entry];

  const details = [entry.duration, entry.source].filter((d): d is string => !!d?.trim()).join(', ');
  const name = conditionName(id);
  const info = standard ? CONDITIONS[standard.id].summary : '';
  const message = `${index >= 0 ? 'Refreshed' : 'Now'} ${name}${details ? ` (${details})` : ''}${info ? ` — ${info}` : ''}`;
  let next: EngineResult = { character: { ...c, conditions }, events: [gameEvent('condition-added', message)] };
  if (INCAPACITATING_CONDITIONS.has(key)) {
    const ended = endConcentration(next.character, name);
    next = { character: ended.character, events: [...next.events, ...ended.events] };
  }
  return { character: touch(next.character), events: next.events };
}

/**
 * Remove a condition by id or name. Removing "Exhaustion" clears every level (use changeExhaustion to
 * lower it by one). When Unconscious ends the character remains Prone (SRD 5.2.1).
 */
export function removeCondition(c: Character, conditionId: string): EngineResult {
  const raw = String(conditionId ?? '').trim();
  if (!raw) return unchanged(c, 'Which condition should be removed?');
  const exactKey = conditionKey(raw);
  const standard = c.conditions.some((x) => conditionKey(x.id) === exactKey) ? null : matchStandardCondition(raw);
  if (standard?.id === 'exhaustion') {
    return exhaustionLevel(c) > 0 ? changeExhaustion(c, -exhaustionLevel(c)) : unchanged(c, 'No Exhaustion to remove.');
  }
  const key = standard ? standard.id : exactKey;
  if (!c.conditions.some((x) => conditionKey(x.id) === key)) return unchanged(c, `Not ${conditionName(key)} — nothing to remove.`);
  if (key === 'unconscious' && c.hp.current <= 0 && c.hp.max > 0 && !c.deathSaves.dead) {
    return unchanged(c, 'At 0 HP a character stays Unconscious until they regain Hit Points — heal them instead.');
  }

  let conditions = withoutCondition(c.conditions, key);
  let message = `No longer ${conditionName(key)}.`;
  if (key === 'unconscious' && !c.conditions.some((x) => conditionKey(x.id) === 'prone')) {
    conditions = withCondition(conditions, { id: 'prone', source: 'Was unconscious' });
    message += ' Still Prone (standing up costs half your Speed).';
  }
  return { character: touch({ ...c, conditions }), events: [gameEvent('condition-removed', message)] };
}

/** Change exhaustion by delta, clamped 0–6. Reaching 6 = death (2024). */
export function changeExhaustion(c: Character, delta: number): EngineResult {
  const d = toInt(delta);
  if (d === 0) return { character: c, events: [] };
  if (c.deathSaves.dead) return unchanged(c, 'Already dead.');
  const before = exhaustionLevel(c);
  const after = clamp(before + d, 0, 6);
  if (after === before) return unchanged(c, before === 0 ? 'No Exhaustion to remove.' : `Exhaustion is already ${before}.`);
  if (after === 6) {
    return die(
      { ...c, exhaustion: 6, hp: { ...c.hp, temp: 0 } },
      { ...c.deathSaves, stable: false, dead: true },
      `Exhaustion ${before} → 6 — dies of exhaustion.`,
    );
  }
  const effect = after > 0 ? ` (${MINUS}${2 * after} to D20 Tests, ${MINUS}${5 * after} ft Speed)` : ' — no longer exhausted';
  return {
    character: touch({ ...c, exhaustion: after }),
    events: [gameEvent('exhaustion-changed', `Exhaustion ${before} → ${after}${effect}`)],
  };
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

function rechargeText(uses: FeatureUses): string {
  switch (uses.recharge) {
    case 'short':
      return 'recharges on a Short or Long Rest';
    case 'long':
      return 'recharges on a Long Rest';
    case 'dawn':
      return 'recharges at dawn';
    case 'turn':
      return 'recharges each turn';
    default:
      return "doesn't recharge";
  }
}

const featureName = (f: Feature) => f.name;

/** Find a feature by (fuzzy, case-insensitive) name. */
export function findFeature(c: Character, name: string): Feature | undefined {
  return matchByName(c.features, name, featureName).match;
}

function replaceFeature(c: Character, feature: Feature): Character {
  return touch({ ...c, features: c.features.map((f) => (f.id === feature.id ? feature : f)) });
}

/** "Lantern Luck (Mothkin)": the name before its last parentheses and the words in them (nested ones kept), or null. */
function splitQualifier(text: string): { base: string; words: string } | null {
  const s = text.trim();
  if (!s.endsWith(')')) return null;
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i -= 1) {
    if (s[i] === ')') depth += 1;
    if (s[i] !== '(') continue;
    depth -= 1;
    if (depth > 0) continue;
    const base = s.slice(0, i).trim();
    const words = s.slice(i + 1, -1).trim();
    return base && words ? { base, words } : null;
  }
  return null;
}

/**
 * The features named `name` exactly; else, for "Lantern Luck (Mothkin)", those named "Lantern Luck" whose source
 * ("feat", "species") or source name ("Mothkin"; "Ability Score Improvement" for "Ability Score Improvement (Fighter
 * 8)") the parentheses give: how the DM picks one of several features of one name.
 */
function namedFeatures(c: Character, name: string): Feature[] {
  const exact = c.features.filter((f) => nameKey(f.name) === nameKey(name));
  const split = exact.length ? null : splitQualifier(name);
  if (!split) return exact;
  const words = nameKey(split.words);
  const same = c.features.filter((f) => nameKey(f.name) === nameKey(split.base));
  const exactly = same.filter((f) => nameKey(f.source) === words || nameKey(f.sourceName ?? '') === words);
  return exactly.length ? exactly : same.filter((f) => nameKey(f.sourceName ?? '').startsWith(`${words}-`));
}

/**
 * A feature by name (namedFeatures, else matchByName). Of several of that name (a feat beside the trait it's named
 * like, a Repeatable feat taken twice): the first whose uses pass the first test in `fits`, else the next test, else
 * the first with uses, else the first.
 */
function featureByName(c: Character, name: string, fits: ReadonlyArray<(uses: FeatureUses) => boolean>): NameMatch<Feature> {
  const named = namedFeatures(c, name);
  const found: NameMatch<Feature> = named.length ? { match: named[0], candidates: named } : matchByName(c.features, name, featureName);
  if (!found.match || found.candidates.length < 2) return found;
  for (const fit of fits) {
    const match = found.candidates.find((f) => f.uses && fit(f.uses));
    if (match) return { ...found, match };
  }
  return { ...found, match: found.candidates.find((f) => f.uses) ?? found.match };
}

/**
 * A feature's name with what tells it from the others of its name in `features`, as features_use and features_restore
 * take it: its source name when theirs differ ("Lantern Luck (Mothkin)"), else its source ("Lantern Luck (feat)"),
 * else the name alone.
 */
export function featureLabel(f: Feature, features: readonly Feature[]): string {
  const others = features.filter((o) => o.id !== f.id && nameKey(o.name) === nameKey(f.name));
  if (!others.length) return f.name;
  const sourceName = f.sourceName?.trim();
  if (sourceName && others.every((o) => nameKey(o.sourceName ?? '') !== nameKey(sourceName))) return `${f.name} (${sourceName})`;
  return others.every((o) => o.source !== f.source) ? `${f.name} (${f.source})` : f.name;
}

/**
 * After a use or restore by a name other features with uses share, the label of the one changed and a sentence on how
 * to name the others (by featureLabel); the plain name and no sentence when the DM's name matched no other with uses
 * (`matched`: a name in parentheses that picks one) or no label differs. A name in parentheses that two share
 * ("Wick Tender (feat)" for two takings) gets the label and the sentence, as the bare name does.
 */
function namesakes(c: Character, matched: readonly Feature[], feature: Feature, verb: string): { label: string; note: string } {
  const others = c.features
    .filter((f) => f.id !== feature.id && f.uses && nameKey(f.name) === nameKey(feature.name))
    .map((f) => featureLabel(f, c.features))
    .filter((label) => label !== feature.name);
  if (!others.length || !matched.some((f) => f.id !== feature.id && f.uses)) return { label: feature.name, note: '' };
  const named = others.map((label) => `"${label}"`).join(' or ');
  const note = others.length === 1 ? ` Another ${feature.name} is on the sheet: to ${verb} it, name it ${named}.` : ` Other ${feature.name} features are on the sheet: to ${verb} one, name it ${named}.`;
  return { label: featureLabel(feature, c.features), note };
}

/** Use `amount` (default 1) uses of a limited-use feature. Warns if not enough uses remain. */
export function useFeature(c: Character, name: string, amount = 1): EngineResult {
  const n = Math.max(1, toInt(amount, 1));
  const found = featureByName(c, name, [(u) => u.max - u.used >= n, (u) => u.used < u.max]);
  const feature = found.match;
  if (!feature) return unchanged(c, lookupProblem('feature', name, found, featureName));
  if (!feature.uses) return unchanged(c, `${feature.name} has no limited uses to spend.`);
  const left = feature.uses.max - feature.uses.used;
  if (n > left) return unchanged(c, `Not enough uses of ${feature.name}: ${left} of ${feature.uses.max} left, ${n} needed.`);
  const uses = { ...feature.uses, used: feature.uses.used + n };
  const { label, note } = namesakes(c, found.candidates, feature, 'use');
  return {
    character: replaceFeature(c, { ...feature, uses }),
    events: [gameEvent('feature-used', `Used ${label}${n > 1 ? ` ×${n}` : ''} (${uses.max - uses.used}/${uses.max} left; ${rechargeText(uses)})${note ? `.${note}` : ''}`)],
  };
}

/** Restore all uses of a feature (or `amount` uses). */
export function restoreFeature(c: Character, name: string, amount?: number): EngineResult {
  const want = amount === undefined ? 1 : Math.max(1, toInt(amount, 1));
  const found = featureByName(c, name, [(u) => u.used >= want, (u) => u.used > 0]);
  const feature = found.match;
  if (!feature) return unchanged(c, lookupProblem('feature', name, found, featureName));
  if (!feature.uses) return unchanged(c, `${feature.name} has no limited uses to restore.`);
  if (feature.uses.used === 0) return unchanged(c, `${feature.name} is already fully available (${feature.uses.max}/${feature.uses.max}).`);
  const used = amount === undefined ? 0 : Math.max(0, feature.uses.used - want);
  const uses = { ...feature.uses, used };
  const regained = feature.uses.used - used;
  const { label, note } = namesakes(c, found.candidates, feature, 'restore');
  return {
    character: replaceFeature(c, { ...feature, uses }),
    events: [gameEvent('feature-restored', `${label}: regained ${regained} use${regained === 1 ? '' : 's'} (${uses.max - used}/${uses.max})${note ? `.${note}` : ''}`)],
  };
}

/**
 * The side of the feat line a feature's source puts it on: a feat, or a species trait or class or subclass feature.
 * A background's feature, a boon, an item's, homebrew and the DM's other entries are on neither.
 */
export function featOrTrait(source: FeatureSource): 'feat' | 'trait' | undefined {
  if (source === 'feat') return 'feat';
  return source === 'species' || source === 'class' || source === 'subclass' ? 'trait' : undefined;
}

/**
 * The feat of this name on a sheet, whose numbers the builder, levelUp and addFeature keep: a feature of the name on the
 * feat's side of the feat line or on neither (featOrTrait), the one the level-up panel counts as the feat. A species
 * trait, class or subclass feature or transformation power of the name isn't it, and brings none of them.
 */
export function isFeatNamed(f: Pick<Feature, 'name' | 'source'>, feat: string): boolean {
  return nameKey(f.name) === nameKey(feat) && featOrTrait(f.source) !== 'trait' && f.source !== 'transformation';
}

/** The Alert feat (isFeatNamed), whose Initiative bonus the sheet stores. */
export const isAlertFeat = (f: Pick<Feature, 'name' | 'source'>): boolean => isFeatNamed(f, 'Alert');

/** The Tough feat (isFeatNamed), whose Hit Points the sheet stores. */
export const isToughFeat = (f: Pick<Feature, 'name' | 'source'>): boolean => isFeatNamed(f, 'Tough');

/**
 * What the sheet stores for a feat it comes to hold outside a level-up (addFeature: the DM's features_add; levelUp counts
 * its own, the panel's pick and a level_up extra), from the features before and after: Alert's Proficiency Bonus on
 * Initiative when it first holds the Alert feat, by an entry added or one rewritten into it (SRD 5.2.1 Alert: "When you
 * roll Initiative, you can add your Proficiency Bonus to the roll"; isAlertFeat), and, when it first holds the Tough feat
 * (isToughFeat), the twice-the-level Hit Points levelUp gives Tough when it's gained (progression.ts featureHpBonuses),
 * current HP moving with the maximum as for Constitution (a hero at 0 HP stays at 0). Later levels add theirs at
 * level-up; nothing takes them back.
 */
function joiningNumbers(before: Character, after: Character): EngineResult {
  let character = after;
  const events: GameEvent[] = [];
  const level = characterLevel(before);
  if (!before.features.some(isAlertFeat) && after.features.some(isAlertFeat)) {
    const pb = proficiencyBonus(level);
    character = { ...character, initiativeBonusExtra: toInt(before.initiativeBonusExtra) + pb };
    events.push(gameEvent('combat', `Initiative ${formatModifier(initiativeModifier(before))} → ${formatModifier(initiativeModifier(character))} (Alert: Proficiency Bonus ${formatModifier(pb)})`));
  }
  if (!before.features.some(isToughFeat) && after.features.some(isToughFeat)) {
    const max = before.hp.max + 2 * level;
    character = { ...character, hp: { ...character.hp, max, current: before.hp.current > 0 ? before.hp.current + 2 * level : 0 } };
    events.push(gameEvent('hp-changed', `HP maximum ${before.hp.max} → ${max} (Tough: twice your level, ${level})`));
  }
  return { character, events };
}

/** A feat whose numbers the sheet stores (joiningNumbers): the Alert or Tough feat. */
const storesNumbers = (f: Pick<Feature, 'name' | 'source'>): boolean => isAlertFeat(f) || isToughFeat(f);

/**
 * The feature addFeature rewrites for an entry of this name and source: the first of its name on the same side of the
 * feat line, or on either for an entry on neither (featOrTrait). Undefined when it would add one. A transformation's
 * power is the transformation's (transform_character changes it, and its end takes it): another entry of its name joins
 * beside it, as the level-up panel's feat does. A feat whose numbers the sheet stores (Alert, Tough) stays the feat: a
 * species trait or class feature of its name joins beside it too, so its numbers are never left without it, nor paid
 * again when the feat is recorded after.
 */
export function featureToRewrite(c: Character, feature: Pick<Feature, 'name' | 'source'>): Feature | undefined {
  const key = nameKey(feature.name.trim());
  const side = featOrTrait(feature.source);
  return c.features.find((f) => {
    const theirs = featOrTrait(f.source);
    if (nameKey(f.name) !== key || (f.source === 'transformation') !== (feature.source === 'transformation')) return false;
    if (side === 'trait' && storesNumbers(f)) return false;
    return !side || !theirs || side === theirs;
  });
}

/**
 * Add a feature, or update the existing feature with the same name, keeping its id, where it came from (its source
 * name: "Mothkin", "Ability Score Improvement (Fighter 4)", which the DM's "Granted in play" never replaces, so a name
 * a result gave, "Lantern Luck (Mothkin)", still finds it) and the uses it has spent (a features_restore or a rest gives
 * those back). Uses that keep the number keep how it grows (a Rage the DM rewrites still follows the Barbarian table);
 * another number, or uses where it had none, is the DM's ruling (FeatureUses.ruled), which level-ups leave as it is.
 * Beside a namesake, the result names the feature as a use or restore takes it now (featureLabel). A feat and a species
 * trait or class feature never merge (featOrTrait):
 * a feat that shares its name with one (an older book's trait and a book's feat of one name) joins the sheet beside it,
 * and the trait keeps its text. A feature on neither side (the DM's entry for an Epic Boon as a boon, or an Origin feat
 * as its background's) updates the one of its name on either. The sheet coming to hold the Alert or Tough feat gets its
 * numbers (joiningNumbers: Alert's Initiative bonus, Tough's Hit Points); a change that leaves it holding what it held
 * brings none.
 */
export function addFeature(c: Character, feature: Omit<Feature, 'id'> & { id?: string }): EngineResult {
  const name = feature.name?.trim();
  if (!name) return unchanged(c, 'A feature needs a name.');
  const existing = featureToRewrite(c, { name, source: feature.source });
  if (existing) {
    const updated: Feature = { ...existing, ...feature, id: existing.id, name, ...(existing.sourceName ? { sourceName: existing.sourceName } : {}) };
    const old = existing.uses;
    if (feature.uses) {
      const growth = old?.max === feature.uses.max ? { ...(old.scale ? { scale: old.scale } : {}), ...(old.ruled ? { ruled: true } : {}) } : { ruled: true };
      updated.uses = { ...feature.uses, used: Math.min(old?.used ?? feature.uses.used, feature.uses.max), ...growth };
    }
    const character = replaceFeature(c, updated);
    // A trait rewritten by a boon's or other entry of the name is the Alert or Tough feat now (isFeatNamed): it brings its numbers.
    const numbers = joiningNumbers(c, character);
    // By the name a use or restore takes now, beside a namesake (a boon's entry over a trait changes its "(species)").
    return { character: numbers.character, events: [gameEvent('feature-restored', `Updated feature: ${featureLabel(updated, character.features)}`), ...numbers.events] };
  }
  const added: Feature = { ...feature, id: feature.id ?? newId(), name };
  const features = [...c.features, added];
  const usesText = added.uses ? ` (${added.uses.max} use${added.uses.max === 1 ? '' : 's'}, ${rechargeText(added.uses)})` : '';
  const beside = c.features.filter((f) => nameKey(f.name) === nameKey(name)).map((f) => featureLabel(f, features));
  const numbers = joiningNumbers(c, { ...c, features });
  return {
    character: touch(numbers.character),
    events: [gameEvent('feature-restored', `Gained feature: ${name}${usesText}${beside.length ? `, beside ${beside.join(' and ')}` : ''}`), ...numbers.events],
  };
}

export function removeFeature(c: Character, name: string): EngineResult {
  const found = matchByName(c.features, name, featureName);
  const feature = found.match;
  if (!feature) return unchanged(c, lookupProblem('feature', name, found, featureName));
  return {
    character: touch({ ...c, features: c.features.filter((f) => f.id !== feature.id) }),
    events: [gameEvent('feature-used', `Removed feature: ${feature.name}`)],
  };
}

// ---------------------------------------------------------------------------
// Ability scores
// ---------------------------------------------------------------------------

/** The highest an ability score can ever be (SRD 5.2.1 "Ability Scores and Modifiers": 1 to 30). */
export const ABILITY_SCORE_LIMIT = 30;

/**
 * Change one ability score by `change`, never above `max` (20 for Ability Score Improvements and
 * feats, SRD 5.2.1; up to 30 for Epic Boons and transformations) nor below 1. An increase never
 * lowers a score already above the cap (e.g. set by a magic item). A Constitution modifier change
 * also changes the HP maximum by the change for each level (SRD 5.2.1 Gaining a Level: "When your
 * Constitution modifier increases by 1, your Hit Point maximum increases by 1 for each level you
 * have attained"; a decrease mirrors it) — current HP moves with it, and a hero at 0 HP stays at 0.
 * An increase adds exactly that; a loss never takes the hero's own maximum below 1, but one that
 * drains hold near 0 can reach 0 and kill, like Aid ending.
 */
export function changeAbilityScore(c: Character, ability: Ability, change: number, max = 20): EngineResult {
  const before = c.abilityScores[ability];
  const cap = clamp(toInt(max, 20), 1, ABILITY_SCORE_LIMIT);
  const delta = toInt(change);
  const target = delta > 0 ? Math.max(before, Math.min(cap, before + delta)) : Math.max(1, before + delta);
  const name = ABILITY_NAMES[ability];
  if (target === before) {
    return unchanged(c, `${name} is already ${before}${delta > 0 ? ` (the most it can reach here is ${cap})` : ''}.`);
  }
  const events: GameEvent[] = [gameEvent('combat', `${name} ${before} → ${target}`)];
  if (delta > 0 && before + delta > cap) events.push(warning(`${name} is capped at ${cap}.`));
  let character: Character = { ...c, abilityScores: { ...c.abilityScores, [ability]: target } };
  if (ability === 'con') {
    const perLevel = abilityModifier(target) - abilityModifier(before);
    const hpChange = perLevel * characterLevel(c);
    if (hpChange !== 0) {
      const why = `Constitution modifier ${perLevel > 0 ? '+' : ''}${perLevel} per level`;
      // An increase adds exactly hpChange. On a loss the floor of 1 is the hero's own maximum's (lasting entries are part
      // of it); effects in force (Aid, a drain) come on top of it, so their records still add up and ending one gives
      // back exactly its amount. A loss never raises the maximum.
      const adjustments = hpMaxAdjustments(c);
      const effects = adjustments.reduce((sum, a) => sum + (a.ends === 'never' ? 0 : a.amount), 0);
      const maxHp = hpChange > 0 ? c.hp.max + hpChange : Math.min(c.hp.max, Math.max(1, c.hp.max - effects + hpChange) + effects);
      if (maxHp <= 0) {
        // Drains held the maximum within reach of the loss, so it reaches 0 (SRD 5.2.1 Instant Death: "A creature dies if
        // its Hit Point maximum reaches 0"); the shortfall comes off the reductions, so their records still add up.
        const records = absorbShortfall(adjustments, -maxHp).filter((x): x is HpMaxAdjustment => x !== null);
        const zeroed = withAdjustments({ ...character, hp: { ...c.hp, max: 0, current: 0 } }, records);
        if (c.deathSaves.dead) {
          if (c.hp.max !== 0) events.push(gameEvent('hp-changed', `HP maximum ${c.hp.max} → 0 (${why})`));
          return { character: touch(zeroed), events };
        }
        const died = dieAtMaxZero(zeroed, `HP maximum ${c.hp.max} → 0 (${why}) — a creature dies if its Hit Point maximum reaches 0.`);
        return { character: died.character, events: [...events, ...died.events] };
      }
      const current = c.hp.current > 0 ? Math.min(maxHp, Math.max(1, c.hp.current + hpChange)) : 0;
      character = { ...character, hp: { ...c.hp, max: maxHp, current } };
      events.push(gameEvent('hp-changed', `HP maximum ${c.hp.max} → ${maxHp} (${why})`));
    }
  }
  return { character: touch(character), events };
}

/** Gain or spend Heroic Inspiration. You can never have more than one (SRD 5.2.1). */
export function setHeroicInspiration(c: Character, value: boolean): EngineResult {
  if (value === c.heroicInspiration) {
    return unchanged(
      c,
      value
        ? 'Already has Heroic Inspiration — you can only have one (give the new one to an ally who lacks it, or it is lost).'
        : 'No Heroic Inspiration to spend.',
    );
  }
  return {
    character: touch({ ...c, heroicInspiration: value }),
    events: [
      value
        ? gameEvent('feature-restored', 'Gained Heroic Inspiration (spend it to reroll any one die).')
        : gameEvent('feature-used', 'Spent Heroic Inspiration.'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

const itemName = (i: InventoryItem) => i.name;
const MAX_ATTUNED = 3;

/** Options for inventory changes. */
export interface InventoryOptions {
  /** Equipment catalog (BuilderData.equipment) for the AC recompute; the SRD armor table is used without it. */
  catalog?: readonly EquipmentOption[];
}

/**
 * After an inventory change, keep the stored AC in step with worn armor, shields and attuned
 * protection items (syncArmorClass: an AC set by hand is kept, with a warning giving the computed one).
 */
function withArmorClass(before: Character, result: EngineResult, opts: InventoryOptions): EngineResult {
  if (result.character === before) return result;
  const ac = syncArmorClass(before, result.character, opts.catalog ?? []);
  if (ac.character === result.character && ac.events.length === 0) return result;
  return { character: ac.character, events: [...result.events, ...ac.events] };
}

/** Find an inventory item by (fuzzy, case-insensitive) name. */
export function findItem(c: Character, name: string): InventoryItem | undefined {
  return matchByName(c.inventory, name, itemName).match;
}

/**
 * Add an item; stacks onto an existing item with the same name (non-magic, no charges). An item added
 * equipped or attuned updates the AC (see syncArmorClass).
 */
export function addItem(c: Character, item: Omit<InventoryItem, 'id'> & { id?: string }, opts: InventoryOptions = {}): EngineResult {
  const name = item.name?.trim();
  if (!name) return unchanged(c, 'An item needs a name.');
  const quantity = Math.max(1, toInt(item.quantity, 1));
  const stackable = !item.magic && !item.charges;
  const index = stackable
    ? c.inventory.findIndex((i) => nameKey(i.name) === nameKey(name) && !i.magic && !i.charges)
    : -1;
  if (index >= 0) {
    const existing = c.inventory[index];
    const total = existing.quantity + quantity;
    return {
      character: touch({ ...c, inventory: c.inventory.map((i, n) => (n === index ? { ...i, quantity: total } : i)) }),
      events: [gameEvent('item-added', `Added ${quantity} × ${existing.name} (now ${total})`)],
    };
  }
  const added: InventoryItem = { ...item, id: item.id ?? newId(), name, quantity };
  return withArmorClass(
    c,
    {
      character: touch({ ...c, inventory: [...c.inventory, added] }),
      events: [gameEvent('item-added', `Added ${quantity > 1 ? `${quantity} × ` : ''}${name}`)],
    },
    opts,
  );
}

/**
 * Remove `quantity` (default all) of an item. Warns if the item is missing or the quantity is too high.
 * Removing worn armor, a Shield or an attuned protection item updates the AC (see syncArmorClass).
 */
export function removeItem(c: Character, name: string, quantity?: number, opts: InventoryOptions = {}): EngineResult {
  const found = matchByName(c.inventory, name, itemName);
  const item = found.match;
  if (!item) return unchanged(c, lookupProblem('item', name, found, itemName));
  const n = quantity === undefined ? item.quantity : Math.max(1, toInt(quantity, 1));
  if (n > item.quantity) return unchanged(c, `Only ${item.quantity} × ${item.name} — can't remove ${n}.`);
  const left = item.quantity - n;
  const inventory = left > 0 ? c.inventory.map((i) => (i.id === item.id ? { ...i, quantity: left } : i)) : c.inventory.filter((i) => i.id !== item.id);
  return withArmorClass(
    c,
    {
      character: touch({ ...c, inventory }),
      events: [gameEvent('item-removed', `Removed ${n} × ${item.name}${left > 0 ? ` (${left} left)` : ''}`)],
    },
    opts,
  );
}

function describePatch(patch: Partial<Omit<InventoryItem, 'id'>>): string {
  const parts: string[] = [];
  if (patch.name !== undefined) parts.push(`renamed to ${patch.name}`);
  if (patch.quantity !== undefined) parts.push(`quantity ${patch.quantity}`);
  if (patch.equipped !== undefined) parts.push(patch.equipped ? 'equipped' : 'unequipped');
  if (patch.attuned !== undefined) parts.push(patch.attuned ? 'attuned' : 'no longer attuned');
  if (patch.charges !== undefined) parts.push(`charges ${patch.charges.max - patch.charges.used}/${patch.charges.max}`);
  const other = Object.keys(patch).filter((k) => !['name', 'quantity', 'equipped', 'attuned', 'charges'].includes(k));
  if (other.length) parts.push(`${other.join(', ')} changed`);
  return parts.join(', ');
}

/**
 * Patch an item. Setting quantity below 1 removes it. Attuning a 4th item is refused (a creature can
 * be attuned to at most three magic items). Equipping or attuning (or the reverse) updates the AC when
 * it was worked out from gear (see syncArmorClass); an AC set by hand is kept, with a warning.
 */
export function updateItem(
  c: Character,
  name: string,
  patch: Partial<Omit<InventoryItem, 'id'>>,
  opts: InventoryOptions = {},
): EngineResult {
  const found = matchByName(c.inventory, name, itemName);
  const item = found.match;
  if (!item) return unchanged(c, lookupProblem('item', name, found, itemName));
  if (patch.name !== undefined && !patch.name.trim()) return unchanged(c, "An item's name can't be empty.");
  if (patch.attuned && !item.attuned) {
    const attuned = c.inventory.filter((i) => i.attuned).length;
    if (attuned >= MAX_ATTUNED) return unchanged(c, `Already attuned to ${MAX_ATTUNED} magic items — end an Attunement first.`);
  }
  const updated: InventoryItem = { ...item, ...patch, id: item.id, ...(patch.name ? { name: patch.name.trim() } : {}) };
  if (updated.quantity < 1) {
    return withArmorClass(
      c,
      {
        character: touch({ ...c, inventory: c.inventory.filter((i) => i.id !== item.id) }),
        events: [gameEvent('item-removed', `Removed ${item.name} (quantity 0)`)],
      },
      opts,
    );
  }
  const change = describePatch(patch);
  return withArmorClass(
    c,
    {
      character: touch({ ...c, inventory: c.inventory.map((i) => (i.id === item.id ? updated : i)) }),
      events: [gameEvent('item-added', `Updated ${item.name}${change ? `: ${change}` : ''}`)],
    },
    opts,
  );
}

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

type Coin = keyof Currency;
/** Lowest to highest value. */
const COINS: readonly Coin[] = ['cp', 'sp', 'ep', 'gp', 'pp'];
const CP_VALUE: Record<Coin, number> = { cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000 };
/** Breaking one coin gives coins of the next denomination down (electrum breaks into silver). */
const BREAKS_INTO: Partial<Record<Coin, Coin>> = { pp: 'gp', gp: 'sp', ep: 'sp', sp: 'cp' };

function valueInCp(purse: Currency): number {
  return COINS.reduce((sum, coin) => sum + Math.max(0, toInt(purse[coin])) * CP_VALUE[coin], 0);
}

/** Total wealth expressed in gp (fractional). */
export function totalGp(currency: Currency): number {
  return valueInCp(currency) / 100;
}

/** "23 gp, 30 sp, 14 cp" (highest first, zeros omitted). */
export function formatCurrency(currency: Partial<Currency>): string {
  const parts = [...COINS].reverse().flatMap((coin) => {
    const n = toInt(currency[coin]);
    return n ? [`${formatInt(n)} ${coin}`] : [];
  });
  return parts.length ? parts.join(', ') : 'no coins';
}

/** Break the smallest available coin worth more than `target`, cascading down so change comes in natural coins. */
function breakLargerCoin(have: Currency, target: Coin): boolean {
  const source = COINS.find((coin) => CP_VALUE[coin] > CP_VALUE[target] && have[coin] > 0);
  if (!source) return false;
  have[source] -= 1;
  let coin: Coin = source;
  while (coin !== target) {
    const next: Coin = coin === 'gp' && target === 'ep' ? 'ep' : (BREAKS_INTO[coin] as Coin);
    const count = CP_VALUE[coin] / CP_VALUE[next];
    if (next === target) {
      have[next] += count;
      break;
    }
    have[next] += count - 1; // keep the rest as change, break one more
    coin = next;
  }
  return true;
}

/** Pay debts largest coin first; break larger coins when short, else pay with smaller coins. Caller checks affordability. */
function payFrom(purse: Currency, owed: Currency): Currency {
  const have = { ...purse };
  const debt = { ...owed };
  for (const coin of [...COINS].reverse()) {
    while (debt[coin] > 0) {
      if (have[coin] > 0) {
        const pay = Math.min(have[coin], debt[coin]);
        have[coin] -= pay;
        debt[coin] -= pay;
      } else if (!breakLargerCoin(have, coin)) {
        const smaller = BREAKS_INTO[coin];
        if (!smaller) throw new Error('payFrom: unaffordable debt (affordability must be checked first)');
        debt[smaller] += debt[coin] * (CP_VALUE[coin] / CP_VALUE[smaller]);
        debt[coin] = 0;
      }
    }
  }
  return have;
}

/**
 * Add (positive) or spend (negative) coins. When spending, make change automatically from larger
 * denominations (1 pp = 10 gp, 1 gp = 10 sp = 2 ep, 1 sp = 10 cp); with no larger coins left, smaller
 * coins pay instead. Gains in the same delta arrive before paying. Warns and changes nothing if the
 * character cannot afford it.
 */
export function changeCurrency(c: Character, delta: Partial<Currency>): EngineResult {
  const gains: Currency = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
  const costs: Currency = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
  for (const coin of COINS) {
    const n = toInt(delta[coin]);
    if (n > 0) gains[coin] = n;
    else if (n < 0) costs[coin] = -n;
  }
  const gaining = valueInCp(gains) > 0;
  const spending = valueInCp(costs) > 0;
  if (!gaining && !spending) return { character: c, events: [] };

  const purse: Currency = { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 };
  for (const coin of COINS) purse[coin] = Math.max(0, toInt(c.currency[coin])) + gains[coin];
  if (valueInCp(purse) < valueInCp(costs)) {
    return unchanged(
      c,
      `Can't afford ${formatCurrency(costs)} — only ${formatCurrency(c.currency)} (${formatGp(totalGp(c.currency))} gp in all). Nothing was spent.`,
    );
  }
  const after = spending ? payFrom(purse, costs) : purse;
  const what = [gaining ? `gained ${formatCurrency(gains)}` : '', spending ? `spent ${formatCurrency(costs)}` : ''].filter(Boolean).join(', ');
  return {
    character: touch({ ...c, currency: after }),
    events: [gameEvent('currency-changed', `${what.charAt(0).toUpperCase()}${what.slice(1)} — purse: ${formatCurrency(after)}`)],
  };
}

function formatGp(gp: number): string {
  return Number.isInteger(gp) ? String(gp) : gp.toFixed(2);
}

// ---------------------------------------------------------------------------
// Experience
// ---------------------------------------------------------------------------

/** Add XP; reports whether the new total reaches the next level (for XP-based campaigns). */
export function gainXp(c: Character, amount: number): EngineResult & { levelUpAvailable: boolean } {
  const n = toInt(amount);
  const level = characterLevel(c);
  if (n === 0) return { character: c, events: [], levelUpAvailable: levelForXp(c.xp) > level };
  const xp = Math.max(0, toInt(c.xp) + n);
  const reachable = levelForXp(xp);
  const levelUpAvailable = reachable > level && level < 20;
  const next = touch({ ...c, xp });
  const change = n > 0 ? `+${formatInt(n)}` : `${MINUS}${formatInt(-n)}`;
  const tail = levelUpAvailable ? ` — enough for level ${reachable}: level up available!` : '';
  return {
    character: next,
    events: [gameEvent('xp-gained', `${change} XP (${formatInt(xp)} total)${tail}`)],
    levelUpAvailable,
  };
}

// ---------------------------------------------------------------------------
// Spells and concentration
// ---------------------------------------------------------------------------

/** The most likely casting ability for a character without a Spellcasting block: class, else best of INT/WIS/CHA. */
function guessSpellAbility(c: Character): Ability {
  const fromClass = spellcastingAbility(c);
  if (fromClass) return fromClass;
  const mental: Ability[] = ['int', 'wis', 'cha'];
  return mental.reduce((best, a) => (abilityModifier(c.abilityScores[a]) > abilityModifier(c.abilityScores[best]) ? a : best));
}

function ensureSpellcasting(c: Character): Spellcasting {
  return c.spellcasting ?? { ability: guessSpellAbility(c), slots: {}, spells: [], concentratingOn: null };
}

const knownSpellName = (s: KnownSpell) => s.name;

/** Add a spell, or update the known spell with the same name (keeping its id). */
export function addSpell(c: Character, spell: Omit<KnownSpell, 'id'> & { id?: string }): EngineResult {
  const name = spell.name?.trim();
  if (!name) return unchanged(c, 'A spell needs a name.');
  const sc = ensureSpellcasting(c);
  const level = clamp(toInt(spell.level), 0, 9);
  const index = sc.spells.findIndex((s) => nameKey(s.name) === nameKey(name));
  const levelText = level === 0 ? 'cantrip' : `level ${level}`;
  if (index >= 0) {
    const updated: KnownSpell = { ...sc.spells[index], ...spell, id: sc.spells[index].id, name, level };
    const spells = sc.spells.map((s, i) => (i === index ? updated : s));
    return { character: touch({ ...c, spellcasting: { ...sc, spells } }), events: [gameEvent('feature-restored', `Updated spell: ${name} (${levelText})`)] };
  }
  const added: KnownSpell = { ...spell, id: spell.id ?? newId(), name, level };
  return {
    character: touch({ ...c, spellcasting: { ...sc, spells: [...sc.spells, added] } }),
    events: [gameEvent('feature-restored', `Added spell: ${name} (${levelText}${added.prepared ? ', prepared' : ''})`)],
  };
}

export function removeSpell(c: Character, name: string): EngineResult {
  const sc = c.spellcasting;
  if (!sc) return unchanged(c, `No spell named "${name}".`);
  const found = matchByName(sc.spells, name, knownSpellName);
  const spell = found.match;
  if (!spell) return unchanged(c, lookupProblem('spell', name, found, knownSpellName));
  return withoutSpell(c, sc, spell);
}

/**
 * Remove the sheet spell with this id: the sheet's replacements name the exact entry, where removeSpell's name match
 * could take another ("Shield" finding Shield of Faith). Ends Concentration on it, as removeSpell does, unless
 * `keepConcentration`: a spell swapped out of the prepared list (a level's choices, the change after a Long Rest) goes
 * on, for replacing a prepared spell isn't among what breaks Concentration (srd:rule:concentration: Another
 * Concentration Effect, Damage, Incapacitated or Dead). No end event then, and nothing ends with it.
 */
export function removeSpellById(c: Character, id: string, opts: { keepConcentration?: boolean } = {}): EngineResult {
  const sc = c.spellcasting;
  const spell = sc?.spells.find((s) => s.id === id);
  if (!sc || !spell) return unchanged(c, 'That spell is no longer on the sheet.');
  return withoutSpell(c, sc, spell, opts.keepConcentration === true);
}

function withoutSpell(c: Character, sc: Spellcasting, spell: KnownSpell, keepConcentration = false): EngineResult {
  const concentrating = !keepConcentration && sc.concentratingOn && nameKey(sc.concentratingOn) === nameKey(spell.name);
  const spellcasting: Spellcasting = {
    ...sc,
    spells: sc.spells.filter((s) => s.id !== spell.id),
    ...(concentrating ? { concentratingOn: null } : {}),
  };
  const events = [gameEvent('feature-used', `Removed spell: ${spell.name}`)];
  let character: Character = { ...c, spellcasting };
  if (concentrating) {
    events.push(gameEvent('condition-removed', `Concentration on ${spell.name} ends.`));
    const ended = afterConcentrationEnds(character, spell.name);
    character = ended.character;
    events.push(...ended.events);
  }
  return { character: touch(character), events };
}

/**
 * Start (name) or end (null) concentration. Starting a new one ends the previous (srd:rule:concentration, Another
 * Concentration Effect); what ended with it ends too (afterConcentrationEnds). The same spell again changes nothing:
 * the name as given, or the sheet's spell it finds ("Faith" for a Shield of Faith on the sheet is that spell). With
 * `exact`, for a caller that has already decided whether the name is the spell held, only the very name held is the
 * same spell, never the sheet's looser match ("Invisibility" while holding Greater Invisibility is another spell: the
 * one held ends). A new one is recorded in the sheet's spelling only of that very name ("hold person" is Hold
 * Person), else as given ("Invisibility" with only See Invisibility on the sheet is Invisibility; "Fireball" isn't
 * Delayed Blast Fireball).
 */
export function setConcentration(c: Character, spellName: string | null, opts: { exact?: boolean } = {}): EngineResult {
  const current = c.spellcasting?.concentratingOn ?? null;
  const name = spellName?.trim() || null;
  if (name === null) {
    if (!current || !c.spellcasting) return { character: c, events: [] };
    const ended = afterConcentrationEnds({ ...c, spellcasting: { ...c.spellcasting, concentratingOn: null } }, current);
    return { character: touch(ended.character), events: [gameEvent('condition-removed', `No longer concentrating on ${current}.`), ...ended.events] };
  }
  const spells = c.spellcasting?.spells ?? [];
  const found = opts.exact === true ? undefined : matchByName(spells, name, knownSpellName).match;
  if (current && (nameKey(current) === nameKey(name) || (found && nameKey(current) === nameKey(found.name)))) return { character: c, events: [] };
  const label = spells.find((s) => nameKey(s.name) === nameKey(name))?.name ?? name;
  if (c.deathSaves.dead) return unchanged(c, "The dead can't concentrate.");
  const incapacitated = c.conditions.map((x) => conditionKey(x.id)).find((k) => INCAPACITATING_CONDITIONS.has(k));
  if (incapacitated) return unchanged(c, `Can't concentrate while ${conditionName(incapacitated)}.`);
  const sc = ensureSpellcasting(c);
  let character: Character = { ...c, spellcasting: { ...sc, concentratingOn: label } };
  const events: GameEvent[] = [];
  if (current) {
    events.push(gameEvent('condition-removed', `Concentration on ${current} ends (started concentrating on ${label}).`));
    const ended = afterConcentrationEnds(character, current);
    character = ended.character;
    events.push(...ended.events);
  }
  events.push(gameEvent('condition-added', `Concentrating on ${label}.`));
  return { character: touch(character), events };
}

/**
 * The clock (a countdown that ran out at a turn start) or the end of a fight ends the hero's Concentration on `spell`:
 * while the sheet still concentrates on it, it ends with "Concentration on Bless ends: <reason>." and what ends with it
 * (afterConcentrationEnds). Otherwise (the sheet moved on, or the call is repeated) nothing changes.
 */
export function expireConcentration(c: Character, spell: string, reason: string): EngineResult {
  const current = c.spellcasting?.concentratingOn;
  if (!c.spellcasting || !current || typeof spell !== 'string' || nameKey(current) !== nameKey(spell)) return { character: c, events: [] };
  const why = String(reason ?? '').replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
  const ended = afterConcentrationEnds({ ...c, spellcasting: { ...c.spellcasting, concentratingOn: null } }, current);
  return {
    character: touch(ended.character),
    events: [gameEvent('condition-removed', `Concentration on ${current} ends${why ? `: ${why}` : ''}.`), ...ended.events],
  };
}

/** "AC 18 was set by hand for Haste: if it counted Haste, set the AC back to 16 (armor and abilities)." (handSetAcNaming) */
export function handSetAcReminder(c: Character, spell: string, catalog: readonly EquipmentOption[] = []): GameEvent | null {
  const named = handSetAcNaming(c, spell, catalog);
  if (!named) return null;
  return warning(`AC ${named.stored} was set by hand for ${spell}: if it counted ${spell}, set the AC back to ${named.computed} (armor and abilities).`);
}

/**
 * What ends with the hero's Concentration on `spell` (srd:rule:concentration: "If the effect's creator loses
 * Concentration, the effect ends"), for a character that no longer concentrates on it: the Shield of Faith record when
 * it is that spell (the app counted its +2 and takes it off: endAcSpell; no reminder then, for an old save's words kept
 * beside the counted part would ask for the 2 again), else, for any spell, a reminder when the AC was set by hand for
 * it (Haste, Slow, an old save's Shield of Faith with no record), which the app can't take out itself. Never for Mage
 * Armor, which needs no Concentration (srd:spell:mage-armor, Duration: "8 hours"): an older save's Concentration on it
 * ending ends nothing, and its record (if any) stays; it ends on its own end (endAcSpell), a Long Rest or the DM's
 * word. The one helper every path that ends her Concentration goes through: 0 HP, death and an Incapacitating
 * condition (endConcentration), setConcentration, a spell removed, a Long Rest and expireConcentration.
 */
export function afterConcentrationEnds(c: Character, spell: string): EngineResult {
  const acSpell = acSpellNamed(spell);
  if (acSpell === 'Shield of Faith' && acSpells(c).includes('Shield of Faith')) return endAcSpell(c, 'Shield of Faith');
  if (acSpell === 'Mage Armor') return { character: c, events: [] };
  const reminder = handSetAcReminder(c, spell);
  return { character: c, events: reminder ? [reminder] : [] };
}

// ---------------------------------------------------------------------------
// AC from spells (Character.acSpells: Mage Armor, Shield of Faith)
// ---------------------------------------------------------------------------

/** The record list in its stored form: AC_SPELL_NAMES order, absent when empty. */
function withAcSpells(c: Character, list: readonly AcSpellName[]): Character {
  const kept = AC_SPELL_NAMES.filter((n) => list.includes(n));
  const next: Character = { ...c, acSpells: kept };
  if (!kept.length) delete next.acSpells;
  return next;
}

function notAnAcSpell(name: string): string {
  const given = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
  return `The app counts AC only for Mage Armor and Shield of Faith${given ? `, not ${given}` : ''}.`;
}

/** The armor the hero wears, known or not (srd:spell:mage-armor: "a willing creature who isn't wearing armor"). */
function armorWorn(c: Character, catalog: readonly EquipmentOption[]): InventoryItem | undefined {
  return wornArmor(c.inventory, catalog).known.find((w) => w.stats.kind === 'armor')?.item ?? unknownWornArmor(c, catalog);
}

/**
 * A record changed: the AC follows through syncArmorClass, and one plain event says so ("Mage Armor: AC 12 → 15",
 * "Mage Armor ends: AC 15 → 12", "…: AC stays 17"); its warnings stay.
 */
function acSpellChange(before: Character, after: Character, label: string, catalog: readonly EquipmentOption[]): EngineResult {
  const synced = syncArmorClass(before, after, catalog);
  const from = before.armorClass;
  const to = synced.character.armorClass;
  return {
    character: touch(synced.character),
    events: [
      gameEvent('combat', `${label}: ${from === to ? `AC stays ${to}` : `AC ${from} → ${to}`}`),
      ...synced.events.filter((e) => e.type === 'warning'),
    ],
  };
}

/**
 * Record an AC spell on the hero; the AC follows (syncArmorClass): Mage Armor's base 13 + Dexterity, used while no
 * armor is worn and no other base AC is higher (srd:spell:mage-armor; srd:rule:armor-class), Shield of Faith's +2
 * (srd:spell:shield-of-faith). The same spell twice is one record (srd:rule:casting-spells-effects-combining-spell-
 * effects). A name the app doesn't count, one already recorded, and Mage Armor on a hero wearing armor change nothing,
 * with a warning.
 */
export function addAcSpell(c: Character, name: string, catalog: readonly EquipmentOption[] = []): EngineResult {
  const spell = acSpellNamed(name);
  if (!spell) return unchanged(c, notAnAcSpell(name));
  const list = acSpells(c);
  if (list.includes(spell)) return unchanged(c, `${spell} is already recorded.`);
  if (AC_SPELLS[spell].base !== undefined) {
    const armor = armorWorn(c, catalog);
    if (armor) return unchanged(c, `${spell} needs a target who isn't wearing armor: ${c.name.trim() || 'the hero'} wears ${armor.name}.`);
  }
  return acSpellChange(c, withAcSpells(c, [...list, spell]), spell, catalog);
}

/**
 * End a recorded AC spell; the AC follows (syncArmorClass). One that isn't recorded changes nothing, with a warning,
 * and the reminder when the AC was set by hand for it (an old save's "set by the DM: Shield of Faith"): the app can't
 * take it out itself.
 */
export function endAcSpell(c: Character, name: string, catalog: readonly EquipmentOption[] = []): EngineResult {
  const spell = acSpellNamed(name);
  if (!spell) return unchanged(c, notAnAcSpell(name));
  const list = acSpells(c);
  if (!list.includes(spell)) {
    const reminder = handSetAcReminder(c, spell, catalog);
    return { character: c, events: [warning(`${spell} isn't recorded.`), ...(reminder ? [reminder] : [])] };
  }
  return acSpellChange(c, withAcSpells(c, list.filter((n) => n !== spell)), `${spell} ends`, catalog);
}
