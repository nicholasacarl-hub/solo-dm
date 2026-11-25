/**
 * Combat tools: the initiative tracker for NPCs and monsters, and the battle map's part in a fight (start_combat
 * with `map`, placing newcomers, the map line after a turn change). The hero's own HP and conditions stay on the
 * character sheet (update_character); the tracker only orders the hero's turn.
 *
 * Hidden creatures (the hero hasn't noticed them) work with or without a map: nothing they do writes a player log
 * line, and the player-facing summaries leave them out (D41). The DM's results name them, tagged "[hidden]".
 *
 * Concentration (spell effects, SPEC §3.2): an NPC's or monster's is DM knowledge, recorded with `concentrate` and
 * counted down at its turn starts; the app rolls its Constitution save against damage and ends it at 0 HP, on an
 * Incapacitating condition, a failed save or when its time is up, naming (never removing) what may end with it. No
 * player log line names its spell. The hero's Concentration is the sheet's: the tracker only counts it down.
 *
 * Writes: every handler does its awaiting first (the initiative roll, the rules index, a save), then writes once —
 * combat changes through mutateCombat against the latest state. Only start_combat creates the row with setCombat
 * (there is no combat yet to update), and end_combat deletes it with setCombat(null). A turn start that ends the
 * hero's spell, and end_combat ending it, write the sheet first, then the combat.
 */
import {
  addCombatant,
  concentrationSaveDC,
  concentrationTurnStart,
  conditionKey,
  conditionName,
  createBattleMap,
  createCombat,
  currentCombatant,
  damageCombatant,
  endNpcConcentration,
  expireConcentration,
  findCombatant,
  gainXp,
  healCombatant,
  healthDescriptor,
  INCAPACITATING_CONDITIONS,
  initiativeModifier,
  matchStandardCondition,
  nextTurn,
  placeCombatants,
  removeCombatant,
  rollD20Test,
  roundsLeftText,
  setNpcConcentration,
  squareLabel,
  statBlockMapStats,
  summarizeCombat,
  updateCombatant,
  xpToNextLevel,
  type AddedCondition,
  type ConcentrationEnd,
  type PlacementAnchor,
  type PlacementRequest,
  type PlacementResult,
} from '@/engine';
import {
  SRD_SOURCE_ID,
  type ActiveCondition,
  type BattleMap,
  type Campaign,
  type Character,
  type Combatant,
  type CombatState,
  type CompendiumEntry,
  type CreatureSize,
  type CreatureSpeeds,
  type D20TestResult,
  type GameEvent,
} from '@/types';
import { isReviewedImport } from '@/data/structured/materialize';
import { nameKey } from '@/lib/id';
import { describeMapSetup, distanceFt, dmName, finalPositions, spaceText, turnStartLine, type MapStatsLine } from '../mapText';
import { battleMapsMode } from '../modes';
import { findAllowedEntry } from './rules';
import type { ToolInput } from './definitions';
import {
  defined,
  eventLines,
  fail,
  keptHomebrewLines,
  logRoll,
  logTool,
  mutateCharacter,
  mutateCombat,
  NO_COMBAT,
  ok,
  requireCampaign,
  requireCharacter,
  ToolInputError,
  type ToolContext,
  type ToolOutcome,
} from './context';
import { parseMapSpec, parsePosition } from './map';
import { performPlayerRoll } from './rolls';
import {
  cascadeLines,
  concentrationSavePurpose,
  heroConcentrationRefusal,
  knownSpellId,
  noConcentrationText,
  npcSave,
  roundsText,
  spanText,
  spellTiming,
  untilSpellEndsLines,
  wereLeftText,
  withHeroCountdown,
  type EndingCaster,
  type SpellTiming,
} from './spellEffects';

type CombatantSpec = ToolInput<'start_combat'>['combatants'][number];

/** "Goblin" ×3 → Goblin 1..3, skipping names already in the fight. */
function groupNames(spec: CombatantSpec, taken: Set<string>): string[] {
  const count = spec.count ?? 1;
  const names: string[] = [];
  if (count === 1 && !taken.has(nameKey(spec.name))) {
    names.push(spec.name);
  } else {
    for (let n = 1; names.length < count; n++) {
      const name = `${spec.name} ${n}`;
      if (!taken.has(nameKey(name))) names.push(name);
    }
  }
  for (const name of names) taken.add(nameKey(name));
  return names;
}

async function statBlockEntry(ctx: ToolContext, name: string | undefined, campaign: Campaign): Promise<CompendiumEntry | undefined> {
  if (!name) return undefined;
  try {
    const index = await ctx.deps.rulesIndex();
    return findAllowedEntry(index, name, { kind: 'monster', campaign });
  } catch {
    return undefined;
  }
}

/** "Bandit 1–2" for a numbered series, else the names. */
function groupLabel(base: string, names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? base;
  const numbers = names.map((n) => (n.startsWith(`${base} `) ? Number(n.slice(base.length + 1)) : NaN));
  const consecutive = numbers.every((v, i) => Number.isInteger(v) && (i === 0 || v === numbers[i - 1] + 1));
  return consecutive ? `${base} ${numbers[0]}–${numbers[numbers.length - 1]}` : names.join(', ');
}

type StatSource = 'given' | 'block' | 'default';

const SOURCE_WORDS: Record<StatSource, string> = { given: 'as given', block: 'from the stat block', default: 'default' };

/** "(stat block)", "(defaults)", "(as given)", or a mix: "size as given, speed from the stat block, reach default". */
function sourceText(size: StatSource, speed: StatSource, reach: StatSource): string {
  if (size === speed && speed === reach) return size === 'block' ? 'stat block' : size === 'default' ? 'defaults' : 'as given';
  return `size ${SOURCE_WORDS[size]}, speed ${SOURCE_WORDS[speed]}, reach ${SOURCE_WORDS[reach]}`;
}

interface Group {
  combatants: Combatant[];
  /** "Goblin ×3: initiative 13 [d20 (11) + 2 = 13]" (+ where the numbers came from). */
  line: string;
  /** Its map stats as the setup result lists them. */
  stats: MapStatsLine;
}

/** A group's stat block and numbers, resolved (and checked) before anyone rolls. */
interface ResolvedGroup {
  spec: CombatantSpec;
  entry?: CompendiumEntry;
  ac: number;
  hpMax: number;
  initiativeBonus: number;
  /** "AC 17, HP 52, initiative +2 from the stat block (The Gloamwood Almanac)" and/or "(the stat block says …)". */
  provenance: string;
}

/** The DM tools' limits (definitions.ts combatantSpec): a stat-block number outside them is never used. */
const NUMBER_RANGES = { ac: [1, 40], hp: [1, 2000], initiative: [-10, 20] } as const;

/** Numbers a stat block supplies: the SRD's and reviewed imports' (spec §6.3); homebrew and unreviewed imports supply none. */
function blockNumbers(entry: CompendiumEntry | undefined): { ac?: number; hp?: number; initiative?: number } {
  if (!entry || !(entry.sourceId === SRD_SOURCE_ID || isReviewedImport(entry))) return {};
  const data = entry.data ?? {};
  const pick = (value: unknown, [min, max]: readonly [number, number]) =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
  return { ac: pick(data.ac, NUMBER_RANGES.ac), hp: pick(data.hp, NUMBER_RANGES.hp), initiative: pick(data.initiative, NUMBER_RANGES.initiative) };
}

const signedText = (n: number) => (n < 0 ? `${n}` : `+${n}`);
const listText = (items: readonly string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * Resolve a group's stat block (`stat_block`, or — only when a number is left out — the group's name without a
 * trailing number) and its numbers: explicit input wins (elites, variants), else the stat block's. Throws the
 * DM-facing error when a number is neither given nor in a stat block. A call that gives all three numbers and no
 * stat_block looks nothing up, as before structured imports.
 */
async function resolveGroup(ctx: ToolContext, spec: CombatantSpec, campaign: Campaign): Promise<ResolvedGroup> {
  const omitted = spec.ac === undefined || spec.hp_max === undefined || spec.initiative_bonus === undefined;
  const lookup = spec.stat_block ?? (omitted ? spec.name.replace(/\s+\d+$/, '').trim() : undefined);
  const entry = await statBlockEntry(ctx, lookup, campaign);
  const block = blockNumbers(entry);
  const ac = spec.ac ?? block.ac;
  const hpMax = spec.hp_max ?? block.hp;
  const initiativeBonus = spec.initiative_bonus ?? block.initiative;
  if (ac === undefined || hpMax === undefined || initiativeBonus === undefined) {
    const missing = [ac === undefined && 'ac', hpMax === undefined && 'hp_max', initiativeBonus === undefined && 'initiative_bonus'].filter(
      (m): m is string => Boolean(m),
    );
    throw new ToolInputError(
      `Give ${listText(missing)} for ${spec.name}: no stat block with ${missing.length > 1 ? 'those numbers' : 'that number'} was found (name one in stat_block, or give the numbers).`,
    );
  }
  const used: string[] = [];
  const differs: string[] = [];
  const note = (given: number | undefined, fromBlock: number | undefined, text: (n: number) => string) => {
    if (given === undefined && fromBlock !== undefined) used.push(text(fromBlock));
    else if (given !== undefined && fromBlock !== undefined && given !== fromBlock) differs.push(text(fromBlock));
  };
  note(spec.ac, block.ac, (n) => `AC ${n}`);
  note(spec.hp_max, block.hp, (n) => `HP ${n}`);
  note(spec.initiative_bonus, block.initiative, (n) => `initiative ${signedText(n)}`);
  const provenance = [
    used.length && entry ? `${used.join(', ')} from the stat block (${entry.sourceName})` : '',
    differs.length ? `(the stat block says ${differs.join(', ')})` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return { spec, ...(entry ? { entry } : {}), ac, hpMax, initiativeBonus, provenance };
}

function buildGroup(ctx: ToolContext, resolved: ResolvedGroup, taken: Set<string>): Group {
  const { spec, entry } = resolved;
  const roll = rollD20Test(resolved.initiativeBonus, {
    advantage: spec.surprised ? 'disadvantage' : 'normal',
    rng: ctx.deps.rng,
  });
  // Map stats: explicit input, then the stat block (D44), then the engine's defaults (Medium, walk 30, reach 5).
  const block = entry ? statBlockMapStats(entry) : {};
  const size: CreatureSize | undefined = spec.size ?? block.size;
  const speeds: CreatureSpeeds | undefined = spec.speeds ?? block.speeds;
  const reachFt = spec.reach_ft ?? block.reachFt;
  const names = groupNames(spec, taken);
  const combatants = names.map(
    (name): Combatant => ({
      id: ctx.deps.newId(),
      name,
      side: spec.side,
      isPlayer: false,
      initiative: roll.total,
      initiativeBonus: resolved.initiativeBonus,
      ac: resolved.ac,
      hp: { max: resolved.hpMax, current: resolved.hpMax, temp: 0 },
      conditions: [],
      defeated: false,
      hideHp: spec.hide_hp ?? spec.side === 'enemy',
      ...defined({ statBlockName: spec.stat_block ?? entry?.name, statBlockId: entry?.id, notes: spec.notes, size, speeds, reachFt }),
      ...(spec.hidden ? { hidden: true } : {}),
    }),
  );
  const label = names.length > 1 ? `${spec.name} ×${names.length}` : names[0];
  const source = (given: unknown, fromBlock: unknown): StatSource => (given !== undefined ? 'given' : fromBlock !== undefined ? 'block' : 'default');
  const stats: MapStatsLine = {
    label: `${spec.hidden ? '[hidden] ' : ''}${groupLabel(spec.name, names)}`,
    size: size ?? 'Medium',
    speeds: speeds ?? { walk: 30 },
    reachFt: reachFt ?? 5,
    source: sourceText(source(spec.size, block.size), source(spec.speeds, block.speeds), source(spec.reach_ft, block.reachFt)),
  };
  const line = `${label}: initiative ${roll.total} [${roll.breakdown}]${resolved.provenance ? ` · ${resolved.provenance}` : ''}`;
  return { combatants, line, stats };
}

function turnLine(state: CombatState): string {
  const current = currentCombatant(state);
  return current ? `Round ${state.round}: ${current.name}'s turn.` : `Round ${state.round}.`;
}

// ---------------------------------------------------------------------------
// start_combat
// ---------------------------------------------------------------------------

type StartInput = ToolInput<'start_combat'>;

/** The map part of start_combat, parsed and checked before anyone rolls (D43). */
interface StartMap {
  map: BattleMap | null;
  heroAnchor: PlacementAnchor | null;
  /** Per input group: where it starts (null: placed automatically). */
  anchors: (PlacementAnchor | null)[];
  /** Notes for the DM: the map was ignored, positions were ignored, the "every fight" nudge. */
  notes: string[];
}

function prepareStartMap(input: StartInput, campaign: Campaign): StartMap {
  const mode = battleMapsMode(campaign.settings);
  const positioned = input.hero_position !== undefined || input.combatants.some((c) => c.position !== undefined);
  const none: StartMap = { map: null, heroAnchor: null, anchors: input.combatants.map(() => null), notes: [] };
  if (input.map && mode === 'off') return { ...none, notes: ['Battle maps are Off in this campaign: the map was ignored.'] };
  if (!input.map) {
    const notes = positioned ? ['No map: positions were ignored.'] : [];
    if (mode === 'always') notes.push('This campaign plays every fight on a battle map: add one with update_map create.');
    return { ...none, notes };
  }
  const map = createBattleMap(parseMapSpec(input.map, 'start_combat'));
  const heroAnchor = input.hero_position !== undefined ? parsePosition(input.hero_position, map, 1, 'start_combat: hero_position') : null;
  if (heroAnchor?.kind === 'squares') throw new ToolInputError('start_combat: hero_position is one square or a place.');
  const anchors = input.combatants.map((spec, i) =>
    spec.position !== undefined ? parsePosition(spec.position, map, spec.count ?? 1, `start_combat: combatants[${i}] (${spec.name}) position`) : null,
  );
  return { map, heroAnchor, anchors, notes: [] };
}

/** The hero first (so nobody is auto-placed next to the hero by accident), then each group in input order. */
function startPlacements(hero: Combatant, groups: readonly Group[], plan: StartMap, input: StartInput): PlacementRequest[] {
  const requests: PlacementRequest[] = [{ ids: [hero.id], anchor: plan.heroAnchor ?? { kind: 'auto' } }];
  groups.forEach((g, i) => {
    const elevation = input.combatants[i].elevation_ft;
    requests.push({ ids: g.combatants.map((c) => c.id), anchor: plan.anchors[i] ?? { kind: 'auto' }, ...(elevation !== undefined ? { elevationFt: elevation } : {}) });
  });
  return requests;
}

export async function startCombatTool(input: StartInput, ctx: ToolContext): Promise<ToolOutcome> {
  const store = ctx.deps.store();
  const campaign = requireCampaign(store);
  const character = requireCharacter(store);
  if (store.combat?.active) {
    return fail(`A combat is already running (${store.combat.encounterName ?? 'unnamed'}). Use update_combat to add combatants, or end_combat first.`);
  }
  // Every map input is checked before the player is asked to roll: a typo never wastes the roll.
  const plan = prepareStartMap(input, campaign);
  // So are the numbers: a creature without AC, HP or initiative (and no stat block for them) fails here.
  const resolved: ResolvedGroup[] = [];
  for (const spec of input.combatants) resolved.push(await resolveGroup(ctx, spec, campaign));
  const concentrationNote = await heroConcentrationNote(ctx, character);

  const heroRoll = await performPlayerRoll(ctx, {
    rollType: 'initiative',
    revealDc: false,
    advantage: input.player_surprised ? 'disadvantage' : 'normal',
    reason: input.encounter_name ?? 'The fight begins',
  });
  const hero: Combatant = {
    id: ctx.deps.newId(),
    name: character.name,
    side: 'player',
    isPlayer: true,
    initiative: heroRoll.result.total,
    initiativeBonus: initiativeModifier(character),
    ac: character.armorClass,
    conditions: [],
    defeated: false,
  };

  const taken = new Set([nameKey(character.name)]);
  const groups: Group[] = [];
  const lines: string[] = [`${character.name}: initiative ${heroRoll.result.total}`, ...heroRoll.notes];
  for (const r of resolved) {
    const group = buildGroup(ctx, r, taken);
    groups.push(group);
    lines.push(group.line);
  }

  let state = createCombat([hero, ...groups.flatMap((g) => g.combatants)], input.encounter_name);
  let placed: PlacementResult[] = [];
  if (plan.map) {
    const placement = placeCombatants({ ...state, map: plan.map }, character, startPlacements(hero, groups, plan, input));
    state = placement.state;
    placed = placement.placed;
  }
  if (ctx.deps.store().combat?.active) return fail('A combat started while the initiative was being rolled. Use update_combat instead.');
  await ctx.deps.store().setCombat(state);

  const title = input.encounter_name ?? 'Combat';
  const visible = state.combatants.filter((c) => !c.hidden).length;
  const mapLine = state.map ? `\nBattle map: ${state.map.name ? `${state.map.name} ` : ''}(${state.map.width}×${state.map.height})` : '';
  const heroAc = character.armorClass;
  await logTool(ctx, 'start_combat', 'combat', `Combat started: ${title} (${visible} combatants)`, {
    detail: `${summarizeCombat(state, { forPlayer: true, heroAc })}${mapLine}`,
  });
  const out = [
    `Combat started: ${title}.`,
    ...lines,
    '',
    summarizeCombat(state, { heroAc, heroConcentration: character.spellcasting?.concentratingOn }),
    turnLine(state),
  ];
  out.push(...plan.notes);
  if (concentrationNote) out.push(concentrationNote);
  if (state.map) out.push('', describeMapSetup(state, character, { placed, stats: groups.map((g) => g.stats) }));
  return ok(out.join('\n'));
}

/**
 * For the DM when a fight starts while the hero concentrates: the app counts the spell from the hero's first turn (a
 * spell already running lasts the hero's first N turns whatever the initiative order: concentrationTurnStart), so a
 * spell with less left needs its rounds given. The hero by name, or "The hero" when the sheet's name is blank. A sheet
 * Concentration on a spell the rules data says needs none (an older save's Mage Armor, srd:spell:mage-armor: "Duration:
 * 8 hours"; a mis-flagged import) gets the refusal update_combat concentrate would give, and the call that ends it.
 */
async function heroConcentrationNote(ctx: ToolContext, character: Character): Promise<string | null> {
  const spell = character.spellcasting?.concentratingOn?.trim();
  if (!spell) return null;
  const refused = await heroConcentrationRefusal(ctx, character, spell);
  if (refused) return `${refused} End it with update_character concentration: null.`;
  const name = character.name.trim() || 'The hero';
  const call = `update_combat concentrate target "${name}" spell "${spell}"`;
  const { rounds } = await spellTiming(ctx, spell, knownSpellId(character, spell));
  if (rounds === undefined) return `${name} is concentrating on ${spell}: the app has no duration for it, so it isn't counted; give rounds with ${call} to count it.`;
  return `${name} is concentrating on ${spell}: the app counts its ${spanText(rounds)} from ${name}'s first turn; if less is left, give rounds with ${call}.`;
}

// ---------------------------------------------------------------------------
// update_combat
// ---------------------------------------------------------------------------

type UpdateInput = ToolInput<'update_combat'>;

function requireTarget(state: CombatState, target: string | undefined, action: string): Combatant {
  if (!target) throw new ToolInputError(`update_combat ${action} needs a target.`);
  const found = findCombatant(state, target);
  if (!found) {
    const names = state.combatants.map((c) => c.name).join(', ');
    throw new ToolInputError(`No combatant named "${target}". Combatants: ${names}.`);
  }
  return found;
}

function refuseHero(c: Combatant, what: string): void {
  if (c.isPlayer) throw new ToolInputError(`${c.name} is the hero: change their ${what} with update_character instead.`);
}

function hpText(c: Combatant | undefined, forPlayer: boolean): string {
  if (!c?.hp) return '';
  if (forPlayer && c.hideHp) return healthDescriptor(c.hp);
  return `HP ${c.hp.current}/${c.hp.max}`;
}

/**
 * A DM-named condition: the standard one the name is by the engine's strict match ("Poisoned", "Grappled by the
 * ogre"), else the DM's own name as a homebrew condition ("Mark of the Invisible Hand" gives no Invisible rules).
 */
function conditionIdOf(name: string): string {
  return matchStandardCondition(name)?.id ?? name.trim();
}

function toConditions(list: UpdateInput['conditions_add']): ActiveCondition[] {
  return (list ?? []).map((c) => ({
    id: conditionIdOf(c.condition),
    ...defined({ source: c.source, duration: c.duration }),
  }));
}

interface CombatChange {
  state: CombatState;
  /** The result's first line (for the DM). */
  summary: string;
  /** The player's log line: the summary by default; null for none (a hidden creature's activity, D41). */
  log?: string | null;
  /** Extra lines for Claude. */
  notes?: string[];
  /** Log the line behind the DM screen (combatant notes are DM-only). */
  secret?: boolean;
  /** The Constitution save the app rolled to keep the target's Concentration: a DM roll logged after the damage line. */
  save?: { purpose: string; result: D20TestResult; secret: boolean };
  /** NPCs' and monsters' Concentration that ran out as the turn this action began started. */
  ended?: ConcentrationEnd[];
}

/** A Concentration save worked out before the write: the creature, its spell, the DC and the app's roll. */
interface PreparedSave {
  id: string;
  spell: string;
  dc: number;
  /** Absent when its stat block gives no Constitution save: the DM rolls it. */
  roll?: D20TestResult;
  /** Its stat block has Legendary Resistance: it decides before a failed save ends anything. */
  legendary: boolean;
  /** The card goes behind the screen: the creature is hidden, or its numbers are (hideHp). */
  secret: boolean;
}

/** What update_combat looks up and rolls before its one combat write (the rules index, a stat block, the dice). */
interface Prepared {
  reinforcements: Reinforcements | null;
  /** concentrate on an NPC: the spell in the rules data (its Concentration flag and duration). */
  timing?: SpellTiming;
  /** damage to a concentrating NPC that stays above 0 HP. */
  save?: PreparedSave;
  /** next_turn and remove: the hero's spell's full duration, when the hero's combatant has no countdown for it. */
  heroRounds?: number;
}

/** Whose Concentration ended, as the end cascade reads it. */
const npcCaster = (end: ConcentrationEnd): EndingCaster => ({ id: end.id, name: end.name, hidden: end.hidden, isHero: false });

/** An NPC's Concentration ended: the line saying so, then what may end with it (§3.5). */
function endedLines(end: ConcentrationEnd | undefined, line: string, state: CombatState, hero: Character | null, skip: readonly AddedCondition[] = []): string[] {
  return end ? [line, ...cascadeLines(end.spell, npcCaster(end), hero, state, skip)] : [];
}

/** "(10 rounds left)": the DM's own count as given, the app's in minutes past 10 rounds ("about 60 minutes left"). */
function leftText(rounds: number, given: boolean): string {
  return given ? `${roundsText(rounds)} left` : roundsLeftText(rounds);
}

/**
 * The lookups and rolls an action needs, done before the write (as start_combat's): the rules data for a spell an NPC
 * or the hero is given to concentrate on (one that needs no Concentration is refused: srd:spell:shield "Duration: 1
 * round"; the hero's refusal says where its effect goes instead); a concentrating NPC's Constitution save against
 * damage that leaves it standing (srd:rule:concentration: "The DC equals 10 or half the damage taken (round down),
 * whichever number is higher, up to a maximum DC of 30"), from its stat block, with the app's dice; the duration of the
 * hero's spell for a turn start that has to start its countdown.
 */
async function prepareEffects(ctx: ToolContext, state: CombatState, input: UpdateInput): Promise<Omit<Prepared, 'reinforcements'>> {
  const target = input.target ? findCombatant(state, input.target) : undefined;
  switch (input.action) {
    case 'concentrate': {
      if (!target || typeof input.spell !== 'string') return {};
      if (target.isPlayer) {
        const refused = await heroConcentrationRefusal(ctx, ctx.deps.store().character, input.spell);
        if (refused) throw new ToolInputError(refused);
        return {};
      }
      const timing = await spellTiming(ctx, input.spell);
      const refused = noConcentrationText(timing, input.spell);
      if (refused) throw new ToolInputError(refused);
      return { timing };
    }
    case 'damage': {
      const amount = input.amount ?? 0;
      if (!target || target.isPlayer || !target.concentration || !target.hp || amount <= 0) return {};
      const after = damageCombatant(state, target.id, amount).state.combatants.find((c) => c.id === target.id);
      if (!after?.hp || after.hp.current <= 0) return {};
      const dc = concentrationSaveDC(amount);
      const { con, legendary } = await npcSave(ctx, target);
      const roll = con !== undefined ? rollD20Test(con, { dc, rng: ctx.deps.rng }) : undefined;
      const secret = target.hidden === true || target.hideHp === true;
      return { save: { id: target.id, spell: target.concentration.spell, dc, ...(roll ? { roll } : {}), legendary, secret } };
    }
    case 'next_turn':
    case 'remove': {
      const hero = ctx.deps.store().character;
      const spell = hero?.spellcasting?.concentratingOn?.trim();
      if (!spell) return {};
      const countdown = state.combatants.find((c) => c.isPlayer)?.concentrationCountdown;
      if (countdown && nameKey(countdown.spell) === nameKey(spell)) return {};
      const { rounds } = await spellTiming(ctx, spell, knownSpellId(hero, spell));
      return rounds !== undefined ? { heroRounds: rounds } : {};
    }
    default:
      return {};
  }
}

/** Newcomers for `add`: built (stat blocks looked up, initiative rolled) before the write. */
interface Reinforcements {
  group: Group;
  anchor: PlacementAnchor | null;
  elevationFt?: number;
  /** "No map: positions were ignored." */
  note?: string;
}

async function prepareReinforcements(ctx: ToolContext, state: CombatState, input: UpdateInput): Promise<Reinforcements> {
  const spec = input.combatant;
  if (!spec) throw new ToolInputError('update_combat add needs `combatant`.');
  const campaign = requireCampaign(ctx.deps.store());
  // The position is checked before anything is rolled.
  const anchor = state.map && spec.position !== undefined ? parsePosition(spec.position, state.map, spec.count ?? 1, 'update_combat add: position') : null;
  const taken = new Set(state.combatants.map((c) => nameKey(c.name)));
  const group = buildGroup(ctx, await resolveGroup(ctx, spec, campaign), taken);
  const note = !state.map && spec.position !== undefined ? 'No map: positions were ignored.' : undefined;
  return { group, anchor, ...(spec.elevation_ft !== undefined ? { elevationFt: spec.elevation_ft } : {}), ...(note ? { note } : {}) };
}

function placedNote(state: CombatState, placed: readonly PlacementResult[]): string[] {
  const at = placed.filter((p) => p.at);
  const missing = placed.filter((p) => !p.at);
  const lines: string[] = [];
  if (at.length) lines.push(`Placed: ${at.map((p) => `${dmName(state, p.id)} at ${squareLabel(p.at as { x: number; y: number })}${p.why ? ` (${p.why})` : ''}`).join(' · ')}`);
  if (missing.length) lines.push(`Not placed: ${missing.map((p) => `${dmName(state, p.id)}${p.why ? ` (${p.why})` : ''}`).join(' · ')}`);
  return lines;
}

function addReinforcements(state: CombatState, hero: Character | null, r: Reinforcements): CombatChange {
  let next = state;
  for (const c of r.group.combatants) next = addCombatant(next, c);
  const notes = [r.group.line];
  if (r.note) notes.push(r.note);
  if (next.map) {
    const ids = r.group.combatants.map((c) => c.id);
    const placement = placeCombatants(next, hero, [{ ids, anchor: r.anchor ?? { kind: 'auto', arriving: true }, ...(r.elevationFt !== undefined ? { elevationFt: r.elevationFt } : {}) }]);
    next = placement.state;
    notes.push(...placedNote(next, placement.placed));
  }
  const ids = new Set(r.group.combatants.map((c) => c.id));
  const added = next.combatants.filter((c) => ids.has(c.id));
  const shown = added.filter((c) => !c.hidden).map((c) => c.name);
  return {
    state: next,
    summary: `Joined the fight: ${added.map((c) => dmName(next, c.id)).join(', ')}`,
    log: shown.length ? `Joined the fight: ${shown.join(', ')}` : null,
    notes,
  };
}

function changeHp(state: CombatState, hero: Character | null, input: UpdateInput, kind: 'damage' | 'heal', save?: PreparedSave): CombatChange {
  const target = requireTarget(state, input.target, kind);
  refuseHero(target, 'hit points');
  if (input.amount === undefined) throw new ToolInputError(`update_combat ${kind} needs an amount.`);
  const r = kind === 'damage' ? damageCombatant(state, target.id, input.amount) : healCombatant(state, target.id, input.amount);
  const after = r.state.combatants.find((c) => c.id === target.id);
  const verb = kind === 'damage' ? `takes ${input.amount} damage` : `heals ${input.amount}`;
  const outcome = after?.defeated && !target.defeated ? ' — down!' : ` (${hpText(after, true)})`;
  const summary = `${target.name} ${verb}${outcome}`;
  const change: CombatChange = {
    state: r.state,
    summary,
    log: target.hidden ? null : summary,
    notes: [`${target.name}: ${hpText(after, false)}`, ...eventLines(r.events)],
  };
  if (kind !== 'damage' || input.amount <= 0 || !after?.hp || !after.concentration) return change;
  return { ...change, ...concentrationAfterDamage(r.state, hero, after, input.amount, save, change.notes ?? []) };
}

/**
 * A concentrating NPC took damage (srd:rule:concentration, Damage). At 0 HP its Concentration ends
 * (srd:rule:damage-and-healing-dropping-to-0-hit-points-instant-death: "A monster dies the instant it drops to 0 Hit
 * Points"). Otherwise the save the app rolled before the write decides: kept; failed, but a creature with Legendary
 * Resistance decides first; or failed, and the spell ends with how many rounds were left. With no Constitution save in
 * its stat block the DM rolls, behind the screen when the creature or its numbers are hidden.
 */
function concentrationAfterDamage(
  state: CombatState,
  hero: Character | null,
  target: Combatant,
  amount: number,
  save: PreparedSave | undefined,
  notes: string[],
): Pick<CombatChange, 'state' | 'notes' | 'save'> {
  const held = target.concentration as NonNullable<Combatant['concentration']>;
  const name = target.name;
  const endCall = `update_combat concentrate target "${name}" spell null`;
  if ((target.hp?.current ?? 0) <= 0) {
    const r = endNpcConcentration(state, target.id);
    return { state: r.state, notes: [...notes, ...endedLines(r.ended, `${name}'s ${held.spell} ends: it drops to 0 HP.`, r.state, hero)] };
  }
  const prepared = save?.id === target.id && nameKey(save.spell) === nameKey(held.spell) ? save : undefined;
  // The app's own card's purpose, for a roll the DM makes too: it never names the spell, whoever can see the roll.
  const purpose = concentrationSavePurpose(name);
  if (!prepared?.roll) {
    const dc = prepared?.dc ?? concentrationSaveDC(amount);
    const secret = target.hidden || target.hideHp ? ', secret: true' : '';
    return {
      state,
      notes: [
        ...notes,
        `Concentration check: ${name} must make a DC ${dc} Constitution saving throw to keep ${held.spell} — roll it with roll_dice (purpose "${purpose}"${secret}); on a failure call ${endCall}.`,
      ],
    };
  }
  const { roll, dc } = prepared;
  const card = { purpose, result: roll, secret: prepared.secret };
  const head = `Concentration: Constitution save ${roll.total} (${roll.expression}) vs DC ${dc}`;
  if (roll.success) return { state, notes: [...notes, `${head} — ${name} keeps ${held.spell}.`], save: card };
  if (prepared.legendary) {
    return {
      state,
      notes: [...notes, `${head} — fails. ${name} has Legendary Resistance: if it uses one it keeps ${held.spell} (nothing to do); otherwise ${endCall}.`],
      save: card,
    };
  }
  const r = endNpcConcentration(state, target.id);
  const left = r.ended?.roundsLeft;
  const line = `${head} — fails: ${name}'s ${held.spell} ends${left !== undefined ? ` (${wereLeftText(left)})` : ''}.`;
  return { state: r.state, notes: [...notes, ...endedLines(r.ended, line, r.state, hero)], save: card };
}

function changeConditions(state: CombatState, hero: Character | null, input: UpdateInput): CombatChange {
  const target = requireTarget(state, input.target, 'conditions');
  refuseHero(target, 'conditions');
  if (!input.conditions_add?.length && !input.conditions_remove?.length) {
    throw new ToolInputError('update_combat conditions needs conditions_add or conditions_remove.');
  }
  // As the engine removes the hero's: a condition the creature has by that name, else the standard condition the name
  // strictly is, if the creature has it. A name that finds nothing removes nothing and says so to the DM only; the
  // summary and the player's log name what was removed as it was stored, never the DM's typed details.
  const find = (key: string) => target.conditions.find((c) => conditionKey(c.id) === key);
  const removed: ActiveCondition[] = [];
  const missed: string[] = [];
  for (const name of input.conditions_remove ?? []) {
    const hit = find(conditionKey(name)) ?? find(conditionKey(conditionIdOf(name)));
    if (!hit) missed.push(name.trim());
    else if (!removed.includes(hit)) removed.push(hit);
  }
  const removedKeys = new Set(removed.map((c) => conditionKey(c.id)));
  const added = toConditions(input.conditions_add);
  const addedKeys = new Set(added.map((c) => conditionKey(c.id)));
  const conditions = [...target.conditions.filter((c) => !removedKeys.has(conditionKey(c.id)) && !addedKeys.has(conditionKey(c.id))), ...added];
  const parts = [
    added.length ? `+${added.map((c) => c.id).join(', +')}` : '',
    removed.length ? `−${removed.map((c) => c.id).join(', −')}` : '',
  ].filter(Boolean);
  const has = target.conditions.length ? ` (it has ${target.conditions.map((c) => c.id).join(', ')})` : '';
  const misses = missed.map((name) => `Not removed: ${target.name} has no "${name}"${has}.`);
  const summary = parts.length ? `${target.name}: ${parts.join(' ')}` : `${target.name}: no change`;
  let next = parts.length ? updateCombatant(state, target.id, { conditions }) : state;
  const notes = [...misses, ...keptHomebrewLines(input.conditions_add, conditions)];
  // srd:rule:concentration: "Your Concentration ends if you have the Incapacitated condition" (or one that includes it).
  const incapacitated = added.map((c) => conditionKey(c.id)).find((key) => INCAPACITATING_CONDITIONS.has(key));
  if (incapacitated && target.concentration) {
    const r = endNpcConcentration(next, target.id);
    next = r.state;
    // What this call added isn't named back (an ally's Hold Person that broke this one).
    const skip: AddedCondition[] = added.map((c) => ({ combatantId: target.id, condition: c.id }));
    notes.push(...endedLines(r.ended, `${target.name}'s ${target.concentration.spell} ends: it is ${conditionName(incapacitated)}.`, next, hero, skip));
  }
  return { state: next, summary, log: target.hidden || !parts.length ? null : summary, notes };
}

/** Removing a creature drops a stop it made or reacted to (the move can't be repeated any more). */
function withoutStopOf(state: CombatState, id: string): CombatState {
  const stop = state.map?.stop;
  if (!state.map || !stop || (stop.moverId !== id && !stop.reactorIds.includes(id))) return state;
  const { stop: _dropped, ...map } = state.map;
  return { ...state, map };
}

function setHidden(state: CombatState, id: string, hidden: boolean): CombatState {
  return {
    ...state,
    combatants: state.combatants.map((c) => {
      if (c.id !== id) return c;
      if (hidden) return { ...c, hidden: true };
      const { hidden: _was, ...rest } = c;
      return rest;
    }),
  };
}

function reveal(state: CombatState, hero: Character | null, input: UpdateInput): CombatChange {
  const target = requireTarget(state, input.target, 'reveal');
  if (target.isPlayer) throw new ToolInputError(`${target.name} is the hero: only other creatures can be hidden or revealed.`);
  if (!target.hidden) return { state, summary: `${target.name} is already visible to the player.`, log: null };
  const next = setHidden(state, target.id, false);
  const shown = next.combatants.find((c) => c.id === target.id) as Combatant;
  const space = next.map ? spaceText(shown, hero) : null;
  const heroC = next.combatants.find((c) => c.isPlayer);
  const d = space && heroC ? distanceFt(shown, heroC, hero) : null;
  const where = space ? ` (${space}${d !== null && heroC ? `, ${d} ft from ${heroC.name}` : ''})` : '';
  return { state: next, summary: `${target.name} is now visible to the player${where}.`, log: `${target.name} appears${space ? ` (${space})` : ''}` };
}

function hide(state: CombatState, input: UpdateInput): CombatChange {
  const target = requireTarget(state, input.target, 'hide');
  if (target.isPlayer) throw new ToolInputError(`${target.name} is the hero: only other creatures can be hidden or revealed.`);
  if (target.hidden) return { state, summary: `${target.name} is already hidden from the player.`, log: null };
  return { state: setHidden(state, target.id, true), summary: `${target.name} is now hidden from the player.`, log: null };
}

/**
 * update_combat concentrate on an NPC or monster: start (with its countdown: `rounds`, else the spell's duration in the
 * rules data), recast (the count restarts: srd:rule:casting-spells-effects-combining-spell-effects), switch (the spell
 * it held ends: srd:rule:concentration, Another Concentration Effect) or end it (spell null). DM knowledge only: no
 * player log line (srd:rule:casting-spells-effects-targets).
 */
function concentrate(state: CombatState, hero: Character | null, input: UpdateInput, timing: SpellTiming | undefined): CombatChange {
  const target = requireTarget(state, input.target, 'concentrate');
  if (target.isPlayer) return heroConcentrate(state, target, hero, input);
  const name = target.name;
  if (input.spell === undefined) throw new ToolInputError(`update_combat concentrate needs \`spell\`: what ${name} concentrates on, or null when that ends.`);
  if (input.spell === null) {
    if (input.rounds !== undefined) throw new ToolInputError('`rounds` counts a spell: give it with `spell`, or leave it out with spell null.');
    const r = endNpcConcentration(state, target.id);
    if (!r.ended) return { state, summary: `${name} isn't concentrating on anything.`, log: null };
    return { state: r.state, summary: `${name} stops concentrating on ${r.ended.spell}.`, log: null, notes: cascadeLines(r.ended.spell, npcCaster(r.ended), hero, r.state) };
  }
  const given = input.rounds !== undefined;
  const rounds = input.rounds ?? timing?.rounds;
  // A spell in the rules data is recorded as the data spells it ("hold person" is Hold Person).
  const r = setNpcConcentration(state, target.id, timing?.found && timing.name ? timing.name : input.spell, rounds);
  if (r.refused) throw new ToolInputError(r.refused);
  const spell = r.state.combatants.find((c) => c.id === target.id)?.concentration?.spell ?? input.spell;
  const why = timing?.found ? `the rules data gives ${spell} no duration in rounds` : `${spell} isn't a spell in the rules data`;
  const none = `no countdown: ${why} — give rounds to count it`;
  const count = rounds !== undefined ? leftText(rounds, given) : undefined;
  if (r.recast) return { state: r.state, summary: count ? `${name} recasts ${spell}: ${count}.` : `${name} recasts ${spell} (${none}).`, log: null };
  const notes = r.previous ? endedLines(r.previous, `${name}'s ${r.previous.spell} ends: it started concentrating on ${spell}.`, r.state, hero) : [];
  return { state: r.state, summary: `${name} is concentrating on ${spell} (${count ?? none}).`, log: null, notes };
}

/**
 * update_combat concentrate on the hero: only how long the sheet's spell still lasts (Extended Spell, a higher-level
 * slot), on the hero's countdown. The sheet holds the hero's Concentration: update_character starts and ends it.
 */
function heroConcentrate(state: CombatState, target: Combatant, hero: Character | null, input: UpdateInput): CombatChange {
  const name = target.name;
  const sheet = hero?.spellcasting?.concentratingOn?.trim() || null;
  if (input.spell === null) throw new ToolInputError(`${name}'s Concentration is on the character sheet: end it with update_character concentration: null.`);
  if (!sheet) {
    throw new ToolInputError(`${name} isn't concentrating on anything: start it with update_character concentration${input.spell ? ` "${input.spell}"` : ''}.`);
  }
  if (input.spell === undefined || nameKey(input.spell) !== nameKey(sheet)) {
    throw new ToolInputError(
      `${name} is concentrating on ${sheet}${input.spell ? `, not ${input.spell}` : ''}: for the hero, concentrate only sets rounds (spell "${sheet}" with rounds); update_character concentration starts or ends the hero's Concentration.`,
    );
  }
  if (input.rounds === undefined) throw new ToolInputError(`Give rounds: how long ${name}'s ${sheet} still lasts (1 minute = 10 rounds).`);
  return { state: withHeroCountdown(state, { spell: sheet, roundsLeft: input.rounds }), summary: `${name}'s ${sheet}: ${roundsText(input.rounds)} left.`, log: null };
}

function applyAction(state: CombatState, hero: Character | null, input: UpdateInput, prepared: Prepared): CombatChange {
  switch (input.action) {
    case 'next_turn': {
      const next = nextTurn(state);
      const current = currentCombatant(next);
      const summary = turnLine(next);
      return { state: next, summary, log: current?.hidden ? null : summary };
    }
    case 'damage':
      return changeHp(state, hero, input, 'damage', prepared.save);
    case 'heal':
      return changeHp(state, hero, input, 'heal');
    case 'add':
      return addReinforcements(state, hero, prepared.reinforcements as Reinforcements);
    case 'remove': {
      const target = requireTarget(state, input.target, 'remove');
      refuseHero(target, 'place in the fight (end_combat ends it)');
      const summary = `${target.name} leaves the fight`;
      const next = removeCombatant(withoutStopOf(state, target.id), target.id);
      // Leaving the fight doesn't end a spell (srd:rule:concentration): the app only stops counting it.
      const held = target.concentration;
      const notes = held
        ? [
            `${target.name} was concentrating on ${held.spell}${held.roundsLeft !== undefined ? ` (${roundsLeftText(held.roundsLeft)})` : ''}: the app no longer tracks it.`,
            ...untilSpellEndsLines(held.spell, target.name, hero, next),
          ]
        : [];
      return { state: next, summary, log: target.hidden ? null : summary, notes };
    }
    case 'conditions':
      return changeConditions(state, hero, input);
    case 'defeat': {
      const target = requireTarget(state, input.target, 'defeat');
      refuseHero(target, 'status');
      const summary = `${target.name} is out of the fight`;
      let next = updateCombatant(state, target.id, { defeated: true });
      // A creature that fled can keep concentrating (srd:rule:concentration ends it on damage, Incapacitated or death):
      // the spell stays, but a defeated creature's turn never starts, so the app stops counting it.
      const held = target.concentration;
      if (!held) return { state: next, summary, log: target.hidden ? null : summary };
      if (held.roundsLeft !== undefined) next = updateCombatant(next, target.id, { concentration: { spell: held.spell } });
      const note = `${target.name} was concentrating on ${held.spell}: if it fell, end it with update_combat concentrate target "${target.name}" spell null; if it fled still concentrating, the spell goes on (the app no longer counts it).`;
      return { state: next, summary, log: target.hidden ? null : summary, notes: [note] };
    }
    case 'concentrate':
      return concentrate(state, hero, input, prepared.timing);
    case 'note': {
      const target = requireTarget(state, input.target, 'note');
      if (!input.note) throw new ToolInputError('update_combat note needs `note`.');
      // Notes are the DM's (the tracker and summaries hide them), so the log line is secret too.
      return {
        state: updateCombatant(state, target.id, { notes: input.note }),
        summary: `DM note on ${target.name}: ${input.note}`,
        secret: true,
      };
    }
    case 'reveal':
      return reveal(state, hero, input);
    case 'hide':
      return hide(state, input);
  }
}

const ICON: Partial<Record<UpdateInput['action'], 'hp' | 'heal'>> = { damage: 'hp', heal: 'heal' };

/** The hero's Concentration that ran out at the hero's turn start, ended on the sheet before the combat write. */
interface HeroExpiry {
  spell: string;
  /** expireConcentration's events: the end, then what ended with it (Shield of Faith's +2, a hand-set AC reminder). */
  events: GameEvent[];
  acBefore: number;
  acAfter: number;
}

/**
 * A turn start ends the hero's spell when its countdown runs out (concentrationTurnStart). Worked out first on a peek
 * of the action, so the sheet is written before the combat (expireConcentration; a no-op when the sheet moved on): a
 * reload between the two writes leaves a countdown the next turn start drops, never a spell the sheet still holds.
 */
async function expireHeroSpell(ctx: ToolContext, input: UpdateInput, prepared: Prepared): Promise<HeroExpiry | null> {
  const state = ctx.deps.store().combat;
  const hero = ctx.deps.store().character;
  const spell = hero?.spellcasting?.concentratingOn ?? null;
  if (!state || !hero || !spell) return null;
  const peek = concentrationTurnStart(state, applyAction(state, hero, input, prepared).state, { spell, rounds: prepared.heroRounds });
  const ended = peek.heroEnded;
  if (!ended) return null;
  let was = hero;
  const r = await mutateCharacter(ctx, (c) => {
    was = c;
    return expireConcentration(c, ended, 'its duration is up');
  });
  return r.events.length ? { spell: ended, events: r.events, acBefore: was.armorClass, acAfter: r.character.armorClass } : null;
}

/** " — AC 18 → 16" when the end changed the hero's AC (Shield of Faith's record). */
const acChangeText = (from: number, to: number): string => (from !== to ? ` — AC ${from} → ${to}` : '');

export async function updateCombatTool(input: UpdateInput, ctx: ToolContext): Promise<ToolOutcome> {
  const store = ctx.deps.store();
  const start = store.combat;
  if (!start?.active) return fail(NO_COMBAT);
  if (input.action !== 'concentrate' && (input.spell !== undefined || input.rounds !== undefined)) {
    throw new ToolInputError('`spell` and `rounds` go with action concentrate.');
  }
  const reinforcements = input.action === 'add' ? await prepareReinforcements(ctx, start, input) : null;
  const prepared: Prepared = { reinforcements, ...(await prepareEffects(ctx, ctx.deps.store().combat ?? start, input)) };
  // A turn start (next_turn, or removing the creature whose turn it is) counts Concentration down: the sheet first.
  const turns = input.action === 'next_turn' || input.action === 'remove';
  const heroExpiry = turns ? await expireHeroSpell(ctx, input, prepared) : null;
  const hero = ctx.deps.store().character;
  const before = ctx.deps.store().combat ?? start;
  const change = await mutateCombat(ctx, (c): CombatChange => {
    const r = applyAction(c, hero, input, prepared);
    if (!turns) return r;
    const tick = concentrationTurnStart(c, r.state, { spell: hero?.spellcasting?.concentratingOn ?? null, rounds: prepared.heroRounds });
    return { ...r, state: tick.state, ended: tick.ended };
  });
  const log = change.log === undefined ? change.summary : change.log;
  if (log) await logTool(ctx, 'update_combat', ICON[input.action] ?? 'combat', log, { secret: change.secret });
  // The app's Concentration save, after the damage line; its purpose never names the spell, and its roll type says it
  // is a save (compared to a DC), whatever the creature is called ("Attack Dog").
  if (change.save) await logRoll(ctx, { actor: 'dm', purpose: change.save.purpose, result: change.save.result, secret: change.save.secret, rollType: 'save' });
  if (heroExpiry) {
    await logTool(ctx, 'update_combat', 'spell', `Your concentration on ${heroExpiry.spell} ends: its duration is up${acChangeText(heroExpiry.acBefore, heroExpiry.acAfter)}`);
  }

  const heroNow = ctx.deps.store().character;
  const heroName = heroNow?.name.trim() || 'The hero';
  const notes = [...(change.notes ?? [])];
  for (const end of change.ended ?? []) notes.push(...endedLines(end, `${end.name}'s ${end.spell} ends: its duration is up.`, change.state, heroNow));
  if (heroExpiry) {
    const heroC = change.state.combatants.find((c) => c.isPlayer);
    notes.push(
      `${heroName}'s ${heroExpiry.spell} ends: its duration is up.`,
      ...eventLines(heroExpiry.events.slice(1)),
      ...cascadeLines(heroExpiry.spell, { id: heroC?.id, name: heroName, hidden: false, isHero: true }, heroNow, change.state),
    );
  }
  const summary = summarizeCombat(change.state, { heroAc: heroNow?.armorClass, heroConcentration: heroNow?.spellcasting?.concentratingOn });
  const lines = [change.summary, ...notes, '', summary];
  if (input.action !== 'next_turn') lines.push(turnLine(change.state));
  const mapLine = turnStartLine(before, change.state, heroNow);
  if (mapLine) lines.push(mapLine);
  const standing = change.state.combatants.filter((c) => !c.isPlayer && !c.defeated && c.side === 'enemy');
  if (before.combatants.some((c) => c.side === 'enemy') && standing.length === 0) {
    lines.push('No enemies are left standing: call end_combat when the fight is over.');
  }
  return ok(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// end_combat
// ---------------------------------------------------------------------------

/** What the end of a fight does to Concentration: DM lines, and the player's log line when the hero's ran out. */
interface FightEndConcentration {
  lines: string[];
  log?: string;
}

/**
 * Concentration as a fight ends (no game clock counts it afterwards). The hero's, with a minute or less left (a
 * countdown of 10 or less, or no countdown yet and a spell of at most a minute), runs out after the fight: ended on the
 * sheet (expireConcentration), so a forgotten Bless never restarts its count in the next fight. A longer one is named
 * with the call that ends it. NPCs still concentrating are named, with the hero's conditions their spells may hold.
 */
async function concentrationAsFightEnds(ctx: ToolContext, combat: CombatState): Promise<FightEndConcentration> {
  const lines: string[] = [];
  let log: string | undefined;
  const hero = ctx.deps.store().character;
  const spell = hero?.spellcasting?.concentratingOn?.trim();
  if (hero && spell) {
    const name = hero.name.trim() || 'The hero';
    const countdown = combat.combatants.find((c) => c.isPlayer)?.concentrationCountdown;
    const left = countdown && nameKey(countdown.spell) === nameKey(spell) ? countdown.roundsLeft : undefined;
    const full = left === undefined ? (await spellTiming(ctx, spell, knownSpellId(hero, spell))).rounds : undefined;
    const rounds = left ?? full;
    if (rounds !== undefined && rounds <= 10) {
      let was = hero;
      const r = await mutateCharacter(ctx, (c) => {
        was = c;
        return expireConcentration(c, spell, 'it runs out after the fight');
      });
      if (r.events.length) {
        log = `Your concentration on ${spell} runs out after the fight${acChangeText(was.armorClass, r.character.armorClass)}`;
        lines.push(
          `${name}'s ${spell} runs out after the fight${left !== undefined ? ` (${wereLeftText(left)})` : ''}.`,
          ...eventLines(r.events.slice(1)),
          ...cascadeLines(spell, { name, hidden: false, isHero: true }, r.character, null),
        );
      }
    } else {
      const time = left !== undefined ? ` (${roundsLeftText(left)})` : full !== undefined ? ` (at most ${roundsLeftText(full)})` : '';
      lines.push(`${name} is still concentrating on ${spell}${time}: end it with update_character concentration: null when it runs out.`);
    }
  }
  const npcs = combat.combatants.filter((c) => !c.isPlayer && c.concentration);
  if (npcs.length) {
    const held = npcs.map((c) => `${c.name} (${c.concentration?.spell})`).join(', ');
    lines.push(`Still concentrating as the fight ends: ${held} — the app no longer tracks ${npcs.length === 1 ? 'it' : 'them'}.`);
    const heroNow = ctx.deps.store().character;
    for (const c of npcs) lines.push(...untilSpellEndsLines(c.concentration?.spell ?? '', c.name, heroNow, null));
  }
  return { lines, ...(log ? { log } : {}) };
}

export async function endCombatTool(input: ToolInput<'end_combat'>, ctx: ToolContext): Promise<ToolOutcome> {
  const store = ctx.deps.store();
  const campaign = requireCampaign(store);
  const combat = store.combat;
  if (!combat) return fail('No combat is active.');
  // Where everyone ended, for the log (the player's view: hidden creatures left out). The map goes with the row.
  const positions = combat.map ? finalPositions(combat, store.character) : null;
  // Before the row goes: the sheet first, then the combat.
  const concentration = await concentrationAsFightEnds(ctx, combat);
  await store.setCombat(null);
  await logTool(ctx, 'end_combat', 'combat', `Combat ended: ${input.summary}`, positions ? { detail: positions } : {});
  if (concentration.log) await logTool(ctx, 'end_combat', 'spell', concentration.log);

  const lines = [`Combat ended: ${input.summary}`, ...concentration.lines];
  if (input.xp_award) {
    if (campaign.settings.milestoneLeveling) {
      lines.push('XP not awarded: this campaign uses milestone leveling.');
    } else if (store.character) {
      const award = input.xp_award;
      const change = await mutateCharacter(ctx, (c) => gainXp(c, award));
      await logTool(ctx, 'end_combat', 'xp', `XP +${award} (total ${change.character.xp})`);
      lines.push(`XP +${award} (total ${change.character.xp}).`);
      if (change.levelUpAvailable || xpToNextLevel(change.character) === 0) {
        lines.push('The hero has enough XP to level up: call level_up at a fitting moment.');
      }
    }
  }
  return ok(lines.join('\n'));
}
