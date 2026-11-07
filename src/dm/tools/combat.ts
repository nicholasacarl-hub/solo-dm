/**
 * Combat tools: the initiative tracker for NPCs and monsters. The hero's own HP and conditions
 * stay on the character sheet (update_character); the tracker only orders the hero's turn.
 */
import {
  addCombatant,
  createCombat,
  currentCombatant,
  damageCombatant,
  findCombatant,
  gainXp,
  healCombatant,
  healthDescriptor,
  initiativeModifier,
  nextTurn,
  normalizeConditionId,
  removeCombatant,
  rollD20Test,
  summarizeCombat,
  updateCombatant,
  xpToNextLevel,
} from '@/engine';
import type { ActiveCondition, Campaign, Combatant, CombatState } from '@/types';
import { nameKey } from '@/lib/id';
import { findAllowedEntry } from './rules';
import type { ToolInput } from './definitions';
import {
  defined,
  eventLines,
  fail,
  logTool,
  mutateCharacter,
  ok,
  requireCampaign,
  requireCharacter,
  ToolInputError,
  type ToolContext,
  type ToolOutcome,
} from './context';
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

async function statBlockId(ctx: ToolContext, name: string | undefined, campaign: Campaign): Promise<string | undefined> {
  if (!name) return undefined;
  try {
    const index = await ctx.deps.rulesIndex();
    return findAllowedEntry(index, name, { kind: 'monster', campaign })?.id;
  } catch {
    return undefined;
  }
}

async function buildGroup(
  ctx: ToolContext,
  spec: CombatantSpec,
  taken: Set<string>,
  campaign: Campaign,
): Promise<{ combatants: Combatant[]; line: string }> {
  const roll = rollD20Test(spec.initiative_bonus, {
    advantage: spec.surprised ? 'disadvantage' : 'normal',
    rng: ctx.deps.rng,
  });
  const blockId = await statBlockId(ctx, spec.stat_block, campaign);
  const names = groupNames(spec, taken);
  const combatants = names.map(
    (name): Combatant => ({
      id: ctx.deps.newId(),
      name,
      side: spec.side,
      isPlayer: false,
      initiative: roll.total,
      initiativeBonus: spec.initiative_bonus,
      ac: spec.ac,
      hp: { max: spec.hp_max, current: spec.hp_max, temp: 0 },
      conditions: [],
      defeated: false,
      hideHp: spec.hide_hp ?? spec.side === 'enemy',
      ...defined({ statBlockName: spec.stat_block, statBlockId: blockId, notes: spec.notes }),
    }),
  );
  const label = names.length > 1 ? `${spec.name} ×${names.length}` : names[0];
  return { combatants, line: `${label}: initiative ${roll.total} [${roll.breakdown}]` };
}

function turnLine(state: CombatState): string {
  const current = currentCombatant(state);
  return current ? `Round ${state.round}: ${current.name}'s turn.` : `Round ${state.round}.`;
}

export async function startCombatTool(input: ToolInput<'start_combat'>, ctx: ToolContext): Promise<ToolOutcome> {
  const store = ctx.deps.store();
  const campaign = requireCampaign(store);
  const character = requireCharacter(store);
  if (store.combat?.active) {
    return fail(`A combat is already running (${store.combat.encounterName ?? 'unnamed'}). Use update_combat to add combatants, or end_combat first.`);
  }

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
  const others: Combatant[] = [];
  const lines: string[] = [`${character.name}: initiative ${heroRoll.result.total}`, ...heroRoll.notes];
  for (const spec of input.combatants) {
    const group = await buildGroup(ctx, spec, taken, campaign);
    others.push(...group.combatants);
    lines.push(group.line);
  }

  const state = createCombat([hero, ...others], input.encounter_name);
  await ctx.deps.store().setCombat(state);
  const title = input.encounter_name ?? 'Combat';
  await logTool(ctx, 'start_combat', 'combat', `Combat started: ${title} (${state.combatants.length} combatants)`, {
    detail: summarizeCombat(state, { forPlayer: true }),
  });
  return ok([`Combat started: ${title}.`, ...lines, '', summarizeCombat(state), turnLine(state)].join('\n'));
}

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

function toConditions(list: ToolInput<'update_combat'>['conditions_add']): ActiveCondition[] {
  return (list ?? []).map((c) => ({
    id: normalizeConditionId(c.condition) ?? c.condition.trim(),
    ...defined({ source: c.source, duration: c.duration }),
  }));
}

interface CombatChange {
  state: CombatState;
  /** Player-facing log line. */
  summary: string;
  /** Extra lines for Claude. */
  notes?: string[];
  /** Log the line behind the DM screen (combatant notes are DM-only). */
  secret?: boolean;
}

async function addReinforcements(ctx: ToolContext, state: CombatState, input: ToolInput<'update_combat'>): Promise<CombatChange> {
  if (!input.combatant) throw new ToolInputError('update_combat add needs `combatant`.');
  const campaign = requireCampaign(ctx.deps.store());
  const taken = new Set(state.combatants.map((c) => nameKey(c.name)));
  const group = await buildGroup(ctx, input.combatant, taken, campaign);
  let next = state;
  for (const c of group.combatants) next = addCombatant(next, c);
  return { state: next, summary: `Joined the fight: ${group.combatants.map((c) => c.name).join(', ')}`, notes: [group.line] };
}

function changeHp(state: CombatState, input: ToolInput<'update_combat'>, kind: 'damage' | 'heal'): CombatChange {
  const target = requireTarget(state, input.target, kind);
  refuseHero(target, 'hit points');
  if (input.amount === undefined) throw new ToolInputError(`update_combat ${kind} needs an amount.`);
  const r = kind === 'damage' ? damageCombatant(state, target.id, input.amount) : healCombatant(state, target.id, input.amount);
  const after = r.state.combatants.find((c) => c.id === target.id);
  const verb = kind === 'damage' ? `takes ${input.amount} damage` : `heals ${input.amount}`;
  const outcome = after?.defeated && !target.defeated ? ' — down!' : ` (${hpText(after, true)})`;
  return {
    state: r.state,
    summary: `${target.name} ${verb}${outcome}`,
    notes: [`${target.name}: ${hpText(after, false)}`, ...eventLines(r.events)],
  };
}

function changeConditions(state: CombatState, input: ToolInput<'update_combat'>): CombatChange {
  const target = requireTarget(state, input.target, 'conditions');
  refuseHero(target, 'conditions');
  const removed = new Set((input.conditions_remove ?? []).map((c) => normalizeConditionId(c) ?? c.trim()));
  const added = toConditions(input.conditions_add);
  const addedIds = new Set(added.map((c) => c.id));
  const conditions = [...target.conditions.filter((c) => !removed.has(c.id) && !addedIds.has(c.id)), ...added];
  const parts = [
    added.length ? `+${added.map((c) => c.id).join(', +')}` : '',
    removed.size ? `−${[...removed].join(', −')}` : '',
  ].filter(Boolean);
  if (parts.length === 0) throw new ToolInputError('update_combat conditions needs conditions_add or conditions_remove.');
  return { state: updateCombatant(state, target.id, { conditions }), summary: `${target.name}: ${parts.join(' ')}` };
}

async function applyAction(ctx: ToolContext, state: CombatState, input: ToolInput<'update_combat'>): Promise<CombatChange> {
  switch (input.action) {
    case 'next_turn': {
      const next = nextTurn(state);
      return { state: next, summary: turnLine(next) };
    }
    case 'damage':
    case 'heal':
      return changeHp(state, input, input.action === 'damage' ? 'damage' : 'heal');
    case 'add':
      return addReinforcements(ctx, state, input);
    case 'remove': {
      const target = requireTarget(state, input.target, 'remove');
      refuseHero(target, 'place in the fight (end_combat ends it)');
      return { state: removeCombatant(state, target.id), summary: `${target.name} leaves the fight` };
    }
    case 'conditions':
      return changeConditions(state, input);
    case 'defeat': {
      const target = requireTarget(state, input.target, 'defeat');
      refuseHero(target, 'status');
      return { state: updateCombatant(state, target.id, { defeated: true }), summary: `${target.name} is out of the fight` };
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
  }
}

export async function updateCombatTool(input: ToolInput<'update_combat'>, ctx: ToolContext): Promise<ToolOutcome> {
  const state = ctx.deps.store().combat;
  if (!state?.active) return fail('No combat is active. Use start_combat first.');
  const change = await applyAction(ctx, state, input);
  await ctx.deps.store().setCombat(change.state);
  await logTool(ctx, 'update_combat', input.action === 'damage' ? 'hp' : input.action === 'heal' ? 'heal' : 'combat', change.summary, {
    secret: change.secret,
  });
  const lines = [change.summary, ...(change.notes ?? []), '', summarizeCombat(change.state)];
  if (input.action !== 'next_turn') lines.push(turnLine(change.state));
  const standing = change.state.combatants.filter((c) => !c.isPlayer && !c.defeated && c.side === 'enemy');
  if (state.combatants.some((c) => c.side === 'enemy') && standing.length === 0) {
    lines.push('No enemies are left standing: call end_combat when the fight is over.');
  }
  return ok(lines.join('\n'));
}

export async function endCombatTool(input: ToolInput<'end_combat'>, ctx: ToolContext): Promise<ToolOutcome> {
  const store = ctx.deps.store();
  const campaign = requireCampaign(store);
  if (!store.combat) return fail('No combat is active.');
  await store.setCombat(null);
  await logTool(ctx, 'end_combat', 'combat', `Combat ended: ${input.summary}`);

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
