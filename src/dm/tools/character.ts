/**
 * Character tools: batched sheet changes, rests, leveling, and reading the full sheet.
 * Every change runs through the pure engine and lands in the store in one atomic update.
 *
 * Content from the player's books (structured imports, spec §5.5, §6.4, §6.6): level_up takes an
 * imported class's or subclass's features (with their text and refs) from the merged builder data;
 * inventory_add, spells_add and features_add link an exact name to the rules index or the builder data,
 * so the sheet gets numbers and provenance (refs), never invented text. SRD classes keep today's
 * DM-supplied features, and a failure to read the data leaves every tool exactly as it was.
 */
import {
  abilityModifier,
  changeAbilityScore,
  computeArmorClass,
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
  type LevelUpOptions,
} from '@/engine';
import type { RulesIndex } from '@/data';
import { withAdaptationNotes } from '@/data/options/adaptationNotes';
import { inventoryFromEntry } from '@/data/options/inventory';
import { gainedFeatures } from '@/data/options/leveling';
import { addSubclassSpells, classRefOf, subclassCastingOf, subclassRefOf, subclassSpellsToAdd, spellEntryRef } from '@/data/options/levelUpChoices';
import { classByName, classOptionFor, optionSourceLabel, subclassOptionFor } from '@/data/options/resolve';
import { nameKey } from '@/lib/id';
import { textFingerprint } from '@/lib/importedContent';
import {
  ABILITY_NAMES,
  SKILL_NAMES,
  type BuilderData,
  type Campaign,
  type Character,
  type ClassLevel,
  type ClassOption,
  type CompendiumEntry,
  type Currency,
  type EquipmentOption,
  type Feature,
  type GameEvent,
  type HitDie,
  type ImportedRef,
  type InventoryItem,
  type KnownSpell,
  type ProficiencyLevel,
  type RollResult,
  type Skill,
  type SpellSlotLevel,
  type SubclassOption,
  type ToolActivityIcon,
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
import { truncate } from '../narration';
import { refitHeroAfterSheetChange } from './map';
import { findAllowedEntry } from './rules';

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

// -- links to the rules index and builder data (structured imports) ----------

/** What update_character found for the names it was given (resolved before the atomic update). */
interface Links {
  /** Per inventory_add entry: the linked item, or null (added as given). */
  items: (Omit<InventoryItem, 'id'> | null)[];
  /** Per spells_add entry: the spell entry its exact name resolves to, or null. */
  spells: (CompendiumEntry | null)[];
  /** Per features_add entry: the ref of the one imported feat with that name, or null. */
  feats: (ImportedRef | null)[];
  /** The merged equipment catalog, for Armor Class ([] when it couldn't load: the SRD armor table). */
  catalog: readonly EquipmentOption[];
}

const NO_LINKS: Links = { items: [], spells: [], feats: [], catalog: [] };

async function loadIndexOrNull(ctx: ToolContext): Promise<RulesIndex | null> {
  try {
    return await ctx.deps.rulesIndex();
  } catch {
    return null;
  }
}

async function loadBuilderOrNull(ctx: ToolContext): Promise<BuilderData | null> {
  try {
    return await ctx.deps.builderData();
  } catch {
    return null;
  }
}

/** The entry an exact name resolves to among the sources the DM may consult, or null. */
function exactEntry(index: RulesIndex | null, campaign: Campaign | null, name: string, kind: 'spell' | 'item' | 'magic-item'): CompendiumEntry | null {
  if (!index || !campaign) return null;
  const entry = findAllowedEntry(index, name, { kind, campaign });
  return entry && entry.kind === kind && nameKey(entry.name) === nameKey(name) ? entry : null;
}

/**
 * An inventory_add item linked to the index (spec §6.6): the catalog option's or the entry's numbers
 * (armor, bonuses, attunement) and ref. What the DM gave explicitly wins (category, magic, weight), and
 * the DM's description is kept — for a book's item it is the DM's words about it, so the ref marks it
 * copied and exports leave it out.
 */
function linkedItem(item: NonNullable<ToolInput<'update_character'>['inventory_add']>[number], entry: CompendiumEntry, catalog: readonly EquipmentOption[]): Omit<InventoryItem, 'id'> {
  const linked: Omit<InventoryItem, 'id'> = { ...inventoryFromEntry(entry, item.quantity, catalog), ...defined({ category: item.category, magic: item.magic, weight: item.weight }) };
  if (item.description) {
    linked.description = item.description;
    if (linked.ref) linked.ref = { ...linked.ref, textCopied: true, textHash: textFingerprint(item.description) };
  }
  return linked;
}

/** The ref of the one imported feat named like a features_add entry (the DM's description stays on this device). */
function featRef(name: string, data: BuilderData | null): ImportedRef | null {
  const key = nameKey(name);
  const matches = (data?.feats ?? []).filter((f) => f.source && f.ref && nameKey(f.name) === key);
  return matches.length === 1 ? (matches[0].ref ?? null) : null;
}

async function resolveLinks(input: ToolInput<'update_character'>, ctx: ToolContext): Promise<Links> {
  const items = input.inventory_add ?? [];
  const spells = input.spells_add ?? [];
  const feats = input.features_add ?? [];
  if (!items.length && !spells.length && !feats.length && !mayChangeArmorClass(input)) return NO_LINKS;
  const campaign = ctx.deps.store().campaign;
  const [data, index] = await Promise.all([loadBuilderOrNull(ctx), items.length || spells.length ? loadIndexOrNull(ctx) : Promise.resolve(null)]);
  const catalog = data?.equipment ?? [];
  return {
    items: items.map((item) => {
      const entry = exactEntry(index, campaign, item.name, 'magic-item') ?? exactEntry(index, campaign, item.name, 'item');
      return entry ? linkedItem(item, entry, catalog) : null;
    }),
    spells: spells.map((spell) => exactEntry(index, campaign, spell.name, 'spell')),
    feats: feats.map((f) => featRef(f.name, data)),
    catalog,
  };
}

function inventorySteps(input: ToolInput<'update_character'>, links: Links): ((c: Character) => EngineResult)[] {
  const steps: ((c: Character) => EngineResult)[] = [];
  for (const item of input.inventory_remove ?? []) steps.push((c) => removeItem(c, item.name, item.quantity));
  (input.inventory_add ?? []).forEach((item, i) => {
    const add: Omit<InventoryItem, 'id'> = links.items[i] ?? { name: item.name, quantity: item.quantity, ...defined({
      description: item.description,
      category: item.category,
      magic: item.magic,
      weight: item.weight,
    }) };
    steps.push((c) => addItem(c, add));
  });
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

/**
 * A spells_add spell. When its exact name resolves to a spell the DM may consult, it takes that entry's
 * id (so the sheet's text and the map's area presets find it), its ritual and concentration flags, and
 * for a book's spell a ref (nothing copied). Otherwise it is added as given, as before.
 */
function addedSpell(spell: NonNullable<ToolInput<'update_character'>['spells_add']>[number], entry: CompendiumEntry | null): Omit<KnownSpell, 'id'> & { id?: string } {
  const base = { name: spell.name, level: spell.level, prepared: spell.prepared ?? true, source: spell.source ?? 'Granted in play' };
  if (!entry) return { ...base, ...defined({ ritual: spell.ritual, concentration: spell.concentration, notes: spell.notes }) };
  const flag = (value: unknown, given: boolean | undefined) => (typeof value === 'boolean' ? value : given);
  const ritual = flag(entry.data?.ritual, spell.ritual);
  const concentration = flag(entry.data?.concentration, spell.concentration);
  const ref = spellEntryRef(entry);
  return {
    id: entry.id,
    ...base,
    ...(ritual ? { ritual } : {}),
    ...(concentration ? { concentration } : {}),
    ...defined({ notes: spell.notes }),
    ...(ref ? { ref } : {}),
  };
}

function spellSteps(input: ToolInput<'update_character'>, links: Links): ((c: Character) => EngineResult)[] {
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
  (input.spells_add ?? []).forEach((spell, i) => {
    const add = addedSpell(spell, links.spells[i] ?? null);
    steps.push((c) => addSpell(c, add));
  });
  return steps;
}

function featureSteps(input: ToolInput<'update_character'>, links: Links): ((c: Character) => EngineResult)[] {
  const steps: ((c: Character) => EngineResult)[] = [];
  for (const f of input.features_use ?? []) steps.push((c) => useFeature(c, f.name, f.amount));
  for (const f of input.features_restore ?? []) steps.push((c) => restoreFeature(c, f.name, f.amount));
  (input.features_add ?? []).forEach((f, i) => {
    // The DM's words about a book's feat: the ref lets exports leave them out and restore refill the book's text.
    const ref = links.feats[i];
    steps.push((c) =>
      addFeature(c, {
        name: f.name,
        description: f.description,
        source: f.source,
        sourceName: 'Granted in play',
        ...(f.uses_max ? { uses: { max: f.uses_max, used: 0, recharge: f.recharge ?? 'long' } } : {}),
        ...(ref ? { ref } : {}),
      }),
    );
  });
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

// -- abilities and proficiencies ---------------------------------------------

const PROFICIENCY: Record<'none' | 'half' | 'proficient' | 'expertise', ProficiencyLevel> = { none: 0, half: 0.5, proficient: 1, expertise: 2 };
const PROFICIENCY_NAME: Record<number, string> = { 0: 'not proficient', 0.5: 'half proficiency', 1: 'proficient', 2: 'expertise' };

export function setSkillProficiency(c: Character, skill: Skill, level: keyof typeof PROFICIENCY): EngineResult {
  const before = c.skills[skill] ?? 0;
  const next = PROFICIENCY[level];
  if (before === next) return { character: c, events: [] };
  const skills = { ...c.skills };
  if (next === 0) delete skills[skill];
  else skills[skill] = next;
  return { character: { ...c, skills }, events: [statEvent(`${SKILL_NAMES[skill]}: ${PROFICIENCY_NAME[before]} → ${PROFICIENCY_NAME[next]}`)] };
}

/** Add strings to a list (case-insensitively new ones only). */
function addTo(list: readonly string[], items: readonly string[]): string[] {
  const out = [...list];
  for (const item of items) {
    const clean = item.trim();
    if (clean && !out.some((x) => x.toLowerCase() === clean.toLowerCase())) out.push(clean);
  }
  return out;
}

function proficiencySteps(input: ToolInput<'update_character'>): ((c: Character) => EngineResult)[] {
  const steps: ((c: Character) => EngineResult)[] = [];
  for (const a of input.ability_scores ?? []) steps.push((c) => changeAbilityScore(c, a.ability, a.change, a.max ?? 20));
  for (const p of input.skill_proficiencies ?? []) steps.push((c) => setSkillProficiency(c, p.skill, p.level));
  if (input.saving_throws_add?.length) {
    const saves = input.saving_throws_add;
    steps.push((c) => {
      const added = saves.filter((a) => !c.savingThrows.includes(a));
      if (!added.length) return { character: c, events: [] };
      return {
        character: { ...c, savingThrows: [...c.savingThrows, ...added] },
        events: [statEvent(`Saving throw proficiency: ${added.map((a) => ABILITY_NAMES[a]).join(', ')}`)],
      };
    });
  }
  if (input.tools_add?.length) {
    const tools = input.tools_add;
    steps.push((c) => {
      const next = addTo(c.tools, tools);
      return next.length === c.tools.length ? { character: c, events: [] } : { character: { ...c, tools: next }, events: [statEvent(`Tool proficiency: ${next.slice(c.tools.length).join(', ')}`)] };
    });
  }
  if (input.languages_add?.length) {
    const languages = input.languages_add;
    steps.push((c) => {
      const next = addTo(c.languages, languages);
      return next.length === c.languages.length
        ? { character: c, events: [] }
        : { character: { ...c, languages: next }, events: [statEvent(`Languages: ${next.slice(c.languages.length).join(', ')}`)] };
    });
  }
  return steps;
}

/** The change may affect Armor Class: an ability score, or what is equipped or attuned. */
function mayChangeArmorClass(input: ToolInput<'update_character'>): boolean {
  return Boolean(input.ability_scores?.length) || (input.inventory_update ?? []).some((i) => i.equipped !== undefined || i.attuned !== undefined);
}

/**
 * Recompute AC after a change that may affect it (engine computeArmorClass). The sheet's AC is
 * replaced only when it matched the computed value before (no hand-set AC like Mage Armor's);
 * otherwise it stays, with a note of what the armor and scores now give.
 */
export function refreshArmorClass(before: Character, after: Character, catalog: readonly EquipmentOption[] = []): EngineResult {
  if (after.armorClass !== before.armorClass) return { character: after, events: [] };
  const was = computeArmorClass(before, catalog);
  const now = computeArmorClass(after, catalog);
  if (now.ac === was.ac) return { character: after, events: [] };
  if (before.armorClass !== was.ac) {
    return {
      character: after,
      events: [
        {
          type: 'warning',
          message: `AC stays ${after.armorClass} (set by hand); by armor and ability scores it would now be ${now.ac} (${now.formula}). Set armor_class if that is right.`,
        },
      ],
    };
  }
  return { character: { ...after, armorClass: now.ac, acFormula: now.formula }, events: [statEvent(`AC ${before.armorClass} → ${now.ac} (${now.formula})`)] };
}

function buildSections(input: ToolInput<'update_character'>, links: Links = NO_LINKS): Section[] {
  const sections: Section[] = [];
  const add = (icon: ToolActivityIcon, steps: ((c: Character) => EngineResult)[]) => {
    if (steps.length > 0) sections.push({ icon, apply: (c) => chain(c, steps) });
  };
  if (input.hp) sections.push(hpSection(input.hp, input.reason));
  add('condition', conditionSteps(input));
  add('spell', spellSteps(input, links));
  add('info', featureSteps(input, links));
  add('item', inventorySteps(input, links));
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
          { type: 'inspiration', message: value ? 'Heroic Inspiration gained' : 'Heroic Inspiration spent' },
        ],
      }),
    ]);
  }
  add('level', proficiencySteps(input));
  add('info', statSteps(input));
  return sections;
}

/** One log line from several engine messages: "Spent a slot · Concentrating on Fly". */
function joinMessages(events: readonly GameEvent[]): string {
  return truncate(events.map((e) => e.message.trim().replace(/\.$/, '')).filter(Boolean).join(' · '), 160);
}

async function logSections(ctx: ToolContext, results: SectionResult[], reason?: string): Promise<void> {
  for (const r of results) {
    const changes = changesOf(r.events);
    const warnings = warningsOf(r.events).map((w) => w.message);
    const summary = r.section.summary ? r.section.summary(r.before, r.after) : joinMessages(changes);
    if (!summary) continue;
    const detailParts = [
      r.section.summary || summary.endsWith('…') ? changes.map((e) => e.message).join('\n') : '',
      warnings.length ? `Warnings: ${warnings.join('; ')}` : '',
      reason && !r.section.summary ? `Reason: ${reason}` : '',
    ].filter(Boolean);
    await logTool(ctx, 'update_character', r.section.icon, summary, { detail: detailParts.join('\n') || undefined });
  }
}

export async function updateCharacterTool(input: ToolInput<'update_character'>, ctx: ToolContext): Promise<ToolOutcome> {
  if (buildSections(input).length === 0) throw new ToolInputError('Nothing to change: include at least one section (hp, conditions_add, inventory_add, …).');
  const links = await resolveLinks(input, ctx);
  const sections = buildSections(input, links);
  let results: SectionResult[] = [];
  const checkAc = mayChangeArmorClass(input);
  const before = requireCharacter(ctx.deps.store());
  const change = await mutateCharacter(ctx, (start) => {
    results = [];
    let current = start;
    for (const section of sections) {
      const r = section.apply(current);
      results.push({ section, before: current, after: r.character, events: r.events });
      current = r.character;
    }
    if (checkAc) {
      const r = refreshArmorClass(start, current, links.catalog);
      if (r.events.length) results.push({ section: { icon: 'info', apply: () => r }, before: current, after: r.character, events: r.events });
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
  // A size change during a mapped fight re-fits the hero's space (D39).
  const mapLine = await refitHeroAfterSheetChange(ctx, before, change.character);
  if (mapLine) lines.push(mapLine);
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

/** Features whose maximum uses changed in a level-up ("Rage: 2 → 3 uses"). */
function updatedUses(before: Character, after: Character): string[] {
  const lines: string[] = [];
  for (const feature of after.features) {
    const old = before.features.find((f) => f.id === feature.id);
    if (!old?.uses || !feature.uses || old.uses.max === feature.uses.max) continue;
    lines.push(`${feature.name}: ${old.uses.max} → ${feature.uses.max} uses`);
  }
  return lines;
}

/** What the merged builder data says about a level_up (spec §5.5); null without data or for a class it lacks. */
interface DataLevel {
  option: ClassOption;
  existing?: ClassLevel;
  classLevel: number;
  /** The subclass the call names (resolved by name among the class's subclasses), or the hero's. */
  sub?: SubclassOption;
  /** The call chooses the subclass now (catch-up applies). */
  subclassChosenNow: boolean;
  /** Features taken from the data: an imported class's, and an imported subclass's (with catch-up). */
  features: Omit<Feature, 'id'>[];
  /** "Two classes are named Fighter (SRD 5.2.1, The Gloamwood Almanac); used the hero's own." */
  tie: string | null;
}

const COUNT_WORDS = ['', 'One', 'Two', 'Three', 'Four', 'Five'];

function tieNote(option: ClassOption, classes: readonly ClassOption[], own: boolean): string | null {
  const named = classes.filter((o) => nameKey(o.name) === nameKey(option.name));
  if (named.length < 2) return null;
  const count = COUNT_WORDS[named.length] ?? String(named.length);
  return `${count} classes are named ${option.name} (${named.map(optionSourceLabel).join(', ')}); used ${own ? "the hero's own" : `the one from ${optionSourceLabel(option)}`}.`;
}

/** "Two subclasses of Fighter are named Champion (SRD 5.2.1, The Gloamwood Almanac); used the one from SRD 5.2.1." */
function subclassTieNote(option: ClassOption, sub: SubclassOption | undefined, name: string): string | null {
  const named = option.subclasses.filter((s) => nameKey(s.name) === nameKey(name));
  if (named.length < 2) return null;
  const count = COUNT_WORDS[named.length] ?? String(named.length);
  const used = sub ? `used the one from ${optionSourceLabel(sub)}` : 'used the name only';
  return `${count} subclasses of ${option.name} are named ${named[0].name} (${named.map(optionSourceLabel).join(', ')}); ${used}.`;
}

function planFromData(c: Character, data: BuilderData, input: ToolInput<'level_up'>): DataLevel | null {
  const key = nameKey(input.class_name);
  const existing = c.classes.find((cl) => nameKey(cl.name) === key);
  const option = existing ? classOptionFor(existing, data.classes) : classByName(data.classes, input.class_name, c).option;
  if (!option) return null;
  const classLevel = (existing?.level ?? 0) + 1;
  // Naming the hero's own subclass again chooses nothing: it stays the one its id names (B2), so a book's
  // "Champion" never turns into the SRD's. Only a new name is looked up among the class's subclasses.
  const subclassChosenNow = Boolean(input.subclass) && nameKey(existing?.subclass ?? '') !== nameKey(input.subclass ?? '');
  const sub = subclassChosenNow ? subclassOptionFor({ subclass: input.subclass }, option) : existing ? subclassOptionFor(existing, option) : undefined;
  const all = gainedFeatures(option, classLevel, sub, { scores: c.abilityScores, characterLevel: characterLevel(c) + 1 }, { have: c.features, subclassChosenNow });
  // SRD classes and subclasses keep today's DM-supplied features: only a book's come from the data.
  const features = all.filter((f) => (f.source === 'subclass' ? Boolean(sub?.source) : Boolean(option.source)));
  const ties = [tieNote(option, data.classes, Boolean(existing)), subclassChosenNow ? subclassTieNote(option, sub, input.subclass ?? '') : null];
  return { option, existing, classLevel, sub, subclassChosenNow, features, tie: ties.filter(Boolean).join(' ') || null };
}

/** The DM's new_features as sheet features (as today), minus those the data adds with the book's text. */
function dmFeatures(input: ToolInput<'level_up'>, level: number, plan: DataLevel | null): { features: Omit<Feature, 'id'>[]; replaced: string[] } {
  const fromData = new Set((plan?.features ?? []).map((f) => nameKey(f.name)));
  const all = (input.new_features ?? []).map((f) => ({
    name: f.name,
    description: f.description,
    source: 'class' as const,
    sourceName: `${input.class_name} ${level + 1}`,
    ...(f.uses_max ? { uses: { max: f.uses_max, used: 0 as const, recharge: f.recharge ?? ('long' as const) } } : {}),
  }));
  return { features: all.filter((f) => !fromData.has(nameKey(f.name))), replaced: all.filter((f) => fromData.has(nameKey(f.name))).map((f) => f.name) };
}

/** levelUp's options from the data: the class by id, a new class's numbers and ref, the subclass by id with its ref and casting. */
function dataLevelOptions(plan: DataLevel, data: BuilderData, input: ToolInput<'level_up'>): Partial<LevelUpOptions> {
  const { option, existing, sub } = plan;
  // A subclass chosen now; the hero's own, named again, keeps its id and ref as they are.
  const chosen = plan.subclassChosenNow && sub ? sub : undefined;
  const subclassRef = subclassRefOf(chosen);
  const subclassCasting = subclassCastingOf(chosen);
  const classRef = existing ? undefined : classRefOf(option);
  return {
    className: existing ? input.class_name : option.name,
    classId: existing?.classId ?? option.id,
    ...(existing
      ? {}
      : {
          hitDie: (input.hit_die as HitDie | undefined) ?? option.hitDie,
          casterType: input.caster_type ?? option.casterType,
          ...defined({ spellcastingAbility: input.spellcasting_ability ?? option.spellcastingAbility }),
        }),
    ...(classRef ? { classRef } : {}),
    ...(chosen ? { subclass: chosen.name, subclassId: chosen.id } : {}),
    ...(subclassRef ? { subclassRef } : {}),
    ...(subclassCasting ? { subclassCasting } : {}),
    equipment: data.equipment,
  };
}

/** The result's lines about the books: features added with their text (names only), ties, spells. */
function bookLines(plan: DataLevel | null, replaced: string[], spells: { added: string[]; missing: string[] }): string[] {
  if (!plan) return [];
  const lines: string[] = [];
  const fromBooks = plan.features.filter((f) => f.ref).map((f) => `- ${f.name} (${f.ref?.sourceTitle}) — its text is on the sheet`);
  if (fromBooks.length) lines.push("Features from the player's books (added with their text):", ...fromBooks);
  if (replaced.length) lines.push(`Used the book's text instead of your description for: ${replaced.join(', ')}.`);
  if (plan.tie) lines.push(plan.tie);
  if (spells.added.length && plan.sub) lines.push(`Always-prepared ${plan.sub.name} spells added: ${spells.added.join(', ')}.`);
  if (spells.missing.length) lines.push(`Not in the rules you can consult: ${spells.missing.join(', ')} — add with update_character spells_add if they apply.`);
  return lines;
}

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
  // Merged builder data (a failure → today's behavior exactly), and the index for an imported subclass's spells.
  const data = await loadBuilderOrNull(ctx);
  const plan = data ? planFromData(before, data, input) : null;
  const index = plan?.sub?.source && plan.sub.alwaysPreparedSpells?.length ? await loadIndexOrNull(ctx) : null;
  const findSpell = (name: string) => exactEntry(index, campaign, name, 'spell') ?? undefined;
  const { features: extra, replaced } = dmFeatures(input, level, plan);
  const spells = { added: [] as string[], missing: [] as string[] };
  const change = await mutateCharacter(ctx, (c) => {
    const r = levelUp(c, {
      className: input.class_name,
      hpMethod: input.hp_method ?? 'average',
      rng: ctx.deps.rng,
      ...defined({
        subclass: input.subclass,
        hitDie: input.hit_die as HitDie | undefined,
        casterType: input.caster_type,
        spellcastingAbility: input.spellcasting_ability,
      }),
      ...(plan && data ? dataLevelOptions(plan, data, input) : {}),
      newFeatures: [...(plan?.features ?? []), ...extra],
    });
    if (r.character === c || !plan) return r;
    // The older-edition notes of the class and its subclass (a 2014 subclass chosen now) join the sheet's (B6).
    const noted = withAdaptationNotes(r.character, [plan.option, plan.sub]);
    if (!plan.sub?.source) return noted === r.character ? r : { ...r, character: noted };
    const toAdd = subclassSpellsToAdd(plan.sub, plan.classLevel, noted.spellcasting?.spells ?? [], findSpell);
    spells.added = toAdd.spells.map((sp) => sp.name);
    spells.missing = toAdd.missing;
    return { ...r, character: addSubclassSpells(noted, toAdd.spells) };
  });
  const className = plan && !plan.existing ? plan.option.name : input.class_name;
  const summary = `Level up! Level ${change.newLevel} (${className}) · HP +${change.hpGained} (max ${change.character.hp.max})`;
  const uses = updatedUses(before, change.character);
  const notes = (change.character.adaptationNotes ?? []).filter((n) => !(before.adaptationNotes ?? []).includes(n));
  const books = [...bookLines(plan, replaced, spells), ...(notes.length ? ['Older-edition notes now on the sheet (app notes):', ...notes.map((n) => `- ${n}`)] : [])];
  await logTool(ctx, 'level_up', 'level', summary, { detail: [...eventLines(change.events), ...uses, ...books, ...change.reminders].join('\n') || undefined });
  const lines = [summary, ...eventLines(change.events), ...books];
  if (uses.length) lines.push('Limited-use features that grew with the level (already on the sheet):', ...uses.map((u) => `- ${u}`));
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
