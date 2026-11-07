/**
 * Save slots: create, list, delete and duplicate campaigns.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import type { Campaign, Character, UsageTotals } from '@/types';
import { newId } from '@/lib/id';
import { campaignAndImageTables, db } from './db';
import { deleteCampaignData, readCampaignData, writeCampaignData } from './campaignData';
import { assertCampaignNotOpenElsewhere } from './campaignLock';
import { emitCampaignChange } from './events';
import { copyImages, deleteCampaignImages, imagesToCopy } from './images';
import { IdMap, remapCampaignData } from './remap';
import { markCampaignDeleted } from './syncState';
import type { CampaignSummary, NewCampaignInput } from './types';

export function zeroUsage(): UsageTotals {
  return { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 };
}

/** Sum of class levels (0 without classes). */
export function totalLevel(character: Pick<Character, 'classes'>): number {
  return character.classes.reduce((sum, c) => sum + c.level, 0);
}

function summarize(campaign: Campaign, character: Character | undefined): CampaignSummary {
  if (!character) return { campaign, character: null, level: 0 };
  const { id, name, species, classes, portrait, hp, xp } = character;
  return { campaign, character: { id, name, species, classes, portrait, hp, xp }, level: totalLevel(character) };
}

/** Most recently played first (never-played last), then most recently created. */
function compareSlots(a: Campaign, b: Campaign): number {
  if (a.lastPlayedAt !== b.lastPlayedAt) {
    if (a.lastPlayedAt === null) return 1;
    if (b.lastPlayedAt === null) return -1;
    return b.lastPlayedAt - a.lastPlayedAt;
  }
  return b.createdAt - a.createdAt;
}

export async function listCampaigns(): Promise<CampaignSummary[]> {
  const campaigns = await db.campaigns.toArray();
  const characterIds = campaigns.flatMap((c) => (c.characterId ? [c.characterId] : []));
  const characters = await db.characters.bulkGet(characterIds);
  const byId = new Map(characters.flatMap((c) => (c ? [[c.id, c] as const] : [])));
  return campaigns
    .sort(compareSlots)
    .map((c) => summarize(c, c.characterId ? byId.get(c.characterId) : undefined));
}

export function useCampaignList(): CampaignSummary[] | undefined {
  return useLiveQuery(listCampaigns, []);
}

export function getCampaign(id: string): Promise<Campaign | undefined> {
  return db.campaigns.get(id);
}

export async function createCampaign(input: NewCampaignInput): Promise<Campaign> {
  const now = Date.now();
  const campaign: Campaign = {
    id: newId(),
    name: input.name.trim() || 'Untitled campaign',
    premise: input.premise,
    characterId: null,
    settings: input.settings,
    status: 'setup',
    scene: { location: 'Unknown' },
    sessionCount: 0,
    activeSessionId: null,
    ...(input.coverEmoji !== undefined && { coverEmoji: input.coverEmoji }),
    ...(input.coverColor !== undefined && { coverColor: input.coverColor }),
    tension: 5,
    usage: zeroUsage(),
    createdAt: now,
    updatedAt: now,
    lastPlayedAt: null,
  };
  await db.campaigns.add(campaign);
  return campaign;
}

export async function deleteCampaign(id: string): Promise<void> {
  // Never pull a campaign out from under the table of another tab.
  await assertCampaignNotOpenElsewhere(id);
  // Its illustrations go with it (they live only on this device, outside the save itself).
  await db.transaction('rw', campaignAndImageTables(), async () => {
    await deleteCampaignData(id);
    await deleteCampaignImages(id);
  });
  markCampaignDeleted(id);
  emitCampaignChange({ type: 'deleted', campaignId: id });
}

/** A deep copy with fresh ids, illustrations included (so deleting either one leaves the other whole). */
export async function duplicateCampaign(id: string, newName?: string): Promise<Campaign> {
  return db.transaction('rw', campaignAndImageTables(), async () => {
    const data = await readCampaignData(id);
    if (!data) throw new Error('That campaign no longer exists, so it could not be duplicated.');
    const imageIds = new IdMap();
    const copy = remapCampaignData(data, { name: newName?.trim() || `${data.campaign.name} (copy)`, imageIds });
    const pictures = await imagesToCopy(data.log, (oldId) => imageIds.get(oldId), id);
    await writeCampaignData(copy);
    await copyImages(pictures, copy.campaign.id);
    return copy.campaign;
  });
}
