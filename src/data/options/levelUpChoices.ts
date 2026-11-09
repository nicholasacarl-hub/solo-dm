/**
 * Level-up choices from the merged builder data (spec §5.4, D31), pure: a subclass's spellcasting
 * (third casters), the always-prepared spells of an imported subclass, catch-up of earlier subclass
 * features, and the one Feat choice panel — Ability Score Improvement, Epic Boon or Fighting Style —
 * whose default, "Decide with my DM", leaves the level-up exactly as it was before this panel existed.
 *
 * Owner: E4. Shared by the level-up dialog and, for spells and spellcasting, the DM's level_up tool.
 * Only "Level N+" prerequisites are checked; everything else is shown for the DM to rule on.
 */
import { addFeature, addSpell, changeAbilityScore, characterLevel, proficiencyBonus, syncArmorClass } from '@/engine';
import { nameKey } from '@/lib/id';
import { textFingerprint } from '@/lib/importedContent';
import {
  ABILITY_NAMES,
  type Ability,
  type CasterType,
  type Character,
  type ClassFeatureDef,
  type ClassOption,
  type CompendiumEntry,
  type EquipmentOption,
  type FeatOption,
  type Feature,
  type ImportedRef,
  type KnownSpell,
  type SubclassOption,
} from '@/types';
import { abilityIncreaseOf, minLevelOf } from '../structured/normalize/feat';
import { abilityIncreaseSentence } from '../structured/parse/feat';
import { baseFeatureName, findFeatureDef, inlineFightingStyles } from './classFeatures';
import { inferFeatureUses } from './featureUses';
import { optionRef } from './refs';
import { optionSourceLabel } from './resolve';

// ---------------------------------------------------------------------------
// Subclass spellcasting, provenance and catch-up
// ---------------------------------------------------------------------------

/** A subclass that grants Spellcasting makes its class a third caster (SRD 5.2.1 "Multiclassing: Spell Slots"). */
export function subclassCastingOf(sub: SubclassOption | undefined): { casterType: CasterType; spellcastingAbility?: Ability } | undefined {
  if (sub?.casterType !== 'third') return undefined;
  return { casterType: 'third', ...(sub.spellcastingAbility ? { spellcastingAbility: sub.spellcastingAbility } : {}) };
}

/** ClassLevel.subclassRef for an imported subclass (no text copied); undefined for SRD subclasses. */
export function subclassRefOf(sub: SubclassOption | undefined): ImportedRef | undefined {
  return sub ? optionRef(sub, 'subclass') : undefined;
}

/** ClassLevel.ref for a new entry of an imported class; undefined for SRD classes. */
export function classRefOf(cls: ClassOption | undefined): ImportedRef | undefined {
  return cls ? optionRef(cls, 'class') : undefined;
}

const onSheetAsSubclassFeature = (have: readonly Pick<Feature, 'name' | 'source'>[], def: ClassFeatureDef) =>
  have.some((f) => f.source === 'subclass' && nameKey(baseFeatureName(f.name)) === nameKey(def.name));

/**
 * Subclass features from levels below `classLevel` that a subclass chosen now brings with it (SRD 5.2.1
 * "Level Advancement": you gain every subclass feature of your class level or lower), for the
 * "caught up from level N" note.
 */
export function caughtUpFeatures(sub: SubclassOption | undefined, classLevel: number, have: readonly Pick<Feature, 'name' | 'source'>[] = []): ClassFeatureDef[] {
  return sub ? sub.features.filter((d) => d.level < classLevel && !onSheetAsSubclassFeature(have, d)) : [];
}

// ---------------------------------------------------------------------------
// Always-prepared spells of an imported subclass
// ---------------------------------------------------------------------------

/** A spell entry's level: its data, else the summary ("Evocation Cantrip", "Level 2 Evocation"). */
function entrySpellLevel(entry: CompendiumEntry): number | null {
  const raw = entry.data?.level;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 9) return raw;
  const summary = entry.summary ?? '';
  if (/\bcantrip\b/i.test(summary)) return 0;
  const m = /\blevel\s*(\d)\b/i.exec(summary);
  return m ? Number(m[1]) : null;
}

/** A spell entry from an imported book as a KnownSpell's ref (nothing copied: the sheet reads the index). */
export function spellEntryRef(entry: CompendiumEntry): ImportedRef | undefined {
  if (!entry.id.startsWith('lib:')) return undefined;
  return { sourceId: entry.sourceId, sourceTitle: entry.sourceName, entryId: entry.id, kind: 'spell', entryName: entry.name, textHash: '', textCopied: false };
}

/** A sheet spell for a rules-index spell entry: its id, level, flags and (for an imported spell) a ref. */
export function knownSpellFromEntry(entry: CompendiumEntry, extra: Partial<KnownSpell> = {}): KnownSpell | null {
  const level = entrySpellLevel(entry);
  if (level === null) return null;
  const ref = spellEntryRef(entry);
  return {
    id: entry.id,
    name: entry.name,
    level,
    prepared: true,
    ...(entry.data?.ritual === true ? { ritual: true } : {}),
    ...(entry.data?.concentration === true ? { concentration: true } : {}),
    ...(ref ? { ref } : {}),
    ...extra,
  };
}

export interface SubclassSpells {
  /** Always prepared from now on: index ids, levels and refs from the rules index. */
  spells: KnownSpell[];
  /** Names the rules index doesn't have (a book's spell that isn't accepted yet): the DM adds them. */
  missing: string[];
}

/**
 * The always-prepared spells an imported subclass grants up to `classLevel` that the sheet doesn't
 * have yet (spec §5.4). `find` looks a spell up by name in the rules index; SRD subclasses list none.
 */
export function subclassSpellsToAdd(
  sub: SubclassOption | undefined,
  classLevel: number,
  have: readonly Pick<KnownSpell, 'name'>[],
  find: (name: string) => CompendiumEntry | undefined,
): SubclassSpells {
  const out: SubclassSpells = { spells: [], missing: [] };
  if (!sub?.source || !sub.alwaysPreparedSpells?.length) return out;
  const known = new Set(have.map((s) => nameKey(s.name)));
  for (const row of sub.alwaysPreparedSpells) {
    if (row.level > classLevel) continue;
    for (const name of row.spells) {
      const key = nameKey(name);
      if (!key || known.has(key)) continue;
      known.add(key);
      const entry = find(name);
      const spell = entry?.kind === 'spell' ? knownSpellFromEntry(entry, { alwaysPrepared: true, source: sub.name }) : null;
      if (spell) out.spells.push(spell);
      else out.missing.push(name.trim());
    }
  }
  return out;
}

/** Add the subclass's always-prepared spells to the sheet (engine addSpell keeps the index ids). */
export function addSubclassSpells(c: Character, spells: readonly KnownSpell[]): Character {
  let next = c;
  for (const spell of spells) next = addSpell(next, spell).character;
  return next;
}

// ---------------------------------------------------------------------------
// The Feat choice panel
// ---------------------------------------------------------------------------

export type FeatChoiceKind = 'asi' | 'epic-boon' | 'fighting-style';

export interface FeatChoiceTrigger {
  kind: FeatChoiceKind;
  /** The gained feature that offers the choice ("Ability Score Improvement"). */
  featureName: string;
}

const TRIGGERS: Readonly<Record<string, FeatChoiceKind>> = {
  'ability-score-improvement': 'asi',
  'epic-boon': 'epic-boon',
  'fighting-style': 'fighting-style',
};

/** The feat choice a level offers, from the features it gains (Ability Score Improvement, Epic Boon or Fighting Style). */
export function featChoiceTrigger(gained: readonly Pick<Feature, 'name'>[]): FeatChoiceTrigger | null {
  for (const f of gained) {
    const kind = TRIGGERS[nameKey(baseFeatureName(f.name))];
    if (kind) return { kind, featureName: f.name };
  }
  return null;
}

/** "Increase your Wisdom or Charisma score by 1, to a maximum of 20": what a feat raises, and the cap. */
export interface FeatIncrease {
  abilities: Ability[];
  amount: 1 | 2;
  max: number;
}

/** A feat's ability increase: its structured field (imports), else the SRD sentence in its text. */
export function featIncrease(feat: Pick<FeatOption, 'description' | 'abilityIncrease'>): FeatIncrease | undefined {
  const sentence = abilityIncreaseSentence(feat.description.split(/\n{2,}/));
  const parsed = feat.abilityIncrease ?? abilityIncreaseOf(sentence);
  if (!parsed?.abilities.length) return undefined;
  const cap = /\bto a maximum of (\d{2})\b/i.exec(sentence);
  const max = cap ? Math.min(30, Math.max(1, Number(cap[1]))) : 20;
  return { abilities: [...parsed.abilities], amount: parsed.amount, max };
}

/** The level a feat needs ("Level 4+"), the only prerequisite part the app checks. */
export function featMinLevel(feat: Pick<FeatOption, 'minLevel' | 'prerequisite'>): number | undefined {
  return feat.minLevel ?? minLevelOf(feat.prerequisite);
}

/** One option of the panel: a feat, or a fighting style the class feature prints itself. */
export interface FeatPick {
  /** The feat id, or "inline:<name>" for a style the class feature prints. */
  id: string;
  name: string;
  description: string;
  feat?: FeatOption;
  /** "SRD 5.2.1" or the book's title. */
  sourceLabel: string;
  prerequisite?: string;
  minLevel?: number;
  /** False when the character's new level is below minLevel: still selectable, with "My DM allows it". */
  meetsLevel: boolean;
  /** A feat that can't be taken twice and is already on the sheet. */
  taken: boolean;
  increase?: FeatIncrease;
  ref?: ImportedRef;
}

export interface FeatChoiceContext {
  cls?: ClassOption;
  /** The character level after this level-up. */
  characterLevel: number;
  /** Features already on the sheet (non-repeatable feats there are disabled). */
  have: readonly Pick<Feature, 'name' | 'source'>[];
}

const ASI_FEAT = 'ability-score-improvement';

function takenFeat(feat: FeatOption, have: FeatChoiceContext['have']): boolean {
  if (feat.repeatable) return false;
  const key = nameKey(feat.name);
  return have.some((f) => f.source === 'feat' && nameKey(baseFeatureName(f.name)) === key);
}

function featPick(feat: FeatOption, ctx: FeatChoiceContext): FeatPick {
  const minLevel = featMinLevel(feat);
  const increase = featIncrease(feat);
  return {
    id: feat.id,
    name: feat.name,
    description: feat.description,
    feat,
    sourceLabel: optionSourceLabel(feat),
    ...(feat.prerequisite ? { prerequisite: feat.prerequisite } : {}),
    ...(minLevel !== undefined ? { minLevel } : {}),
    meetsLevel: minLevel === undefined || ctx.characterLevel >= minLevel,
    taken: takenFeat(feat, ctx.have),
    ...(increase ? { increase } : {}),
    ...(feat.ref ? { ref: feat.ref } : {}),
  };
}

/** Fighting styles the class feature prints itself, with the feature's ref (the hash of the part copied). */
function inlineStylePicks(cls: ClassOption | undefined): FeatPick[] {
  const def = cls ? findFeatureDef(cls, 'Fighting Style', 20) : undefined;
  return inlineFightingStyles(def).map((o) => ({
    id: `inline:${nameKey(o.name)}`,
    name: o.name,
    description: o.description,
    sourceLabel: cls ? optionSourceLabel(cls) : 'SRD 5.2.1',
    meetsLevel: true,
    taken: false,
    ...(def?.ref ? { ref: { ...def.ref, textHash: textFingerprint(o.description), textCopied: true } } : {}),
  }));
}

/**
 * What the panel offers (spec §5.4): General feats at Ability Score Improvement levels (the Ability
 * Score Improvement feat itself is the +2 / +1 +1 options); Epic Boons and General feats at Epic Boon;
 * Fighting Style feats plus the styles the class feature prints at Fighting Style (a feat wins over a
 * same-named printed style). Every book's feats count, in builder order (SRD first).
 */
export function featChoices(kind: FeatChoiceKind, feats: readonly FeatOption[], ctx: FeatChoiceContext): FeatPick[] {
  const categories: readonly FeatOption['category'][] = kind === 'asi' ? ['general'] : kind === 'epic-boon' ? ['epic-boon', 'general'] : ['fighting-style'];
  const picks = categories.flatMap((category) => feats.filter((f) => f.category === category && nameKey(f.name) !== ASI_FEAT).map((f) => featPick(f, ctx)));
  if (kind !== 'fighting-style') return picks;
  for (const style of inlineStylePicks(ctx.cls)) {
    if (!picks.some((p) => nameKey(p.name) === nameKey(style.name))) picks.push(style);
  }
  return picks;
}

/** Whether the panel's +2 / +1 +1 options apply (Ability Score Improvement and Epic Boon levels). */
export const offersScoreIncrease = (kind: FeatChoiceKind): boolean => kind !== 'fighting-style';

export type FeatChoice =
  | { kind: 'dm' }
  | { kind: 'plus-two'; ability: Ability }
  | { kind: 'plus-one-one'; abilities: [Ability, Ability] }
  | { kind: 'feat'; pick: FeatPick; ability?: Ability };

/** Whether a choice can be applied (two different abilities; an ability for a feat that raises one of several). */
export function featChoiceComplete(choice: FeatChoice): boolean {
  if (choice.kind === 'plus-one-one') return choice.abilities[0] !== choice.abilities[1];
  if (choice.kind === 'feat') {
    const abilities = choice.pick.increase?.abilities ?? [];
    return abilities.length <= 1 || (choice.ability !== undefined && abilities.includes(choice.ability));
  }
  return true;
}

/** "+2 Strength", "+1 Wisdom, +1 Charisma". */
function increaseText(parts: readonly { ability: Ability; amount: number }[]): string {
  return parts.map((p) => `+${p.amount} ${ABILITY_NAMES[p.ability]}`).join(', ');
}

/** "chose: +2 Strength" · "feat: Lantern Bearer (The Gloamwood Almanac)" — names only, for the DM notice. */
export function featChoiceNotice(choice: FeatChoice): string | null {
  switch (choice.kind) {
    case 'dm':
      return null;
    case 'plus-two':
      return `chose: ${increaseText([{ ability: choice.ability, amount: 2 }])}`;
    case 'plus-one-one':
      return `chose: ${increaseText(choice.abilities.map((ability) => ({ ability, amount: 1 })))}`;
    case 'feat': {
      const { pick } = choice;
      if (!pick.feat) return `fighting style: ${pick.name}`;
      return `feat: ${pick.name}${pick.feat.source ? ` (${pick.feat.source.title})` : ''}`;
    }
  }
}

const CHOICE_REMINDER: Readonly<Record<FeatChoiceKind, RegExp>> = {
  asi: /ability score improvement/i,
  'epic-boon': /epic boon/i,
  'fighting-style': /fighting style/i,
};

/** The level-up reminders minus the one the player's choice answers ("…: Ability Score Improvement — raise…"). */
export function dropChoiceReminder(reminders: readonly string[], kind: FeatChoiceKind, choice: FeatChoice): string[] {
  if (choice.kind === 'dm') return [...reminders];
  return reminders.filter((r) => !CHOICE_REMINDER[kind].test(r));
}

export interface ApplyFeatChoiceContext {
  /** "Fighter", the class whose level offered the choice. */
  className: string;
  classLevel: number;
  /** Features the level-up just added (ids not on the sheet before it). */
  addedIds: ReadonlySet<string>;
  /** Builder equipment, so a DEX or CON change keeps AC right (engine syncArmorClass). */
  equipment?: readonly EquipmentOption[];
}

export interface AppliedFeatChoice {
  character: Character;
  /** Engine warnings (a score already at its cap, …). */
  warnings: string[];
}

function raise(c: Character, parts: readonly { ability: Ability; amount: number }[], max: number, warnings: string[]): Character {
  let next = c;
  for (const { ability, amount } of parts) {
    const r = changeAbilityScore(next, ability, amount, max);
    warnings.push(...r.events.filter((e) => e.type === 'warning').map((e) => e.message));
    next = r.character;
  }
  return next;
}

/** The feature the level-up added for the trigger ("Ability Score Improvement", source class). */
function triggerFeature(c: Character, trigger: FeatChoiceTrigger, addedIds: ReadonlySet<string>): Feature | undefined {
  return c.features.find((f) => addedIds.has(f.id) && nameKey(f.name) === nameKey(trigger.featureName));
}

/**
 * Apply the panel's choice after levelUp (spec §5.4): +2 or +1 +1 (cap 20; a CON change changes HP,
 * SRD 5.2.1 "Ability Score Improvement") renames the gained feature "Ability Score Improvement (+2
 * Strength)" as a feat; a feat takes the gained feature's place at Ability Score Improvement and Epic
 * Boon levels (and joins it at Fighting Style, as the builder does) with its text, ref and uses, plus
 * its ability increase. "Decide with my DM" changes nothing.
 */
export function applyFeatChoice(c: Character, trigger: FeatChoiceTrigger, choice: FeatChoice, ctx: ApplyFeatChoiceContext): AppliedFeatChoice {
  const warnings: string[] = [];
  if (choice.kind === 'dm' || !featChoiceComplete(choice)) return { character: c, warnings };
  const placeholder = triggerFeature(c, trigger, ctx.addedIds);
  let next: Character;
  if (choice.kind === 'plus-two' || choice.kind === 'plus-one-one') {
    const parts = choice.kind === 'plus-two' ? [{ ability: choice.ability, amount: 2 }] : choice.abilities.map((ability) => ({ ability, amount: 1 }));
    next = raise(c, parts, 20, warnings);
    const name = `${trigger.featureName} (${increaseText(parts)})`;
    next = placeholder
      ? { ...next, features: next.features.map((f) => (f.id === placeholder.id ? { ...f, name, source: 'feat' as const } : f)) }
      : addFeature(next, { name, source: 'feat', sourceName: `${ctx.className} ${ctx.classLevel}`, description: '' }).character;
  } else {
    const { pick } = choice;
    const sourceName = `${trigger.featureName} (${ctx.className} ${ctx.classLevel})`;
    const inline = !pick.feat;
    // A feat's uses follow the character level; a style the class prints, the class level.
    const level = characterLevel(c);
    const uses = inferFeatureUses(pick.name, pick.description, { level: inline ? ctx.classLevel : level, proficiencyBonus: proficiencyBonus(level), scores: c.abilityScores });
    const feature: Omit<Feature, 'id'> = {
      name: pick.name,
      source: inline ? 'class' : 'feat',
      sourceName,
      description: pick.description,
      ...(uses ? { uses } : {}),
      ...(pick.ref ? { ref: pick.ref } : {}),
    };
    const kept = trigger.kind === 'fighting-style' || !placeholder ? c : { ...c, features: c.features.filter((f) => f.id !== placeholder.id) };
    next = addFeature(kept, feature).character;
    const increase = pick.increase;
    if (increase) {
      const ability = increase.abilities.length === 1 ? increase.abilities[0] : choice.ability;
      if (ability) next = raise(next, [{ ability, amount: increase.amount }], increase.max, warnings);
    }
  }
  const ac = syncArmorClass(c, next, ctx.equipment ?? []);
  warnings.push(...ac.events.filter((e) => e.type === 'warning').map((e) => e.message));
  return { character: ac.character, warnings };
}
