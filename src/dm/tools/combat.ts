/**
 * Combat tools: the initiative tracker for NPCs and monsters, and the battle map's part in a fight (start_combat
 * with `map`, placing newcomers, the map line after a turn change). The hero's own HP and conditions stay on the
 * character sheet (update_character); the tracker only orders the hero's turn.
 *
 * Hidden creatures (the hero hasn't noticed them) work with or without a map: nothing they do writes a player log
 * line, and the player-facing summaries leave them out (D41). The DM's results name them, tagged "[hidden]".
 *
 * Writes: every handler does its awaiting first (the initiative roll, the rules index), then writes once — combat
 * changes through mutateCombat against the latest state. Only start_combat creates the row with setCombat (there is
 * no combat yet to update), and end_combat deletes it with setCombat(null).
 */
import {
  addCombatant,
  conditionKey,
  createBattleMap,
  createCombat,
  currentCombatant,
  damageCombatant,
  findCombatant,
  gainXp,
  healCombatant,
  healthDescriptor,
  initiativeModifier,
  matchStandardCondition,
  nextTurn,
  placeCombatants,
  removeCombatant,
  rollD20Test,
  squareLabel,
  statBlockMapStats,
  summarizeCombat,
  updateCombatant,
  xpToNextLevel,
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
  await logTool(ctx, 'start_combat', 'combat', `Combat started: ${title} (${visible} combatants)`, {
    detail: `${summarizeCombat(state, { forPlayer: true })}${mapLine}`,
  });
  const out = [`Combat started: ${title}.`, ...lines, '', summarizeCombat(state), turnLine(state)];
  out.push(...plan.notes);
  if (state.map) out.push('', describeMapSetup(state, character, { placed, stats: groups.map((g) => g.stats) }));
  return ok(out.join('\n'));
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

function changeHp(state: CombatState, input: UpdateInput, kind: 'damage' | 'heal'): CombatChange {
  const target = requireTarget(state, input.target, kind);
  refuseHero(target, 'hit points');
  if (input.amount === undefined) throw new ToolInputError(`update_combat ${kind} needs an amount.`);
  const r = kind === 'damage' ? damageCombatant(state, target.id, input.amount) : healCombatant(state, target.id, input.amount);
  const after = r.state.combatants.find((c) => c.id === target.id);
  const verb = kind === 'damage' ? `takes ${input.amount} damage` : `heals ${input.amount}`;
  const outcome = after?.defeated && !target.defeated ? ' — down!' : ` (${hpText(after, true)})`;
  const summary = `${target.name} ${verb}${outcome}`;
  return {
    state: r.state,
    summary,
    log: target.hidden ? null : summary,
    notes: [`${target.name}: ${hpText(after, false)}`, ...eventLines(r.events)],
  };
}

function changeConditions(state: CombatState, input: UpdateInput): CombatChange {
  const target = requireTarget(state, input.target, 'conditions');
  refuseHero(target, 'conditions');
  // As the engine removes the hero's: a name the creature has is removed as named, any other as the condition it is.
  const has = (name: string) => target.conditions.some((c) => conditionKey(c.id) === conditionKey(name));
  const removed = new Set((input.conditions_remove ?? []).map((name) => (has(name) ? name.trim() : conditionIdOf(name))));
  const removedKeys = new Set([...removed].map(conditionKey));
  const added = toConditions(input.conditions_add);
  const addedKeys = new Set(added.map((c) => conditionKey(c.id)));
  const conditions = [...target.conditions.filter((c) => !removedKeys.has(conditionKey(c.id)) && !addedKeys.has(conditionKey(c.id))), ...added];
  const parts = [
    added.length ? `+${added.map((c) => c.id).join(', +')}` : '',
    removed.size ? `−${[...removed].join(', −')}` : '',
  ].filter(Boolean);
  if (parts.length === 0) throw new ToolInputError('update_combat conditions needs conditions_add or conditions_remove.');
  const summary = `${target.name}: ${parts.join(' ')}`;
  return {
    state: updateCombatant(state, target.id, { conditions }),
    summary,
    log: target.hidden ? null : summary,
    notes: keptHomebrewLines(input.conditions_add, conditions),
  };
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

function applyAction(state: CombatState, hero: Character | null, input: UpdateInput, reinforcements: Reinforcements | null): CombatChange {
  switch (input.action) {
    case 'next_turn': {
      const next = nextTurn(state);
      const current = currentCombatant(next);
      const summary = turnLine(next);
      return { state: next, summary, log: current?.hidden ? null : summary };
    }
    case 'damage':
    case 'heal':
      return changeHp(state, input, input.action);
    case 'add':
      return addReinforcements(state, hero, reinforcements as Reinforcements);
    case 'remove': {
      const target = requireTarget(state, input.target, 'remove');
      refuseHero(target, 'place in the fight (end_combat ends it)');
      const summary = `${target.name} leaves the fight`;
      return { state: removeCombatant(withoutStopOf(state, target.id), target.id), summary, log: target.hidden ? null : summary };
    }
    case 'conditions':
      return changeConditions(state, input);
    case 'defeat': {
      const target = requireTarget(state, input.target, 'defeat');
      refuseHero(target, 'status');
      const summary = `${target.name} is out of the fight`;
      return { state: updateCombatant(state, target.id, { defeated: true }), summary, log: target.hidden ? null : summary };
    }
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

export async function updateCombatTool(input: UpdateInput, ctx: ToolContext): Promise<ToolOutcome> {
  const store = ctx.deps.store();
  const start = store.combat;
  if (!start?.active) return fail(NO_COMBAT);
  const reinforcements = input.action === 'add' ? await prepareReinforcements(ctx, start, input) : null;
  const hero = ctx.deps.store().character;
  const before = ctx.deps.store().combat ?? start;
  const change = await mutateCombat(ctx, (c) => applyAction(c, hero, input, reinforcements));
  const log = change.log === undefined ? change.summary : change.log;
  if (log) await logTool(ctx, 'update_combat', ICON[input.action] ?? 'combat', log, { secret: change.secret });

  const lines = [change.summary, ...(change.notes ?? []), '', summarizeCombat(change.state)];
  if (input.action !== 'next_turn') lines.push(turnLine(change.state));
  const mapLine = turnStartLine(before, change.state, hero);
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

export async function endCombatTool(input: ToolInput<'end_combat'>, ctx: ToolContext): Promise<ToolOutcome> {
  const store = ctx.deps.store();
  const campaign = requireCampaign(store);
  const combat = store.combat;
  if (!combat) return fail('No combat is active.');
  // Where everyone ended, for the log (the player's view: hidden creatures left out). The map goes with the row.
  const positions = combat.map ? finalPositions(combat, store.character) : null;
  await store.setCombat(null);
  await logTool(ctx, 'end_combat', 'combat', `Combat ended: ${input.summary}`, positions ? { detail: positions } : {});

  const lines = [`Combat ended: ${input.summary}`];
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
