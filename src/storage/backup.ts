/**
 * Save files: export a campaign to a JSON bundle, validate one, and import it back.
 * Bundles hold one campaign and what it owns — never the imported library, never shared homebrew.
 */
import { z } from 'zod';
import { slugify } from '@/lib/id';
import type { Campaign } from '@/types';
import { campaignTables, db } from './db';
import { deleteCampaignData, normalizeCampaignData, readCampaignData, writeCampaignData } from './campaignData';
import { isCampaignOpenElsewhere, OPEN_ELSEWHERE_ERROR } from './campaignLock';
import { emitCampaignChange } from './events';
import { remapCampaignData } from './remap';
import type { CampaignBundle, CampaignData } from './types';

export const BUNDLE_FORMAT = 'solo-dm-campaign';
export const BUNDLE_VERSION = 1;
export const BUNDLE_EXTENSION = '.solodm.json';

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function exportCampaignBundle(campaignId: string): Promise<CampaignBundle> {
  const data = await readCampaignData(campaignId);
  if (!data) throw new Error('That campaign no longer exists, so it could not be exported.');
  return { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: Date.now(), ...data };
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
// Validation (lenient: key fields are checked, sensible defaults fill gaps, unknown fields pass through)
// ---------------------------------------------------------------------------

const id = z.string().min(1);
const timestamp = z.number();
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

const characterSchema = z.looseObject({
  id,
  campaignId: z.string().optional(),
  name: z.string(),
  species: z.string().default(''),
  background: z.string().default(''),
  classes: z.array(z.looseObject({ name: z.string(), level: z.number().int().min(0) })),
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
  tools: strings,
  languages: strings,
  weaponProficiencies: strings,
  armorTraining: strings,
  conditions: z.array(z.looseObject({ id: z.string() })).default([]),
  hitDice: z.array(z.looseObject({})).default([]),
  features: z.array(z.looseObject({ id, name: z.string() })).default([]),
  attacks: z.array(z.looseObject({ id, name: z.string() })).default([]),
  inventory: z.array(z.looseObject({ id, name: z.string(), quantity: z.number() })).default([]),
  exhaustion: z.number().default(0),
  heroicInspiration: z.boolean().default(false),
  notes: z.string().default(''),
  createdAt: timestamp.default(0),
  updatedAt: timestamp.default(0),
});

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
  kind: z.enum(['player', 'dm', 'roll', 'tool', 'system', 'session', 'recap', 'error']),
  createdAt: timestamp,
});

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

const combatSchema = z.looseObject({
  active: z.boolean().default(true),
  round: z.number().default(1),
  turnIndex: z.number().default(0),
  combatants: z.array(z.looseObject({ id, name: z.string() })),
  startedAt: timestamp.default(0),
});

const bundleSchema = z.looseObject({
  format: z.literal(BUNDLE_FORMAT),
  version: z.literal(BUNDLE_VERSION),
  exportedAt: timestamp.default(0),
  campaign: campaignSchema,
  character: characterSchema.nullable().default(null),
  sessions: z.array(sessionSchema).default([]),
  transcript: z.array(transcriptSchema).default([]),
  log: z.array(logSchema).default([]),
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
  const { campaign, replaced } = await db.transaction('rw', campaignTables(), async () => {
    const existing = await db.campaigns.get(data.campaign.id);
    const foreign = await collidesWithOtherCampaigns(data);
    if (foreign && onForeignIds === 'fail') {
      throw new Error('This save shares record ids with another campaign on this device. Import it from a file as a copy instead.');
    }
    if ((existing !== undefined && mode === 'copy') || foreign) {
      const remapped = remapCampaignData(data, { name: `${data.campaign.name} (copy)` });
      await writeCampaignData(remapped);
      return { campaign: remapped.campaign, replaced: false };
    }
    // Replacing a campaign that is being played in another tab would be overwritten by that tab.
    if (existing && openElsewhere) throw new Error(OPEN_ELSEWHERE_ERROR);
    if (existing) await deleteCampaignData(existing.id);
    await writeCampaignData(data);
    return { campaign: data.campaign, replaced: existing !== undefined };
  });
  if (replaced) emitCampaignChange({ type: 'replaced', campaignId: campaign.id });
  return campaign;
}
