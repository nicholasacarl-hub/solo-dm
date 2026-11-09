/**
 * Merged builder data (spec §5.1, pure): accepted option records → builder options (ids = publicId,
 * descriptions = the book's words via featureText, a ref on every copied text), attached to the SRD
 * without mutating it (an SRD class that gains subclasses is shallow-cloned once).
 *
 * Owner: E4. Rules: only accepted, valid records of switched-on books (the snapshot); explicit fields win;
 * same names coexist (lookups go through options/resolve.ts); SRD first in builder.json order, then
 * imports grouped by book title, then by name; problems are reported, never thrown.
 */
import { ABILITY_NAMES, SKILL_NAMES } from '@/types';
import type {
  Adaptation,
  BackgroundData,
  BackgroundOption,
  BuilderData,
  ClassData,
  ClassFeatureDef,
  ClassOption,
  CompendiumEntry,
  EquipmentOption,
  FeatData,
  FeatOption,
  FeatureData,
  ImportedRef,
  ItemData,
  LibrarySource,
  MagicItemData,
  OptionSource,
  SpeciesData,
  SpeciesOption,
  SpeciesTrait,
  StructuredKind,
  StructuredRecord,
  SubclassData,
  SubclassOption,
  TextSpan,
  TraitData,
} from '@/types';
import { findEquipment } from '../options/resolve';
import { refFor, spanLocation } from '../options/refs';
import type { LibrarySnapshot } from '../rulesIndexStore';
import { adaptation, withAdaptations } from './adaptations';
import { featureText, resolveSpan } from './paragraphs';
import { firstParagraphs, lineageRowText, splitRow } from './parse/srdRulesOptions';

export interface MergeProblem { recordId: string; sourceTitle: string; kind: StructuredKind; name: string; message: string }

/** A magic item waiting for the catalog: mergeBuilderData finds its base (same book → SRD → other books). */
export interface ImportedMagicItem {
  /** id, name, source, and the category the catalog would give it. */
  option: EquipmentOption;
  data: MagicItemData;
}

export interface ImportedOptions {
  classes: ClassOption[];
  /** `parentClassName`: the class as printed, for the problem when the parent isn't available. */
  subclasses: { option: SubclassOption; parentClassId: string; parentClassName?: string }[];
  species: SpeciesOption[]; backgrounds: BackgroundOption[]; feats: FeatOption[]; equipment: EquipmentOption[];
  /** Magic items that may join the catalog (§5.1 rule 7); resolved against the merged catalog. */
  magicItems?: ImportedMagicItem[];
  problems: MergeProblem[];
}

// ---------------------------------------------------------------------------
// Reading one record
// ---------------------------------------------------------------------------

interface RecordContext {
  record: StructuredRecord;
  source: LibrarySource;
  option: { id: string; name: string; source: OptionSource };
  entriesById: ReadonlyMap<string, CompendiumEntry>;
  problems: MergeProblem[];
}

function problem(ctx: Pick<RecordContext, 'record' | 'source' | 'problems'>, message: string): void {
  ctx.problems.push({ recordId: ctx.record.id, sourceTitle: ctx.source.title, kind: ctx.record.kind, name: ctx.record.name, message });
}

/** The book's words for a part and their ref (§7.1); a span that no longer resolves leaves the text empty. */
function copiedText(ctx: RecordContext, span: TextSpan, part: string | undefined, level?: number): { description: string; ref?: ImportedRef } {
  const text = featureText(span, part ?? ctx.record.name, ctx.entriesById);
  if (text === null) {
    problem(ctx, `The text of ${part ?? ctx.record.name} couldn't be found in the book; the sheet shows its name only.`);
    return { description: '', ...withRef(refFor(ctx.option, ctx.record.kind, part, level)) };
  }
  const ref = refFor(ctx.option, ctx.record.kind, part, level, { text, at: spanLocation(span), bookFingerprint: ctx.source.fingerprint });
  return { description: text, ...withRef(ref) };
}

const withRef = (ref: ImportedRef | undefined) => (ref ? { ref } : {});

function featureDef(ctx: RecordContext, f: FeatureData): ClassFeatureDef {
  const { description, ref } = copiedText(ctx, f.text, f.name, f.level);
  const summary = description ? firstParagraphs(description, 300) : undefined;
  return { level: f.level, name: f.name, description, ...(summary ? { summary } : {}), ...withRef(ref) };
}

function trait(ctx: RecordContext, t: TraitData): SpeciesTrait {
  const { description, ref } = copiedText(ctx, t.text, t.name);
  return { name: t.name, description, ...withRef(ref) };
}

/** A lineage printed as one table row: the SRD-style text built from its cells ("… Level 3: X. Level 5: Y."). */
function tableRowLineage(ctx: RecordContext, name: string, span: TextSpan): SpeciesTrait | null {
  const row = resolveSpan(span, ctx.entriesById);
  if (row === null || !row.trim().startsWith('|')) return null;
  const description = lineageRowText(splitRow(row));
  if (!description) return null;
  const ref = refFor(ctx.option, ctx.record.kind, name, undefined, { text: description, at: spanLocation(span), bookFingerprint: ctx.source.fingerprint });
  return { name, description, ...withRef(ref) };
}

const CASTER_LABEL: Readonly<Record<ClassData['casterType'], string | null>> = {
  full: 'Full caster',
  half: 'Half caster',
  third: 'Third caster',
  pact: 'Pact Magic',
  none: null,
};

function classSummary(d: ClassData): string {
  const caster = CASTER_LABEL[d.casterType];
  return [
    `d${d.hitDie} Hit Die`,
    caster ? `${caster}${d.spellcastingAbility ? ` (${ABILITY_NAMES[d.spellcastingAbility]})` : ''}` : null,
    `Subclass at level ${d.subclassLevel}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

function classOption(ctx: RecordContext, d: ClassData): ClassOption {
  return {
    ...ctx.option,
    summary: classSummary(d),
    hitDie: d.hitDie,
    primaryAbilities: [...d.primaryAbilities],
    savingThrows: [...d.savingThrows],
    skillChoices: { count: d.skillChoices.count, from: [...d.skillChoices.from] },
    weaponProficiencies: [...d.weaponProficiencies],
    armorTraining: [...d.armorTraining],
    tools: [...d.tools],
    casterType: d.casterType,
    ...(d.spellcastingAbility ? { spellcastingAbility: d.spellcastingAbility } : {}),
    weaponMasteryCount: d.weaponMasteryCount,
    startingEquipment: d.startingEquipment.map((p) => ({ ...p, items: p.items.map((i) => ({ ...i })) })),
    subclassLevel: d.subclassLevel,
    features: d.features.map((f) => featureDef(ctx, f)),
    subclasses: [],
    levelTable: d.levelTable.map((row) => ({ ...row })),
    primaryAbilityRule: d.primaryAbilityRule,
    ...(d.spellListName ? { spellListName: d.spellListName } : {}),
    ...(d.spellNames?.length ? { spellNames: [...d.spellNames] } : {}),
  };
}

function subclassOption(ctx: RecordContext, d: SubclassData): SubclassOption {
  const levels = d.features.map((f) => f.level);
  return {
    ...ctx.option,
    summary: d.summary,
    features: d.features.map((f) => featureDef(ctx, f)),
    ...(levels.length ? { firstLevel: Math.min(...levels) } : {}),
    ...(d.casterType ? { casterType: d.casterType } : {}),
    ...(d.spellcastingAbility ? { spellcastingAbility: d.spellcastingAbility } : {}),
    ...(d.alwaysPreparedSpells?.length ? { alwaysPreparedSpells: d.alwaysPreparedSpells.map((s) => ({ level: s.level, spells: [...s.spells] })) } : {}),
  };
}

function speciesSummary(d: SpeciesData): string {
  return [`${d.sizes.join(' or ')} ${d.creatureType}`, `Speed ${d.speed} ft.`, d.darkvision ? `Darkvision ${d.darkvision} ft.` : null]
    .filter(Boolean)
    .join(' · ');
}

function speciesOption(ctx: RecordContext, d: SpeciesData): SpeciesOption {
  const lineages = (d.lineages ?? []).map((l) => (l.form === 'table-row' ? tableRowLineage(ctx, l.name, l.text) : null) ?? trait(ctx, l));
  return {
    ...ctx.option,
    summary: speciesSummary(d),
    creatureType: d.creatureType,
    sizes: [...d.sizes],
    speed: d.speed,
    ...(d.darkvision ? { darkvision: d.darkvision } : {}),
    traits: d.traits.map((t) => trait(ctx, t)),
    ...(lineages.length ? { lineages } : {}),
    ...(d.lineageTrait ? { lineageTrait: d.lineageTrait } : {}),
    ...(d.legacyAbilityIncreases?.length ? { legacyAbilityIncreases: d.legacyAbilityIncreases.map((a) => ({ ...a })) } : {}),
    ...(d.languages?.length ? { languages: [...d.languages] } : {}),
  };
}

const ABILITY_SHORT = (a: keyof typeof ABILITY_NAMES) => ABILITY_NAMES[a].slice(0, 3);

function backgroundSummary(d: BackgroundData): string {
  return [
    d.abilityScores.length ? d.abilityScores.map(ABILITY_SHORT).join(', ') : 'Any three abilities',
    d.feat || 'Origin feat: your choice',
    d.skills.map((s) => SKILL_NAMES[s]).join(', '),
  ]
    .filter(Boolean)
    .join(' · ');
}

function backgroundOption(ctx: RecordContext, d: BackgroundData): BackgroundOption {
  return {
    ...ctx.option,
    summary: backgroundSummary(d),
    abilityScores: [...d.abilityScores],
    feat: d.feat,
    skills: [...d.skills],
    tool: d.tool,
    equipment: d.equipment.map((p) => ({ ...p, items: p.items.map((i) => ({ ...i })) })),
    ...(d.abilityScores.length ? {} : { abilityChoice: 'any' as const }),
    ...(d.feat ? {} : { featChoice: true }),
    ...(d.languages?.length ? { languages: [...d.languages] } : {}),
    ...(d.legacyFeature ? { legacyFeature: trait(ctx, d.legacyFeature) } : {}),
  };
}

function featOption(ctx: RecordContext, d: FeatData): FeatOption {
  const { description, ref } = copiedText(ctx, d.text, undefined);
  return {
    ...ctx.option,
    category: d.category,
    ...(d.prerequisite ? { prerequisite: d.prerequisite } : {}),
    ...(d.repeatable ? { repeatable: true } : {}),
    description,
    ...(d.minLevel !== undefined ? { minLevel: d.minLevel } : {}),
    ...(d.abilityIncrease ? { abilityIncrease: { abilities: [...d.abilityIncrease.abilities], amount: d.abilityIncrease.amount } } : {}),
    ...withRef(ref),
  };
}

function itemOption(ctx: RecordContext, d: ItemData): EquipmentOption {
  const { format: _format, ...fields } = d;
  return { ...ctx.option, ...fields, ...(fields.properties ? { properties: [...fields.properties] } : {}) };
}

const MAGIC_CATALOG_CATEGORY: Partial<Record<MagicItemData['category'], EquipmentOption['category']>> = {
  armor: 'armor',
  shield: 'shield',
  weapon: 'weapon',
};

function magicItem(ctx: RecordContext, d: MagicItemData): ImportedMagicItem {
  return { option: { ...ctx.option, category: MAGIC_CATALOG_CATEGORY[d.category] ?? 'gear' }, data: d };
}

/**
 * Builder options from the accepted, valid records of switched-on books (§5.1). Subclasses aren't
 * attached here (mergeBuilderData does it, on a copy of their parent); magic items wait for the catalog.
 */
export function importedOptions(snapshot: LibrarySnapshot): ImportedOptions {
  const out: Required<ImportedOptions> = {
    classes: [], subclasses: [], species: [], backgrounds: [], feats: [], equipment: [], magicItems: [], problems: [],
  };
  const sources = new Map(snapshot.sources.map((s) => [s.id, s]));
  for (const record of snapshot.accepted) {
    const source = sources.get(record.sourceId);
    if (!source || record.status !== 'accepted' || !record.data) continue;
    const data = record.data;
    const ctx: RecordContext = {
      record,
      source,
      option: {
        id: record.publicId,
        name: record.name,
        source: { sourceId: source.id, title: source.title, recordId: record.id, format: data.format, adaptations: record.adaptations.map((a) => ({ ...a })) },
      },
      entriesById: snapshot.entriesById,
      problems: out.problems,
    };
    switch (record.kind) {
      case 'class':
        out.classes.push(classOption(ctx, data as ClassData));
        break;
      case 'subclass': {
        const sub = data as SubclassData;
        if (!record.parentClassId) {
          problem(ctx, `Choose the class ${record.name} belongs to on the book page before it can be used.`);
          break;
        }
        out.subclasses.push({ option: subclassOption(ctx, sub), parentClassId: record.parentClassId, parentClassName: sub.parentClass });
        break;
      }
      case 'species':
        out.species.push(speciesOption(ctx, data as SpeciesData));
        break;
      case 'background':
        out.backgrounds.push(backgroundOption(ctx, data as BackgroundData));
        break;
      case 'feat':
        out.feats.push(featOption(ctx, data as FeatData));
        break;
      case 'item':
        out.equipment.push(itemOption(ctx, data as ItemData));
        break;
      case 'magic-item':
        out.magicItems.push(magicItem(ctx, data as MagicItemData));
        break;
      default:
        break; // spells and monsters live in the rules index only
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merging onto the SRD
// ---------------------------------------------------------------------------

type Sourced = { name: string; source?: OptionSource };

/** Imports grouped by book title, then by name (the build script's byName order). */
function byBookThenName(a: Sourced, b: Sourced): number {
  return (
    (a.source?.title ?? '').localeCompare(b.source?.title ?? '', 'en') ||
    a.name.localeCompare(b.name, 'en') ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );
}

const sorted = <T extends Sourced>(list: readonly T[]) => [...list].sort(byBookThenName);

/**
 * A subclass as attached to its parent (§5.1 rule 5): features printed below the parent's subclass level
 * arrive at that level (subclass-early-features), and an older-format subclass on an SRD class notes the
 * possible overlap (subclass-overlap). `firstLevel` keeps the printed level; the option itself is untouched.
 */
function placedSubclass(sub: SubclassOption, parent: ClassOption): SubclassOption {
  const level = parent.subclassLevel;
  const early = sub.features.some((f) => f.level < level);
  const overlap = sub.source?.format === '2014' && !parent.source;
  if (!early && !overlap) return sub;
  const notes: Adaptation[] = [];
  if (early) notes.push(adaptation('subclass-early-features', { name: sub.name, className: parent.name, level }));
  if (overlap) notes.push(adaptation('subclass-overlap', { name: sub.name, className: parent.name }));
  const features = early
    ? sub.features.map((f) => (f.level >= level ? f : { ...f, level, ...(f.ref ? { ref: { ...f.ref, level } } : {}) }))
    : sub.features;
  return {
    ...sub,
    features,
    ...(sub.source ? { source: { ...sub.source, adaptations: withAdaptations(sub.source.adaptations, notes) } } : {}),
  };
}

const problemOf = (option: { name: string; source?: OptionSource }, kind: StructuredKind, message: string): MergeProblem => ({
  recordId: option.source?.recordId ?? '',
  sourceTitle: option.source?.title ?? '',
  kind,
  name: option.name,
  message,
});

/** §5.1 rule 7: a magic item joins the catalog with its base's stats, as gear carrying its bonuses, or not at all. */
function catalogMagicItem(item: ImportedMagicItem, mundane: readonly EquipmentOption[]): EquipmentOption | null {
  const { option, data } = item;
  const magic = {
    rarity: data.rarity,
    attunement: data.attunement,
    ...(data.bonuses ? { bonuses: { ...data.bonuses } } : {}),
  };
  const category = MAGIC_CATALOG_CATEGORY[data.category];
  if (category) {
    const base = data.baseItem ? findEquipment(data.baseItem, mundane, option.source?.sourceId)?.option : undefined;
    if (!base || base.category !== category) return null;
    const { source: _baseSource, magic: _baseMagic, ...stats } = base;
    return { ...stats, ...(stats.properties ? { properties: [...stats.properties] } : {}), id: option.id, name: option.name, source: option.source, magic: { ...magic, baseItemId: base.id } };
  }
  if (data.bonuses?.ac || data.bonuses?.savingThrows) return { id: option.id, name: option.name, source: option.source, category: 'gear', magic };
  return null;
}

/** Never mutates `srd` (the cached builder.json object); an SRD class that gains subclasses is shallow-cloned once. */
export function mergeBuilderData(srd: BuilderData, imported: ImportedOptions): { data: BuilderData; problems: MergeProblem[] } {
  const problems = [...imported.problems];
  const magicItems = imported.magicItems ?? [];
  const any =
    imported.classes.length + imported.subclasses.length + imported.species.length + imported.backgrounds.length +
    imported.feats.length + imported.equipment.length + magicItems.length;
  if (!any) return { data: srd, problems };

  const importedClasses = sorted(imported.classes);
  const parents = new Map([...srd.classes, ...importedClasses].map((c) => [c.id, c]));
  const attachTo = new Map<string, SubclassOption[]>();
  for (const sub of [...imported.subclasses].sort((a, b) => byBookThenName(a.option, b.option))) {
    const parent = parents.get(sub.parentClassId);
    if (!parent) {
      const name = sub.parentClassName?.trim() || 'its class';
      problems.push(problemOf(sub.option, 'subclass', `Its class, ${name}, isn't accepted yet or its book is switched off.`));
      continue;
    }
    attachTo.set(parent.id, [...(attachTo.get(parent.id) ?? []), placedSubclass(sub.option, parent)]);
  }
  const attach = (cls: ClassOption): ClassOption => {
    const subs = attachTo.get(cls.id);
    return subs ? { ...cls, subclasses: [...cls.subclasses, ...subs] } : cls;
  };

  const mundane = [...srd.equipment, ...imported.equipment];
  const magic = magicItems.map((m) => catalogMagicItem(m, mundane)).filter((o): o is EquipmentOption => o !== null);
  return {
    data: {
      classes: [...srd.classes.map(attach), ...importedClasses.map(attach)],
      species: [...srd.species, ...sorted(imported.species)],
      backgrounds: [...srd.backgrounds, ...sorted(imported.backgrounds)],
      feats: [...srd.feats, ...sorted(imported.feats)],
      equipment: [...srd.equipment, ...sorted([...imported.equipment, ...magic])],
    },
    problems,
  };
}
