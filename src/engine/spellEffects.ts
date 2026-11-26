/**
 * Spell effects over time, in combat rounds. Pure functions over CombatState and Character:
 * - how long a spell lasts, in rounds (durationRounds), and how the DM reads what is left (roundsLeftText);
 * - Concentration held by NPCs and monsters (Combatant.concentration; the hero's is the sheet's,
 *   Spellcasting.concentratingOn, counted by Combatant.concentrationCountdown), started, switched and ended;
 * - the countdowns that end a spell at its caster's turn start (concentrationTurnStart);
 * - what the DM is told to end with a spell, which the app can't end exactly itself: lasting areas on the map
 *   (concentrationAreas), conditions whose source names it (conditionsNaming), an AC set by hand for it
 *   (handSetAcNaming).
 * Lookups (a spell's duration, a stat block's saves) happen in src/dm and are passed in.
 */
import type { ActiveCondition, BattleMap, Character, Combatant, CombatState, EquipmentOption, MapEffect } from '@/types';
import { nameKey } from '@/lib/id';
import { safeEnd } from '@/lib/text';
import { currentCombatant, findCombatant } from './combat';
import { INCAPACITATING_CONDITIONS, conditionKey, conditionName, matchStandardCondition } from './conditions';
import { computeArmorClass, handSetNames } from './rules';
import { namesSpell } from './util';

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

/**
 * Rounds in each unit of a spell's time span. srd:rule:combat-the-order-of-combat: "A round represents about 6
 * seconds in the game world", so a minute is 10 rounds (derived: the SRD states no conversion), an hour 600 and a day
 * 14,400.
 */
const ROUNDS_PER = { round: 1, minute: 10, hour: 600, day: 14_400 } as const;

/** "1 minute", "Concentration, up to 10 minutes", "Concentration up to 10 minutes", "Up to 8 hours", "10 days". */
const TIME_SPAN = /^(?:concentration,?\s+)?(?:up to\s+)?(\d+)\s+(round|minute|hour|day)s?$/i;

/**
 * A spell's Duration entry as combat rounds (srd:rule:casting-spells-duration: a time span "specifies how long the
 * spell lasts in rounds, minutes, hours, or the like"), or undefined for anything else: Instantaneous, "Until
 * dispelled", "Special", "Instantaneous or 1 hour (see below)", a number in words.
 */
export function durationRounds(duration?: string): number | undefined {
  if (typeof duration !== 'string') return undefined;
  const match = TIME_SPAN.exec(duration.replace(/\s+/g, ' ').trim());
  if (!match) return undefined;
  const rounds = Number(match[1]) * ROUNDS_PER[match[2].toLowerCase() as keyof typeof ROUNDS_PER];
  return Number.isSafeInteger(rounds) && rounds > 0 ? rounds : undefined;
}

/** "1 round left", "7 rounds left"; past 10 rounds in minutes, rounded up: "about 9 minutes left". */
export function roundsLeftText(rounds: number): string {
  const n = Math.max(0, Math.trunc(Number.isFinite(rounds) ? rounds : 0));
  if (n > 10) return `about ${Math.ceil(n / 10)} minutes left`;
  return `${n} round${n === 1 ? '' : 's'} left`;
}

// ---------------------------------------------------------------------------
// NPC and monster Concentration
// ---------------------------------------------------------------------------

/** A creature's Concentration that just ended (or that another spell replaced). */
export interface ConcentrationEnd {
  /** The combatant. */
  id: string;
  name: string;
  /** What it concentrated on (a spell, or another Concentration effect). */
  spell: string;
  /** The rounds the app still counted when it ended (absent when it wasn't counting, or the count ran out). */
  roundsLeft?: number;
  /** The creature is hidden from the player (Combatant.hidden): nothing the player sees may give its turn away. */
  hidden: boolean;
}

export interface NpcConcentrationChange {
  state: CombatState;
  /** Why nothing changed (the hero, a defeated or Incapacitated creature, no such combatant, no spell name). */
  refused?: string;
  /** The Concentration the new spell ended (srd:rule:concentration, Another Concentration Effect). */
  previous?: ConcentrationEnd;
  /** The same spell again: its countdown restarts (srd:rule:casting-spells-effects-combining-spell-effects). */
  recast: boolean;
}

/** The most of a spell's name a record keeps (the normalizer reads 1–80 characters). */
const SPELL_NAME_MAX = 80;

function spellName(spell: unknown): string {
  const flat = typeof spell === 'string' ? spell.replace(/\s+/g, ' ').trim() : '';
  return flat.slice(0, safeEnd(flat, SPELL_NAME_MAX)).trim();
}

/** A positive whole number of rounds, or undefined. */
function positiveRounds(rounds: unknown): number | undefined {
  return typeof rounds === 'number' && Number.isSafeInteger(rounds) && rounds > 0 ? rounds : undefined;
}

/** By id, else by name ("Cultist Fanatic", a unique part of one), as damageCombatant finds its target. */
function combatantNamed(state: CombatState, id: string): Combatant | undefined {
  return state.combatants.find((c) => c.id === id) ?? findCombatant(state, id);
}

function endOf(c: Combatant, held: NonNullable<Combatant['concentration']>, counted: boolean): ConcentrationEnd {
  const roundsLeft = counted ? positiveRounds(held.roundsLeft) : undefined;
  return { id: c.id, name: c.name, spell: held.spell, ...(roundsLeft !== undefined ? { roundsLeft } : {}), hidden: c.hidden === true };
}

/** The state with one combatant's field set to `value`, or removed when undefined. */
function withField<K extends 'concentration' | 'concentrationCountdown'>(
  state: CombatState,
  id: string,
  key: K,
  value: Combatant[K] | undefined,
): CombatState {
  const combatants = state.combatants.map((c) => {
    if (c.id !== id) return c;
    const next: Combatant = { ...c };
    if (value === undefined) delete next[key];
    else next[key] = value;
    return next;
  });
  return { ...state, combatants };
}

/**
 * An NPC or monster starts concentrating on `spell` (or another Concentration effect), counted for `rounds` of its turn
 * starts when given (durationRounds of the spell, or the DM's count). Starting another spell ends the one it held
 * (srd:rule:concentration: "You lose Concentration on an effect the moment you start casting a spell that requires
 * Concentration"): it comes back as `previous`. The same spell again is a recast: the count restarts at `rounds`
 * (none when not given). Refused for the hero, whose Concentration is the sheet's, for a defeated creature, and for one
 * with the Incapacitated condition or one that includes it (srd:rule:concentration: "Your Concentration ends if you
 * have the Incapacitated condition or you die").
 */
export function setNpcConcentration(state: CombatState, id: string, spell: string, rounds?: number): NpcConcentrationChange {
  const c = combatantNamed(state, id);
  if (!c) return { state, refused: `No combatant "${id}".`, recast: false };
  if (c.isPlayer) return { state, refused: `${c.name} is the hero: their Concentration is on the sheet.`, recast: false };
  if (c.defeated) return { state, refused: `${c.name} is defeated and can't start concentrating.`, recast: false };
  const incapacitated = c.conditions.map((x) => conditionKey(x.id)).find((k) => INCAPACITATING_CONDITIONS.has(k));
  if (incapacitated) return { state, refused: `${c.name} can't concentrate while ${conditionName(incapacitated)}.`, recast: false };
  const name = spellName(spell);
  if (!name) return { state, refused: `Name the spell ${c.name} concentrates on.`, recast: false };
  const count = positiveRounds(rounds);
  const held = c.concentration;
  const recast = !!held && nameKey(held.spell) === nameKey(name);
  const record = count === undefined ? { spell: name } : { spell: name, roundsLeft: count };
  if (recast && held.spell === record.spell && held.roundsLeft === record.roundsLeft) return { state, recast };
  const previous = held && !recast ? endOf(c, held, true) : undefined;
  return { state: withField(state, c.id, 'concentration', record), ...(previous ? { previous } : {}), recast };
}

/**
 * An NPC's or monster's Concentration ends: a failed save, 0 HP (srd:rule:damage-and-healing-dropping-to-0-hit-points-
 * instant-death: "A monster dies the instant it drops to 0 Hit Points"), an Incapacitating condition, the DM's word.
 * Nothing changes when it isn't concentrating; a defeated creature's ends too.
 */
export function endNpcConcentration(state: CombatState, id: string): { state: CombatState; ended?: ConcentrationEnd } {
  const c = combatantNamed(state, id);
  if (!c?.concentration) return { state };
  return { state: withField(state, c.id, 'concentration', undefined), ended: endOf(c, c.concentration, true) };
}

/** The hero's side of a turn start: the sheet's Concentration, and its full duration in rounds when known. */
export interface HeroConcentration {
  /** Spellcasting.concentratingOn. */
  spell: string | null;
  /** durationRounds of that spell (or the DM's count), used when the hero's combatant has no countdown for it. */
  rounds?: number;
}

export interface ConcentrationTurn {
  state: CombatState;
  /** NPCs' and monsters' Concentration that ran out. */
  ended: ConcentrationEnd[];
  /** The hero's spell whose time is up: the caller ends it on the sheet (expireConcentration). */
  heroEnded?: string;
}

/**
 * The countdowns at a turn start. A turn started when (round, creature whose turn it is) changed from `before` to
 * `after` (as turnStartReport keys it: a lone creature's next_turn starts its own turn again, in a new round); a
 * defeated creature's turn never starts. createCombat starts no turn, so the first creature of round 1 isn't counted
 * down: a spell it casts then first counts at its round-2 turn start.
 *
 * The countdown is anchored on the caster's turn start: a spell lasting N rounds (srd:rule:casting-spells-duration,
 * srd:rule:combat-the-order-of-combat) cast on its caster's turn ends at the start of that creature's turn N rounds
 * later (Bless, 10 rounds, cast in round 1 ends as its caster's turn starts in round 11). Nothing is counted down at a
 * turn start in round 1: a count there before the caster's first turn (a spell running when the fight starts, or
 * rounds given before that turn) lasts that many of the caster's turns, whether it acts first (round 1's first turn is
 * never started) or not, and a spell cast on the caster's round-1 turn is counted from after that turn start anyway.
 * - An NPC or monster whose Concentration is counted: one fewer, from round 2; at 0 it ends (`ended`).
 * - The hero: no Concentration on the sheet drops the countdown. A countdown for the sheet's spell counts down from
 *   round 2; at 0 it is dropped and the spell comes back as `heroEnded`. Without one (or with one for another spell,
 *   stale), `rounds` starts it lazily; without `rounds` the app doesn't count it. At a turn start in round 1 it starts
 *   at the full `rounds`: a spell already running when the fight starts lasts the hero's first `rounds` turns, whether
 *   the hero acts first (that round-1 turn start is never counted, so the count starts at rounds − 1 at the hero's
 *   round-2 turn start) or not (it starts here, in round 1). Later it starts at rounds − 1: the spell was cast before
 *   this turn start, on the hero's last turn (0 or less ends it). Either way Bless running at start_combat ends as the
 *   hero's turn starts in round 11, and so does Bless given 10 rounds before the hero's first turn.
 */
export function concentrationTurnStart(before: CombatState, after: CombatState, hero: HeroConcentration): ConcentrationTurn {
  const was = currentCombatant(before);
  const now = currentCombatant(after);
  const unchanged: ConcentrationTurn = { state: after, ended: [] };
  if (!now || now.defeated || (before.round === after.round && was?.id === now.id)) return unchanged;
  const firstRound = after.round <= 1;
  if (!now.isPlayer) {
    const held = now.concentration;
    if (!held || held.roundsLeft === undefined || firstRound) return unchanged;
    const left = held.roundsLeft - 1;
    if (left > 0) return { state: withField(after, now.id, 'concentration', { ...held, roundsLeft: left }), ended: [] };
    return { state: withField(after, now.id, 'concentration', undefined), ended: [endOf(now, held, false)] };
  }
  const countdown = now.concentrationCountdown;
  const drop = (): CombatState => (countdown ? withField(after, now.id, 'concentrationCountdown', undefined) : after);
  const spell = typeof hero.spell === 'string' ? hero.spell.trim() : '';
  if (!spell) return { state: drop(), ended: [] };
  if (countdown && nameKey(countdown.spell) === nameKey(spell)) {
    if (firstRound) return unchanged;
    const left = countdown.roundsLeft - 1;
    if (left > 0) return { state: withField(after, now.id, 'concentrationCountdown', { ...countdown, roundsLeft: left }), ended: [] };
    return { state: drop(), ended: [], heroEnded: spell };
  }
  const rounds = positiveRounds(hero.rounds);
  if (rounds === undefined) return { state: drop(), ended: [] };
  const left = firstRound ? rounds : rounds - 1;
  if (left > 0) return { state: withField(after, now.id, 'concentrationCountdown', { spell, roundsLeft: left }), ended: [] };
  return { state: drop(), ended: [], heroEnded: spell };
}

// ---------------------------------------------------------------------------
// What to end with a spell (named for the DM, never ended by the app)
// ---------------------------------------------------------------------------

/**
 * Lasting areas on the map that may be `spell`'s (srd:rule:concentration: "If the effect's creator loses
 * Concentration, the effect ends"): their label names the spell as whole words (a plural "Webs" counts; "Butterfly
 * Swarm" isn't Fly), or the spell without its trailing note (namesSpell: "Spirit Guardians" for a sheet copy's "Spirit
 * Guardians (scroll)"), and they don't come from another creature. The app never removes them: a label isn't an
 * identity, so the DM is told the exact call.
 */
export function concentrationAreas(map: BattleMap | undefined, casterId: string, spell: string): MapEffect[] {
  if (!map) return [];
  return map.effects.filter((e) => e.duration === 'lasting' && !(e.spec.fromId && e.spec.fromId !== casterId) && namesSpell(e.label, spell));
}

/** A condition that names a spell, and on whom. */
export interface ConditionNaming {
  /** The hero's name, or the combatant's. */
  who: string;
  /** On the hero's sheet (not a combatant). */
  isHero: boolean;
  condition: ActiveCondition;
  /** The combatant's id; absent for the hero. */
  combatantId?: string;
}

/** A condition the triggering call itself just added: on the hero's sheet (no combatantId) or on that combatant. */
export interface AddedCondition {
  combatantId?: string;
  /** The condition's id or the name the call gave ("Paralyzed"). */
  condition: string;
}

/** The key a condition name is stored under: the standard id when it is one, else the name (as addCondition stores it). */
function storedKey(condition: string): string {
  return conditionKey(matchStandardCondition(condition)?.id ?? condition);
}

/**
 * Conditions whose `source` or `duration` names `spell` as whole words (case-insensitive), or the spell without its
 * trailing note (namesSpell: a Paralyzed sourced "Hold Person" for a sheet copy's "Hold Person (scroll)"), on the hero
 * (her sheet's conditions) and on each other combatant: the ones the spell may have imposed, which the DM may need to
 * end with it. The conditions the triggering call itself just added are skipped (`skip`: a Paralyzed added by an ally's
 * Hold Person that broke this Hold Person isn't named back).
 */
export function conditionsNaming(
  spell: string,
  hero: Character | null,
  state: CombatState | null,
  skip: readonly AddedCondition[] = [],
): ConditionNaming[] {
  const names = (x: ActiveCondition) => namesSpell(x.source, spell) || namesSpell(x.duration, spell);
  const skipped = (combatantId: string | undefined, x: ActiveCondition) =>
    skip.some((s) => s.combatantId === combatantId && storedKey(s.condition) === conditionKey(x.id));
  const out: ConditionNaming[] = [];
  for (const x of hero?.conditions ?? []) {
    if (names(x) && !skipped(undefined, x)) out.push({ who: hero?.name.trim() || 'The hero', isHero: true, condition: x });
  }
  for (const c of state?.combatants ?? []) {
    // The hero's conditions are the sheet's; her combatant's list stays empty.
    if (c.isPlayer) continue;
    for (const x of c.conditions) if (names(x) && !skipped(c.id, x)) out.push({ who: c.name, isHero: false, condition: x, combatantId: c.id });
  }
  return out;
}

/**
 * The hero's AC was set by hand for `spell` (its formula is "set by the DM: …" and the DM's words name the spell as
 * whole words, or the spell without its trailing note: Haste, Slow, an old save's Shield of Faith or Mage Armor, and
 * "Haste" for a sheet copy's "Haste (scroll)"; handSetNames), so the app can't take the spell back out of it itself:
 * the stored AC and what armor, abilities and the recorded spells give instead. The app's own parts never count ("set
 * by the DM: shrine blessing +1 + Shield of Faith 2" isn't set for Shield of Faith: the app takes that +2 off itself).
 * Undefined otherwise, and when the two are the same (nothing to set back; armor the app can't identify keeps the
 * stored AC).
 */
export function handSetAcNaming(
  c: Character,
  spell: string,
  catalog: readonly EquipmentOption[] = [],
): { stored: number; computed: number } | undefined {
  if (!handSetNames(c.acFormula, spell)) return undefined;
  const computed = computeArmorClass(c, catalog).ac;
  return computed === c.armorClass ? undefined : { stored: c.armorClass, computed };
}
