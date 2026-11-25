/**
 * Spell effects on the DM's side (SPEC §3): the lookups the engine takes as input — a spell's Concentration flag and
 * duration (spellTiming), a stat block's Constitution save (npcSave) — and the DM-only lines that name what may end
 * with a spell (§3.5). The app ends what it can end exactly; what it can only guess at (an area on the map, a condition
 * the spell imposed, an AC set by hand) it names with the exact call, and prints nothing when nothing matches.
 *
 * None of these lines reaches the player's log: an NPC's Concentration is DM knowledge (srd:rule:casting-spells-effects-
 * targets: "Unless a spell has a perceptible effect, a creature doesn't know it was targeted by the spell"). DM text
 * never refers to the hero with a pronoun (amendment 1): the hero's name instead.
 */
import {
  acSpellNamed,
  acSpells,
  concentrationAreas,
  conditionKey,
  conditionName,
  conditionsNaming,
  durationRounds,
  handSetAcNaming,
  matchStandardCondition,
  rectsLabel,
  type AddedCondition,
  type ConditionNaming,
} from '@/engine';
import { matchByName, namesPhrase } from '@/engine/util';
import { isReviewedImport } from '@/data/structured/materialize';
import { nameKey } from '@/lib/id';
import { SRD_SOURCE_ID, type Character, type Combatant, type CombatState, type CompendiumEntry, type MapEffect } from '@/types';
import { dmName } from '../mapText';
import type { ToolContext } from './context';
import { findAllowedEntry } from './rules';

// ---------------------------------------------------------------------------
// Lookups (SPEC §3.1)
// ---------------------------------------------------------------------------

/** What the rules data says of a spell's time: whether it needs Concentration and how long it lasts. */
export interface SpellTiming {
  /** A spell by that id or name is among the sources the DM may consult. */
  found: boolean;
  /** Its name as the rules data spells it. */
  name?: string;
  /** data.concentration, when the data says. */
  concentration?: boolean;
  /** data.duration as written ("Concentration, up to 1 minute"). */
  duration?: string;
  /** The duration in combat rounds (durationRounds), when it is a time span. */
  rounds?: number;
}

async function indexOrNull(ctx: ToolContext) {
  try {
    return await ctx.deps.rulesIndex();
  } catch {
    return null;
  }
}

/** A name's trailing qualifier, as stat blocks and DMs write a casting: "Hold Person (3rd level)" is Hold Person. */
const QUALIFIED = /^(.*\S)\s*\([^()]*\)\s*$/;

/**
 * A spell's Concentration flag and duration from the rules data the DM may consult (findAllowedEntry, kind 'spell'): by
 * the hero's own copy's id when given (KnownSpell.id is the entry's id when the sheet linked it), else by name. A name
 * that finds nothing and ends in a parenthetical ("Hold Person (3rd level)", "Mind Spike (level 4 version)") is looked
 * up without it, so the spell found is recorded by its own name and the cascade matches conditions sourced "Hold Person".
 */
export async function spellTiming(ctx: ToolContext, name: string, id?: string): Promise<SpellTiming> {
  const campaign = ctx.deps.store().campaign;
  const index = await indexOrNull(ctx);
  if (!index || !campaign) return { found: false };
  const byId = id ? index.get(id) : undefined;
  const find = (n: string) => findAllowedEntry(index, n, { kind: 'spell', campaign });
  const bare = QUALIFIED.exec(name)?.[1];
  const entry: CompendiumEntry | undefined = byId?.kind === 'spell' ? byId : (find(name) ?? (bare ? find(bare) : undefined));
  if (!entry || entry.kind !== 'spell') return { found: false };
  const data = entry.data ?? {};
  const duration = typeof data.duration === 'string' && data.duration.trim() ? data.duration.trim() : undefined;
  const rounds = durationRounds(duration);
  return {
    found: true,
    name: entry.name,
    ...(typeof data.concentration === 'boolean' ? { concentration: data.concentration } : {}),
    ...(duration ? { duration } : {}),
    ...(rounds !== undefined ? { rounds } : {}),
  };
}

/** The id of the hero's own copy of a spell (for spellTiming), when the sheet holds it. */
export function knownSpellId(c: Character | null | undefined, spell: string): string | undefined {
  return c?.spellcasting?.spells.find((s) => nameKey(s.name) === nameKey(spell))?.id;
}

/**
 * "Shield doesn't require Concentration (Duration: 1 round).": a spell the rules data says needs no Concentration, or null
 * when the data doesn't know it or doesn't say (those are never refused).
 */
export function noConcentrationText(timing: SpellTiming, spell: string): string | null {
  if (!timing.found || timing.concentration !== false) return null;
  return `${timing.name ?? spell} doesn't require Concentration${timing.duration ? ` (Duration: ${timing.duration})` : ''}.`;
}

/**
 * The hero's Concentration started on a spell the rules data says needs none (update_combat concentrate on the hero,
 * update_character concentration): the refusal, with where its effect goes instead. The name is looked up as given (by
 * the sheet's id only for a spell of exactly that name), so a namesake on the sheet never decides it: Invisibility isn't
 * refused beside the sheet's See Invisibility (srd:spell:invisibility: "Concentration, up to 1 hour"), and Shield is
 * refused beside its Shield of Faith (srd:spell:shield: "Duration: 1 round"). Only a name the rules data doesn't know is
 * read as the sheet's spell it matches ("Faith" for Shield of Faith). Mage Armor's and Shield of Faith's AC the app
 * records (srd:spell:mage-armor: "Duration: 8 hours"); Shield's +5 the DM folds in (srd:spell:shield: "Until the start
 * of your next turn, you have a +5 bonus to AC"). Null when nothing is refused.
 */
export async function heroConcentrationRefusal(ctx: ToolContext, hero: Character | null, spell: string): Promise<string | null> {
  let asked = spell;
  let timing = await spellTiming(ctx, spell, knownSpellId(hero, spell));
  if (!timing.found) {
    const known = hero?.spellcasting ? matchByName(hero.spellcasting.spells, spell, (s) => s.name).match : undefined;
    // The sheet's spell of exactly that name was looked up already (by its id).
    if (known && nameKey(known.name) !== nameKey(spell)) {
      asked = known.name;
      timing = await spellTiming(ctx, asked, known.id);
    }
  }
  const refused = noConcentrationText(timing, asked);
  if (!refused) return null;
  const name = timing.name ?? asked;
  const heroName = hero?.name.trim() || 'The hero';
  const ac = acSpellNamed(name);
  if (ac) return `${refused} Record its AC with update_character ac_spells_add ["${ac}"].`;
  if (nameKey(name) === 'shield') return `${refused} Fold its +5 into the dc of attacks on ${heroName} until the start of ${heroName}'s next turn.`;
  return refused;
}

/** A creature's Constitution saving throw bonus from its stat block, and whether the block has Legendary Resistance. */
export interface NpcSave {
  con?: number;
  legendary: boolean;
}

/**
 * The stat block behind a combatant (statBlockId, else statBlockName) and what its Concentration save needs. Only the
 * SRD's and reviewed imports' numbers are used (as start_combat's): data.savingThrows.con. Reviewed imports carry no
 * saves (src/types/structured.ts MonsterData), and homebrew none, so for them the DM rolls. `legendary`: the block's text
 * has Legendary Resistance (srd:monster:mummy-lord: "If the mummy fails a saving throw, it can choose to succeed
 * instead"), so the creature decides before a failed save ends anything.
 */
export async function npcSave(ctx: ToolContext, c: Combatant): Promise<NpcSave> {
  const campaign = ctx.deps.store().campaign;
  const index = await indexOrNull(ctx);
  if (!index || !campaign) return { legendary: false };
  const byId = c.statBlockId ? index.get(c.statBlockId) : undefined;
  const entry = byId?.kind === 'monster' ? byId : c.statBlockName ? findAllowedEntry(index, c.statBlockName, { kind: 'monster', campaign }) : undefined;
  if (!entry || entry.kind !== 'monster') return { legendary: false };
  const legendary = /legendary resistance/i.test(entry.text ?? '');
  if (!(entry.sourceId === SRD_SOURCE_ID || isReviewedImport(entry))) return { legendary };
  const saves = entry.data?.savingThrows;
  const con = saves && typeof saves === 'object' ? (saves as Record<string, unknown>).con : undefined;
  return typeof con === 'number' && Number.isInteger(con) && Math.abs(con) <= 30 ? { con, legendary } : { legendary };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** "1 round", "7 rounds". */
export function roundsText(n: number): string {
  return `${n} round${n === 1 ? '' : 's'}`;
}

/** "3 rounds were left", "1 round was left": the exact count at an end, so a misapplied end can be put right. */
export function wereLeftText(n: number): string {
  return `${roundsText(n)} ${n === 1 ? 'was' : 'were'} left`;
}

/** A span of rounds as the rules write durations: "1 minute", "10 minutes", "1 hour", "1 day", "6 rounds". */
export function spanText(rounds: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (rounds % 14_400 === 0) return unit(rounds / 14_400, 'day');
  if (rounds % 600 === 0) return unit(rounds / 600, 'hour');
  if (rounds % 10 === 0) return unit(rounds / 10, 'minute');
  return roundsText(rounds);
}

/** `["Web", "Webs"]`: labels as a JSON array for the exact call. */
function labelArray(labels: readonly string[]): string {
  return `[${labels.map((l) => JSON.stringify(l)).join(', ')}]`;
}

/** A label as update_map effects_end compares it (battleMap's endEffects, sameText): spaces collapsed, case aside. */
const labelKey = (label: string) => label.replace(/\s+/g, ' ').trim().toLowerCase();

/** "Cultist Fanatic's Constitution save to keep concentration": a Concentration save's purpose, never naming the spell. */
export function concentrationSavePurpose(name: string): string {
  return `${name}'s Constitution save to keep concentration`;
}

/** "is Paralyzed" for a standard condition, `has "Hexed"` for a homebrew one. */
function conditionState(id: string): string {
  const standard = matchStandardCondition(id);
  return standard && standard.id === conditionKey(id) ? `is ${conditionName(id)}` : `has "${id.trim()}"`;
}

/** "Mira Voss is Paralyzed (source: Hold Person)": the field that names the spell. */
function conditionPhrase(n: ConditionNaming, spell: string): string {
  const { source, duration } = n.condition;
  const detail = namesPhrase(source, spell) ? `source: ${source?.trim()}` : `duration: ${duration?.trim() ?? ''}`;
  return `${n.who} ${conditionState(n.condition.id)} (${detail})`;
}

/** Where a lasting area is: "G7:J10", or "15-ft Emanation around Mira Voss" for one that moves with its creature. */
function areaPlace(state: CombatState, e: MapEffect): string {
  const from = e.spec.fromId;
  if (e.spec.shape === 'emanation' && from && state.combatants.some((c) => c.id === from)) {
    return `${e.spec.sizeFt ?? 0}-ft Emanation around ${dmName(state, from)}`;
  }
  return rectsLabel(e.rects) || 'no squares';
}

// ---------------------------------------------------------------------------
// The end cascade (SPEC §3.5)
// ---------------------------------------------------------------------------

/** Who held a spell that ended: an NPC or monster, or the hero (whose combatant id the map knows her by). */
export interface EndingCaster {
  /** The combatant's id (the hero's combatant for the hero); absent outside a fight. */
  id?: string;
  name: string;
  /** Hidden from the player (Combatant.hidden): ending its area now would give its turn away. */
  hidden: boolean;
  isHero: boolean;
}

/**
 * An NPC's `spell` is Shield of Faith and the hero holds a Shield of Faith record the hero isn't concentrating on: the
 * +2 may be that NPC's (the app takes a record the hero concentrates on to be the hero's own casting).
 */
function mayBeOthersShieldOfFaith(spell: string, hero: Character): boolean {
  const concentrating = hero.spellcasting?.concentratingOn;
  return acSpellNamed(spell) === 'Shield of Faith' && acSpells(hero).includes('Shield of Faith') && !(concentrating && acSpellNamed(concentrating) === 'Shield of Faith');
}

/**
 * The areas line: each label once, as the exact call ends every effect its label names (update_map effects_end, by
 * sameText), so a repeated label would be refused. A label that names more than one effect on the map, this spell's or
 * not (two casters of Spirit Guardians, two Darkness spells placed at a point), says so: the call ends them all, and one
 * that isn't this spell's is placed again as a lasting area with no saves rolled for it (its spell didn't end).
 */
function areasLine(combat: CombatState, map: NonNullable<CombatState['map']>, areas: readonly MapEffect[], hidden: boolean): string {
  const one = areas.length === 1;
  const when = hidden ? ` once the player can see ${one ? 'it' : 'them'} go (not during a hidden creature's turn)` : '';
  const labels = areas.map((e) => e.label).filter((label, i, all) => all.findIndex((l) => labelKey(l) === labelKey(label)) === i);
  const shared = labels
    .map((label) => ({ label, n: map.effects.filter((e) => labelKey(e.label) === labelKey(label)).length }))
    .filter((s) => s.n > 1)
    .map((s) => `every area named "${s.label}" (${s.n} on the map)`);
  // Placed again only (lasting), never resolved again: resolve_area's own result asks for saves.
  const also = shared.length
    ? ` — effects_end ends ${shared.join(' and ')}: place again with resolve_area (lasting) any that isn't this spell's, rolling no saves for it`
    : '';
  return `Still on the map: ${areas.map((e) => `${e.label} (${areaPlace(combat, e)})`).join(' · ')} — if ${one ? 'it was' : 'they were'} this spell's, end ${one ? 'it' : 'them'} with update_map effects_end ${labelArray(labels)}${when}${also}.`;
}

/**
 * What the DM may need to end with `spell` now that `caster`'s Concentration on it ended (srd:rule:concentration: "If
 * the effect's creator loses Concentration, the effect ends"), as DM-only lines with the exact call. Nothing when
 * nothing matches.
 * 1. Lasting areas on the map that may be the spell's (concentrationAreas): named, never removed (areasLine).
 * 2. Conditions whose source or duration names it (conditionsNaming), except those the triggering call just added.
 * 3. An NPC's Shield of Faith ending while the hero holds a record the hero isn't concentrating on: maybe it was the
 *    NPC's.
 * 4. An NPC's spell the hero's AC was set by hand for (a Stone Golem's Slow). Not for a spell the hero holds a record of
 *    (step 3, or the record's own end, takes its bonus off). For the hero's own spells the engine's end cascade says it
 *    (afterConcentrationEnds).
 */
export function cascadeLines(
  spell: string,
  caster: EndingCaster,
  hero: Character | null,
  combat: CombatState | null,
  skip: readonly AddedCondition[] = [],
): string[] {
  const lines: string[] = [];
  const heroName = hero?.name.trim() || 'The hero';
  const map = combat?.map;
  if (combat && map && caster.id) {
    const areas = concentrationAreas(map, caster.id, spell);
    if (areas.length) lines.push(areasLine(combat, map, areas, caster.hidden));
  }
  for (const n of conditionsNaming(spell, hero, combat, skip)) {
    const call = n.isHero ? 'update_character conditions_remove' : 'update_combat conditions';
    lines.push(`${conditionPhrase(n, spell)}: if the spell caused it, remove it with ${call}.`);
  }
  if (!caster.isHero && hero) {
    if (mayBeOthersShieldOfFaith(spell, hero)) {
      lines.push(`${heroName}'s Shield of Faith +2: if it was ${caster.name}'s, end it with update_character ac_spells_end ["Shield of Faith"].`);
    }
    const recorded = acSpellNamed(spell);
    const handSet = recorded && acSpells(hero).includes(recorded) ? undefined : handSetAcNaming(hero, spell);
    if (handSet) {
      lines.push(`${heroName}'s AC ${handSet.stored} was set by hand for ${spell}: if it counted ${spell}, set armor_class back to ${handSet.computed} (armor and abilities).`);
    }
  }
  return lines;
}

/**
 * For a caster the app stops tracking while its spell may go on (removed from the fight, or still concentrating when
 * the fight ends): each condition that names the spell, to remove when it ends ("Mira Voss is Paralyzed (source: Hold
 * Person): remove it when that spell ends."), and the hero's Shield of Faith record the caster's own Shield of Faith may
 * be (srd:spell:shield-of-faith: "Duration: Concentration, up to 10 minutes"), to end when that spell ends.
 */
export function untilSpellEndsLines(spell: string, caster: string, hero: Character | null, combat: CombatState | null): string[] {
  const lines = conditionsNaming(spell, hero, combat).map((n) => `${conditionPhrase(n, spell)}: remove it when that spell ends.`);
  if (hero && mayBeOthersShieldOfFaith(spell, hero)) {
    lines.push(`${hero.name.trim() || 'The hero'}'s Shield of Faith +2: if it is ${caster}'s, end it with update_character ac_spells_end ["Shield of Faith"] when that spell ends.`);
  }
  return lines;
}

/** The hero's combatant with its countdown set to `countdown`, or without one (the field removed). */
export function withHeroCountdown(state: CombatState, countdown: { spell: string; roundsLeft: number } | undefined): CombatState {
  const hero = state.combatants.find((c) => c.isPlayer);
  if (!hero) return state;
  const now = hero.concentrationCountdown;
  if (countdown ? now?.spell === countdown.spell && now.roundsLeft === countdown.roundsLeft : now === undefined) return state;
  return {
    ...state,
    combatants: state.combatants.map((c) => {
      if (c.id !== hero.id) return c;
      const next: Combatant = { ...c };
      if (countdown) next.concentrationCountdown = { ...countdown };
      else delete next.concentrationCountdown;
      return next;
    }),
  };
}
