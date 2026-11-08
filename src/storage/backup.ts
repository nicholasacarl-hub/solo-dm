/**
 * Save files: export a campaign to a JSON bundle, validate one, and import it back.
 * Bundles hold one campaign and what it owns — never the imported library, never shared homebrew,
 * never text from the player's imported books (the DM's rules lookups are redacted in exports), and
 * never illustrations (they stay on this device; the story log's image entries travel without them,
 * and a device that doesn't have the picture says so).
 */
import { z } from 'zod';
import { findSrdClass } from '@/engine/classData';
import { normalizeCombatState } from '@/engine/mapNormalize';
import { slugify } from '@/lib/id';
import { hasImported, redactImported } from '@/lib/importedContent';
import type { Campaign, CombatState, HitDiceEntry, HitDie } from '@/types';
import { campaignAndImageTables, db } from './db';
import { deleteCampaignData, normalizeCampaignData, readCampaignData, writeCampaignData } from './campaignData';
import { isCampaignOpenElsewhere, OPEN_ELSEWHERE_ERROR } from './campaignLock';
import { emitCampaignChange } from './events';
import { copyImages, imagesToCopy } from './images';
import { IdMap, remapCampaignData } from './remap';
import type { CampaignBundle, CampaignData } from './types';

export const BUNDLE_FORMAT = 'solo-dm-campaign';
export const BUNDLE_VERSION = 1;
export const BUNDLE_EXTENSION = '.solodm.json';

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * A copy of `value` in which every passage of imported-book text (wrapped by the DM's rules lookups,
 * see src/lib/importedContent.ts) is replaced by a short placeholder. Unchanged parts are shared;
 * the input is never modified.
 */
export function redactImportedDeep<T>(value: T): T {
  if (typeof value === 'string') return (hasImported(value) ? redactImported(value) : value) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item: unknown) => {
      const redacted = redactImportedDeep(item);
      if (redacted !== item) changed = true;
      return redacted;
    });
    return (changed ? items : value) as T;
  }
  if (typeof value === 'object' && value !== null) {
    let changed = false;
    const entries = Object.entries(value).map(([key, item]: [string, unknown]) => {
      const redacted = redactImportedDeep(item);
      if (redacted !== item) changed = true;
      return [key, redacted] as const;
    });
    return (changed ? Object.fromEntries(entries) : value) as T;
  }
  return value;
}

/**
 * The campaign as a save file (used for downloads and GitHub pushes). Imported-book text that the
 * DM looked up is replaced by a placeholder in the transcript and everywhere else; tool_use ids and
 * the rest of the transcript are kept. The stored campaign is not changed.
 */
export async function exportCampaignBundle(campaignId: string): Promise<CampaignBundle> {
  const data = await readCampaignData(campaignId);
  if (!data) throw new Error('That campaign no longer exists, so it could not be exported.');
  return { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: Date.now(), ...redactImportedDeep(data) };
}

/** The file text of a bundle (pretty-printed so saves diff nicely in git). */
export function serializeBundle(bundle: CampaignBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

export function bundleFileName(campaignName: string): string {
  return `${slugify(campaignName) || 'campaign'}${BUNDLE_EXTENSION}`;
}

export async function downloadCampaign(campaignId: string): Promise<void> {
  const bundle = await exportCampaignBundle(campaignId);
  const blob = new Blob([serializeBundle(bundle)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = bundleFileName(bundle.campaign.name);
  link.style.display = 'none';
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Revoke after the click has been handled; some browsers read the URL asynchronously.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

// ---------------------------------------------------------------------------
// Validation (lenient: key fields are checked, sensible defaults fill gaps — including everything the
// rules engine reads from a character — unknown fields pass through, and display-log entries that
// can't be shown are dropped)
// ---------------------------------------------------------------------------

const id = z.string().min(1);
const timestamp = z.number();

/** z.enum needs tuples; tests keep these equal to CREATURE_SIZES and BATTLE_MAPS_MODES (src/types). */
export const SAVE_CREATURE_SIZES = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'] as const;
export const SAVE_BATTLE_MAPS_MODES = ['off', 'auto', 'always'] as const;
const strings = z.array(z.string()).default([]);

const usageSchema = z
  .looseObject({
    requests: z.number().default(0),
    inputTokens: z.number().default(0),
    outputTokens: z.number().default(0),
    cacheReadTokens: z.number().default(0),
    cacheWriteTokens: z.number().default(0),
    estimatedCostUsd: z.number().default(0),
  })
  .default(() => ({
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
  }));

const settingsSchema = z.looseObject({
  tone: z.string().default(''),
  setting: z.string().default(''),
  rulesFidelity: z.enum(['strict', 'balanced', 'narrative']).catch('balanced'),
  homebrewFreedom: z.enum(['none', 'light', 'moderate', 'wild']).catch('moderate'),
  difficulty: z.enum(['story', 'standard', 'hard', 'brutal']).catch('standard'),
  narrationLength: z.enum(['brief', 'standard', 'rich']).catch('standard'),
  playerRollMode: z.enum(['auto', 'prompt', 'physical']).catch('prompt'),
  showDmRolls: z.boolean().catch(false),
  milestoneLeveling: z.boolean().catch(true),
  enabledSources: strings,
  lines: strings,
  veils: strings,
  // Missing means 'offered'; anything unreadable is treated as missing.
  transformations: z.enum(['off', 'offered', 'consequences']).optional().catch(undefined),
  artStyle: z.string().optional().catch(undefined),
  // Missing means 'auto' (When it helps); anything unreadable is treated as missing.
  battleMaps: z.enum(SAVE_BATTLE_MAPS_MODES).optional().catch(undefined),
});

const campaignSchema = z.looseObject({
  id,
  name: z.string(),
  premise: z.string().default(''),
  characterId: id.nullable().default(null),
  settings: settingsSchema,
  status: z.enum(['setup', 'active', 'archived']).catch('active'),
  scene: z.looseObject({ location: z.string() }).default(() => ({ location: 'Unknown' })),
  sessionCount: z.number().int().min(0).default(0),
  activeSessionId: id.nullable().default(null),
  tension: z.number().default(5),
  usage: usageSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
  lastPlayedAt: timestamp.nullable().default(null),
});

const abilitySchema = z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']);
const hitDieSchema = z.union([z.literal(6), z.literal(8), z.literal(10), z.literal(12)]);

/** A class entry; ids, hit die and caster type come from the SRD class of that name when missing. */
const classLevelSchema = z
  .looseObject({
    name: z.string(),
    level: z.number().int().min(0),
    classId: z.string().min(1).optional().catch(undefined),
    hitDie: hitDieSchema.optional().catch(undefined),
    casterType: z.enum(['full', 'half', 'third', 'pact', 'none']).optional().catch(undefined),
    spellcastingAbility: abilitySchema.optional().catch(undefined),
  })
  .transform((cl) => {
    const srd = findSrdClass(cl.classId) ?? findSrdClass(cl.name);
    return {
      ...cl,
      classId: cl.classId ?? srd?.id ?? `class:${slugify(cl.name) || 'unknown'}`,
      hitDie: cl.hitDie ?? srd?.hitDie ?? 8,
      casterType: cl.casterType ?? srd?.casterType ?? 'none',
    };
  });

/** One hit die pool per die size, as many dice as levels in those classes (none spent). */
function hitDiceFromClasses(classes: { level: number; hitDie: HitDie }[]): HitDiceEntry[] {
  const totals = new Map<HitDie, number>();
  for (const cl of classes) totals.set(cl.hitDie, (totals.get(cl.hitDie) ?? 0) + cl.level);
  return [...totals].filter(([, total]) => total > 0).map(([die, total]) => ({ die, total, spent: 0 }));
}

const coin = z.number().default(0);

/** An array whose unreadable items are left out, instead of failing the whole file. */
function keepReadable<T extends z.ZodType>(item: T) {
  return z.array(z.unknown()).transform((items) =>
    items.flatMap((value) => {
      const parsed = item.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    }),
  );
}

const transformationSchema = z.looseObject({
  id,
  name: z.string(),
  summary: z.string().default(''),
  stage: z.string().optional().catch(undefined),
  origin: z.enum(['accepted', 'imposed']).catch('accepted'),
  status: z.enum(['active', 'ended']).catch('active'),
  howItEnds: z.string().optional().catch(undefined),
  featureIds: z.array(z.string()).default([]).catch([]),
  startedSession: z.number().default(0),
  endedSession: z.number().optional().catch(undefined),
  createdAt: timestamp.default(0),
  updatedAt: timestamp.default(0),
});

const characterSchema = z
  .looseObject({
    id,
    campaignId: z.string().optional(),
    name: z.string(),
    species: z.string().default(''),
    background: z.string().default(''),
    classes: z.array(classLevelSchema),
    abilityScores: z.looseObject({
      str: z.number(),
      dex: z.number(),
      con: z.number(),
      int: z.number(),
      wis: z.number(),
      cha: z.number(),
    }),
    hp: z.looseObject({ max: z.number(), current: z.number(), temp: z.number().default(0) }),
    xp: z.number().default(0),
    savingThrows: strings,
    skills: z.record(z.string(), z.number()).default(() => ({})),
    tools: strings,
    languages: strings,
    weaponProficiencies: strings,
    armorTraining: strings,
    armorClass: z.number().default(10),
    speed: z.number().default(30),
    size: z.enum(SAVE_CREATURE_SIZES).catch('Medium'),
    deathSaves: z
      .looseObject({
        successes: z.number().default(0),
        failures: z.number().default(0),
        stable: z.boolean().default(false),
        dead: z.boolean().default(false),
      })
      .default(() => ({ successes: 0, failures: 0, stable: false, dead: false })),
    conditions: z.array(z.looseObject({ id: z.string() })).default([]),
    hitDice: z.array(z.looseObject({ die: hitDieSchema, total: z.number(), spent: z.number().default(0) })).optional(),
    spellcasting: z
      .looseObject({
        ability: abilitySchema.optional().catch(undefined),
        slots: z.record(z.string(), z.looseObject({ max: z.number(), used: z.number().default(0) })).default(() => ({})),
        spells: z.array(z.looseObject({ name: z.string() })).default([]),
      })
      .optional(),
    features: z.array(z.looseObject({ id, name: z.string() })).default([]),
    attacks: z.array(z.looseObject({ id, name: z.string() })).default([]),
    inventory: z.array(z.looseObject({ id, name: z.string(), quantity: z.number() })).default([]),
    currency: z.looseObject({ cp: coin, sp: coin, ep: coin, gp: coin, pp: coin }).default(() => ({ cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 })),
    exhaustion: z.number().default(0),
    heroicInspiration: z.boolean().default(false),
    personality: z.looseObject({}).default(() => ({})),
    notes: z.string().default(''),
    transformations: keepReadable(transformationSchema).optional().catch(undefined),
    createdAt: timestamp.default(0),
    updatedAt: timestamp.default(0),
  })
  .transform(({ hitDice, spellcasting, ...character }) => ({
    ...character,
    hitDice: hitDice ?? hitDiceFromClasses(character.classes),
    ...(spellcasting && {
      spellcasting: {
        ...spellcasting,
        ability: spellcasting.ability ?? character.classes.find((cl) => cl.spellcastingAbility)?.spellcastingAbility ?? 'int',
      },
    }),
  }));

const sessionSchema = z.looseObject({
  id,
  campaignId: z.string().optional(),
  number: z.number().int().min(0),
  status: z.enum(['active', 'ended']).catch('ended'),
  model: z.string().default(''),
  systemPrompt: z.string().default(''),
  startedAt: timestamp,
  endedAt: timestamp.nullable().default(null),
  recap: z.string().nullable().default(null),
  dmNotes: z.string().nullable().default(null),
  usage: usageSchema,
  contextTokens: z.number().default(0),
});

const transcriptSchema = z.looseObject({
  id,
  sessionId: id,
  seq: z.number(),
  param: z.looseObject({ role: z.string(), content: z.unknown() }),
  createdAt: timestamp.default(0),
});

const logSchema = z.looseObject({
  id,
  campaignId: z.string().optional(),
  sessionId: id.nullable().default(null),
  seq: z.number(),
  // Kinds this version doesn't know (from a newer app) are left out, like entries that can't be shown.
  kind: z.string(),
  createdAt: timestamp,
});

/** A picture that was still being painted when the game was saved will never finish on this device. */
const UNFINISHED_PICTURE = 'This picture wasn’t finished when the game was saved.';

/** What each kind of display-log entry needs to be shown (defaults fill what can be guessed). */
const logKindSchemas = {
  player: z.looseObject({ text: z.string() }),
  dm: z.looseObject({
    text: z.string(),
    choices: z.array(z.string()).optional().catch(undefined),
    streaming: z.boolean().optional().catch(undefined),
  }),
  roll: z.looseObject({
    actor: z.enum(['player', 'dm']).catch('player'),
    purpose: z.string().default(''),
    roll: z.looseObject({
      total: z.number(),
      expression: z.string().default(''),
      dice: z.array(z.looseObject({ sides: z.number(), value: z.number() })).default([]),
      modifier: z.number().default(0),
      breakdown: z.string().default(''),
    }),
    secret: z.boolean().default(false),
  }),
  tool: z.looseObject({ tool: z.string().default(''), icon: z.string().min(1).catch('info'), summary: z.string() }),
  system: z.looseObject({ text: z.string(), level: z.enum(['info', 'warning']).catch('info') }),
  session: z.looseObject({ event: z.enum(['start', 'end']), sessionNumber: z.number() }),
  recap: z.looseObject({ sessionNumber: z.number().default(0), text: z.string() }),
  error: z.looseObject({ text: z.string(), retryable: z.boolean().default(false) }),
  image: z
    .looseObject({
      imageId: id,
      title: z.string().default(''),
      subject: z.enum(['scene', 'character', 'npc', 'creature', 'item', 'battle']).catch('scene'),
      status: z.enum(['pending', 'ready', 'failed']).catch('failed'),
      error: z.string().optional().catch(undefined),
    })
    .transform((entry) => (entry.status === 'pending' ? { ...entry, status: 'failed' as const, error: UNFINISHED_PICTURE } : entry)),
} as const;

function isKnownKind(kind: string): kind is keyof typeof logKindSchemas {
  return Object.hasOwn(logKindSchemas, kind);
}

/** Display-log entries lacking what their kind needs (or of a kind this version doesn't know) are left out. */
function showableLogEntries(entries: z.infer<typeof logSchema>[]): unknown[] {
  return entries.flatMap((entry) => {
    if (!isKnownKind(entry.kind)) return [];
    const parsed = logKindSchemas[entry.kind].safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

const journalSchema = z.looseObject({
  id,
  campaignId: z.string().optional(),
  kind: z.enum(['npc', 'location', 'faction', 'item', 'lore', 'event', 'ruling', 'note']).catch('note'),
  name: z.string(),
  summary: z.string().default(''),
  tags: strings,
  secret: z.boolean().default(false),
  firstSession: z.number().default(0),
  lastSession: z.number().default(0),
  createdAt: timestamp.default(0),
  updatedAt: timestamp.default(0),
});

const questSchema = z.looseObject({
  id,
  campaignId: z.string().optional(),
  title: z.string(),
  status: z.enum(['rumor', 'active', 'completed', 'failed', 'abandoned']).catch('active'),
  summary: z.string().default(''),
  objectives: z.array(z.looseObject({ id, text: z.string(), done: z.boolean().default(false) })).default([]),
  ambition: z.boolean().optional().catch(undefined),
  createdAt: timestamp.default(0),
  updatedAt: timestamp.default(0),
});

const clockSchema = z.looseObject({
  id,
  campaignId: z.string().optional(),
  name: z.string(),
  segments: z.number().int().min(1),
  filled: z.number().min(0).default(0),
  kind: z.enum(['threat', 'progress', 'countdown']).catch('threat'),
  secret: z.boolean().default(false),
  resolved: z.boolean().default(false),
  createdAt: timestamp.default(0),
  updatedAt: timestamp.default(0),
});

const homebrewSchema = z.looseObject({
  id,
  sourceId: z.literal('homebrew').catch('homebrew'),
  sourceName: z.string().default('Homebrew'),
  campaignId: z.string().nullable().optional(),
  kind: z.string().min(1).catch('other'),
  name: z.string(),
  text: z.string().default(''),
  origin: z.enum(['dm', 'player']).catch('dm'),
  status: z.enum(['active', 'retired']).catch('active'),
  createdAt: timestamp.default(0),
  updatedAt: timestamp.default(0),
});

const combatantSchema = z.looseObject({
  id,
  name: z.string(),
  // The tracker lists a combatant's conditions, so they must be a list (unreadable ones are dropped).
  conditions: z.array(z.looseObject({ id: z.string() })).default([]).catch([]),
});

const combatSchema = z
  .looseObject({
    active: z.boolean().default(true),
    round: z.number().default(1),
    turnIndex: z.number().default(0),
    combatants: z.array(combatantSchema),
    startedAt: timestamp.default(0),
    map: z.unknown().optional(),
  })
  // One source of truth for every battle-map field (positions, sizes, speeds, hidden, reactions, the map), shared
  // with the IndexedDB load path: it never throws, drops what it can't read, and keeps the combat.
  .transform((c): CombatState => normalizeCombatState(c));

const bundleSchema = z.looseObject({
  format: z.literal(BUNDLE_FORMAT),
  version: z.literal(BUNDLE_VERSION),
  exportedAt: timestamp.default(0),
  campaign: campaignSchema,
  character: characterSchema.nullable().default(null),
  sessions: z.array(sessionSchema).default([]),
  transcript: z.array(transcriptSchema).default([]),
  log: z.array(logSchema).default([]).transform(showableLogEntries),
  combat: combatSchema.nullable().default(null),
  journal: z.array(journalSchema).default([]),
  quests: z.array(questSchema).default([]),
  clocks: z.array(clockSchema).default([]),
  homebrew: z.array(homebrewSchema).default([]),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((out, key) => {
    if (typeof key === 'number') return `${out}[${key}]`;
    return out ? `${out}.${String(key)}` : String(key);
  }, '');
}

function invalid(detail: string): Error {
  return new Error(`This isn't a valid Solo DM save file: ${detail}`);
}

/** Validate a parsed save file (a JSON string is parsed first). Throws a readable Error. */
export function parseCampaignBundle(data: unknown): CampaignBundle {
  let value = data;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw invalid('the file is not valid JSON.');
    }
  }
  if (!isRecord(value)) throw invalid('expected a JSON object.');
  if (value.format !== BUNDLE_FORMAT) throw invalid('it is missing the "solo-dm-campaign" format marker.');
  if (typeof value.version === 'number' && value.version > BUNDLE_VERSION) {
    throw new Error(
      `This save was made by a newer version of Solo DM (save format ${value.version}). Update the app, then import it again.`,
    );
  }
  const result = bundleSchema.safeParse(value);
  if (!result.success) {
    const { issues } = result.error;
    const shown = issues.slice(0, 3).map((issue) => `${formatPath(issue.path) || 'file'}: ${issue.message}`);
    const more = issues.length > shown.length ? ` (and ${issues.length - shown.length} more problems)` : '';
    throw invalid(`${shown.join('; ')}${more}.`);
  }
  // Key fields are verified above; the remaining fields pass through unchanged.
  return result.data as unknown as CampaignBundle;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function bundleData(bundle: CampaignBundle): CampaignData {
  const { campaign, character, sessions, transcript, log, combat, journal, quests, clocks, homebrew } = bundle;
  return { campaign, character, sessions, transcript, log, combat, journal, quests, clocks, homebrew };
}

/** True when a record id in the data already belongs to a different campaign (only hand-edited files do this). */
async function collidesWithOtherCampaigns(data: CampaignData): Promise<boolean> {
  const campaignId = data.campaign.id;
  const ownedElsewhere = (rows: ({ campaignId: string | null } | undefined)[]) =>
    rows.some((row) => row !== undefined && row.campaignId !== campaignId);
  const ids = <T extends { id: string }>(rows: T[]) => rows.map((r) => r.id);
  const sessionIds = new Set(ids(data.sessions));
  const [characters, sessions, log, journal, quests, clocks, homebrew, transcript] = await Promise.all([
    db.characters.bulkGet(data.character ? [data.character.id] : []),
    db.sessions.bulkGet(ids(data.sessions)),
    db.log.bulkGet(ids(data.log)),
    db.journal.bulkGet(ids(data.journal)),
    db.quests.bulkGet(ids(data.quests)),
    db.clocks.bulkGet(ids(data.clocks)),
    db.homebrew.bulkGet(ids(data.homebrew)),
    db.transcript.bulkGet(ids(data.transcript)),
  ]);
  return (
    [characters, sessions, log, journal, quests, clocks, homebrew].some(ownedElsewhere) ||
    transcript.some((m) => m !== undefined && !sessionIds.has(m.sessionId))
  );
}

/**
 * Import a bundle. If a campaign with the same id exists: 'replace' overwrites it (records the file
 * doesn't have are removed), 'copy' imports under fresh ids as "<name> (copy)". Returns the imported campaign.
 */
export function importCampaignBundle(bundle: CampaignBundle, mode: 'replace' | 'copy' = 'replace'): Promise<Campaign> {
  return importBundle(bundle, mode, 'copy');
}

/**
 * importCampaignBundle with a policy for record ids that already belong to another campaign
 * (possible only with hand-edited files): import as a copy, or fail (GitHub pulls must keep ids).
 */
export async function importBundle(
  bundle: CampaignBundle,
  mode: 'replace' | 'copy',
  onForeignIds: 'copy' | 'fail',
): Promise<Campaign> {
  const data = normalizeCampaignData(bundleData(bundle));
  // Checked before the transaction (it can't wait on anything but the database).
  const openElsewhere = await isCampaignOpenElsewhere(data.campaign.id);
  const { campaign, replaced } = await db.transaction('rw', campaignAndImageTables(), async () => {
    const existing = await db.campaigns.get(data.campaign.id);
    const foreign = await collidesWithOtherCampaigns(data);
    if (foreign && onForeignIds === 'fail') {
      throw new Error('This save shares record ids with another campaign on this device. Import it from a file as a copy instead.');
    }
    if ((existing !== undefined && mode === 'copy') || foreign) {
      const imageIds = new IdMap();
      const remapped = remapCampaignData(data, { name: `${data.campaign.name} (copy)`, imageIds });
      // Pictures the story shows that are on this device come along under the copy's own ids.
      const pictures = await imagesToCopy(data.log, (oldId) => imageIds.get(oldId));
      await writeCampaignData(remapped);
      await copyImages(pictures, remapped.campaign.id);
      return { campaign: remapped.campaign, replaced: false };
    }
    // A replaced campaign keeps its pictures: they were never part of the save.
    // Replacing a campaign that is being played in another tab would be overwritten by that tab.
    if (existing && openElsewhere) throw new Error(OPEN_ELSEWHERE_ERROR);
    if (existing) await deleteCampaignData(existing.id);
    await writeCampaignData(data);
    return { campaign: data.campaign, replaced: existing !== undefined };
  });
  if (replaced) emitCampaignChange({ type: 'replaced', campaignId: campaign.id });
  return campaign;
}
