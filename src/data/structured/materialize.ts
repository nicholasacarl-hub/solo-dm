/**
 * Materialized index entries (spec §6.1, pure): accepted records become SRD-shaped rules-index entries
 * on read, beside the raw chunks (records beside entries, D1). Nothing here is stored: un-accepting,
 * switching a book off or deleting it reverts the index by construction.
 *
 * - span `entry`: the primary chunk, same id, re-kinded and re-named, its part chain rejoined; the other
 *   parts leave the index and become `data.aliasIds`.
 * - span `section`, species / background: one entry `publicId` with the section's text (headings
 *   re-levelled like chunk.ts renderSection); the section's chunks leave the index (aliases).
 * - span `section`, class / subclass: one entry `publicId` with the overview blocks; feature blocks stay
 *   as `rule` entries carrying the SRD's class-feature shape `{ class, classId, level, subclass?, subclassId? }`.
 * - span `row`: one app-written `item` entry `publicId` after its table, which stays a rule.
 * - span `table` (unread): nothing.
 *
 * Every materialized entry's `data` holds the SRD-shaped fields consumers read (public/srd/compendium.json),
 * plus `recordId`, `adaptations` (the app-written notes, for the stats line), `aliasIds` when it replaces
 * chunks, and the few extra fields the stats line needs (`subclassLevel`, `featureLevels`, `lineages`,
 * `abilityIncrease`, `minLevel`). Summaries and item texts are written by the app in the SRD's style.
 */
import {
  ABILITY_NAMES,
  STRUCTURED_SCHEMA_VERSION,
  SKILL_NAMES,
  type Ability,
  type BackgroundData,
  type ClassData,
  type CompendiumEntry,
  type FeatData,
  type ItemData,
  type LibrarySource,
  type MagicItemData,
  type MonsterData,
  type Skill,
  type SpeciesData,
  type SpellData,
  type StructuredRecord,
  type SubclassData,
} from '@/types';
import { DATA_SCHEMAS } from './schemas';

type Data = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Shared formatting (also used by statsLine.ts)
// ---------------------------------------------------------------------------

/** "+2", "−1" (true minus), "+0". */
export function signed(n: number): string {
  return n < 0 ? `−${Math.abs(n)}` : `+${n}`;
}

/** "12 GP", "5 SP", "2 CP" from a price in gold pieces. */
export function costText(gp: number): string {
  if (Number.isInteger(gp)) return `${gp} GP`;
  const sp = Math.round(gp * 10 * 1000) / 1000;
  if (Number.isInteger(sp)) return `${sp} SP`;
  return `${Math.round(gp * 100)} CP`;
}

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const titleCase = (s: string) => s.split(/([\s-])/).map((w) => (/^[\s-]$/.test(w) ? w : capitalize(w))).join('');
const abilityShort = (a: Ability) => capitalize(a);
/** Drop undefined values (and nothing else). */
function defined<T extends Data>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** True for an entry materialized from an accepted record (data.recordId is a string). SRD entries never are. */
export function isReviewedImport(entry: CompendiumEntry): boolean {
  return typeof entry.data?.recordId === 'string';
}

/** Enabled entries + accepted, valid records → index entries in reading order. No accepted records → `entries` itself. */
export function materializeEntries(entries: CompendiumEntry[], accepted: StructuredRecord[], sources: LibrarySource[]): CompendiumEntry[] {
  if (accepted.length === 0) return entries;
  const byId = new Map(entries.map((e) => [e.id, e]));
  const enabled = new Set(sources.map((s) => s.id));
  const usable = accepted
    .filter((r) => isMaterializable(r, enabled, byId))
    .sort(byReadingOrder);
  if (usable.length === 0) return entries;

  const plan = new Plan();
  const subclassNames = subclassesByParent(usable);
  for (const record of usable) {
    switch (record.span) {
      case 'entry':
        planEntry(plan, record, byId);
        break;
      case 'section':
        if (record.kind === 'class' || record.kind === 'subclass') planClassSection(plan, record, byId, subclassNames);
        else planSection(plan, record, byId);
        break;
      case 'row':
        planRow(plan, record, byId);
        break;
      default:
        break; // 'table': its rows stand for it
    }
  }
  return plan.apply(entries);
}

function isMaterializable(r: StructuredRecord, enabled: ReadonlySet<string>, byId: ReadonlyMap<string, CompendiumEntry>): boolean {
  if (r.status !== 'accepted' || r.data === null || r.span === 'table') return false;
  if (!enabled.has(r.sourceId) || r.schemaVersion > STRUCTURED_SCHEMA_VERSION) return false;
  if (!r.entryIds.length || !byId.has(r.entryIds[0])) return false;
  if (r.kind === 'subclass' && !r.parentClassId) return false;
  return (DATA_SCHEMAS[r.kind] as { safeParse(v: unknown): { success: boolean } }).safeParse(r.data).success;
}

const ordinal = (id: string | undefined): number => {
  const parts = (id ?? '').split(':');
  return parts.length === 3 && /^\d+$/.test(parts[2]) ? Number(parts[2]) : Number.MAX_SAFE_INTEGER;
};

function byReadingOrder(a: StructuredRecord, b: StructuredRecord): number {
  const row = (r: StructuredRecord) => (r.span === 'row' ? (r.rowIndex ?? 0) + 1 : 0);
  return (
    a.sourceId.localeCompare(b.sourceId) ||
    ordinal(a.entryIds[0]) - ordinal(b.entryIds[0]) ||
    row(a) - row(b) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Accepted subclass names by their parent class option id (for a class entry's `subclasses`). */
function subclassesByParent(records: readonly StructuredRecord[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of records) {
    if (r.kind !== 'subclass' || !r.parentClassId) continue;
    out.set(r.parentClassId, [...(out.get(r.parentClassId) ?? []), r.name]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The plan: what replaces, hides, enriches or follows each chunk
// ---------------------------------------------------------------------------

class Plan {
  private readonly claimed = new Set<string>();
  private readonly replace = new Map<string, CompendiumEntry>();
  private readonly hide = new Set<string>();
  private readonly enrich = new Map<string, CompendiumEntry>();
  private readonly after = new Map<string, CompendiumEntry[]>();

  isClaimed(id: string): boolean {
    return this.claimed.has(id);
  }

  /** Claim chunks; the first is replaced by `entry`, the rest leave the index. */
  replaceChunks(ids: readonly string[], entry: CompendiumEntry): void {
    ids.forEach((id, i) => {
      this.claimed.add(id);
      if (i === 0) this.replace.set(id, entry);
      else this.hide.add(id);
    });
  }

  enrichChunk(id: string, entry: CompendiumEntry): void {
    this.claimed.add(id);
    this.enrich.set(id, entry);
  }

  append(afterId: string, entry: CompendiumEntry): void {
    this.after.set(afterId, [...(this.after.get(afterId) ?? []), entry]);
  }

  apply(entries: readonly CompendiumEntry[]): CompendiumEntry[] {
    const out: CompendiumEntry[] = [];
    for (const e of entries) {
      const replaced = this.replace.get(e.id);
      if (replaced) out.push(replaced);
      else if (!this.hide.has(e.id)) out.push(this.enrich.get(e.id) ?? e);
      out.push(...(this.after.get(e.id) ?? []));
    }
    return out;
  }
}

/** The record's chunks that exist and no earlier record claimed, in its order (null when its primary is gone). */
function freeChunks(plan: Plan, record: StructuredRecord, byId: ReadonlyMap<string, CompendiumEntry>, ids = record.entryIds): CompendiumEntry[] | null {
  if (plan.isClaimed(record.entryIds[0])) return null;
  return [...new Set(ids)].flatMap((id) => {
    const e = byId.get(id);
    return e && !plan.isClaimed(id) ? [e] : [];
  });
}

/** The chunk's path with its own (chunk) name replaced by `name`. */
function renamedPath(chunk: CompendiumEntry, name: string): string[] | undefined {
  if (!chunk.path?.length) return undefined;
  const path = [...chunk.path];
  if (path[path.length - 1] === chunk.name) path[path.length - 1] = name;
  return path;
}

function recordData(record: StructuredRecord, extra: Data = {}): Data {
  return {
    ...kindData(record),
    ...extra,
    recordId: record.id,
    adaptations: record.adaptations.map((a) => a.note),
  };
}

function materialized(record: StructuredRecord, primary: CompendiumEntry, id: string, text: string, extra: Data = {}): CompendiumEntry {
  const path = renamedPath(primary, record.name);
  const summary = summaryFor(record);
  return {
    id,
    sourceId: primary.sourceId,
    sourceName: primary.sourceName,
    kind: record.kind,
    name: record.name,
    ...(summary ? { summary } : {}),
    text,
    ...(path ? { path } : {}),
    data: recordData(record, extra),
  };
}

function planEntry(plan: Plan, record: StructuredRecord, byId: ReadonlyMap<string, CompendiumEntry>): void {
  const chunks = freeChunks(plan, record, byId);
  if (!chunks?.length) return;
  const aliasIds = chunks.slice(1).map((c) => c.id);
  const text = chunks.map((c) => c.text).join('\n\n');
  const entry = materialized(record, chunks[0], chunks[0].id, text, aliasIds.length ? { aliasIds } : {});
  plan.replaceChunks(chunks.map((c) => c.id), entry);
}

const PART = /^(.*) \(part (\d+)\)$/;

/** A section's text from its chunks: descendant headings re-levelled to start at ### (chunk.ts renderSection). */
export function sectionText(chunks: readonly CompendiumEntry[]): string {
  if (!chunks.length) return '';
  const depthOf = (c: CompendiumEntry) => (c.path?.length ? c.path.length : 1);
  const rootDepth = depthOf(chunks[0]);
  const parts: string[] = [chunks[0].text.trim()];
  for (let i = 1; i < chunks.length; i++) {
    const c = chunks[i];
    const part = PART.exec(c.name);
    const prev = chunks[i - 1];
    const prevBase = PART.exec(prev.name)?.[1] ?? prev.name;
    if (part && part[1] === prevBase) {
      parts.push(c.text.trim());
      continue;
    }
    const depth = Math.max(1, depthOf(c) - rootDepth);
    parts.push(`${'#'.repeat(Math.min(6, depth + 2))} ${c.name}`, c.text.trim());
  }
  return parts.filter(Boolean).join('\n\n');
}

function planSection(plan: Plan, record: StructuredRecord, byId: ReadonlyMap<string, CompendiumEntry>): void {
  const chunks = freeChunks(plan, record, byId);
  if (!chunks?.length) return;
  const entry = materialized(record, chunks[0], record.publicId, sectionText(chunks), { aliasIds: chunks.map((c) => c.id) });
  plan.replaceChunks(chunks.map((c) => c.id), entry);
}

function planClassSection(
  plan: Plan,
  record: StructuredRecord,
  byId: ReadonlyMap<string, CompendiumEntry>,
  subclassNames: ReadonlyMap<string, string[]>,
): void {
  const data = record.data as ClassData | SubclassData;
  const primaryId = record.entryIds[0];
  // Blocks a feature's span points into (never the overview's first block) stay as their own rule entries.
  const featureIds = new Set(data.features.flatMap((f) => f.text.entryIds).filter((id) => id !== primaryId && record.entryIds.includes(id)));
  const overview = freeChunks(plan, record, byId, record.entryIds.filter((id) => !featureIds.has(id)));
  if (!overview?.length) return;
  const extra: Data =
    record.kind === 'class'
      ? { subclasses: subclassNames.get(record.publicId) ?? [], subclassLevel: (data as ClassData).subclassLevel }
      : { featureLevels: [...new Set(data.features.map((f) => f.level))].sort((a, b) => a - b) };
  const entry = materialized(record, overview[0], record.publicId, sectionText(overview), { ...extra, aliasIds: overview.map((c) => c.id) });
  plan.replaceChunks(overview.map((c) => c.id), entry);

  // Feature blocks: the SRD's class-feature shape. A block holding several features keeps its own name.
  const featuresOf = new Map<string, ClassData['features']>();
  for (const f of data.features) {
    for (const id of new Set(f.text.entryIds)) if (featureIds.has(id)) featuresOf.set(id, [...(featuresOf.get(id) ?? []), f]);
  }
  for (const [id, features] of featuresOf) {
    const chunk = byId.get(id);
    if (!chunk || plan.isClaimed(id)) continue;
    const level = Math.min(...features.map((f) => f.level));
    const single = features.length === 1 && features[0].text.entryIds[0] === id ? features[0] : undefined;
    const name = single ? single.name : chunk.name;
    const owner = featureOwner(record, level);
    const path = renamedPath(chunk, name);
    plan.enrichChunk(id, {
      ...chunk,
      kind: 'rule',
      name,
      summary: owner.summary,
      ...(path ? { path } : {}),
      data: owner.data,
    });
  }
}

/** "Wickwright feature (level 1)" / "Ember Warden feature (Fighter level 3)" and their data, as the SRD writes them. */
function featureOwner(record: StructuredRecord, level: number): { summary: string; data: Data } {
  if (record.kind === 'class') {
    return { summary: `${record.name} feature (level ${level})`, data: { class: record.name, classId: record.publicId, level } };
  }
  const sub = record.data as SubclassData;
  return {
    summary: `${record.name} feature (${sub.parentClass} level ${level})`,
    data: { class: sub.parentClass, classId: record.parentClassId, subclass: record.name, subclassId: record.publicId, level },
  };
}

function planRow(plan: Plan, record: StructuredRecord, byId: ReadonlyMap<string, CompendiumEntry>): void {
  const table = byId.get(record.entryIds[0]);
  if (!table) return;
  const data = record.data as ItemData;
  const path = table.path?.length ? [...table.path, record.name] : [table.name, record.name];
  const summary = itemSummary(data);
  plan.append(table.id, {
    id: record.publicId,
    sourceId: table.sourceId,
    sourceName: table.sourceName,
    kind: 'item',
    name: record.name,
    ...(summary ? { summary } : {}),
    text: itemText(record.name, data),
    path,
    data: recordData(record),
  });
}

// ---------------------------------------------------------------------------
// SRD-shaped data per kind
// ---------------------------------------------------------------------------

function kindData(record: StructuredRecord): Data {
  const d = record.data as StructuredRecord['data'];
  switch (record.kind) {
    case 'monster':
      return monsterData(d as MonsterData);
    case 'spell':
      return spellData(d as SpellData);
    case 'magic-item': {
      const m = d as MagicItemData;
      return defined({ category: m.category, rarity: m.rarity, rarityText: m.rarityText, attunement: m.attunement, baseItem: m.baseItem, bonuses: m.bonuses, charges: m.charges });
    }
    case 'item': {
      const { format: _format, ...fields } = d as ItemData;
      return defined({ ...fields });
    }
    case 'feat': {
      const f = d as FeatData;
      return defined({ category: f.category, prerequisite: f.prerequisite, repeatable: f.repeatable ? true : undefined, minLevel: f.minLevel, abilityIncrease: f.abilityIncrease });
    }
    case 'species': {
      const s = d as SpeciesData;
      return defined({ creatureType: s.creatureType, sizes: s.sizes, speed: s.speed, darkvision: s.darkvision, lineages: s.lineages?.map((l) => l.name) });
    }
    case 'background': {
      const b = d as BackgroundData;
      return { abilityScores: b.abilityScores, feat: b.feat, skills: b.skills, tool: b.tool };
    }
    case 'class': {
      const c = d as ClassData;
      return defined({ hitDie: c.hitDie, primaryAbilities: c.primaryAbilities, savingThrows: c.savingThrows, casterType: c.casterType, spellcastingAbility: c.spellcastingAbility });
    }
    case 'subclass': {
      const s = d as SubclassData;
      return { class: s.parentClass, classId: record.parentClassId };
    }
  }
}

function monsterData(m: MonsterData): Data {
  return defined({
    cr: m.cr,
    crValue: m.crValue,
    xp: m.xp,
    pb: m.pb,
    size: m.size,
    sizes: m.sizes,
    type: m.type,
    tags: m.tags,
    alignment: m.alignment,
    ac: m.ac,
    acNote: m.acNote,
    hp: m.hp,
    hitDice: m.hitDice,
    speed: m.speed,
    speeds: m.speeds,
    initiative: m.initiative,
    reachFt: m.reachFt,
    abilities: m.abilities,
    senses: m.senses,
    passivePerception: m.passivePerception,
    languages: m.languages,
    resistances: m.resistances,
    immunities: m.immunities,
    vulnerabilities: m.vulnerabilities,
    legendary: m.legendary,
  });
}

function spellData(s: SpellData): Data {
  return defined({
    level: s.level,
    school: s.school,
    classes: s.classes,
    ritual: s.ritual,
    concentration: s.concentration,
    castingTime: s.castingTime,
    range: s.range,
    components: s.components,
    duration: s.duration,
    saveAbility: s.saveAbility,
    attack: s.attack,
    damage: s.damage,
    damageTypes: s.damageTypes,
    area: s.area ? defined({ shape: s.area.shape, size: s.area.sizeFt, widthFt: s.area.widthFt, heightFt: s.area.heightFt }) : undefined,
    damageByCharacterLevel: s.damageByCharacterLevel,
  });
}

// ---------------------------------------------------------------------------
// Summaries (the SRD's style) and app-written item text
// ---------------------------------------------------------------------------

const MAGIC_CATEGORY: Readonly<Record<string, string>> = {
  'wondrous-item': 'Wondrous Item', armor: 'Armor', shield: 'Shield', weapon: 'Weapon', ammunition: 'Ammunition', potion: 'Potion',
  ring: 'Ring', rod: 'Rod', scroll: 'Scroll', staff: 'Staff', wand: 'Wand', other: 'Magic Item',
};
const FEAT_CATEGORY: Readonly<Record<string, string>> = { origin: 'Origin', general: 'General', 'fighting-style': 'Fighting Style', 'epic-boon': 'Epic Boon' };
const CASTER_SUMMARY: Readonly<Record<string, string>> = {
  full: 'Full spellcaster', half: 'Half spellcaster', third: 'Third spellcaster', pact: 'Pact Magic', none: 'No spellcasting',
};

/** The index summary of a materialized entry, in the SRD's style ("CR 3 (700 XP) · Large Dragon"). */
export function summaryFor(record: StructuredRecord): string {
  const d = record.data;
  if (!d) return '';
  switch (record.kind) {
    case 'monster': {
      const m = d as MonsterData;
      const size = m.sizes && m.sizes.length > 1 ? m.sizes.join(' or ') : m.size;
      return `CR ${m.cr}${m.xp !== undefined ? ` (${m.xp.toLocaleString('en-US')} XP)` : ''} · ${size} ${m.type}`;
    }
    case 'spell': {
      const s = d as SpellData;
      const head = s.level === 0 ? `${s.school} cantrip` : `Level ${s.level} ${s.school}`;
      return s.classes.length ? `${head} · ${s.classes.join(', ')}` : head;
    }
    case 'magic-item': {
      const m = d as MagicItemData;
      const rarity = m.rarity === 'varies' ? (m.rarityText ? m.rarityText.toLowerCase() : 'rarity varies') : m.rarity;
      const attune = m.attunement === true ? ' (requires attunement)' : typeof m.attunement === 'string' && m.attunement ? ` (requires attunement ${m.attunement})` : '';
      return `${MAGIC_CATEGORY[m.category] ?? 'Magic Item'}${m.baseItem ? ` (${m.baseItem})` : ''}, ${rarity}${attune}`;
    }
    case 'item':
      return itemSummary(d as ItemData);
    case 'feat': {
      const f = d as FeatData;
      return `${FEAT_CATEGORY[f.category] ?? 'General'} Feat${f.prerequisite ? ` (Prerequisite: ${f.prerequisite})` : ''}`;
    }
    case 'species': {
      const s = d as SpeciesData;
      return [`${s.sizes.join(' or ')} ${s.creatureType}`, `Speed ${s.speed} ft.`, s.darkvision ? `Darkvision ${s.darkvision} ft.` : ''].filter(Boolean).join(' · ');
    }
    case 'background': {
      const b = d as BackgroundData;
      return [
        b.abilityScores.length ? b.abilityScores.map(abilityShort).join(', ') : 'Any three abilities',
        b.feat || 'Origin feat: your choice',
        b.skills.map((s) => SKILL_NAMES[s as Skill] ?? s).join(', '),
      ].filter(Boolean).join(' · ');
    }
    case 'class': {
      const c = d as ClassData;
      const joiner = c.primaryAbilityRule === 'any' ? ' or ' : ' and ';
      return [c.primaryAbilities.map((a) => ABILITY_NAMES[a]).join(joiner), `d${c.hitDie} Hit Die`, CASTER_SUMMARY[c.casterType] ?? ''].filter(Boolean).join(' · ');
    }
    case 'subclass': {
      const s = d as SubclassData;
      return [`${s.parentClass} subclass`, s.summary].filter(Boolean).join(' · ');
    }
  }
}

const GEAR_SUMMARY: Readonly<Record<string, string>> = { gear: 'Adventuring Gear', tool: 'Tool', pack: 'Equipment Pack' };

/** "AC 14 + Dex modifier (max 2)", "AC 11 + Dex modifier", "AC 16". */
function armorClassText(i: Pick<ItemData, 'armorClass' | 'dexCap'>): string {
  const cap = i.dexCap;
  const dex = cap === null || cap === undefined ? ' + Dex modifier' : cap > 0 ? ` + Dex modifier (max ${cap})` : '';
  return `AC ${i.armorClass ?? 0}${dex}`;
}

const priceParts = (i: Pick<ItemData, 'costGp' | 'weight'>) =>
  [i.costGp !== undefined ? costText(i.costGp) : '', i.weight !== undefined ? `${i.weight} lb.` : ''].filter(Boolean);

/** An item row's summary in the SRD's style ("Martial Melee Weapon · 1d8 Bludgeoning · Reach, Two-Handed"). */
export function itemSummary(i: ItemData): string {
  switch (i.category) {
    case 'weapon':
      return [
        `${titleCase(i.weaponCategory ?? '')} ${titleCase(i.weaponType ?? '')} Weapon`.replace(/\s+/g, ' ').trim(),
        [i.damage, i.damageType ? titleCase(i.damageType) : ''].filter(Boolean).join(' '),
        (i.properties ?? []).join(', '),
      ].filter(Boolean).join(' · ');
    case 'armor':
      return [`${titleCase(i.armorType ?? '')} Armor`.trim(), i.armorClass !== undefined ? armorClassText(i) : ''].filter(Boolean).join(' · ');
    case 'shield':
      return ['Shield', i.armorClass !== undefined ? `${signed(i.armorClass)} AC` : ''].filter(Boolean).join(' · ');
    default:
      return [GEAR_SUMMARY[i.category] ?? 'Adventuring Gear', ...priceParts(i)].join(' · ');
  }
}

/** The app-written text of an item row ("Hookstaff — Martial Melee Weapon. Damage 1d8 bludgeoning. …"). Never book text. */
export function itemText(name: string, i: ItemData): string {
  const sentences: string[] = [];
  switch (i.category) {
    case 'weapon': {
      sentences.push(`${titleCase(i.weaponCategory ?? '')} ${titleCase(i.weaponType ?? '')} Weapon`.replace(/\s+/g, ' ').trim());
      if (i.damage) sentences.push(`Damage ${[i.damage, i.damageType].filter(Boolean).join(' ')}`);
      if (i.properties?.length) sentences.push(`Properties: ${i.properties.join(', ')}`);
      if (i.range && !(i.properties ?? []).some((p) => p.includes(i.range as string))) sentences.push(`Range ${i.range}`);
      if (i.mastery) sentences.push(`Mastery: ${i.mastery}`);
      break;
    }
    case 'armor':
      sentences.push(`${titleCase(i.armorType ?? '')} Armor`.trim());
      if (i.armorClass !== undefined) sentences.push(armorClassText(i));
      if (i.strengthRequirement !== undefined) sentences.push(`Strength ${i.strengthRequirement}`);
      if (i.stealthDisadvantage) sentences.push('Stealth: Disadvantage');
      break;
    case 'shield':
      sentences.push('Shield');
      if (i.armorClass !== undefined) sentences.push(`${signed(i.armorClass)} AC`);
      break;
    default:
      sentences.push(GEAR_SUMMARY[i.category] ?? 'Adventuring Gear');
  }
  const price = priceParts(i).join(', ');
  const body = [...sentences, price].filter(Boolean).map((s) => (s.endsWith('.') ? s : `${s}.`));
  return `${name} — ${body.join(' ')}`;
}
