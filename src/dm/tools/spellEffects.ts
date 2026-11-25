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
import { namesPhrase } from '@/engine/util';
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

/**
 * A spell's Concentration flag and duration from the rules data the DM may consult (findAllowedEntry, kind 'spell'): by
 * the hero's own copy's id when given (KnownSpell.id is the entry's id when the sheet linked it), else by name.
 */
export async function spellTiming(ctx: ToolContext, name: string, id?: string): Promise<SpellTiming> {
  const campaign = ctx.deps.store().campaign;
  const index = await indexOrNull(ctx);
  if (!index || !campaign) return { found: false };
  const byId = id ? index.get(id) : undefined;
  const entry: CompendiumEntry | undefined = byId?.kind === 'spell' ? byId : findAllowedEntry(index, name, { kind: 'spell', campaign });
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
 * What the DM may need to end with `spell` now that `caster`'s Concentration on it ended (srd:rule:concentration: "If
 * the effect's creator loses Concentration, the effect ends"), as DM-only lines with the exact call. Nothing when
 * nothing matches.
 * 1. Lasting areas on the map that may be the spell's (concentrationAreas): named, never removed.
 * 2. Conditions whose source or duration names it (conditionsNaming), except those the triggering call just added.
 * 3. An NPC's Shield of Faith ending while the hero holds a record she isn't concentrating on: maybe it was the NPC's.
 * 4. An NPC's spell the hero's AC was set by hand for (a Stone Golem's Slow). For the hero's own spells the engine's
 *    end cascade says it (afterConcentrationEnds).
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
    if (areas.length) {
      const one = areas.length === 1;
      const when = caster.hidden ? ` once the player can see ${one ? 'it' : 'them'} go (not during a hidden creature's turn)` : '';
      lines.push(
        `Still on the map: ${areas.map((e) => `${e.label} (${areaPlace(combat, e)})`).join(' · ')} — if ${one ? 'it was' : 'they were'} this spell's, end ${one ? 'it' : 'them'} with update_map effects_end ${labelArray(areas.map((e) => e.label))}${when}.`,
      );
    }
  }
  for (const n of conditionsNaming(spell, hero, combat, skip)) {
    const call = n.isHero ? 'update_character conditions_remove' : 'update_combat conditions';
    lines.push(`${conditionPhrase(n, spell)}: if the spell caused it, remove it with ${call}.`);
  }
  if (!caster.isHero && hero) {
    const concentrating = hero.spellcasting?.concentratingOn;
    if (acSpellNamed(spell) === 'Shield of Faith' && acSpells(hero).includes('Shield of Faith') && !(concentrating && acSpellNamed(concentrating) === 'Shield of Faith')) {
      lines.push(`${heroName}'s Shield of Faith +2: if it was ${caster.name}'s, end it with update_character ac_spells_end ["Shield of Faith"].`);
    }
    const handSet = handSetAcNaming(hero, spell);
    if (handSet) {
      lines.push(`${heroName}'s AC ${handSet.stored} was set by hand for ${spell}: if it counted ${spell}, set armor_class back to ${handSet.computed} (armor and abilities).`);
    }
  }
  return lines;
}

/**
 * For a caster the app stops tracking while its spell may go on (removed from the fight, or still concentrating when
 * the fight ends): each condition that names the spell, to remove when it ends. "Mira Voss is Paralyzed (source: Hold
 * Person): remove it when that spell ends."
 */
export function untilSpellEndsLines(spell: string, hero: Character | null, combat: CombatState | null): string[] {
  return conditionsNaming(spell, hero, combat).map((n) => `${conditionPhrase(n, spell)}: remove it when that spell ends.`);
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
