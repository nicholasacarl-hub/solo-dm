/**
 * The canonical (stored) form of structured data, with ranges: validates normalizer output, review
 * edits, JSON packs and records read back from storage (spec D5, §2.8). Unlike the wire schemas these
 * are never sent to the API, so they may use optionals, unions and refinements freely.
 *
 * - DATA_SCHEMAS[kind] are z.strictObjects mirroring src/types/structured.ts field for field (optional
 *   fields .optional()): unknown keys (a JSON "__proto__" own property included) fail; integrality and
 *   ranges are enforced here (AC 1–40, HP 1–2000, initiative −10…20 and reach 5–60 are the DM tool
 *   limits of definitions.ts:198-213).
 * - RECORD_SCHEMA validates a whole StructuredRecord as read from IndexedDB; its `data` (and a
 *   proposal's) is checked with DATA_SCHEMAS[record.kind]. The envelope strips unknown keys rather than
 *   failing, so a record from a newer app version still reads (it is read-only: `newer-version`).
 *
 * CONTRACT (Day 0). schemas.test.ts checks that each schema's type equals StructuredDataByKind[kind].
 */
import { z } from 'zod';
import {
  ABILITIES,
  CREATURE_SIZES,
  SKILLS,
  STRUCTURED_KINDS,
  type StructuredDataByKind,
  type StructuredKind,
  type StructuredRecord,
} from '@/types';

/** The limits of spec §2.7, shared by the schemas, the planner, packs and the UI's messages. */
export const STRUCTURED_LIMITS = {
  recordsPerSource: 5000,
  entriesPerRecord: 200,
  requestChars: { entity: 16_000, section: 60_000 },
  nameChars: 120,
  stringChars: 400,
  summaryChars: 200,
  modelNoteChars: 300,
  classFeatures: 60,
  subclassFeatures: 30,
  traits: 24,
  lineages: 16,
  levelTableRows: 20,
  levelTableKeys: 16,
  spellNames: 400,
  rowsPerGearTable: 60,
  recordJsonBytes: 64 * 1024,
  pack: { bytes: 20 * 1024 * 1024, entries: 10_000, records: 5000 },
  concurrency: { min: 1, max: 4, default: 3 },
} as const;

const L = STRUCTURED_LIMITS;
const int = (min: number, max: number) => z.int().min(min).max(max);
/** A name: a feature, trait, lineage, class, spell or item name. */
const name = z.string().min(1).max(L.nameChars);
/** A short string field (may be empty only where the type says so). */
const text = z.string().max(L.stringChars);
const filled = z.string().min(1).max(L.stringChars);

const sourceFormat = z.enum(['2024', '2014', 'other']);
const ability = z.enum(ABILITIES);
const skill = z.enum(SKILLS);
const creatureSize = z.enum(CREATURE_SIZES);

/** Challenge ratings and their numeric values (SRD 5.2.1 "Experience Points by Challenge Rating"). */
export const CR_VALUES: Readonly<Record<string, number>> = {
  '0': 0, '1/8': 0.125, '1/4': 0.25, '1/2': 0.5,
  ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [String(i + 1), i + 1])),
};
const CR_LIST = Object.keys(CR_VALUES) as [string, ...string[]];

/** Paragraphs from..to (1-based, inclusive) of the block made of `entryIds` (spec §2.2, §3.3). */
export const TEXT_SPAN = z
  .strictObject({ entryIds: z.array(z.string()).min(1).max(L.entriesPerRecord), from: z.int().min(1), to: z.int().min(1) })
  .refine((s) => s.from <= s.to, { message: 'The text must end at or after the paragraph it starts at.', path: ['to'] });

const trait = z.strictObject({ name, text: TEXT_SPAN });
const lineage = z.strictObject({ name, text: TEXT_SPAN, form: z.enum(['paragraphs', 'table-row']) });
const feature = z.strictObject({ level: int(1, 20), name, text: TEXT_SPAN });
const equipmentPackage = z.strictObject({
  label: name,
  items: z.array(z.strictObject({ name, quantity: int(1, 1000) })),
  gp: z.number().min(0).max(1_000_000),
});
const speed = int(0, 300);
const bonus = int(1, 5);

const monster = z
  .strictObject({
    format: sourceFormat,
    size: creatureSize,
    sizes: z.array(creatureSize).min(1).max(6).optional(),
    type: filled,
    tags: z.array(name).optional(),
    alignment: text.optional(),
    ac: int(1, 40),
    acNote: text.optional(),
    hp: int(1, 2000),
    hitDice: text.optional(),
    speed: filled,
    speeds: z.strictObject({
      walk: speed.optional(),
      fly: speed.optional(),
      swim: speed.optional(),
      climb: speed.optional(),
      burrow: speed.optional(),
      hover: z.boolean().optional(),
    }),
    initiative: int(-10, 20),
    reachFt: int(5, 60).multipleOf(5),
    cr: z.enum(CR_LIST),
    crValue: z.number().min(0).max(30),
    xp: int(0, 1_000_000).optional(),
    pb: int(2, 9).optional(),
    abilities: z.strictObject({
      str: int(1, 30),
      dex: int(1, 30),
      con: int(1, 30),
      int: int(1, 30),
      wis: int(1, 30),
      cha: int(1, 30),
    }),
    senses: text.optional(),
    passivePerception: int(0, 60).optional(),
    languages: text.optional(),
    resistances: text.optional(),
    immunities: text.optional(),
    vulnerabilities: text.optional(),
    legendary: z.boolean(),
  })
  .refine((m) => CR_VALUES[m.cr] === m.crValue, { message: "The CR's value doesn't match the CR.", path: ['crValue'] });

const spell = z.strictObject({
  format: sourceFormat,
  level: int(0, 9),
  school: z.enum(['Abjuration', 'Conjuration', 'Divination', 'Enchantment', 'Evocation', 'Illusion', 'Necromancy', 'Transmutation']),
  classes: z.array(name),
  ritual: z.boolean(),
  concentration: z.boolean(),
  castingTime: filled,
  range: filled,
  components: text.optional(),
  duration: filled,
  area: z
    .strictObject({
      shape: z.enum(['sphere', 'cylinder', 'cone', 'line', 'cube', 'emanation']),
      sizeFt: int(5, 1000),
      widthFt: int(5, 60).optional(),
      heightFt: int(5, 1000).optional(),
    })
    .optional(),
  saveAbility: ability.optional(),
  attack: z.enum(['melee', 'ranged']).optional(),
  damage: text.optional(),
  damageTypes: z.array(name).optional(),
  damageByCharacterLevel: z.record(z.string().regex(/^\d{1,2}$/), filled).optional(),
});

const magicItem = z.strictObject({
  format: sourceFormat,
  category: z.enum(['armor', 'shield', 'weapon', 'ammunition', 'potion', 'ring', 'rod', 'scroll', 'staff', 'wand', 'wondrous-item', 'other']),
  rarity: z.enum(['common', 'uncommon', 'rare', 'very rare', 'legendary', 'artifact', 'varies']),
  rarityText: text.optional(),
  attunement: z.union([z.boolean(), name]),
  baseItem: name.optional(),
  bonuses: z
    .strictObject({
      ac: bonus.optional(),
      savingThrows: bonus.optional(),
      attack: bonus.optional(),
      damage: bonus.optional(),
      acOnlyWhen: z.enum(['no-armor', 'no-armor-no-shield']).optional(),
    })
    .optional(),
  charges: int(1, 100).optional(),
});

const item = z.strictObject({
  format: sourceFormat,
  category: z.enum(['weapon', 'armor', 'shield', 'gear', 'tool', 'pack']),
  costGp: z.number().min(0).max(1_000_000).optional(),
  weight: z.number().min(0).max(10_000).optional(),
  weaponCategory: z.enum(['simple', 'martial']).optional(),
  weaponType: z.enum(['melee', 'ranged']).optional(),
  range: text.optional(),
  damage: text.optional(),
  damageType: text.optional(),
  properties: z.array(name).optional(),
  mastery: text.optional(),
  armorClass: int(0, 30).optional(),
  dexCap: int(0, 10).nullable().optional(),
  strengthRequirement: int(1, 30).optional(),
  stealthDisadvantage: z.boolean().optional(),
  armorType: z.enum(['light', 'medium', 'heavy']).optional(),
  description: text.optional(),
});

const feat = z.strictObject({
  format: sourceFormat,
  category: z.enum(['origin', 'general', 'fighting-style', 'epic-boon']),
  prerequisite: text.optional(),
  minLevel: int(1, 20).optional(),
  repeatable: z.boolean(),
  abilityIncrease: z.strictObject({ abilities: z.array(ability).min(1).max(6), amount: z.literal([1, 2]) }).optional(),
  text: TEXT_SPAN,
});

const species = z.strictObject({
  format: sourceFormat,
  creatureType: name,
  sizes: z.array(creatureSize).min(1).max(6),
  speed,
  darkvision: int(1, 300).optional(),
  traits: z.array(trait).max(L.traits),
  lineageTrait: name.optional(),
  lineages: z.array(lineage).max(L.lineages).optional(),
  legacyAbilityIncreases: z.array(z.strictObject({ ability: z.enum([...ABILITIES, 'any']), amount: int(1, 5) })).optional(),
  languages: z.array(name).optional(),
});

const background = z.strictObject({
  format: sourceFormat,
  abilityScores: z
    .array(ability)
    .max(3)
    .refine((a) => a.length === 0 || a.length === 3, { message: 'A background lists three ability scores, or none.' }),
  feat: z.string().max(L.nameChars),
  skills: z.array(skill).max(SKILLS.length),
  tool: text,
  equipment: z.array(equipmentPackage).max(6),
  languages: z.array(name).optional(),
  legacyFeature: trait.optional(),
});

const levelTableRow = z
  .record(z.string().min(1).max(60), z.union([text, z.number()]))
  .refine((row) => Object.keys(row).length <= L.levelTableKeys, { message: `A level-table row has at most ${L.levelTableKeys} columns.` });

const klass = z.strictObject({
  format: sourceFormat,
  hitDie: z.literal([6, 8, 10, 12]),
  primaryAbilities: z.array(ability).min(1).max(6),
  primaryAbilityRule: z.enum(['all', 'any']),
  savingThrows: z.array(ability).length(2),
  skillChoices: z.strictObject({ count: int(0, SKILLS.length), from: z.array(skill).max(SKILLS.length) }),
  weaponProficiencies: z.array(filled),
  armorTraining: z.array(filled),
  tools: z.array(filled),
  casterType: z.enum(['full', 'half', 'third', 'pact', 'none']),
  spellcastingAbility: ability.optional(),
  spellListName: name.optional(),
  spellNames: z.array(name).max(L.spellNames).optional(),
  weaponMasteryCount: int(0, 10),
  startingEquipment: z.array(equipmentPackage).max(6),
  subclassLevel: int(1, 3),
  features: z.array(feature).max(L.classFeatures),
  levelTable: z.array(levelTableRow).length(L.levelTableRows),
});

const subclass = z.strictObject({
  format: sourceFormat,
  parentClass: z.string().max(L.nameChars),
  summary: z.string().max(L.summaryChars),
  features: z.array(feature).max(L.subclassFeatures),
  casterType: z.literal('third').optional(),
  spellcastingAbility: ability.optional(),
  alwaysPreparedSpells: z.array(z.strictObject({ level: int(1, 20), spells: z.array(name) })).optional(),
});

/** One schema per kind for the stored form (StructuredDataByKind). */
export const DATA_SCHEMAS = {
  monster,
  spell,
  'magic-item': magicItem,
  item,
  feat,
  species,
  background,
  class: klass,
  subclass,
} as const satisfies { [K in StructuredKind]: z.ZodType<StructuredDataByKind[K]> };

// ---- Whole records (storage reads) ---------------------------------------------------------

const warning = z.object({
  code: z.enum([
    'ungrounded', 'cross-check', 'missing', 'default-used', 'out-of-range', 'unresolved-text', 'unresolved-ref',
    'name-collision', 'engine-name', 'spell-list', 'needs-claude', 'refused', 'failed', 'not-this-kind', 'stale-text',
    'model-note', 'newer-version',
  ]),
  severity: z.enum(['info', 'warn', 'block']),
  field: z.string().max(L.nameChars).optional(),
  message: z.string().min(1).max(2000),
});
const adaptation = z.object({
  code: z.enum([
    'species-asi-not-applied', 'species-languages-suggested', 'background-any-three', 'background-feat-choice',
    'background-feature-kept', 'background-languages-suggested', 'feat-general', 'fighting-style-inline',
    'subclass-early-features', 'subclass-overlap', 'subclass-at-level-1', 'prepared-2024-column',
    'half-caster-slots-2024', 'monster-2014-statblock',
  ]),
  note: z.string().min(1).max(L.stringChars),
});
const excerpt = z.object({ field: z.string().max(L.nameChars), text: z.string().max(4000), grounded: z.boolean() });
const count = z.number().min(0);
const usage = z.object({
  requests: count,
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  estimatedCostUsd: count,
});
const origin = z.enum(['parser', 'claude', 'pack', 'manual']);

const envelope = z.object({
  id: z.string().startsWith('rec:'),
  sourceId: z.string().min(1),
  kind: z.enum(STRUCTURED_KINDS),
  name: name,
  schemaVersion: z.int().min(1),
  publicId: z.string().startsWith('lib:'),
  entryIds: z.array(z.string().min(1)).min(1).max(L.entriesPerRecord),
  span: z.enum(['entry', 'section', 'table', 'row']),
  rowIndex: z.int().min(0).optional(),
  tableRecordId: z.string().optional(),
  candidateKey: z.string().min(1),
  status: z.enum(['pending', 'accepted', 'rejected']),
  confidence: z.enum(['high', 'medium', 'low']),
  origin,
  data: z.unknown().nullable(),
  warnings: z.array(warning),
  adaptations: z.array(adaptation),
  excerpts: z.array(excerpt),
  modelNote: z.string().max(L.modelNoteChars).optional(),
  parentClassId: z.string().optional(),
  edited: z.boolean(),
  proposal: z
    .object({ data: z.unknown(), warnings: z.array(warning), adaptations: z.array(adaptation), excerpts: z.array(excerpt), origin, createdAt: z.number() })
    .optional(),
  textHash: z.string(),
  parserVersion: z.int().min(1).optional(),
  extraction: z
    .object({
      model: z.string(),
      requestedModel: z.string(),
      promptVersion: z.int().min(1),
      at: z.number(),
      usage,
      refusal: z.string().optional(),
    })
    .optional(),
  jobId: z.string().optional(),
  runState: z.enum(['queued', 'running', 'done', 'failed', 'refused', 'skipped']).optional(),
  runAttempts: z.int().min(0).optional(),
  runMaxTokens: z.int().min(1).max(32_000).optional(),
  runError: z
    .object({
      code: z.enum(['refused', 'truncated', 'invalid-output', 'too-long', 'bad-request', 'overloaded', 'network', 'interrupted', 'other']),
      message: z.string(),
      retryable: z.boolean(),
    })
    .optional(),
  reviewedAt: z.number().optional(),
  reviewedElsewhere: z.literal(true).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/**
 * A whole StructuredRecord (storage reads): the envelope, then `data` and `proposal.data` with
 * DATA_SCHEMAS[kind], then the 64 KB size limit. Typed as the record it validates.
 */
export const RECORD_SCHEMA = envelope.superRefine((record, ctx) => {
  const schema: z.ZodType = DATA_SCHEMAS[record.kind];
  const check = (value: unknown, path: (string | number)[]) => {
    const result = schema.safeParse(value);
    if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: [...path, ...issue.path] });
  };
  if (record.data !== null) check(record.data, ['data']);
  if (record.proposal) check(record.proposal.data, ['proposal', 'data']);
  if (JSON.stringify(record).length > L.recordJsonBytes) {
    ctx.addIssue({ code: 'custom', message: 'This record is larger than 64 KB.', path: [] });
  }
}) as unknown as z.ZodType<StructuredRecord>;
