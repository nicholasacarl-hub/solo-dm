/**
 * Character tools: batched sheet changes, rests, leveling, and reading the full sheet.
 * Every change runs through the pure engine and lands in the store in one atomic update.
 */
import {
  abilityModifier,
  addCondition,
  addFeature,
  addItem,
  addSpell,
  applyDamage,
  applyHealing,
  applyLongRest,
  applyShortRest,
  changeCurrency,
  changeExhaustion,
  characterLevel,
  characterSheetText,
  characterStatusLine,
  gainXp,
  levelUp,
  normalizeConditionId,
  removeCondition,
  removeItem,
  removeSpell,
  restoreFeature,
  restoreSlot,
  setConcentration,
  setTempHp,
  spendHitDie,
  spendSlot,
  updateItem,
  useFeature,
  xpToNextLevel,
  type EngineResult,
} from '@/engine';
import type {
  Character,
  Currency,
  GameEvent,
  HitDie,
  InventoryItem,
  RollResult,
  SpellSlotLevel,
  ToolActivityIcon,
} from '@/types';
import type { ToolInput } from './definitions';
import {
  changesOf,
  defined,
  eventLines,
  fail,
  logTool,
  mutateCharacter,
  ok,
  plural,
  requireCampaign,
  requireCharacter,
  ToolInputError,
  warningsOf,
  type ToolContext,
  type ToolOutcome,
} from './context';
import { DmCancelledError } from '../errors';

// ---------------------------------------------------------------------------
// update_character
// ---------------------------------------------------------------------------

interface Section {
  icon: ToolActivityIcon;
  /** Log line for the change; derived from events when omitted. */
  summary?: (before: Character, after: Character) => string;
  apply: (c: Character) => EngineResult;
}

interface SectionResult {
  section: Section;
  before: Character;
  after: Character;
  events: GameEvent[];
}

function chain(c: Character, steps: ((c: Character) => EngineResult)[]): EngineResult {
  let character = c;
  const events: GameEvent[] = [];
  for (const step of steps) {
    const r = step(character);
    character = r.character;
    events.push(...r.events);
  }
  return { character, events };
}

function conditionId(name: string): string {
  return normalizeConditionId(name) ?? name.trim();
}

function hpSection(hp: NonNullable<ToolInput<'update_character'>['hp']>, reason?: string): Section {
  const detail = (amount: string) => (reason ? `(${amount} · ${reason})` : `(${amount})`);
  return {
    icon: hp.kind === 'damage' ? 'hp' : 'heal',
    summary: (before, after) => {
      if (hp.kind === 'temp') return `Temp HP ${before.hp.temp} → ${after.hp.temp}`;
      const label = hp.kind === 'damage' ? `${hp.amount}${hp.damage_type ? ` ${hp.damage_type}` : ''}` : `+${hp.amount}`;
      return `HP ${before.hp.current} → ${after.hp.current} ${detail(label)}`;
    },
    apply: (c) => {
      if (hp.kind === 'damage') return applyDamage(c, hp.amount, { critical: hp.critical, damageType: hp.damage_type });
      if (hp.kind === 'healing') return applyHealing(c, hp.amount);
      return setTempHp(c, hp.amount);
    },
  };
}

function inventorySteps(input: ToolInput<'update_character'>): ((c: Character) => EngineResult)[] {
  const steps: ((c: Character) => EngineResult)[] = [];
  for (const item of input.inventory_remove ?? []) steps.push((c) => removeItem(c, item.name, item.quantity));
  for (const item of input.inventory_add ?? []) {
    const add: Omit<InventoryItem, 'id'> = { name: item.name, quantity: item.quantity, ...defined({
      description: item.description,
      category: item.category,
      magic: item.magic,
      weight: item.weight,
    }) };
    steps.push((c) => addItem(c, add));
  }
  for (const item of input.inventory_update ?? []) {
    const patch = defined({
      equipped: item.equipped,
      attuned: item.attuned,
      quantity: item.quantity,
      description: item.description,
    });
    steps.push((c) => updateItem(c, item.name, patch));
  }
  return steps;
}

function spellSteps(input: ToolInput<'update_character'>): ((c: Character) => EngineResult)[] {
  const steps: ((c: Character) => EngineResult)[] = [];
  for (const slot of input.spell_slots_spend ?? []) {
    steps.push((c) => spendSlot(c, slot.level as SpellSlotLevel, { pact: slot.pact }));
  }
  for (const slot of input.spell_slots_restore ?? []) {
    steps.push((c) => restoreSlot(c, slot.level as SpellSlotLevel, 1, { pact: slot.pact }));
  }
  if (input.concentration !== undefined) {
    const spell = input.concentration;
    steps.push((c) => setConcentration(c, spell));
  }
  for (const name of input.spells_remove ?? []) steps.push((c) => removeSpell(c, name));
  for (const spell of input.spells_add ?? []) {
    steps.push((c) =>
      addSpell(c, {
        name: spell.name,
        level: spell.level,
        prepared: spell.prepared ?? true,
        source: spell.source ?? 'Granted in play',
        ...defined({ ritual: spell.ritual, concentration: spell.concentration, notes: spell.notes }),
      }),
    );
  }
  return steps;
}

function featureSteps(input: ToolInput<'update_character'>): ((c: Character) => EngineResult)[] {
  const steps: ((c: Character) => EngineResult)[] = [];
  for (const f of input.features_use ?? []) steps.push((c) => useFeature(c, f.name, f.amount));
  for (const f of input.features_restore ?? []) steps.push((c) => restoreFeature(c, f.name, f.amount));
  for (const f of input.features_add ?? []) {
    steps.push((c) =>
      addFeature(c, {
        name: f.name,
        description: f.description,
        source: f.source,
        sourceName: 'Granted in play',
        ...(f.uses_max ? { uses: { max: f.uses_max, used: 0, recharge: f.recharge ?? 'long' } } : {}),
      }),
    );
  }
  return steps;
}

function conditionSteps(input: ToolInput<'update_character'>): ((c: Character) => EngineResult)[] {
  const steps: ((c: Character) => EngineResult)[] = [];
  let exhaustion = input.exhaustion_change ?? 0;
  for (const name of input.conditions_remove ?? []) {
    if (conditionId(name) === 'exhaustion') exhaustion -= 1;
    else steps.push((c) => removeCondition(c, conditionId(name)));
  }
  for (const cond of input.conditions_add ?? []) {
    const id = conditionId(cond.condition);
    if (id === 'exhaustion') {
      exhaustion += 1;
      continue;
    }
    steps.push((c) => addCondition(c, { id, ...defined({ source: cond.source, duration: cond.duration }) }));
  }
  if (exhaustion !== 0) steps.push((c) => changeExhaustion(c, exhaustion));
  return steps;
}

/** Events for direct stat edits that have no engine function (AC, speed). */
function statEvent(message: string): GameEvent {
  return { type: 'combat', message };
}

function statSteps(input: ToolInput<'update_character'>): ((c: Character) => EngineResult)[] {
  const steps: ((c: Character) => EngineResult)[] = [];
  if (input.armor_class !== undefined) {
    const ac = input.armor_class;
    steps.push((c) => ({ character: { ...c, armorClass: ac }, events: [statEvent(`AC ${c.armorClass} → ${ac}`)] }));
  }
  if (input.speed !== undefined) {
    const speed = input.speed;
    steps.push((c) => ({ character: { ...c, speed }, events: [statEvent(`Speed ${c.speed} ft. → ${speed} ft.`)] }));
  }
  return steps;
}

function buildSections(input: ToolInput<'update_character'>): Section[] {
  const sections: Section[] = [];
  const add = (icon: ToolActivityIcon, steps: ((c: Character) => EngineResult)[]) => {
    if (steps.length > 0) sections.push({ icon, apply: (c) => chain(c, steps) });
  };
  if (input.hp) sections.push(hpSection(input.hp, input.reason));
  add('condition', conditionSteps(input));
  add('spell', spellSteps(input));
  add('info', featureSteps(input));
  add('item', inventorySteps(input));
  if (input.currency_change) {
    const delta = defined(input.currency_change) as Partial<Currency>;
    add('coin', [(c) => changeCurrency(c, delta)]);
  }
  if (input.xp_gain !== undefined) {
    const xp = input.xp_gain;
    add('xp', [(c) => gainXp(c, xp)]);
  }
  if (input.heroic_inspiration !== undefined) {
    const value = input.heroic_inspiration;
    add('xp', [
      (c) => ({
        character: { ...c, heroicInspiration: value },
        events: [
          value
            ? { type: 'feature-restored', message: 'Heroic Inspiration gained' }
            : { type: 'feature-used', message: 'Heroic Inspiration spent' },
        ],
      }),
    ]);
  }
  add('info', statSteps(input));
  return sections;
}

async function logSections(ctx: ToolContext, results: SectionResult[], reason?: string): Promise<void> {
  for (const r of results) {
    const changes = changesOf(r.events);
    const warnings = warningsOf(r.events).map((w) => w.message);
    const summary = r.section.summary ? r.section.summary(r.before, r.after) : changes.map((e) => e.message).join('; ');
    if (!summary) continue;
    const detailParts = [
      r.section.summary ? changes.map((e) => e.message).join('\n') : '',
      warnings.length ? `Warnings: ${warnings.join('; ')}` : '',
      reason && !r.section.summary ? `Reason: ${reason}` : '',
    ].filter(Boolean);
    await logTool(ctx, 'update_character', r.section.icon, summary, { detail: detailParts.join('\n') || undefined });
  }
}

export async function updateCharacterTool(input: ToolInput<'update_character'>, ctx: ToolContext): Promise<ToolOutcome> {
  const sections = buildSections(input);
  if (sections.length === 0) throw new ToolInputError('Nothing to change: include at least one section (hp, conditions_add, inventory_add, …).');
  let results: SectionResult[] = [];
  const change = await mutateCharacter(ctx, (start) => {
    results = [];
    let current = start;
    for (const section of sections) {
      const r = section.apply(current);
      results.push({ section, before: current, after: r.character, events: r.events });
      current = r.character;
    }
    return { character: current };
  });
  await logSections(ctx, results, input.reason);

  const lines = results.flatMap((r) => eventLines(r.events)).filter(Boolean);
  const campaign = ctx.deps.store().campaign;
  if (input.xp_gain !== undefined && campaign && !campaign.settings.milestoneLeveling && xpToNextLevel(change.character) === 0) {
    lines.push('The hero has enough XP to level up: call level_up at a fitting moment.');
  }
  lines.push(`Status: ${characterStatusLine(change.character)}`);
  return ok(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// take_rest
// ---------------------------------------------------------------------------

function remainingDice(c: Character): HitDie[] {
  return c.hitDice
    .filter((h) => h.total - h.spent > 0)
    .map((h) => h.die)
    .sort((a, b) => b - a);
}

/** Auto roll mode: spend the largest remaining Hit Dice until HP is full or none remain. */
function autoSpendHitDice(ctx: ToolContext, start: Character): { character: Character; spent: number; healed: number; events: GameEvent[] } {
  let character = start;
  let spent = 0;
  let healed = 0;
  const events: GameEvent[] = [];
  while (character.hp.current < character.hp.max) {
    const [die] = remainingDice(character);
    if (!die) break;
    const r = spendHitDie(character, die, { rng: ctx.deps.rng });
    if (!r.roll) break;
    character = r.character;
    spent += 1;
    healed += r.healed;
    events.push(...r.events);
  }
  return { character, spent, healed, events };
}

async function askShortRest(ctx: ToolContext, c: Character, reason?: string): Promise<{ die: HitDie; roll: RollResult }[]> {
  const store = ctx.deps.store();
  ctx.status('Waiting for you to spend Hit Dice…', 'waiting-player');
  try {
    const response = await store.requestInteraction({
      kind: 'short-rest',
      id: ctx.deps.newId(),
      hitDice: c.hitDice,
      conMod: abilityModifier(c.abilityScores.con),
      ...(reason ? { reason } : {}),
    });
    if (response.kind !== 'short-rest') return [];
    return response.response.spent.map((s) => ({ die: s.die as HitDie, roll: s.roll }));
  } catch (err) {
    if (ctx.signal.aborted) throw new DmCancelledError();
    throw err;
  } finally {
    ctx.status('Resting…', 'tool');
  }
}

async function shortRest(ctx: ToolContext, reason?: string): Promise<ToolOutcome> {
  const store = ctx.deps.store();
  const campaign = requireCampaign(store);
  const before = requireCharacter(store);
  const auto = campaign.settings.playerRollMode === 'auto';
  const chosen = auto ? [] : await askShortRest(ctx, before, reason);

  const change = await mutateCharacter(ctx, (c) => {
    let spent = 0;
    let healed = 0;
    const events: GameEvent[] = [];
    let character = c;
    if (auto) {
      const r = autoSpendHitDice(ctx, character);
      ({ character, spent, healed } = r);
      events.push(...r.events);
    } else {
      for (const s of chosen) {
        const r = spendHitDie(character, s.die, { roll: s.roll });
        character = r.character;
        if (r.roll) spent += 1;
        healed += r.healed;
        events.push(...r.events);
      }
    }
    const rest = applyShortRest(character);
    return { character: rest.character, events: [...events, ...rest.events], spent, healed };
  });

  const summary = `Short rest: ${plural(change.spent, 'Hit Die', 'Hit Dice')} spent, +${change.healed} HP (HP ${before.hp.current} → ${change.character.hp.current})`;
  await logTool(ctx, 'take_rest', 'rest', summary, { detail: [reason, ...eventLines(change.events)].filter(Boolean).join('\n') });
  return ok([summary, ...eventLines(change.events), `Status: ${characterStatusLine(change.character)}`].join('\n'));
}

async function longRest(ctx: ToolContext, reason?: string): Promise<ToolOutcome> {
  const change = await mutateCharacter(ctx, (c) => applyLongRest(c));
  const summary = 'Long rest: HP, Hit Dice and spell slots restored';
  await logTool(ctx, 'take_rest', 'rest', summary, { detail: [reason, ...eventLines(change.events)].filter(Boolean).join('\n') });
  return ok([summary, ...eventLines(change.events), `Status: ${characterStatusLine(change.character)}`].join('\n'));
}

export async function takeRestTool(input: ToolInput<'take_rest'>, ctx: ToolContext): Promise<ToolOutcome> {
  if (ctx.deps.store().combat?.active) return fail('The hero cannot rest during combat. End the combat first.');
  return input.kind === 'short' ? shortRest(ctx, input.reason) : longRest(ctx, input.reason);
}

// ---------------------------------------------------------------------------
// level_up
// ---------------------------------------------------------------------------

export async function levelUpTool(input: ToolInput<'level_up'>, ctx: ToolContext): Promise<ToolOutcome> {
  const store = ctx.deps.store();
  const campaign = requireCampaign(store);
  const before = requireCharacter(store);
  const level = characterLevel(before);
  if (level >= 20) return fail('The hero is already level 20.');
  if (!campaign.settings.milestoneLeveling) {
    const needed = xpToNextLevel(before);
    if (needed !== null && needed > 0) {
      return fail(`This is an XP campaign and the hero needs ${needed} more XP to reach level ${level + 1}. Award XP first, or keep playing.`);
    }
  }
  const change = await mutateCharacter(ctx, (c) =>
    levelUp(c, {
      className: input.class_name,
      hpMethod: input.hp_method ?? 'average',
      rng: ctx.deps.rng,
      ...defined({
        subclass: input.subclass,
        hitDie: input.hit_die as HitDie | undefined,
        casterType: input.caster_type,
        spellcastingAbility: input.spellcasting_ability,
      }),
      newFeatures: (input.new_features ?? []).map((f) => ({
        name: f.name,
        description: f.description,
        source: 'class' as const,
        sourceName: `${input.class_name} ${level + 1}`,
        ...(f.uses_max ? { uses: { max: f.uses_max, used: 0, recharge: f.recharge ?? 'long' } } : {}),
      })),
    }),
  );
  const summary = `Level up! Level ${change.newLevel} (${input.class_name}) · HP +${change.hpGained} (max ${change.character.hp.max})`;
  await logTool(ctx, 'level_up', 'level', summary, { detail: [...eventLines(change.events), ...change.reminders].join('\n') || undefined });
  const lines = [summary, ...eventLines(change.events)];
  if (change.reminders.length) lines.push('Choices the player still needs to make:', ...change.reminders.map((r) => `- ${r}`));
  lines.push(`Status: ${characterStatusLine(change.character)}`);
  return ok(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// get_character_sheet
// ---------------------------------------------------------------------------

export async function getCharacterSheetTool(_input: ToolInput<'get_character_sheet'>, ctx: ToolContext): Promise<ToolOutcome> {
  return ok(characterSheetText(requireCharacter(ctx.deps.store())));
}
