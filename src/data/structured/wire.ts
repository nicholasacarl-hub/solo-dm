/**
 * What Claude and the offline parser both return, one schema per kind. Rules (guarded by
 * src/dm/extract/format.test.ts): every property required; no optional, nullable or union property;
 * numbers are z.number() (the app checks integrality and ranges); enum values are lowercase;
 * no .describe() (guidance lives in the cached system prompt); no book text anywhere.
 * Sentinels: "" text, [] lists, 0 numbers, false booleans, "none"/"unknown" enum members,
 * { block: "", from: 0, to: 0 } for "no text".
 *
 * CONTRACT (Day 0). A pure leaf: imports only zod and @/types, so src/dm/libraryRequests.ts and
 * src/dm/extract/** can import it without the @/data barrel. Any change bumps EXTRACT_PROMPT_VERSION.
 */
import { z } from 'zod';
import type { StructuredKind } from '@/types';

const t = z.string();
const n = z.number();
const b = z.boolean();
const names = z.array(z.string());
const ability = z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha', 'none']);
const format = z.enum(['2024', '2014', 'other']);
const span = z.object({ block: t, from: n, to: n });
const named = z.object({ name: t, text: span });
const feature = z.object({ level: n, name: t, text: span });
const head = { matchesKind: b, name: t, format };   // first in every kind: the model decides these first

export const WIRE = {
  monster: z.object({
    ...head,
    sizeText: t, typeText: t, alignmentText: t, acText: t, hpText: t, speedText: t, initiativeText: t, crText: t,
    abilityScores: z.object({ str: n, dex: n, con: n, int: n, wis: n, cha: n }),
    sensesText: t, languagesText: t, resistancesText: t, immunitiesText: t, vulnerabilitiesText: t,
    reachText: t, legendary: b, notes: t,
  }),
  spell: z.object({
    ...head,
    levelText: t, level: n,
    school: z.enum(['abjuration', 'conjuration', 'divination', 'enchantment', 'evocation', 'illusion',
      'necromancy', 'transmutation', 'unknown']),
    classesText: t, castingTimeText: t, rangeText: t, componentsText: t, durationText: t,
    ritual: b, concentration: b, areaText: t, saveAbility: ability,
    attack: z.enum(['melee', 'ranged', 'none']), damageText: t, cantripScalingText: t, notes: t,
  }),
  'magic-item': z.object({
    ...head,
    typeLineText: t,
    category: z.enum(['armor', 'shield', 'weapon', 'ammunition', 'potion', 'ring', 'rod', 'scroll', 'staff', 'wand',
      'wondrous-item', 'other']),
    rarity: z.enum(['common', 'uncommon', 'rare', 'very rare', 'legendary', 'artifact', 'varies', 'unknown']),
    attunement: z.enum(['none', 'required', 'required-by']), attunementText: t, baseItemText: t,
    acBonus: n, saveBonus: n, attackBonus: n, damageBonus: n, bonusText: t,
    acCondition: z.enum(['always', 'no-armor', 'no-armor-no-shield']),
    chargesText: t, notes: t,
  }),
  item: z.object({
    ...head,
    items: z.array(z.object({
      name: t,
      category: z.enum(['weapon', 'armor', 'shield', 'gear', 'tool', 'pack']),
      costText: t, weightText: t,
      weaponCategory: z.enum(['simple', 'martial', 'none']), weaponType: z.enum(['melee', 'ranged', 'none']),
      damageText: t, propertiesText: t, masteryText: t,
      armorType: z.enum(['light', 'medium', 'heavy', 'none']), acText: t, strengthText: t, stealthDisadvantage: b,
    })),
    notes: t,
  }),
  feat: z.object({
    ...head,
    categoryText: t,
    category: z.enum(['origin', 'general', 'fighting-style', 'epic-boon', 'unknown']),
    prerequisiteText: t, repeatable: b, abilityIncreaseText: t, notes: t,
  }),
  background: z.object({
    ...head,
    abilityScoresText: t, featText: t, skillsText: t, toolText: t, equipmentText: t, languagesText: t,
    legacyFeature: named, notes: t,
  }),
  species: z.object({
    ...head,
    creatureTypeText: t, sizeText: t, speedText: t, darkvisionText: t,
    traits: z.array(named), lineageTraitName: t, lineages: z.array(named),
    abilityIncreasesText: t, languagesText: t, notes: t,
  }),
  class: z.object({
    ...head,
    primaryAbilityText: t, hitDieText: t, savingThrowsText: t, skillsText: t, weaponsText: t, armorText: t,
    toolsText: t, equipmentText: t,
    casterType: z.enum(['full', 'half', 'third', 'pact', 'none']), spellcastingAbility: ability,
    preparedSpellsText: t, spellListText: t, subclassLevel: n,
    levelTable: z.array(z.object({ header: t, values: names })),
    features: z.array(feature), notes: t,
  }),
  subclass: z.object({
    ...head,
    parentClassText: t, taglineText: t,
    features: z.array(feature),
    casterType: z.enum(['third', 'none']), spellcastingAbility: ability,
    alwaysPreparedSpells: z.array(z.object({ level: n, spells: names })), notes: t,
  }),
} as const satisfies Record<StructuredKind, z.ZodObject>;
export type Wire<K extends StructuredKind> = z.infer<(typeof WIRE)[K]>;
